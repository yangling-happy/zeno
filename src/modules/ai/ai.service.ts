import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ArkChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    content?: string;
  }>;
  data?: {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
}

type AiRetryOptions = {
  maxRetries: number;
  timeoutMs: number;
  retryBaseDelayMs: number;
  tpmRetryDelayMs: number;
  operationName: string;
  successLog?: string;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  constructor(private readonly configService: ConfigService) {}

  async chat(text: string): Promise<string> {
    return this.chatOrThrow(text);
  }

  async chatOrThrow(text: string): Promise<string> {
    return this.completeWithRetry(text, {
      maxRetries: this.getNumber('AI_MAX_RETRIES', 1),
      timeoutMs: this.getNumber('AI_TIMEOUT_MS', 45000),
      retryBaseDelayMs: this.getNumber('AI_RETRY_BASE_DELAY_MS', 500),
      tpmRetryDelayMs: this.getNumber('AI_TPM_RETRY_DELAY_MS', 1500),
      operationName: 'chat',
    });
  }

  async generateDocumentMarkdown(prompt: string): Promise<string> {
    this.logger.log('doc_generation_started');
    try {
      const content = await this.completeWithRetry(prompt, {
        maxRetries: this.getNumber('AI_DOC_MAX_RETRIES', 3),
        timeoutMs: this.getNumber('AI_DOC_TIMEOUT_MS', 90000),
        retryBaseDelayMs: this.getNumber('AI_DOC_RETRY_BASE_DELAY_MS', 1000),
        tpmRetryDelayMs: this.getNumber('AI_DOC_TPM_RETRY_DELAY_MS', 3000),
        operationName: 'document generation',
        successLog: 'doc_generation_succeeded',
      });
      return content;
    } catch (error) {
      this.logger.error(`doc_generation_failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private async completeWithRetry(
    text: string,
    options: AiRetryOptions,
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < options.maxRetries; attempt++) {
      try {
        const content = await this.fetchWithTimeout(text, options.timeoutMs);
        if (options.successLog) {
          this.logger.log(options.successLog);
        }
        return content;
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `AI ${options.operationName} failed (尝试 ${attempt + 1}/${options.maxRetries}): ${lastError.message}`,
        );

        const isTPMLimit =
          lastError.message.includes('Tokens Per Minute') ||
          lastError.message.includes('TPM') ||
          lastError.message.includes('rate_limit');

        if (attempt < options.maxRetries - 1) {
          const delay = isTPMLimit
            ? options.tpmRetryDelayMs
            : options.retryBaseDelayMs * Math.pow(2, attempt) +
              Math.random() * 250;

          if (options.operationName === 'document generation') {
            this.logger.warn(
              `doc_generation_retrying: attempt=${attempt + 2}/${options.maxRetries}, delay_ms=${Math.round(delay)}, reason=${lastError.message}`,
            );
          } else {
            this.logger.log(
              `${isTPMLimit ? 'TPM 限制' : '正常'} - 等待 ${delay / 1000} 秒后重试...`,
            );
          }

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.logger.error(
      `AI ${options.operationName} completely failed: ${lastError?.message}`,
    );
    throw lastError || new Error('AI 调用失败');
  }

  private async fetchWithTimeout(
    text: string,
    timeout: number,
  ): Promise<string> {
    const apiKey = this.configService.get<string>('ARK_API_KEY') || '';
    const model =
      this.configService.get<string>('ARK_MODEL') ||
      this.configService.get<string>('ARK_ENDPOINT_ID') ||
      '';
    const baseUrl =
      this.configService.get<string>('ARK_BASE_URL') ||
      'https://ark.cn-beijing.volces.com/api/v3';

    if (!apiKey || !model) {
      throw new Error('ARK_API_KEY 或 ARK_MODEL 未配置');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: text }],
            temperature: 0.7,
            stream: false,
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      const payload = (await response.json()) as ArkChatCompletionResponse & {
        error?: { message?: string };
      };

      if (!response.ok) {
        const message =
          payload.error?.message || `Ark 请求失败: ${response.status}`;
        this.logger.error(message);
        throw new Error(message);
      }

      const content =
        payload.choices?.[0]?.message?.content ||
        payload.choices?.[0]?.content ||
        payload.data?.choices?.[0]?.message?.content ||
        '';

      if (!content) {
        throw new Error('AI 返回空内容');
      }

      return content;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`AI 调用超时 (${timeout}ms)`);
        }
        throw error;
      }
      throw new Error('AI 调用未知错误');
    }
  }

  private getNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }
}
