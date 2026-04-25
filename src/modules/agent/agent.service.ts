import { Injectable, Logger } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import {
  AgentRunInput,
  AgentRunResult,
  IntentType,
  PersonaProfile,
} from './agent.types';

// 1. 定义 Zod Schema 确保意图识别的精准度
const IntentSchema = z.object({
  intent: z.enum([
    'SCENE_PLAN',
    'SCENE_DOC',
    'SCENE_PRESENT',
    'SCENE_SYNC',
    'SCENE_DELIVERY',
    'AGENT_IDENTITY',
    'SAFE_REFUSAL',
    'CLARIFY',
    'CHITCHAT',
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe('选择该意图的理由'),
  parameters: z
    .record(z.string(),z.any())
    .optional()
    .describe('提取出的关键参数，如 docTitle, targetDevice 等'),
});

const AgentGraphState = Annotation.Root(
  {
    userInput: Annotation<AgentRunInput>,
    normalizedText: Annotation<string>,
    intent: Annotation<IntentType>,
    confidence: Annotation<number>,
    params: Annotation<z.infer<typeof IntentSchema>['parameters']>,
    persona: Annotation<PersonaProfile>,
    route: Annotation<'plan' | 'sync' | 'chat' | 'end' | 'clarify'>,
    response: Annotation<string>,
    trace: Annotation<string[]>,
  },
);

type GraphState = typeof AgentGraphState.State;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private compiledGraph: any = null;

  private readonly personas: Record<string, PersonaProfile> = {
    zeno: {
      id: 'zeno',
      name: 'Zeno',
      role: '跨端协同指挥官',
      tone: '专业、高效、具备行动力',
      styleRules: ['优先给出场景解决方案', '跨端操作需明确确认'],
      boundaries: ['不涉及用户隐私数据'],
    },
  };

  constructor(private readonly aiService: AiService) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const graph = this.getOrCreateGraph();
    const initialState: GraphState = {
      userInput: input,
      normalizedText: '',
      intent: 'CLARIFY',
      confidence: 0,
      params: {},
      persona: this.personas.zeno,
      route: 'clarify',
      response: '',
      trace: [],
    };

    const result = await graph.invoke(initialState);
    return {
      intent: result.intent,
      confidence: result.confidence,
      response: result.response || '任务已接收，正在处理中...',
      trace: result.trace,
    };
  }

  private getOrCreateGraph() {
    if (this.compiledGraph) return this.compiledGraph;

    const graph = new StateGraph(AgentGraphState)
      .addNode('normalize_input', (state) => ({
        normalizedText: state.userInput.text.trim(),
        trace: [...state.trace, 'normalize_input'],
      }))
      // 场景 A: 意图识别入口
      .addNode('intent_classifier', async (state) => {
        const cls = await this.classifyIntent(state.normalizedText);
        return {
          intent: cls.intent,
          confidence: cls.confidence,
          params: cls.parameters,
          route: this.resolveRoute(cls.intent as IntentType, cls.confidence),
          trace: [...state.trace, 'intent_classifier'],
        };
      })
      // 场景 B: 任务规划节点
      .addNode('planner_node', async (state) => {
        return {
          response: `[场景B: 任务规划] 我已理解您的意图：${state.params?.goal || '新任务'}。正在为您拆解步骤...`,
          trace: [...state.trace, 'planner_node'],
        };
      })
      // 场景 E: 多端同步节点
      .addNode('sync_node', async (state) => {
        return {
          response: `[场景E: 多端同步] 正在将数据从 ${state.userInput.channel || '未知设备'} 同步至另一端...`,
          trace: [...state.trace, 'sync_node'],
        };
      })
      // 通用回复节点
      .addNode('general_chat', async (state) => {
        const response = await this.aiService.chat(
          `作为${state.persona.name}，回答：${state.normalizedText}`,
        );
        return { response, trace: [...state.trace, 'general_chat'] };
      })
      .addEdge(START, 'normalize_input')
      .addEdge('normalize_input', 'intent_classifier')
      .addConditionalEdges('intent_classifier', (state) => state.route, {
        plan: 'planner_node',
        sync: 'sync_node',
        chat: 'general_chat',
        end: END,
      })
      .addEdge('planner_node', END)
      .addEdge('sync_node', END)
      .addEdge('general_chat', END);

    this.compiledGraph = graph.compile();
    return this.compiledGraph;
  }

  private async classifyIntent(text: string) {
    // 使用结构化输出，直接对标比赛场景
    const systemPrompt = `你是zeno,一个多端协同办公助手。
    意图分发规则：
    1. SCENE_PLAN: 涉及任务规划、方案拆解。
    2. SCENE_DOC: 涉及文档编写、内容编辑。
    3. SCENE_PRESENT: 涉及PPT、流程图生成。
    4. SCENE_SYNC: 涉及跨端同步、设备状态切换。
    5. SCENE_DELIVERY: 涉及总结归档。
    6. AGENT_IDENTITY: 询问你是谁。
    输出要求：只返回一个JSON对象，格式为 {"intent":"...","confidence":0-1,"reason":"...","parameters":{}}
    不要返回其他任何内容，确保是严格的JSON格式。`;

    const prompt = `${systemPrompt}\n用户输入：${text}`;
    const response = await this.aiService.chat(prompt);

    try {
      const parsed = JSON.parse(response);
      return IntentSchema.parse(parsed);
    } catch (error) {
      this.logger.warn(
        `意图分类解析失败，降级到兜底逻辑: ${(error as Error).message}`,
      );
      return {
        intent: 'CLARIFY',
        confidence: 0.5,
        reason: '分类失败',
        parameters: {},
      };
    }
  }

  private resolveRoute(
    intent: IntentType,
    confidence: number,
  ): 'plan' | 'sync' | 'chat' | 'end' | 'clarify' {
    if (confidence < 0.6) return 'chat';
    if (intent === 'SCENE_PLAN') return 'plan';
    if (intent === 'SCENE_SYNC') return 'sync';
    if (intent === 'SCENE_DOC' || intent === 'SCENE_PRESENT') return 'chat'; // 可扩展对应节点
    return 'chat';
  }
}
