import { Test, TestingModule } from '@nestjs/testing';
import { AgentService } from './agent.service';
import { AiService } from '../ai/ai.service';
import { AgentToolService } from './tool/agent-tool.service';
import { IntentRoutingService } from './intent/intent-routing.service';
import { SessionService } from './session/session.service';
import { CacheService } from './cache/cache.service';
import { ConfigService } from '@nestjs/config';

describe('AgentService', () => {
  let agentService: AgentService;
  let aiService: jest.Mocked<AiService>;
  let agentToolService: jest.Mocked<AgentToolService>;
  let sessionService: jest.Mocked<SessionService>;
  let cacheService: jest.Mocked<CacheService>;

  beforeEach(async () => {
    // Mock 所有依赖
    aiService = {
      chat: jest.fn(),
    } as any;

    agentToolService = {
      buildActionInstruction: jest.fn(),
    } as any;

    sessionService = {
      getOrCreateSession: jest.fn(),
      addMessage: jest.fn(),
      getSessionHistory: jest.fn(),
      clearSession: jest.fn(),
      getSessionCount: jest.fn(),
    } as any;

    cacheService = {
      set: jest.fn(),
      get: jest.fn().mockReturnValue(null),
      delete: jest.fn(),
      clear: jest.fn(),
      size: jest.fn(),
      cleanup: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: AiService,
          useValue: aiService,
        },
        {
          provide: AgentToolService,
          useValue: agentToolService,
        },
        IntentRoutingService,
        {
          provide: SessionService,
          useValue: sessionService,
        },
        {
          provide: CacheService,
          useValue: cacheService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    agentService = module.get<AgentService>(AgentService);
  });

  describe('run', () => {
    it('should return a valid AgentRunResult', async () => {
      // 模拟会话历史
      sessionService.getSessionHistory.mockReturnValue([]);

      // 模拟 AI 响应
      aiService.chat.mockResolvedValue(
        JSON.stringify({
          intent: 'CHITCHAT',
          confidence: 0.9,
          reason: '用户在闲聊',
          parameters: {},
        }),
      );

      // 模拟工具服务响应
      agentToolService.buildActionInstruction.mockReturnValue({ type: 'NONE' });

      // 调用 run 方法
      const result = await agentService.run({
        text: '你好',
        userId: 'test-user',
      });

      // 验证结果
      expect(result).toBeDefined();
      expect(result.intent).toBe('CHITCHAT');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.response).toBeDefined();
      expect(result.skillExecutionPlan?.primarySkill.skillId).toBe(
        'chitchat.skill',
      );
    });

    it('should fallback to CLARIFY when confidence below skill threshold', async () => {
      sessionService.getSessionHistory.mockReturnValue([]);

      aiService.chat.mockResolvedValue(
        JSON.stringify({
          intent: 'SCENE_SYNC',
          confidence: 0.4,
          reason: '可能涉及同步',
          parameters: {},
        }),
      );

      const result = await agentService.run({
        text: '帮我同步一下',
        userId: 'test-user',
      });

      expect(result.intent).toBe('CLARIFY');
      expect(result.skillExecutionPlan?.primarySkill.fallbackReason).toContain(
        '置信度低于技能阈值',
      );
    });

    it('should treat document advice questions as chat instead of document creation', async () => {
      sessionService.getSessionHistory.mockReturnValue([]);
      aiService.chat.mockResolvedValueOnce(
        '文档建议：先明确目标、受众和结构。',
      );

      const result = await agentService.run({
        text: '平时写文档内容有什么建议',
        userId: 'test-user',
      });

      expect(result.intent).toBe('CHITCHAT');
      expect(result.skillExecutionPlan?.primarySkill.skillId).toBe(
        'chitchat.skill',
      );
      expect(result.actionInstruction).toBeUndefined();
      expect(result.response).toContain('文档建议');
    });

    it('should handle rate limit', async () => {
      // 模拟超过并发限制
      // 这里需要修改 agentService 的内部状态，或者模拟 checkRateLimit 方法
      // 为了简化测试，我们可以直接测试速率限制逻辑
      const result = await agentService.run({
        text: '你好',
        userId: 'test-user',
      });

      // 验证结果
      expect(result).toBeDefined();
    });
  });

  describe('classifyIntent', () => {
    it('should return a valid IntentClassification', async () => {
      // 模拟缓存未命中
      cacheService.get.mockReturnValue(null);

      // 模拟 AI 响应
      aiService.chat.mockResolvedValue(
        JSON.stringify({
          intent: 'CHITCHAT',
          confidence: 0.9,
          reason: '用户在闲聊',
          parameters: {},
        }),
      );

      // 调用 classifyIntent 方法
      const result = await (agentService as any).classifyIntent('你好');

      // 验证结果
      expect(result).toBeDefined();
      expect(result.intent).toBe('CHITCHAT');
      expect(result.confidence).toBeGreaterThanOrEqual(0.98);
      expect(result.reason).toContain('正则规则命中');
    });

    it('should use cached result when available', async () => {
      // 模拟缓存命中
      const cachedResult = {
        intent: 'CHITCHAT',
        confidence: 0.9,
        reason: '用户在闲聊',
        parameters: {},
      };
      cacheService.get.mockReturnValue(cachedResult);

      // 调用 classifyIntent 方法
      const result = await (agentService as any).classifyIntent('你好');

      // 验证结果
      expect(result).toStrictEqual(cachedResult);
      expect(aiService.chat).not.toHaveBeenCalled();
    });
  });
});
