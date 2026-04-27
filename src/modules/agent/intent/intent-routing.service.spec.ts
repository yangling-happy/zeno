import { IntentRoutingService } from './intent-routing.service';
import { AiService } from '../../ai/ai.service';
import { IntentTransformerService } from './intent-transformer.service';

describe('IntentRoutingService', () => {
  let service: IntentRoutingService;
  let aiService: jest.Mocked<AiService>;
  let transformerService: jest.Mocked<IntentTransformerService>;

  beforeEach(() => {
    aiService = {
      chat: jest.fn(),
    } as any;

    transformerService = {
      isEnabled: jest.fn().mockReturnValue(false),
      similarity: jest.fn(),
    } as any;

    service = new IntentRoutingService(aiService, transformerService);
  });

  it('should short-circuit consultative questions to chat gate', async () => {
    const result = await service.route('平时写文档内容有什么建议');

    expect(result.source).toBe('gate');
    expect(result.classification.intent).toBe('CHITCHAT');
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('should use regex for clear document creation requests', async () => {
    const result = await service.route('帮我写一份会议纪要');

    expect(result.source).toBe('regex');
    expect(result.classification.intent).toBe('SCENE_DOC');
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('should use vector retrieval for semantically similar requests', async () => {
    const result = await service.route('把这段内容整理成正式材料');

    expect(result.source).toBe('vector');
    expect(result.classification.intent).toBe('SCENE_DOC');
    expect(result.classification.confidence).toBeGreaterThanOrEqual(0.82);
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('should fall back to llm for hard semantic cases', async () => {
    aiService.chat.mockResolvedValueOnce(
      JSON.stringify({
        intent: 'SCENE_PLAN',
        confidence: 0.91,
        reason: '用户请求的是复杂协作规划',
        parameters: {},
      }),
    );

    const result = await service.route('请协助处理这段复杂需求');

    expect(result.source).toBe('llm');
    expect(aiService.chat).toHaveBeenCalledTimes(1);
    expect(result.classification.intent).toBe('SCENE_PLAN');
    expect(result.classification.confidence).toBe(0.91);
  });

  it('should prioritize transformer retrieval when confidence is high', async () => {
    transformerService.isEnabled.mockReturnValue(true);
    transformerService.similarity.mockImplementation(
      async (_input: string, exemplar: string) => {
        if (exemplar.includes('帮我写一份会议纪要')) {
          return 0.93;
        }
        return 0.31;
      },
    );

    const result = await service.route('请帮我整理一份正式会议文稿');

    expect(result.source).toBe('transformer');
    expect(result.classification.intent).toBe('SCENE_DOC');
    expect(result.classification.confidence).toBe(0.93);
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('should degrade gracefully when transformer scoring fails', async () => {
    transformerService.isEnabled.mockReturnValue(true);
    transformerService.similarity.mockResolvedValue(null);

    const result = await service.route('把这段内容整理成正式材料');

    expect(['vector', 'llm']).toContain(result.source);
    expect(result.classification.intent).toBe('SCENE_DOC');
  });
});
