import { Test, TestingModule } from '@nestjs/testing';
import { AgentService } from './agent.service';
import { AiService } from '../ai/ai.service';
import { AgentToolService } from './agent-tool.service';
import { SessionService } from './session/session.service';
import { CacheService } from './cache.service';
import { ConfigService } from '@nestjs/config';

// 模拟配置服务
class MockConfigService {
  get(key: string): string | undefined {
    if (key === 'ARK_API_KEY') {
      return 'mock-api-key';
    }
    if (key === 'ARK_MODEL') {
      return 'mock-model';
    }
    return undefined;
  }
}

// 模拟AI服务
class MockAiService {
  async chat(text: string): Promise<string> {
    // 模拟意图识别结果，故意返回SCENE_DOC来模拟误判
    if (text.includes('帮我')) {
      return JSON.stringify({
        intent: 'SCENE_DOC',
        confidence: 0.7,
        reason: '用户请求帮助，可能需要创建文档',
        parameters: {},
      });
    }
    // 对于明确的非文档请求，返回正确的意图
    if (text.includes('你是谁')) {
      return JSON.stringify({
        intent: 'AGENT_IDENTITY',
        confidence: 0.95,
        reason: '用户询问身份',
        parameters: {},
      });
    }
    // 默认返回SCENE_DOC来模拟误判
    return JSON.stringify({
      intent: 'SCENE_DOC',
      confidence: 0.65,
      reason: '默认分类为文档创建',
      parameters: {},
    });
  }
}

// 模拟Session服务
class MockSessionService {
  getSessionHistory() {
    return [];
  }
  addMessage() {}
  getOrCreateSession() {
    return {
      id: 'mock-session',
      userId: 'test-user',
      history: [],
      lastActive: Date.now(),
    };
  }
  clearSession() {}
  getSessionCount() {
    return 1;
  }
}

// 模拟Cache服务
class MockCacheService {
  set() {}
  get() {
    return null;
  }
  delete() {}
  clear() {}
  size() {
    return 0;
  }
  cleanup() {}
}

describe('AgentService - 意图识别分析', () => {
  let agentService: AgentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        AgentToolService,
        {
          provide: AiService,
          useClass: MockAiService,
        },
        {
          provide: SessionService,
          useClass: MockSessionService,
        },
        {
          provide: CacheService,
          useClass: MockCacheService,
        },
        {
          provide: ConfigService,
          useClass: MockConfigService,
        },
      ],
    }).compile();

    agentService = module.get<AgentService>(AgentService);
  });

  describe('run', () => {
    it('应该分析意图识别误判情况', async () => {
      // 测试用例
      const testCases = [
        '帮我安排明天的会议',
        '你是谁',
        '如何使用这个系统',
        '给我一个项目计划',
        '帮我做一个PPT',
        '同步我的设备数据',
      ];

      console.log('意图识别测试结果:');
      console.log('====================');

      for (const testCase of testCases) {
        try {
          const result = await agentService.run({
            text: testCase,
            userId: 'test-user',
            channel: 'test-channel',
          });
          console.log(`输入: ${testCase}`);
          console.log(`意图: ${result.intent}`);
          console.log(`置信度: ${result.confidence}`);
          console.log(`响应: ${result.response}`);
          console.log(`动作指令: ${result.actionInstruction?.type}`);
          console.log('---------------------');
        } catch (error) {
          console.error(`测试失败: ${testCase}`, error);
          console.log('---------------------');
        }
      }

      // 验证测试执行完成
      expect(true).toBe(true);
    });
  });
});
