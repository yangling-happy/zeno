import { Injectable } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type {
  AgentRunInput,
  SkillExecutionPlan,
  PersonaProfile,
  ActionInstruction,
} from './agent.types';
import { AgentToolService } from '../agent/tool/agent-tool.service';
import { IntentService } from './intent/intent.service';
import { SceneReplyService } from './scene-reply.service';
import { AiService } from '../ai/ai.service';
import { updateStateWithTrace, buildResponse } from '../common/agent.utils';

const AgentGraphState = Annotation.Root({
  userInput: Annotation<AgentRunInput>(),
  normalizedText: Annotation<string>(),
  intent: Annotation<string>(),
  confidence: Annotation<number>(),
  params: Annotation<Record<string, unknown>>(),
  skillExecutionPlan: Annotation<SkillExecutionPlan | undefined>(),
  persona: Annotation<PersonaProfile>(),
  route: Annotation<string>(),
  response: Annotation<string>(),
  actionInstruction: Annotation<ActionInstruction>(),
  trace: Annotation<string[]>(),
  sessionHistory:
    Annotation<
      Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>
    >(),
});

type GraphState = typeof AgentGraphState.State;

type CompiledAgentGraph = { invoke(state: GraphState): Promise<GraphState> };

@Injectable()
export class AgentGraphService {
  private compiledGraph: CompiledAgentGraph | null = null;

  constructor(
    private readonly intentService: IntentService,
    private readonly sceneReplyService: SceneReplyService,
    private readonly agentToolService: AgentToolService,
    private readonly aiService: AiService,
  ) {}

  getOrCreateGraph() {
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
      .addNode('intent_classifier', async (state) => {
        const cls = await this.intentService.classifyIntent(
          state.normalizedText,
        );
        const skillExecutionPlan = this.intentService.buildExecutionPlan(cls);
        return updateStateWithTrace(
          state,
          {
            intent: skillExecutionPlan.primarySkill.intent,
            confidence: skillExecutionPlan.primarySkill.confidence,
            params: skillExecutionPlan.primarySkill.parameters,
            skillExecutionPlan,
            route: this.intentService.resolveRoute(
              skillExecutionPlan.primarySkill.intent,
              skillExecutionPlan.primarySkill.confidence,
            ),
          },
          'intent_classifier',
        );
      })
      .addNode('planner_node', async (state) => {
        const responseText =
          await this.sceneReplyService.generateSceneUserReply(state, {
            sceneLabel: '任务规划（SCENE_PLAN）',
            contextItems: [
              `规划目标摘要：${state.params ? JSON.stringify(state.params) : '新任务'}`,
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
      .addNode('sync_node', async (state) => {
        const channel = state.userInput.channel?.trim();
        const responseText =
          await this.sceneReplyService.generateSceneUserReply(state, {
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
      .addNode('doc_node', async (state) => {
        const actionInstruction =
          this.agentToolService.buildActionInstructionFromSkillPlan(
            state.skillExecutionPlan,
            state.normalizedText,
            { lastDocId: state.userInput.lastDocId },
          );
        const skillId = state.skillExecutionPlan?.primarySkill.skillId;
        const isAppend = actionInstruction.type === 'LARK_DOC_APPEND';
        const responseText =
          await this.sceneReplyService.generateSceneUserReply(state, {
            sceneLabel: '文档协作（SCENE_DOC）',
            contextItems: isAppend
              ? [
                  skillId ? `命中技能：${skillId}` : '文档类协作流程。',
                  '用户请求为在已有云文档中追加内容；系统将在下游向该文档写入，并回传可访问链接（由动作结果生成，非本段文案虚构）。',
                ]
              : [
                  skillId ? `命中技能：${skillId}` : '文档类协作流程。',
                  '系统此时仅进入后台文档正文生成阶段；只有正文生成成功后，才会创建飞书文档并回传链接。',
                ],
            constraints: isAppend
              ? [
                  '明确说明：内容会追加到用户当前会话中最近使用的云文档，而不是新建另一篇；不得写出具体 URL 或文档 ID，除非用户原文已提供。',
                  '不要承诺「已读取全文」等需要实际拉取文档才成立的结果，除非用户已提供原文。',
                ]
              : [
                  '明确告知用户：正在生成文档正文，完成后会回传飞书文档链接；这条回复不代表文档已经创建。',
                  '不得写出具体 URL 或文档 ID，除非用户原文已提供。',
                  '不要承诺超出「进入后台生成并在完成后回传结果」以外的业务结果。',
                ],
          });
        const response = buildResponse(responseText, actionInstruction);
        return updateStateWithTrace(state, response, 'doc_node');
      })
      .addNode('present_node', async (state) => {
        const actionInstruction =
          this.agentToolService.buildActionInstructionFromSkillPlan(
            state.skillExecutionPlan,
            state.normalizedText,
          );
        const responseText =
          await this.sceneReplyService.generateSceneUserReply(state, {
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
        const responseText =
          await this.sceneReplyService.generateSceneUserReply(state, {
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
}
