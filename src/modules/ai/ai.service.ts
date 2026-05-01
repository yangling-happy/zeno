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
  private readonly maxRetries = 3;
  private readonly timeout = 600000; // 60秒超时

  constructor(private readonly configService: ConfigService) {}

  async chat(text: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.fetchWithTimeout(text, attempt + 1);
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `AI 调用失败 (尝试 ${attempt + 1}/${this.maxRetries}): ${lastError.message}`,
        );

        // 指数退避
        if (attempt < this.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // 降级策略：返回兜底响应
    this.logger.error(`AI 调用完全失败，使用降级响应: ${lastError?.message}`);
    return this.getFallbackResponse(text);
  }

  private async fetchWithTimeout(
    text: string,
    attempt: number,
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

    // 超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

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
          throw new Error(`AI 调用超时 (${this.timeout}ms)`);
        }
        throw error;
      }
      throw new Error('AI 调用未知错误');
    }
  }

  private getFallbackResponse(text: string): string {
    // 简单的降级响应逻辑
    if (text.includes('你好') || text.includes('hello')) {
      return '你好！我是 Zeno，你的多端协同指挥官，负责需求→规划→生成→同步→汇报的全链路自动化。';
    } else if (text.includes('文档') || text.includes('doc')) {
      return '我理解你需要文档相关的帮助。请稍后重试，系统正在处理中。';
    } else if (text.includes('演示') || text.includes('ppt')) {
      return '我理解你需要演示相关的帮助。请稍后重试，系统正在处理中。';
    } else {
      return '系统暂时无法处理你的请求，请稍后重试。';
    }
  }
}
