import { Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, trace as otelTrace } from '@opentelemetry/api';
import { SessionService } from './session/session.service';
import { Optional } from '@nestjs/common';
import { AgentGraphService } from './agent-graph.service';
import {
  AgentRunInput,
  AgentRunResult,
  PersonaProfile,
  SkillExecutionPlan,
  ActionInstruction,
  IntentType,
} from './agent.types';
import { AiService } from '../ai/ai.service';
import { AgentToolService } from './tool/agent-tool.service';
import { IntentRoutingService } from './intent/intent-routing.service';
import { CacheService } from './cache/cache.service';
import { IntentService } from './intent/intent.service';
import { SceneReplyService } from './scene-reply.service';
import { checkRateLimit } from '../common/agent.utils';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  // 简单 persona 定义（可继续抽出）
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
    @Optional() private readonly agentGraphService?: AgentGraphService,
  ) {}

  private getIntentService() {
    return new IntentService(this.cacheService, this.intentRoutingService);
  }

  private readonly tracer = otelTrace.getTracer('agent-service');
  private readonly rateLimitWindow = 1000; // 1秒窗口
  private readonly rateLimitMax = 5; // 每窗口最大请求数
  private readonly concurrentLimit = 10; // 最大并发数
  private readonly requestTimestamps = new Map<string, number[]>(); // 用户请求时间戳
  private readonly activeRequests = new Set<string>(); // 活跃请求ID

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const userId = input.userId || 'anonymous';
    const requestId = `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

    this.activeRequests.add(requestId);

    try {
      return await this.tracer.startActiveSpan('agent.run', async (span) => {
        try {
          span.setAttribute('user.id', userId);
          span.setAttribute('input.text', input.text.substring(0, 100));

          const sessionHistory = this.sessionService.getSessionHistory(
            userId,
            10,
          );
          this.sessionService.addMessage(userId, 'user', input.text);

          const graph = (
            this.agentGraphService
              ? this.agentGraphService
              : new AgentGraphService(
                  this.getIntentService(),
                  new SceneReplyService(this.aiService),
                  this.agentToolService,
                  this.aiService,
                )
          ).getOrCreateGraph();

          const initialState: {
            userInput: AgentRunInput;
            normalizedText: string;
            intent: string;
            confidence: number;
            params: Record<string, unknown>;
            skillExecutionPlan: SkillExecutionPlan | undefined;
            persona: PersonaProfile;
            route: string;
            response: string;
            actionInstruction: ActionInstruction;
            trace: string[];
            sessionHistory: Array<{
              role: 'user' | 'assistant';
              content: string;
              timestamp: number;
            }>;
          } = {
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

          const result = (await graph.invoke(initialState)) as {
            intent: string;
            confidence: number;
            response?: string;
            actionInstruction?: ActionInstruction;
            skillExecutionPlan?: SkillExecutionPlan;
            trace?: string[];
          };

          this.sessionService.addMessage(
            userId,
            'assistant',
            result.response || '任务已接收，正在处理中...',
          );

          span.setAttribute('result.intent', result.intent);
          span.setAttribute('result.confidence', result.confidence);
          span.setAttribute(
            'result.response',
            (result.response || '').substring(0, 100),
          );

          const out: AgentRunResult = {
            intent: result.intent as IntentType,
            confidence: result.confidence,
            response: result.response || '任务已接收，正在处理中...',
            actionInstruction: result.actionInstruction,
            skillExecutionPlan: result.skillExecutionPlan,
            trace: result.trace || [],
          };

          return out;
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
      this.activeRequests.delete(requestId);
    }
  }

  private checkRateLimit(userId: string): boolean {
    return checkRateLimit(
      userId,
      this.requestTimestamps,
      this.rateLimitWindow,
      this.rateLimitMax,
    );
  }

  // Backwards-compatible delegate for tests: classifyIntent
  async classifyIntent(text: string) {
    const svc = this.getIntentService();
    return svc.classifyIntent(text);
  }
}
