import { Injectable, Logger } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SpanStatusCode, trace as otelTrace } from '@opentelemetry/api';
import { AiService } from '../ai/ai.service';
import { AgentToolService } from './agent-tool.service';
import { IntentRoutingService } from './intent/intent-routing.service';
import { SessionService } from './session/session.service';
import { CacheService } from './cache.service';
import {
  ActionInstruction,
  AgentRunInput,
  AgentRunResult,
  IntentType,
  PersonaProfile,
  SkillExecutionPlan,
  SkillMatch,
} from './agent.types';
import {
  IntentSchema,
  type IntentClassification,
} from './zod/agent-zod.schema';
import { EXPLICIT_BOARD_OR_CANVAS_CREATION_RE } from './intent/explicit-board-pattern';
import {
  buildSkillPromptContext,
  getSkillByIntent,
  toSkillPlan,
} from './skill/skill.registry';
import {
  checkRateLimit,
  buildResponse,
  updateStateWithTrace,
} from '../common/agent.utils';

function formatPlannerGoalSummary(
  params: IntentClassification['parameters'] | undefined,
): string {
  const goal = params?.goal;
  if (goal === undefined || goal === null) return '新任务';
  if (typeof goal === 'string') return goal;
  if (typeof goal === 'number' || typeof goal === 'boolean')
    return String(goal);
  return JSON.stringify(goal);
}

/** 结构化场景回复：由 LLM 生成措辞，任务事实与产品约束由调用方注入，避免硬编码话术。 */
type SceneReplyArgs = {
  sceneLabel: string;
  contextItems: string[];
  constraints: string[];
};

const AgentGraphState = Annotation.Root({
  userInput: Annotation<AgentRunInput>,
  normalizedText: Annotation<string>,
  intent: Annotation<IntentType>,
  confidence: Annotation<number>,
  params: Annotation<IntentClassification['parameters']>,
  skillExecutionPlan: Annotation<SkillExecutionPlan | undefined>,
  persona: Annotation<PersonaProfile>,
  route: Annotation<
    'plan' | 'sync' | 'doc' | 'present' | 'chat' | 'end' | 'clarify'
  >,
  response: Annotation<string>,
  actionInstruction: Annotation<ActionInstruction | undefined>,
  trace: Annotation<string[]>,
  sessionHistory: Annotation<
    Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
    }>
  >,
});

type GraphState = typeof AgentGraphState.State;

type CompiledAgentGraph = {
  invoke(state: GraphState): Promise<GraphState>;
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private compiledGraph: CompiledAgentGraph | null = null;

  private readonly personas: Record<string, PersonaProfile> = {
    zeno: {
      id: 'zeno',
      name: 'Zeno',
      role: '多端协同指挥官',
      tone: '专业、高效、具备行动力',
      styleRules: ['优先给出场景解决方案', '跨端操作需明确确认'],
      boundaries: ['不涉及用户隐私数据'],
    },
  };

  constructor(
    private readonly aiService: AiService,
    private readonly agentToolService: AgentToolService,
    private readonly intentRoutingService: IntentRoutingService,
    private readonly sessionService: SessionService,
    private readonly cacheService: CacheService,
  ) {}

  private readonly tracer = otelTrace.getTracer('agent-service');
  private readonly cacheExpiry = 5 * 60 * 1000; // 5分钟缓存过期
  private readonly rateLimitWindow = 1000; // 1秒窗口
  private readonly rateLimitMax = 5; // 每窗口最大请求数
  private readonly concurrentLimit = 10; // 最大并发数
  private readonly requestTimestamps = new Map<string, number[]>(); // 用户请求时间戳
  private readonly activeRequests = new Set<string>(); // 活跃请求ID

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const userId = input.userId || 'anonymous';
    const requestId = `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 检查并发限制
    if (this.activeRequests.size >= this.concurrentLimit) {
      this.logger.warn(`并发请求数超过限制: ${this.activeRequests.size}`);
      return {
        intent: 'CLARIFY',
        confidence: 1,
        response: '系统当前繁忙，请稍后再试',
        actionInstruction: { type: 'NONE' },
        trace: ['rate_limit'],
      };
    }

    // 检查速率限制
    if (!this.checkRateLimit(userId)) {
      this.logger.warn(`用户请求频率超过限制: ${userId}`);
      return {
        intent: 'CLARIFY',
        confidence: 1,
        response: '请求过于频繁，请稍后再试',
        actionInstruction: { type: 'NONE' },
        trace: ['rate_limit'],
      };
    }

    // 添加到活跃请求
    this.activeRequests.add(requestId);

    try {
      return await this.tracer.startActiveSpan('agent.run', async (span) => {
        try {
          // 添加属性到 span
          span.setAttribute('user.id', userId);
          span.setAttribute('input.text', input.text.substring(0, 100));

          // 获取会话历史
          const sessionHistory = this.sessionService.getSessionHistory(
            userId,
            10,
          );

          // 添加用户消息到会话历史
          this.sessionService.addMessage(userId, 'user', input.text);

          const graph = this.getOrCreateGraph();
          const initialState: GraphState = {
            userInput: input,
            normalizedText: '',
            intent: 'CLARIFY',
            confidence: 0,
            params: {},
            skillExecutionPlan: undefined,
            persona: this.personas.zeno,
            route: 'clarify',
            response: '',
            actionInstruction: { type: 'NONE' },
            trace: [],
            sessionHistory,
          };

          const result = await graph.invoke(initialState);

          // 添加助手回复到会话历史
          this.sessionService.addMessage(
            userId,
            'assistant',
            result.response || '任务已接收，正在处理中...',
          );

          // 添加结果属性到 span
          span.setAttribute('result.intent', result.intent);
          span.setAttribute('result.confidence', result.confidence);
          span.setAttribute(
            'result.response',
            (result.response || '').substring(0, 100),
          );

          return {
            intent: result.intent,
            confidence: result.confidence,
            response: result.response || '任务已接收，正在处理中...',
            actionInstruction: result.actionInstruction,
            skillExecutionPlan: result.skillExecutionPlan,
            trace: result.trace,
          };
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          throw error;
        } finally {
          span.end();
        }
      });
    } finally {
      // 从活跃请求中移除
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * 检查速率限制
   * @param userId 用户ID
   * @returns 是否允许请求
   */
  private checkRateLimit(userId: string): boolean {
    return checkRateLimit(
      userId,
      this.requestTimestamps,
      this.rateLimitWindow,
      this.rateLimitMax,
    );
  }

  private formatPersonaBlock(persona: PersonaProfile): string {
    return [
      `你是 ${persona.name}，身份是 ${persona.role}。`,
      `语气与风格：${persona.tone}。`,
      `表达规则：${persona.styleRules.join('；')}。`,
      `边界（不得违反）：${persona.boundaries.join('；')}。`,
    ].join('\n');
  }

  private formatRecentDialogueSnippet(
    sessionHistory: GraphState['sessionHistory'],
    maxTurns = 4,
  ): string {
    if (!sessionHistory?.length) return '';
    return sessionHistory
      .slice(-maxTurns)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
  }

  /**
   * 路由节点的用户可见回复：Context = 任务事实与识别结果；Constraints = 语气、合规与产品规则。
   */
  private async generateSceneUserReply(
    state: GraphState,
    args: SceneReplyArgs,
  ): Promise<string> {
    const dialogue = this.formatRecentDialogueSnippet(state.sessionHistory);
    const sections: string[] = [
      this.formatPersonaBlock(state.persona),
      '',
      `【路由场景】${args.sceneLabel}`,
      '',
      '【任务上下文】',
      ...args.contextItems.map((line) => `- ${line}`),
    ];
    if (dialogue) {
      sections.push('', '【最近对话（仅用于衔接语气，勿冗长复述）】', dialogue);
    }
    sections.push(
      '',
      '【你必须遵守的约束】',
      ...args.constraints.map((line) => `- ${line}`),
      '',
      '【用户本轮输入】',
      state.normalizedText,
      '',
      '请只输出给用户看的正文（自然中文）。不要输出 JSON、不要用 Markdown 一级标题、不要暴露内部字段名或英文路由标识。',
    );
    return this.aiService.chat(sections.join('\n'));
  }

  private getOrCreateGraph() {
    if (this.compiledGraph) return this.compiledGraph;

    const graph = new StateGraph(AgentGraphState)
      .addNode('normalize_input', (state) =>
        updateStateWithTrace(
          state,
          {
            normalizedText: state.userInput.text.trim(),
            sessionHistory: state.sessionHistory,
          },
          'normalize_input',
        ),
      )
      // 场景 A: 意图识别入口
      .addNode('intent_classifier', async (state) => {
        const cls = await this.classifyIntent(state.normalizedText);
        const skillExecutionPlan = this.buildExecutionPlan(cls);
        return updateStateWithTrace(
          state,
          {
            intent: skillExecutionPlan.primarySkill.intent,
            confidence: skillExecutionPlan.primarySkill.confidence,
            params: skillExecutionPlan.primarySkill.parameters,
            skillExecutionPlan,
            route: this.resolveRoute(
              skillExecutionPlan.primarySkill.intent,
              skillExecutionPlan.primarySkill.confidence,
            ),
          },
          'intent_classifier',
        );
      })
      // 场景 B: 任务规划节点
      .addNode('planner_node', async (state) => {
        const responseText = await this.generateSceneUserReply(state, {
          sceneLabel: '任务规划（SCENE_PLAN）',
          contextItems: [
            `规划目标摘要：${formatPlannerGoalSummary(state.params)}`,
            `意图置信度：${state.confidence}`,
          ],
          constraints: [
            '先简要确认用户要达成的目标或任务类型，再说明系统正在拆解执行步骤。',
            '不得编造尚未发生的步骤细节或具体产物（正文、文件名、链接等）。',
            '篇幅控制在 2～5 句话，专业、可执行导向。',
          ],
        });
        const response = buildResponse(responseText);
        return updateStateWithTrace(state, response, 'planner_node');
      })
      // 场景 E: 多端同步节点
      .addNode('sync_node', async (state) => {
        const channel = state.userInput.channel?.trim();
        const responseText = await this.generateSceneUserReply(state, {
          sceneLabel: '多端同步（SCENE_SYNC）',
          contextItems: [
            channel
              ? `当前渠道/来源标识：${channel}`
              : '用户未指定渠道/设备侧信息。',
          ],
          constraints: [
            '说明同步任务已纳入处理或正在进行，不要声称已经全程完成（除非用户语境仅为咨询已完成状态）。',
            '若渠道未知，礼貌说明并引导用户补充来源端与目标端，而非编造设备名。',
            '篇幅 2～4 句话。',
          ],
        });
        const response = buildResponse(responseText);
        return updateStateWithTrace(state, response, 'sync_node');
      })
      // 场景 C: 文档节点
      .addNode('doc_node', async (state) => {
        const actionInstruction =
          this.agentToolService.buildActionInstructionFromSkillPlan(
            state.skillExecutionPlan,
            state.normalizedText,
          );
        const skillId = state.skillExecutionPlan?.primarySkill.skillId;
        const responseText = await this.generateSceneUserReply(state, {
          sceneLabel: '文档协作（SCENE_DOC）',
          contextItems: [
            skillId ? `命中技能：${skillId}` : '文档类协作流程。',
            '系统将创建文档并在会话中返回可访问链接（由下游动作生成，非本段文案虚构）。',
          ],
          constraints: [
            '明确告知用户：会创建文档并在会话中回传链接；不得写出具体 URL 或文档 ID，除非用户原文已提供。',
            '不要承诺超出「创建并交付入口」以外的业务结果。',
          ],
        });
        const response = buildResponse(responseText, actionInstruction);
        return updateStateWithTrace(state, response, 'doc_node');
      })
      // 场景 D: 演示/画布节点
      .addNode('present_node', async (state) => {
        const actionInstruction =
          this.agentToolService.buildActionInstructionFromSkillPlan(
            state.skillExecutionPlan,
            state.normalizedText,
          );
        const responseText = await this.generateSceneUserReply(state, {
          sceneLabel: '演示 / 画布（SCENE_PRESENT）',
          contextItems: [
            '产品事实：创建画板流程可能产生两条独立入口——「正文文档」与「画板画布」。',
            '正文文档用于结构化撰写；画板为可手绘的空白画布。',
            '应避免同一内容在正文与画布两处重复堆叠大段文字。',
          ],
          constraints: [
            '用用户能理解的方式区分「正文文档」与「画板」各自的用途，不提内部路由名或字段名。',
            '不得生成虚构链接或具体时间承诺。',
            '篇幅 2～6 句话。',
          ],
        });
        const response = buildResponse(responseText, actionInstruction);
        return updateStateWithTrace(state, response, 'present_node');
      })
      .addNode('clarify_node', async (state) => {
        const fallbackReason =
          state.skillExecutionPlan?.primarySkill.fallbackReason;
        const responseText = await this.generateSceneUserReply(state, {
          sceneLabel: '意图澄清（CLARIFY）',
          contextItems: [
            `当前归类意图：${state.intent}`,
            `置信度：${state.confidence}`,
            ...(fallbackReason ? [`系统备注：${fallbackReason}`] : []),
          ],
          constraints: [
            '提出 1～3 个具体问题以缩小范围（例如：文档新建、画板新建、向已有画板追加、多端同步等）。',
            '不要替用户武断选定路径；语气友好、简短。',
          ],
        });
        const response = buildResponse(responseText);
        return updateStateWithTrace(state, response, 'clarify_node');
      })
      // 通用回复节点
      .addNode('general_chat', async (state) => {
        const memoryContext = state.userInput.memoryContext;
        let contextBackground = '';

        if (memoryContext && memoryContext.retrievedFacts.length > 0) {
          const factsSummary = memoryContext.retrievedFacts
            .map((fact) => `[${fact.category}] ${fact.content}`)
            .join('\n');
          contextBackground = `\n\n【用户背景信息】\n以下是你从长期记忆中检索到的相关事实：\n${factsSummary}\n`;
        }

        if (memoryContext && memoryContext.recentConversations.length > 0) {
          const recentSummary = memoryContext.recentConversations
            .map((turn) => `${turn.role}: ${turn.content}`)
            .join('\n');
          contextBackground += `\n【最近对话】\n${recentSummary}\n`;
        }

        const responseText = await this.aiService.chat(
          `你是${state.persona.name}，身份是${state.persona.role}。你的职责是"需求→规划→生成→同步→汇报"的全链路自动化协作。请以专业、高效、具备行动力的口吻回答：${state.normalizedText}${contextBackground}`,
        );
        const response = buildResponse(responseText);
        return updateStateWithTrace(state, response, 'general_chat');
      })
      .addEdge(START, 'normalize_input')
      .addEdge('normalize_input', 'intent_classifier')
      .addConditionalEdges('intent_classifier', (state) => state.route, {
        plan: 'planner_node',
        sync: 'sync_node',
        doc: 'doc_node',
        present: 'present_node',
        chat: 'general_chat',
        clarify: 'clarify_node',
        end: END,
      })
      .addEdge('planner_node', END)
      .addEdge('sync_node', END)
      .addEdge('doc_node', END)
      .addEdge('present_node', END)
      .addEdge('clarify_node', END)
      .addEdge('general_chat', END);

    this.compiledGraph = graph.compile();
    return this.compiledGraph;
  }

  private applyBenignBoardCorrection(
    text: string,
    classification: IntentClassification,
  ): IntentClassification {
    if (classification.intent !== 'SAFE_REFUSAL') {
      return classification;
    }
    if (!EXPLICIT_BOARD_OR_CANVAS_CREATION_RE.test(text.trim())) {
      return classification;
    }
    return {
      ...classification,
      intent: 'SCENE_PRESENT',
      confidence: Math.max(classification.confidence, 0.93),
      reason: `显式画板/画布/白板创建语境，纠正误判的安全拒答（原判定：${classification.reason}）`,
      parameters: {
        ...(classification.parameters ?? {}),
        routingSource: 'safe-refusal-board-correction',
      },
    };
  }

  private async classifyIntent(text: string): Promise<IntentClassification> {
    // 生成缓存键
    const cacheKey = `intent:${text.trim().toLowerCase()}`;

    const cachedRaw = this.cacheService.get<unknown>(cacheKey);
    if (cachedRaw !== null) {
      this.logger.debug(`从缓存获取意图分类结果: ${cacheKey}`);
      const cachedResult = IntentSchema.parse(cachedRaw);
      const fixed = this.applyBenignBoardCorrection(text, cachedResult);
      if (fixed.intent !== cachedResult.intent) {
        this.cacheService.set(cacheKey, fixed, this.cacheExpiry);
        this.logger.debug(
          `意图缓存纠偏: ${cacheKey} ${cachedResult.intent} -> ${fixed.intent}`,
        );
      }
      return fixed;
    }

    const routeResult = await this.intentRoutingService.route(text);
    const result = IntentSchema.parse(routeResult.classification);
    const finalResult = this.applyBenignBoardCorrection(text, result);

    this.cacheService.set(cacheKey, finalResult, this.cacheExpiry);
    this.logger.debug(`缓存意图分类结果: ${cacheKey} [${routeResult.source}]`);

    return finalResult;
  }

  private buildSkillPromptContext(): string {
    return buildSkillPromptContext();
  }

  private buildExecutionPlan(
    classification: IntentClassification,
  ): SkillExecutionPlan {
    const matchedSkills = this.matchSkills(classification);
    return this.arbitrateSkills(matchedSkills);
  }

  private matchSkills(classification: IntentClassification): SkillMatch[] {
    const skillDef = getSkillByIntent(classification.intent);
    const parameters = classification.parameters ?? {};
    const missingRequiredParams = skillDef.requiredParams.filter(
      (param) => !(param in parameters),
    );

    let normalizedIntent = classification.intent;
    let normalizedConfidence = classification.confidence;
    let fallbackReason: string | undefined;

    if (
      classification.intent !== 'CLARIFY' &&
      (classification.confidence < skillDef.confidenceThreshold ||
        missingRequiredParams.length > 0)
    ) {
      normalizedIntent = skillDef.fallbackIntent;
      normalizedConfidence = Math.min(classification.confidence, 0.59);
      fallbackReason =
        missingRequiredParams.length > 0
          ? `缺少关键参数: ${missingRequiredParams.join(', ')}`
          : `置信度低于技能阈值(${skillDef.confidenceThreshold})`;
    }

    const normalizedSkillDef = getSkillByIntent(normalizedIntent);

    const primarySkill: SkillMatch = {
      skillId: normalizedSkillDef.id,
      intent: normalizedIntent,
      confidence: normalizedConfidence,
      reason: classification.reason,
      riskLevel: normalizedSkillDef.riskLevel,
      parameters,
      missingRequiredParams,
      fallbackReason,
    };

    return [primarySkill];
  }

  private arbitrateSkills(matches: SkillMatch[]): SkillExecutionPlan {
    if (matches.length === 0) {
      const fallback: SkillMatch = {
        skillId: 'clarify.skill',
        intent: 'CLARIFY',
        confidence: 0.5,
        reason: '未命中可执行技能',
        riskLevel: 'low',
        parameters: {},
        missingRequiredParams: [],
        fallbackReason: '技能候选为空，降级澄清',
      };
      return toSkillPlan(fallback);
    }

    // V1 单技能：按置信度排序选主技能，次技能队列留空；V2 扩展多技能串联。
    const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);
    return toSkillPlan(sorted[0]);
  }

  private resolveRoute(
    intent: IntentType,
    confidence: number,
  ): 'plan' | 'sync' | 'doc' | 'present' | 'chat' | 'end' | 'clarify' {
    if (confidence < 0.6) return 'clarify';
    if (intent === 'SCENE_PLAN') return 'plan';
    if (intent === 'SCENE_SYNC') return 'sync';
    if (intent === 'SCENE_DOC') return 'doc';
    if (intent === 'SCENE_PRESENT') return 'present';
    return 'chat';
  }
}
