import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** HF Inference Providers（serverless）路由器；旧的 api-inference 主机已不再接受 POST /models。 */
const HF_INFERENCE_ROUTER_BASE = 'https://router.huggingface.co/hf-inference';
const LEGACY_HF_INFERENCE_HOST = 'api-inference.huggingface.co';
/** 在 Router /models 上会误判为 SentenceSimilarity，无法用 inputs 字符串做嵌入。 */
const ROUTER_INCOMPATIBLE_EMBEDDING_MODEL =
  'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const DEFAULT_EMBEDDING_MODEL = 'intfloat/multilingual-e5-large';

@Injectable()
export class IntentTransformerService {
  private readonly logger = new Logger(IntentTransformerService.name);
  private readonly embeddingCache = new Map<string, number[]>();
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    let model =
      this.configService.get<string>('INTENT_TRANSFORMER_MODEL') ||
      DEFAULT_EMBEDDING_MODEL;
    if (model === ROUTER_INCOMPATIBLE_EMBEDDING_MODEL) {
      this.logger.warn(
        `INTENT_TRANSFORMER_MODEL=${ROUTER_INCOMPATIBLE_EMBEDDING_MODEL} 在当前 Inference API 上无法用于文本嵌入，已改用 ${DEFAULT_EMBEDDING_MODEL}。`,
      );
      model = DEFAULT_EMBEDDING_MODEL;
    }

    let baseUrl =
      this.configService.get<string>('INTENT_TRANSFORMER_BASE_URL') ||
      HF_INFERENCE_ROUTER_BASE;
    baseUrl = this.normalizeInferenceBaseUrl(baseUrl);

    this.endpoint = `${baseUrl.replace(/\/$/, '')}/models/${model}`;
    this.apiToken =
      this.configService.get<string>('HUGGINGFACE_API_TOKEN') || '';

    const enabledFlag = (
      this.configService.get<string>('INTENT_TRANSFORMER_ENABLED') || 'true'
    ).toLowerCase();

    this.enabled = enabledFlag !== 'false';
  }

  private normalizeInferenceBaseUrl(raw: string): string {
    const trimmed = raw.replace(/\/$/, '');
    try {
      const url = new URL(
        trimmed.startsWith('http') ? trimmed : `https://${trimmed}`,
      );
      if (url.hostname === LEGACY_HF_INFERENCE_HOST) {
        this.logger.warn(
          'INTENT_TRANSFORMER_BASE_URL 指向已弃用的 api-inference.huggingface.co，已自动改用 https://router.huggingface.co/hf-inference。',
        );
        return HF_INFERENCE_ROUTER_BASE;
      }
    } catch {
      // 无效 URL 留在后续 fetch 时报错
    }
    return trimmed;
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
      Accept: 'application/json',
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

    const payload = await this.parseJsonResponseBody(response);

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

  private async parseJsonResponseBody(response: Response): Promise<unknown> {
    const raw = await response.text();
    if (!raw.trim()) {
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      const preview = raw.trim().slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(
        `Transformer 响应非 JSON（HTTP ${response.status}）：${preview}`,
      );
    }
  }
}
