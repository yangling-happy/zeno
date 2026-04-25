import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';

@Injectable()
export class LarkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LarkService.name);
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private eventDispatcher: Lark.EventDispatcher;

  constructor(private configService: ConfigService) {}

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

    // 1. 初始化 API 客户端 (用于调用 OpenAPI，如回复消息)
    this.client = new Lark.Client({
      appId,
      appSecret,
    });

    // 2. 初始化事件调度器
    // 注意：EventDispatcher 构造函数不接受 appId，只需配置验证令牌（可选）
    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const { message } = data;
        try {
          // 解析消息内容
          const content = JSON.parse(message.content).text;
          const messageId = message.message_id;

          this.logger.log(`📩 收到消息: ${content}`);

          // 执行自动回复
          await this.reply(
            messageId,
            `Zeno Agent 已就绪。分析指令中: ${content}`,
          );
        } catch (e) {
          this.logger.error('解析消息内容失败', e);
        }
      },
    });

    // 3. 初始化长连接客户端
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
    });

    // 4. 启动连接
    this.startWS();
  }

  private startWS() {
    this.logger.log('🚀 正在尝试建立飞书长连接...');

    // 在 1.x SDK 中，WSClient 的事件监听并未完全暴露在类型定义中
    // 我们通过 start() 返回的 Promise 来捕捉启动错误
    this.wsClient
      .start({
        eventDispatcher: this.eventDispatcher,
      })
      .then(() => {
        this.logger.log('✅ 飞书长连接已成功建立并开始监听事件');
      })
      .catch((err) => {
        this.logger.error('❌ 飞书长连接启动失败:', err);
        // 这里可以根据需要添加自定义的重连逻辑
      });
  }

  private async reply(messageId: string, text: string) {
    try {
      await this.client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (error) {
      this.logger.error('❌ 回复飞书消息失败:', error);
    }
  }

  async onModuleDestroy() {
    this.logger.log('🔌 正在释放飞书长连接资源...');
    // 提示：如果当前版本的 WSClient 没有暴露 stop() 方法，
    // 通常意味着它由 Node 进程生命周期管理。
    // 如果强制需要关闭，可以尝试 (this.wsClient as any).stop?.();
    if (this.wsClient && (this.wsClient as any).stop) {
        await (this.wsClient as any).stop();
    }
  }
}