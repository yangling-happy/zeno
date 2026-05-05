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
      .addNode('planner_node', (state) => {
        const response = buildResponse(
          `[场景B: 任务规划] 我已理解您的意图：${formatPlannerGoalSummary(state.params)}。正在为您拆解步骤...`,
        );
        return updateStateWithTrace(state, response, 'planner_node');
      })
      // 场景 E: 多端同步节点
      .addNode('sync_node', (state) => {
        const response = buildResponse(
          `[场景E: 多端同步] 正在将数据从 ${state.userInput.channel || '未知设备'} 同步至另一端...`,
        );
        return updateStateWithTrace(state, response, 'sync_node');
      })
      // 场景 C: 文档节点
      .addNode('doc_node', (state) => {
        const actionInstruction =
          this.agentToolService.buildActionInstructionFromSkillPlan(
            state.skillExecutionPlan,
            state.normalizedText,
          );
        const response = buildResponse(
          '已识别为文档协作请求，我会创建文档并在会话中回传链接。',
          actionInstruction,
        );
        return updateStateWithTrace(state, response, 'doc_node');
      })
      // 场景 D: 演示/画布节点
      .addNode('present_node', (state) => {
        const actionInstruction =
          this.agentToolService.buildActionInstructionFromSkillPlan(
            state.skillExecutionPlan,
            state.normalizedText,
          );
        const response = buildResponse(
          '已识别为演示/画布请求：创建画板时会生成「正文文档」与「画板」两条独立链接；正文只写入文档，画板为空白画布可手绘，避免两处重复铺字叠在一起。',
          actionInstruction,
        );
        return updateStateWithTrace(state, response, 'present_node');
      })
      .addNode('clarify_node', (state) => {
        const response = buildResponse(
          '我理解到你可能在发起协作任务。请补充：要创建文档、画板，还是要向已有画板追加内容？',
        );
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

  private async classifyIntent(text: string): Promise<IntentClassification> {
    // 生成缓存键
    const cacheKey = `intent:${text.trim().toLowerCase()}`;

    // 尝试从缓存中获取
    const cachedResult = this.cacheService.get<IntentClassification>(cacheKey);
    if (cachedResult) {
      this.logger.debug(`从缓存获取意图分类结果: ${cacheKey}`);
      return cachedResult;
    }

    const routeResult = await this.intentRoutingService.route(text);
    const result = IntentSchema.parse(routeResult.classification);

    this.cacheService.set(cacheKey, result, this.cacheExpiry);
    this.logger.debug(`缓存意图分类结果: ${cacheKey} [${routeResult.source}]`);

    return result;
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
