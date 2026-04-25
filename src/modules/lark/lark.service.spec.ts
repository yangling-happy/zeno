import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { LarkService } from './lark.service';

let registeredHandlers: Record<
  string,
  (...args: any[]) => void | Promise<void>
> = {};
const startMock = jest.fn().mockResolvedValue(undefined);
const stopMock = jest.fn().mockResolvedValue(undefined);
const replyMock = jest.fn().mockResolvedValue({ code: 0 });
const flushPromises = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

jest.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      im: {
        message: {
          reply: replyMock,
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
    jest.clearAllMocks();
  });

  it('should start ws client when module init with valid config', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              return '';
            },
          },
        },
        {
          provide: AiService,
          useValue: {
            chat: jest.fn(),
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);
    service.onModuleInit();

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(registeredHandlers['im.message.receive_v1']).toBeDefined();
  });

  it('should process received message and reply via message_id', async () => {
    const aiChatMock = jest.fn().mockResolvedValue('豆包回复');

    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              return '';
            },
          },
        },
        {
          provide: AiService,
          useValue: {
            chat: aiChatMock,
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);

    service.onModuleInit();
    registeredHandlers['im.message.receive_v1']({
      message: {
        content: JSON.stringify({ text: '你好' }),
        message_id: 'om_test_msg_id',
      },
    });
    await flushPromises();

    expect(aiChatMock).toHaveBeenCalledWith('你好');
    expect(replyMock).toHaveBeenCalledWith({
      path: {
        message_id: 'om_test_msg_id',
      },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: '豆包回复' }),
      },
    });
  });

  it('should skip duplicated message with same message_id', async () => {
    const aiChatMock = jest.fn().mockResolvedValue('去重回复');

    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              return '';
            },
          },
        },
        {
          provide: AiService,
          useValue: {
            chat: aiChatMock,
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);

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

    expect(aiChatMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it('should not start ws when config is missing', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LarkService,
        {
          provide: ConfigService,
          useValue: {
            get: () => '',
          },
        },
        {
          provide: AiService,
          useValue: {
            chat: jest.fn(),
          },
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
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LARK_APP_ID') return 'cli_test_app_id';
              if (key === 'LARK_APP_SECRET') return 'cli_test_app_secret';
              return '';
            },
          },
        },
        {
          provide: AiService,
          useValue: {
            chat: jest.fn(),
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(LarkService);
    service.onModuleInit();
    await service.onModuleDestroy();

    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
