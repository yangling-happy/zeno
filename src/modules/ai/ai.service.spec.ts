import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

describe('AiService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
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
});
