import { IntentRoutingService } from './intent-routing.service';
import { AiService } from '../../ai/ai.service';

describe('IntentRoutingService', () => {
  let service: IntentRoutingService;
  let aiService: jest.Mocked<AiService>;

  beforeEach(() => {
    aiService = {
      chat: jest.fn(),
    } as any;
    service = new IntentRoutingService(aiService);
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
});
