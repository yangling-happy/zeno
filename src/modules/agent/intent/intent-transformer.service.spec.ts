import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntentTransformerService } from './intent-transformer.service';

describe('IntentTransformerService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should return null similarity when disabled', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        IntentTransformerService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'INTENT_TRANSFORMER_ENABLED') return 'false';
              return '';
            },
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(IntentTransformerService);
    const score = await service.similarity('a', 'b');
    expect(score).toBeNull();
  });

  it('should compute cosine similarity from feature-extraction payload', async () => {
    const embeddingPayload = JSON.stringify([
      [0.1, 0.3, 0.6],
      [0.2, 0.2, 0.6],
    ]);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => embeddingPayload,
    });
    global.fetch = fetchMock as typeof fetch;

    const moduleRef = await Test.createTestingModule({
      providers: [
        IntentTransformerService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'INTENT_TRANSFORMER_ENABLED') return 'true';
              if (key === 'INTENT_TRANSFORMER_MODEL')
                return 'intfloat/multilingual-e5-large';
              if (key === 'INTENT_TRANSFORMER_BASE_URL')
                return 'https://router.huggingface.co/hf-inference';
              if (key === 'HUGGINGFACE_API_TOKEN') return 'test-token';
              return '';
            },
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(IntentTransformerService);
    const score = await service.similarity('写会议纪要', '整理会议文稿');

    expect(typeof score).toBe('number');
    expect(score).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
