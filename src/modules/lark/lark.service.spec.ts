import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentService } from '../agent/agent.service';
import { InstructionDetectorService } from '../common/instruction-detector.service';
import { LarkActionExecutorService } from './lark-action-executor.service';
import { LarkBroadService } from './broad/lark-broad.service';
import { LarkDocService } from './doc/lark-doc.service';
import { LarkReplyService } from './lark-reply.service';
import { LarkService } from './lark.service';
import { LarkSlidesService } from './slides/lark-slides.service';
import {
  LarkMessageJobData,
  LarkMessageQueue,
} from '../queue/lark-message.queue';
import { MemoryService } from '../memory/memory.service';
import { SessionService } from '../agent/session/session.service';

const memoryServiceMock = {
  addConversationTurn: jest.fn().mockResolvedValue(1),
  shouldTriggerSummarization: jest.fn().mockResolvedValue(false),
  getRecentConversations: jest.fn().mockResolvedValue([]),
  extractAndStoreFacts: jest.fn().mockResolvedValue([]),
  buildContextBackground: jest.fn().mockResolvedValue({
    recentConversations: [],
    retrievedFacts: [],
    conversationTurnCount: 0,
  }),
};

let registeredHandlers: Record<
  string,
  (...args: any[]) => void | Promise<void>
> = {};
const startMock = jest.fn().mockResolvedValue(undefined);
const stopMock = jest.fn().mockResolvedValue(undefined);
const replyMock = jest.fn().mockResolvedValue({ code: 0 });
const createMock = jest.fn().mockResolvedValue({ code: 0 });
const docCreateMock = jest.fn().mockResolvedValue({
  data: { document: { document_id: 'doc_test_123' } },
});
const docBlockCreateMock = jest.fn().mockResolvedValue({
  data: { children: [{ block_id: 'block_test_123' }] },
});
const flushPromises = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

const larkMessageQueueTestDouble = {
  enqueueMessage: jest.fn(),
};

function wireImmediateQueueProcessing(service: LarkService) {
  larkMessageQueueTestDouble.enqueueMessage.mockImplementation(
    async (data: LarkMessageJobData) => {
      await service.handleQueuedMessage(data);
      const jobId = data.message.message_id || `lark-${data.receivedAt}`;
      return { jobId, wasAdded: true };
    },
  );
}

jest.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      im: {
        message: {
          create: createMock,
          reply: replyMock,
        },
      },
      docx: {
        v1: {
          document: {
            create: docCreateMock,
          },
          documentBlockChildren: {
            create: docBlockCreateMock,
          },
        },
      },
    })),
    WSClient: jest.fn().mockImplementation(() => ({
      start: startMock,
      stop: stopMock,
    })),
    EventDispatcher: jest.fn().mockImplementation(() => ({
      register: (
        handlers: Record<string, (...args: any[]) => void | Promise<void>>,
      ) => {
        registeredHandlers = handlers;
        return {
          register: () => undefined,
        };
      },
    })),
  };
});

describe('LarkService', () => {
  beforeEach(() => {
    registeredHandlers = {};
    startMock.mockClear();
    stopMock.mockClear();
    replyMock.mockClear();
    createMock.mockClear();
    docCreateMock.mockClear();
    docBlockCreateMock.mockClear();
    larkMessageQueueTestDouble.enqueueMessage.mockReset();
    larkMessageQueueTestDouble.enqueueMessage.mockResolvedValue({
      jobId: 'mock-job-id',
      wasAdded: true,
    });
    jest.clearAllMocks();
  });

  it('should start ws client when module init with valid config', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        LarkActionExecutorService,
        LarkReplyService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              if (key === 'LARK_QUEUE_ACK_ENABLED') return 'false';
              return '';
            },
          },
        },
        {
          provide: AgentService,
          useValue: {
            run: jest.fn(),
          },
        },
        {
          provide: InstructionDetectorService,
          useValue: {
            isInstruction: jest.fn().mockResolvedValue(false),
            processInstruction: jest.fn().mockResolvedValue(''),
            generateDocumentMarkdown: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: MemoryService,
          useValue: memoryServiceMock,
        },
        {
          provide: SessionService,
          useValue: { addMessage: jest.fn() },
        },
        {
          provide: LarkDocService,
          useValue: {
            initClient: jest.fn(),
            createDocument: jest.fn(),
            appendMarkdownToDocument: jest.fn(),
          },
        },
        {
          provide: LarkSlidesService,
          useValue: {
            initClient: jest.fn(),
            createPresentation: jest.fn(),
          },
        },
        {
          provide: LarkBroadService,
          useValue: {
            initClient: jest.fn(),
            createDocumentWithBoard: jest.fn(),
            appendMarkdownToWhiteboard: jest.fn(),
          },
        },
        {
          provide: LarkMessageQueue,
          useValue: larkMessageQueueTestDouble,
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);
    service.onModuleInit();

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(registeredHandlers['im.message.receive_v1']).toBeDefined();
  });

  it('should process received message and reply via message_id', async () => {
    const agentRunMock = jest.fn().mockResolvedValue({
      intent: 'qa',
      confidence: 0.9,
      personaId: 'zeno',
      response: '豆包回复',
      trace: ['normalize_input', 'intent_classifier', 'chat_response'],
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        LarkActionExecutorService,
        LarkReplyService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              if (key === 'LARK_QUEUE_ACK_ENABLED') return 'false';
              return '';
            },
          },
        },
        {
          provide: AgentService,
          useValue: {
            run: agentRunMock,
          },
        },
        {
          provide: InstructionDetectorService,
          useValue: {
            isInstruction: jest.fn().mockResolvedValue(false),
            processInstruction: jest.fn().mockResolvedValue(''),
            generateDocumentMarkdown: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: MemoryService,
          useValue: memoryServiceMock,
        },
        {
          provide: SessionService,
          useValue: { addMessage: jest.fn() },
        },
        {
          provide: LarkDocService,
          useValue: {
            initClient: jest.fn(),
            createDocument: jest.fn().mockResolvedValue({
              documentId: 'doc_test_123',
              url: 'https://feishu.cn/docx/doc_test_123',
            }),
            appendMarkdownToDocument: jest.fn().mockResolvedValue({
              blockIds: ['block_test_123'],
              parentBlockId: 'doc_test_123',
            }),
          },
        },
        {
          provide: LarkSlidesService,
          useValue: {
            initClient: jest.fn(),
            createPresentation: jest.fn(),
          },
        },
        {
          provide: LarkBroadService,
          useValue: {
            initClient: jest.fn(),
            createDocumentWithBoard: jest.fn(),
            appendMarkdownToWhiteboard: jest.fn(),
          },
        },
        {
          provide: LarkMessageQueue,
          useValue: larkMessageQueueTestDouble,
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);

    wireImmediateQueueProcessing(service);
    service.onModuleInit();
    registeredHandlers['im.message.receive_v1']({
      message: {
        content: JSON.stringify({ text: '你好' }),
        message_id: 'om_test_msg_id',
      },
    });
    await flushPromises();

    expect(agentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '你好',
        userId: 'anonymous',
        channel: 'lark',
        memoryContext: {
          recentConversations: [],
          retrievedFacts: [],
          conversationTurnCount: 0,
        },
      }),
    );
    expect(replyMock).toHaveBeenCalledWith({
      path: {
        message_id: 'om_test_msg_id',
      },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({
          config: {
            wide_screen_mode: true,
          },
          elements: [
            {
              tag: 'div',
              text: {
                content: '豆包回复',
                tag: 'lark_md',
              },
            },
          ],
        }),
      },
    });
  });

  it('should skip duplicated message with same message_id', async () => {
    const agentRunMock = jest.fn().mockResolvedValue({
      intent: 'qa',
      confidence: 0.9,
      personaId: 'zeno',
      response: '去重回复',
      trace: ['normalize_input', 'intent_classifier', 'chat_response'],
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        LarkActionExecutorService,
        LarkReplyService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              if (key === 'LARK_QUEUE_ACK_ENABLED') return 'false';
              return '';
            },
          },
        },
        {
          provide: AgentService,
          useValue: {
            run: agentRunMock,
          },
        },
        {
          provide: InstructionDetectorService,
          useValue: {
            isInstruction: jest.fn().mockResolvedValue(false),
            processInstruction: jest.fn().mockResolvedValue(''),
            generateDocumentMarkdown: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: MemoryService,
          useValue: memoryServiceMock,
        },
        {
          provide: SessionService,
          useValue: { addMessage: jest.fn() },
        },
        {
          provide: LarkDocService,
          useValue: {
            initClient: jest.fn(),
            createDocument: jest.fn(),
            appendMarkdownToDocument: jest.fn(),
          },
        },
        {
          provide: LarkSlidesService,
          useValue: {
            initClient: jest.fn(),
            createPresentation: jest.fn(),
          },
        },
        {
          provide: LarkBroadService,
          useValue: {
            initClient: jest.fn(),
            createDocumentWithBoard: jest.fn(),
            appendMarkdownToWhiteboard: jest.fn(),
          },
        },
        {
          provide: LarkMessageQueue,
          useValue: larkMessageQueueTestDouble,
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);

    wireImmediateQueueProcessing(service);
    service.onModuleInit();
    registeredHandlers['im.message.receive_v1']({
      message: {
        content: JSON.stringify({ text: '为什么会有两条？' }),
        message_id: 'om_duplicate_id',
      },
    });
    registeredHandlers['im.message.receive_v1']({
      message: {
        content: JSON.stringify({ text: '为什么会有两条？' }),
        message_id: 'om_duplicate_id',
      },
    });
    await flushPromises();

    expect(agentRunMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it('should not start ws when config is missing', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        LarkActionExecutorService,
        LarkReplyService,
        {
          provide: ConfigService,
          useValue: {
            get: () => '',
          },
        },
        {
          provide: AgentService,
          useValue: {
            run: jest.fn(),
          },
        },
        {
          provide: InstructionDetectorService,
          useValue: {
            isInstruction: jest.fn().mockResolvedValue(false),
            processInstruction: jest.fn().mockResolvedValue(''),
            generateDocumentMarkdown: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: MemoryService,
          useValue: memoryServiceMock,
        },
        {
          provide: SessionService,
          useValue: { addMessage: jest.fn() },
        },
        {
          provide: LarkDocService,
          useValue: {
            initClient: jest.fn(),
            createDocument: jest.fn(),
            appendMarkdownToDocument: jest.fn(),
          },
        },
        {
          provide: LarkSlidesService,
          useValue: {
            initClient: jest.fn(),
            createPresentation: jest.fn(),
          },
        },
        {
          provide: LarkBroadService,
          useValue: {
            initClient: jest.fn(),
            createDocumentWithBoard: jest.fn(),
            appendMarkdownToWhiteboard: jest.fn(),
          },
        },
        {
          provide: LarkMessageQueue,
          useValue: larkMessageQueueTestDouble,
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);
    service.onModuleInit();

    expect(startMock).not.toHaveBeenCalled();
  });

  it('should stop ws client on module destroy', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        LarkActionExecutorService,
        LarkReplyService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              if (key === 'LARK_QUEUE_ACK_ENABLED') return 'false';
              return '';
            },
          },
        },
        {
          provide: AgentService,
          useValue: {
            run: jest.fn(),
          },
        },
        {
          provide: InstructionDetectorService,
          useValue: {
            isInstruction: jest.fn().mockResolvedValue(false),
            processInstruction: jest.fn().mockResolvedValue(''),
            generateDocumentMarkdown: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: MemoryService,
          useValue: memoryServiceMock,
        },
        {
          provide: SessionService,
          useValue: { addMessage: jest.fn() },
        },
        {
          provide: LarkDocService,
          useValue: {
            initClient: jest.fn(),
            createDocument: jest.fn(),
            appendMarkdownToDocument: jest.fn(),
          },
        },
        {
          provide: LarkSlidesService,
          useValue: {
            initClient: jest.fn(),
            createPresentation: jest.fn(),
          },
        },
        {
          provide: LarkBroadService,
          useValue: {
            initClient: jest.fn(),
            createDocumentWithBoard: jest.fn(),
            appendMarkdownToWhiteboard: jest.fn(),
          },
        },
        {
          provide: LarkMessageQueue,
          useValue: larkMessageQueueTestDouble,
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);
    service.onModuleInit();
    await service.onModuleDestroy();

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('should include document url in reply when action is LARK_DOC_CREATE', async () => {
    const agentRunMock = jest.fn().mockResolvedValue({
      intent: 'SCENE_DOC',
      confidence: 0.98,
      response: '我正在为你生成文档正文，完成后会把飞书文档链接回给你。',
      trace: ['normalize_input', 'intent_classifier', 'doc_node'],
      actionInstruction: {
        type: 'LARK_DOC_CREATE',
        params: {
          title: '测试文档',
          summary: '测试摘要',
        },
      },
      skillExecutionPlan: {
        primarySkill: { skillId: 'documentation.skill' },
        secondarySkills: [],
      },
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        LarkActionExecutorService,
        LarkReplyService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              if (key === 'LARK_QUEUE_ACK_ENABLED') return 'false';
              return '';
            },
          },
        },
        {
          provide: AgentService,
          useValue: {
            run: agentRunMock,
          },
        },
        {
          provide: InstructionDetectorService,
          useValue: {
            isInstruction: jest.fn().mockResolvedValue(false),
            processInstruction: jest.fn().mockResolvedValue(''),
            generateDocumentMarkdown: jest
              .fn()
              .mockResolvedValue('# 测试文档\n\n测试摘要'),
          },
        },
        {
          provide: MemoryService,
          useValue: memoryServiceMock,
        },
        {
          provide: SessionService,
          useValue: { addMessage: jest.fn() },
        },
        {
          provide: LarkDocService,
          useValue: {
            initClient: jest.fn(),
            createDocument: jest.fn().mockResolvedValue({
              documentId: 'doc_test_123',
              url: 'https://feishu.cn/docx/doc_test_123',
            }),
            appendMarkdownToDocument: jest.fn().mockResolvedValue({
              blockIds: ['block_test_123'],
              parentBlockId: 'doc_test_123',
            }),
          },
        },
        {
          provide: LarkSlidesService,
          useValue: {
            initClient: jest.fn(),
            createPresentation: jest.fn(),
          },
        },
        {
          provide: LarkBroadService,
          useValue: {
            initClient: jest.fn(),
            createDocumentWithBoard: jest.fn(),
            appendMarkdownToWhiteboard: jest.fn(),
          },
        },
        {
          provide: LarkMessageQueue,
          useValue: larkMessageQueueTestDouble,
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);

    wireImmediateQueueProcessing(service);
    service.onModuleInit();
    registeredHandlers['im.message.receive_v1']({
      message: {
        content: JSON.stringify({ text: '生成文档' }),
        message_id: 'om_doc_create_test_id',
      },
    });
    await flushPromises();

    const larkDocService = moduleRef.get(LarkDocService);

    expect(larkDocService.createDocument).toHaveBeenCalledTimes(1);
    expect(larkDocService.appendMarkdownToDocument).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledTimes(2);

    const progressPayload = replyMock.mock.calls[0][0];
    expect(progressPayload.path.message_id).toBe('om_doc_create_test_id');
    expect(progressPayload.data.msg_type).toBe('interactive');
    const progressContent = JSON.parse(progressPayload.data.content) as {
      elements: Array<{
        text: {
          content: string;
        };
      }>;
    };
    expect(progressContent.elements[0].text.content).toContain('生成');

    const replyPayload = replyMock.mock.calls[1][0];
    expect(replyPayload.path.message_id).toBe('om_doc_create_test_id');
    expect(replyPayload.data.msg_type).toBe('interactive');

    const parsedContent = JSON.parse(replyPayload.data.content) as {
      elements: Array<{
        text: {
          content: string;
        };
      }>;
    };
    expect(parsedContent.elements[0].text.content).toContain(
      'https://feishu.cn/docx/doc_test_123',
    );
  });
});
