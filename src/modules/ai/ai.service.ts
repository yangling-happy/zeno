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
      },
    );

    const payload = (await response.json()) as ArkChatCompletionResponse & {
      error?: { message?: string };
    };

    if (!response.ok) {
      const message =
        payload.error?.message || `Ark 请求失败: ${response.status}`;
      this.logger.error(message);
      throw new Error(message);
    }

    return (
      payload.choices?.[0]?.message?.content ||
      payload.choices?.[0]?.content ||
      payload.data?.choices?.[0]?.message?.content ||
      ''
    );
  }
}
