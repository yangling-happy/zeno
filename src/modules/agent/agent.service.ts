import { Injectable, Logger } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import {
  ActionInstruction,
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
    .record(z.string(), z.any())
    .optional()
    .describe('提取出的关键参数，如 docTitle, targetDevice 等'),
});

const AgentGraphState = Annotation.Root({
  userInput: Annotation<AgentRunInput>,
  normalizedText: Annotation<string>,
  intent: Annotation<IntentType>,
  confidence: Annotation<number>,
  params: Annotation<z.infer<typeof IntentSchema>['parameters']>,
  persona: Annotation<PersonaProfile>,
  route: Annotation<
    'plan' | 'sync' | 'doc' | 'present' | 'chat' | 'end' | 'clarify'
  >,
  response: Annotation<string>,
  actionInstruction: Annotation<ActionInstruction | undefined>,
  trace: Annotation<string[]>,
});

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
      actionInstruction: { type: 'NONE' },
      trace: [],
    };

    const result = await graph.invoke(initialState);
    return {
      intent: result.intent,
      confidence: result.confidence,
      response: result.response || '任务已接收，正在处理中...',
      actionInstruction: result.actionInstruction,
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
          actionInstruction: { type: 'NONE' as const },
          trace: [...state.trace, 'sync_node'],
        };
      })
      // 场景 C: 文档节点
      .addNode('doc_node', async (state) => {
        const actionInstruction = this.buildActionInstruction(
          'SCENE_DOC',
          state.params,
          state.normalizedText,
        );
        return {
          response:
            '已识别为文档协作请求，我会创建文档并在会话中回传链接，随后可继续生成演示文稿或写入画布。',
          actionInstruction,
          trace: [...state.trace, 'doc_node'],
        };
      })
      // 场景 D: 演示/画布节点
      .addNode('present_node', async (state) => {
        const actionInstruction = this.buildActionInstruction(
          'SCENE_PRESENT',
          state.params,
          state.normalizedText,
        );
        return {
          response:
            '已识别为演示/画布请求，我会串联创建文档与演示材料，并按参数写入自由画布。',
          actionInstruction,
          trace: [...state.trace, 'present_node'],
        };
      })
      .addNode('clarify_node', async (state) => {
        return {
          response:
            '我理解到你可能在发起协作任务。请补充：要创建文档、演示文稿，还是要向已有自由画布追加内容？',
          actionInstruction: { type: 'NONE' as const },
          trace: [...state.trace, 'clarify_node'],
        };
      })
      // 通用回复节点
      .addNode('general_chat', async (state) => {
        const response = await this.aiService.chat(
          `作为${state.persona.name}，回答：${state.normalizedText}`,
        );
        return {
          response,
          actionInstruction: { type: 'NONE' as const },
          trace: [...state.trace, 'general_chat'],
        };
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

  private async classifyIntent(text: string) {
    const systemPrompt = `你是一个多端协同办公助手，名字叫zeno。
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
  ): 'plan' | 'sync' | 'doc' | 'present' | 'chat' | 'end' | 'clarify' {
    if (confidence < 0.6) return 'clarify';
    if (intent === 'SCENE_PLAN') return 'plan';
    if (intent === 'SCENE_SYNC') return 'sync';
    if (intent === 'SCENE_DOC') return 'doc';
    if (intent === 'SCENE_PRESENT') return 'present';
    return 'chat';
  }

  private buildActionInstruction(
    intent: IntentType,
    params: z.infer<typeof IntentSchema>['parameters'] | undefined,
    normalizedText: string,
  ): ActionInstruction {
    const docTitle =
      typeof params?.docTitle === 'string' && params.docTitle.trim().length > 0
        ? params.docTitle.trim()
        : `Zeno 文档-${new Date().toLocaleString('zh-CN')}`;

    const presentTitle =
      typeof params?.presentTitle === 'string' &&
      params.presentTitle.trim().length > 0
        ? params.presentTitle.trim()
        : `Zeno 演示-${new Date().toLocaleString('zh-CN')}`;

    if (intent === 'SCENE_DOC') {
      return {
        type: 'LARK_DOC_CREATE',
        params: {
          title: docTitle,
          summary:
            typeof params?.summary === 'string'
              ? params.summary
              : normalizedText.slice(0, 120),
        },
      };
    }

    if (intent === 'SCENE_PRESENT') {
      if (
        typeof params?.whiteboardId === 'string' &&
        params.whiteboardId.trim().length > 0
      ) {
        return {
          type: 'LARK_WHITEBOARD_APPEND',
          params: {
            whiteboardId: params.whiteboardId.trim(),
            text:
              typeof params?.summary === 'string'
                ? params.summary
                : normalizedText.slice(0, 200),
          },
        };
      }

      return {
        type: 'LARK_DOC_PRESENT_LINK',
        params: {
          title: presentTitle,
          summary:
            typeof params?.summary === 'string'
              ? params.summary
              : normalizedText.slice(0, 120),
        },
      };
    }

    return { type: 'NONE' };
  }
}
