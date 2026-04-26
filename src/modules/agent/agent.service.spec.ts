import { Test } from '@nestjs/testing';
import { AgentService } from './agent.service';
import { AiService } from '../ai/ai.service';

describe('AgentService', () => {
  it('should route doc intent to actionable instruction', async () => {
    const aiChatMock = jest.fn().mockResolvedValueOnce(
      JSON.stringify({
        intent: 'SCENE_DOC',
        confidence: 0.95,
        reason: '用户要求创建文档',
        parameters: {
          docTitle: '项目周报',
          summary: '本周交付与风险列表',
        },
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
    const result = await service.run({ text: '帮我创建一份项目周报文档' });

    expect(result.intent).toBe('SCENE_DOC');
    expect(result.actionInstruction?.type).toBe('LARK_DOC_CREATE');
    expect(result.response).toContain('文档协作');
    expect(aiChatMock).toHaveBeenCalledTimes(1);
  });

  it('should route present intent to whiteboard append when whiteboard id exists', async () => {
    const aiChatMock = jest.fn().mockResolvedValueOnce(
      JSON.stringify({
        intent: 'SCENE_PRESENT',
        confidence: 0.91,
        reason: '用户要求在白板补充内容',
        parameters: {
          whiteboardId: 'wb_test_001',
          summary: '请补充架构图说明',
        },
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
    const result = await service.run({ text: '把这段需求追加到自由画布' });

    expect(result.intent).toBe('SCENE_PRESENT');
    expect(result.actionInstruction?.type).toBe('LARK_WHITEBOARD_APPEND');
    expect(result.response).toContain('演示/画布');
    expect(aiChatMock).toHaveBeenCalledTimes(1);
  });

  it('should ask for clarification when confidence is low', async () => {
    const aiChatMock = jest
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          intent: 'SCENE_DOC',
          confidence: 0.3,
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
    const result = await service.run({
      text: '这个你先处理一下',
    });

    expect(result.intent).toBe('SCENE_DOC');
    expect(result.response).toContain('请补充');
    expect(result.actionInstruction?.type).toBe('NONE');
    expect(aiChatMock).toHaveBeenCalledTimes(1);
  });
});
