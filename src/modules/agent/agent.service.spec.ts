import { Test } from '@nestjs/testing';
import { AgentService } from './agent.service';
import { AiService } from '../ai/ai.service';

describe('AgentService', () => {
  it('should return identity response when user asks identity', async () => {
    const aiChatMock = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: AiService,
          useValue: {
            chat: aiChatMock,
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(AgentService);
    const result = await service.run({ text: '你是谁？' });

    expect(result.intent).toBe('agent_identity');
    expect(result.response).toContain('我是 Zeno');
    expect(aiChatMock).not.toHaveBeenCalled();
  });

  it('should ask for clarification when classifier returns unknown with low confidence', async () => {
    const aiChatMock = jest.fn().mockResolvedValueOnce(
      JSON.stringify({
        intent: 'unknown',
        confidence: 0.4,
        reason: '信息不足',
      }),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: AiService,
          useValue: {
            chat: aiChatMock,
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(AgentService);
    const result = await service.run({ text: '这个事情你看着办' });

    expect(result.intent).toBe('unknown');
    expect(result.response).toContain('你是希望我');
    expect(aiChatMock).toHaveBeenCalledTimes(1);
  });

  it('should generate chat response when intent is qa', async () => {
    const aiChatMock = jest
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ intent: 'qa', confidence: 0.9, reason: '问答' }),
      )
      .mockResolvedValueOnce(
        '结论：这是一个问答请求。步骤：先明确目标，再执行。',
      );

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: AiService,
          useValue: {
            chat: aiChatMock,
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(AgentService);
    const result = await service.run({
      text: '怎么把接口性能优化到 200ms 内？',
    });

    expect(result.intent).toBe('qa');
    expect(result.response).toContain('结论');
    expect(aiChatMock).toHaveBeenCalledTimes(2);
  });
});
