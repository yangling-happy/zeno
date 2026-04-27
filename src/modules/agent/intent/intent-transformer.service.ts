import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class IntentTransformerService {
  private readonly logger = new Logger(IntentTransformerService.name);
  private readonly embeddingCache = new Map<string, number[]>();
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    const model =
      this.configService.get<string>('INTENT_TRANSFORMER_MODEL') ||
      'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
    const baseUrl =
      this.configService.get<string>('INTENT_TRANSFORMER_BASE_URL') ||
      'https://api-inference.huggingface.co/pipeline/feature-extraction';

    this.endpoint = `${baseUrl.replace(/\/$/, '')}/${model}`;
    this.apiToken =
      this.configService.get<string>('HUGGINGFACE_API_TOKEN') || '';

    const enabledFlag = (
      this.configService.get<string>('INTENT_TRANSFORMER_ENABLED') || 'true'
    ).toLowerCase();

    this.enabled = enabledFlag !== 'false';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async similarity(textA: string, textB: string): Promise<number | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const [a, b] = await Promise.all([
        this.getEmbedding(textA),
        this.getEmbedding(textB),
      ]);

      if (!a || !b || a.length === 0 || b.length === 0) {
        return null;
      }

      const dim = Math.min(a.length, b.length);
      let dot = 0;
      let normA = 0;
      let normB = 0;

      for (let i = 0; i < dim; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }

      if (normA <= 0 || normB <= 0) {
        return null;
      }

      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    } catch (error) {
      this.logger.warn(
        `Transformer 相似度计算失败，回退传统路由: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    const key = text.trim().toLowerCase();
    if (!key) {
      return null;
    }

    const cached = this.embeddingCache.get(key);
    if (cached) {
      return cached;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        inputs: key,
        options: {
          wait_for_model: true,
        },
      }),
    });

    const payload = (await response.json()) as unknown;

    if (!response.ok) {
      const message =
        typeof payload === 'object' && payload && 'error' in payload
          ? String((payload as { error?: unknown }).error)
          : `Transformer embedding 请求失败: ${response.status}`;
      throw new Error(message);
    }

    const vector = this.extractVector(payload);

    if (!vector || vector.length === 0) {
      throw new Error('Transformer embedding 返回为空');
    }

    this.embeddingCache.set(key, vector);
    return vector;
  }

  private extractVector(payload: unknown): number[] | null {
    if (!Array.isArray(payload) || payload.length === 0) {
      return null;
    }

    if (typeof payload[0] === 'number') {
      return payload as number[];
    }

    if (Array.isArray(payload[0]) && typeof payload[0][0] === 'number') {
      return this.meanPool(payload as number[][]);
    }

    return null;
  }

  private meanPool(tokenVectors: number[][]): number[] {
    const dims = tokenVectors[0]?.length || 0;
    if (dims === 0) {
      return [];
    }

    const pooled = new Array<number>(dims).fill(0);

    for (const tokenVec of tokenVectors) {
      for (let i = 0; i < dims; i++) {
        pooled[i] += tokenVec[i] || 0;
      }
    }

    for (let i = 0; i < dims; i++) {
      pooled[i] /= tokenVectors.length;
    }

    return pooled;
  }
}
