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

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  constructor(private readonly configService: ConfigService) {}

  async chat(text: string): Promise<string> {
    return this.chatOrThrow(text);
  }

  async chatOrThrow(text: string): Promise<string> {
    let lastError: Error | null = null;
    const maxRetries = this.getNumber('AI_MAX_RETRIES', 1);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.fetchWithTimeout(text);
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `AI 调用失败 (尝试 ${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );

        // 判断是否为 TPM 限制错误
        const isTPMLimit =
          lastError.message.includes('Tokens Per Minute') ||
          lastError.message.includes('TPM') ||
          lastError.message.includes('rate_limit');

        if (attempt < maxRetries - 1) {
          const delay = isTPMLimit
            ? this.getNumber('AI_TPM_RETRY_DELAY_MS', 1500)
            : this.getNumber('AI_RETRY_BASE_DELAY_MS', 500) *
                Math.pow(2, attempt) +
              Math.random() * 250;

          this.logger.log(
            `${isTPMLimit ? 'TPM 限制' : '正常'} - 等待 ${delay / 1000} 秒后重试...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.logger.error(`AI 调用完全失败: ${lastError?.message}`);
    throw lastError || new Error('AI 调用失败');
  }

  private async fetchWithTimeout(text: string): Promise<string> {
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

    // 超时控制
    const timeout = this.getNumber('AI_TIMEOUT_MS', 45000);
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
