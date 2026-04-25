import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { AiService } from '../ai/ai.service';

export interface LarkWebhookMessage {
  chat_id?: string;
  open_id?: string;
  content?: string;
  message_id?: string;
}

@Injectable()
export class LarkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LarkService.name);
  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private readonly processedMessageTimestamps = new Map<string, number>();
  private readonly processedMessageTtlMs = 10 * 60 * 1000;
  private readonly processedMessageMaxSize = 5000;

  constructor(
    private readonly configService: ConfigService,
    private readonly aiService: AiService,
  ) {}

  onModuleInit() {
    this.initLarkWS();
  }

  private initLarkWS() {
    const appId = this.configService.get<string>('LARK_APP_ID') || '';
    const appSecret = this.configService.get<string>('LARK_APP_SECRET') || '';

    if (!appId || !appSecret) {
      this.logger.error('❌ LARK_APP_ID 或 LARK_APP_SECRET 未配置');
      return;
    }

    this.client = new Lark.Client({ appId, appSecret });

    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        const message = data?.message as LarkWebhookMessage | undefined;

        if (!message) {
          return;
        }

        if (this.isDuplicateMessage(message.message_id)) {
          this.logger.warn(
            `♻️ 检测到重复投递，已跳过处理: ${message.message_id}`,
          );
          return;
        }

        const text = this.extractText(message.content);
        if (!text) {
          return;
        }

        this.logger.log(`📩 收到消息: ${text}`);

        // 这里不要阻塞事件回调，避免因为 AI 调用耗时导致飞书重试同一条事件。
        void this.processMessage(message, text);
      },
    });

    this.wsClient = new Lark.WSClient({ appId, appSecret });
    this.startWS();
  }

  private extractText(content?: string) {
    if (!content) {
      return '';
    }

    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text?.trim() || '';
    } catch {
      return content.trim();
    }
  }

  private startWS() {
    if (!this.wsClient || !this.eventDispatcher) {
      return;
    }

    this.logger.log('🚀 正在尝试建立飞书长连接...');

    this.wsClient
      .start({ eventDispatcher: this.eventDispatcher })
      .then(() => {
        this.logger.log('✅ 飞书长连接已成功建立并开始监听事件');
      })
      .catch((err) => {
        this.logger.error('❌ 飞书长连接启动失败:', err);
      });
  }

  private isDuplicateMessage(messageId?: string): boolean {
    if (!messageId) {
      return false;
    }

    this.cleanupProcessedMessages();

    if (this.processedMessageTimestamps.has(messageId)) {
      return true;
    }

    this.processedMessageTimestamps.set(messageId, Date.now());
    this.trimProcessedMessages();
    return false;
  }

  private cleanupProcessedMessages() {
    const now = Date.now();
    for (const [id, ts] of this.processedMessageTimestamps.entries()) {
      if (now - ts > this.processedMessageTtlMs) {
        this.processedMessageTimestamps.delete(id);
      }
    }
  }

  private trimProcessedMessages() {
    while (
      this.processedMessageTimestamps.size > this.processedMessageMaxSize
    ) {
      const oldest = this.processedMessageTimestamps.keys().next().value;
      if (!oldest) {
        break;
      }
      this.processedMessageTimestamps.delete(oldest);
    }
  }

  private async processMessage(message: LarkWebhookMessage, text: string) {
    try {
      const reply = await this.aiService.chat(text);
      await this.reply(message.message_id, reply);
    } catch (error) {
      // 处理失败时释放去重标记，允许飞书重试再次触发处理。
      if (message.message_id) {
        this.processedMessageTimestamps.delete(message.message_id);
      }
      this.logger.error('❌ 处理飞书消息失败:', error);
    }
  }

  private async reply(messageId: string | undefined, text: string) {
    if (!this.client) {
      this.logger.warn('飞书客户端未初始化，跳过发送消息');
      return;
    }

    if (!messageId) {
      this.logger.warn('缺少 message_id，无法回复飞书消息');
      return;
    }

    await this.client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  async onModuleDestroy() {
    this.logger.log('🔌 正在释放飞书长连接资源...');
    if (this.wsClient && (this.wsClient as any).stop) {
      await (this.wsClient as any).stop();
    }
  }
}
