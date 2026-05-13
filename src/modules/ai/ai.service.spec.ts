import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

describe('AiService', () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;

  afterEach(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    jest.restoreAllMocks();
  });

  it('should return Ark answer for 你好', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '你好，我是豆包。' } }],
      }),
    });

    global.fetch = fetchMock as typeof fetch;

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'ARK_API_KEY') return 'test-api-key';
              if (key === 'ARK_MODEL') return 'ep-test-model';
              if (key === 'ARK_BASE_URL')
                return 'https://ark.example.com/api/v3';
              return '';
            },
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(AiService);
    await expect(service.chat('你好')).resolves.toBe('你好，我是豆包。');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ark.example.com/api/v3/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('should retry document generation and eventually succeed', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('AI 调用超时 (90000ms)'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '# 文档正文\n\n生成成功。' } }],
        }),
      });

    global.fetch = fetchMock as typeof fetch;
    global.setTimeout = ((fn: (...args: any[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'ARK_API_KEY') return 'test-api-key';
              if (key === 'ARK_MODEL') return 'ep-test-model';
              if (key === 'ARK_BASE_URL')
                return 'https://ark.example.com/api/v3';
              if (key === 'AI_DOC_MAX_RETRIES') return 2;
              if (key === 'AI_DOC_TIMEOUT_MS') return 90000;
              if (key === 'AI_DOC_RETRY_BASE_DELAY_MS') return 1;
              if (key === 'AI_DOC_TPM_RETRY_DELAY_MS') return 1;
              return '';
            },
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(AiService);
    await expect(
      service.generateDocumentMarkdown('生成一份完整 Markdown 正文'),
    ).resolves.toBe('# 文档正文\n\n生成成功。');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
