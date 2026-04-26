import { Injectable, Logger } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';
import { AgentToolService } from './agent-tool.service';
import { SessionService } from './session.service';
import { CacheService } from './cache.service';
import {
  ActionInstruction,
  AgentRunInput,
  AgentRunResult,
  IntentType,
  PersonaProfile,
} from './agent.types';
import { AgentUtils } from './agent.utils';

// 条件导入 OpenTelemetry
let trace: any;
try {
  trace = require('@opentelemetry/api').trace;
} catch (error) {
  // OpenTelemetry 不可用时，使用空实现
  trace = {
    getTracer: () => ({
      startActiveSpan: (name: string, fn: any) =>
        fn({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    }),
  };
}

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
    .record(z.string(), z.unknown())
    .optional()
    .describe('提取出的关键参数，如 docTitle, targetDevice 等'),
});

export type IntentClassification = z.infer<typeof IntentSchema>;

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
  sessionHistory: Annotation<
    Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
    }>
  >,
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

  constructor(
    private readonly aiService: AiService,
    private readonly agentToolService: AgentToolService,
    private readonly sessionService: SessionService,
    private readonly cacheService: CacheService,
  ) {}

  private readonly tracer = trace.getTracer('agent-service');
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
      return this.tracer.startActiveSpan('agent.run', async (span) => {
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
            trace: result.trace,
          };
        } catch (error) {
          span.setStatus({ code: 2, message: (error as Error).message });
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
    const now = Date.now();
    let timestamps = this.requestTimestamps.get(userId) || [];

    // 过滤出窗口内的请求
    timestamps = timestamps.filter(
      (timestamp) => now - timestamp < this.rateLimitWindow,
    );

    // 检查是否超过限制
    if (timestamps.length >= this.rateLimitMax) {
      this.requestTimestamps.set(userId, timestamps);
      return false;
    }

    // 添加当前请求时间戳
    timestamps.push(now);
    this.requestTimestamps.set(userId, timestamps);

    return true;
  }

  private getOrCreateGraph() {
    if (this.compiledGraph) return this.compiledGraph;

    const graph = new StateGraph(AgentGraphState)
      .addNode('normalize_input', (state) =>
        AgentUtils.updateStateWithTrace(
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
        return AgentUtils.updateStateWithTrace(
          state,
          {
            intent: cls.intent,
            confidence: cls.confidence,
            params: cls.parameters,
            route: this.resolveRoute(cls.intent as IntentType, cls.confidence),
          },
          'intent_classifier',
        );
      })
      // 场景 B: 任务规划节点
      .addNode('planner_node', async (state) => {
        const response = AgentUtils.buildResponse(
          `[场景B: 任务规划] 我已理解您的意图：${state.params?.goal || '新任务'}。正在为您拆解步骤...`,
        );
        return AgentUtils.updateStateWithTrace(state, response, 'planner_node');
      })
      // 场景 E: 多端同步节点
      .addNode('sync_node', async (state) => {
        const response = AgentUtils.buildResponse(
          `[场景E: 多端同步] 正在将数据从 ${state.userInput.channel || '未知设备'} 同步至另一端...`,
        );
        return AgentUtils.updateStateWithTrace(state, response, 'sync_node');
      })
      // 场景 C: 文档节点
      .addNode('doc_node', async (state) => {
        const actionInstruction = this.agentToolService.buildActionInstruction(
          'SCENE_DOC',
          state.params,
          state.normalizedText,
        );
        const response = AgentUtils.buildResponse(
          '已识别为文档协作请求，我会创建文档并在会话中回传链接，随后可继续生成演示文稿或写入画布。',
          actionInstruction,
        );
        return AgentUtils.updateStateWithTrace(state, response, 'doc_node');
      })
      // 场景 D: 演示/画布节点
      .addNode('present_node', async (state) => {
        const actionInstruction = this.agentToolService.buildActionInstruction(
          'SCENE_PRESENT',
          state.params,
          state.normalizedText,
        );
        const response = AgentUtils.buildResponse(
          '已识别为演示/画布请求，我会串联创建文档与演示材料，并按参数写入自由画布。',
          actionInstruction,
        );
        return AgentUtils.updateStateWithTrace(state, response, 'present_node');
      })
      .addNode('clarify_node', async (state) => {
        const response = AgentUtils.buildResponse(
          '我理解到你可能在发起协作任务。请补充：要创建文档、演示文稿，还是要向已有自由画布追加内容？',
        );
        return AgentUtils.updateStateWithTrace(state, response, 'clarify_node');
      })
      // 通用回复节点
      .addNode('general_chat', async (state) => {
        const responseText = await this.aiService.chat(
          `作为${state.persona.name}，回答：${state.normalizedText}`,
        );
        const response = AgentUtils.buildResponse(responseText);
        return AgentUtils.updateStateWithTrace(state, response, 'general_chat');
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

    const systemPrompt = `你是一个多端协同办公助手，名字叫zeno。
    意图分发规则：
    1. SCENE_PLAN: 涉及任务规划、方案拆解。
    2. SCENE_DOC: 涉及文档编写、内容编辑。
    3. SCENE_PRESENT: 涉及PPT、流程图生成。
    4. SCENE_SYNC: 涉及跨端同步、设备状态切换。
    5. SCENE_DELIVERY: 涉及总结归档。
    6. AGENT_IDENTITY: 询问你是谁。
    7. SAFE_REFUSAL: 安全拒答。
    8. CLARIFY: 意图模糊需追问。
    9. CHITCHAT: 基础闲聊。
    输出要求：只返回一个JSON对象，格式为 {"intent":"...","confidence":0-1,"reason":"...","parameters":{}}
    不要返回其他任何内容，确保是严格的JSON格式。`;

    const prompt = `${systemPrompt}\n用户输入：${text}`;
    const response = await this.aiService.chat(prompt);

    try {
      const parsed = JSON.parse(response);
      const result = IntentSchema.parse(parsed);

      // 缓存结果
      this.cacheService.set(cacheKey, result, this.cacheExpiry);
      this.logger.debug(`缓存意图分类结果: ${cacheKey}`);

      return result;
    } catch (error) {
      this.logger.warn(
        `意图分类解析失败，降级到兜底逻辑: ${(error as Error).message}`,
      );
      const fallbackResult = {
        intent: 'CLARIFY' as IntentType,
        confidence: 0.5,
        reason: '分类失败',
        parameters: {},
      };

      // 缓存兜底结果
      this.cacheService.set(cacheKey, fallbackResult, this.cacheExpiry / 2); // 兜底结果缓存时间减半

      return fallbackResult;
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
}
