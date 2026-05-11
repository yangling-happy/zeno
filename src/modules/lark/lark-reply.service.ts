import { Injectable, Logger } from '@nestjs/common';
import * as Lark from '@larksuiteoapi/node-sdk';
import { MemoryService } from '../memory/memory.service';
import { LarkCardData, LarkWebhookMessage } from './lark.types';

@Injectable()
export class LarkReplyService {
  private readonly logger = new Logger(LarkReplyService.name);
  private client: Lark.Client | null = null;

  constructor(private readonly memoryService: MemoryService) {}

  initClient(client: Lark.Client) {
    this.client = client;
  }

  async sendReplyAndPersistAssistant(params: {
    message: LarkWebhookMessage;
    senderOpenId?: string;
    userId: string;
    replyText: string;
    intentForMemory: string;
  }): Promise<void> {
    const { message, senderOpenId, userId, replyText, intentForMemory } =
      params;

    if (!senderOpenId && !message.message_id) {
      this.logger.warn('⚠️ 缺少 open_id 和 message_id，无法发送卡片');
      return;
    }

    this.logger.debug(`📨 回复内容预览: ${replyText.slice(0, 300)}`);
    this.logger.log(`💬 准备发送卡片: ${message.message_id || 'unknown'}`);

    if (message.message_id) {
      this.logger.log(`📢 使用 reply 方法回复消息: ${message.message_id}`);
      await this.reply(message.message_id, replyText);
    } else if (message.chat_id) {
      this.logger.log(`📢 消息来自群聊，发送到群聊: ${message.chat_id}`);
      await this.sendCardToChat(message.chat_id, {
        message: replyText,
      });
    } else if (senderOpenId) {
      this.logger.log(`💬 消息来自私聊，发送到私聊: ${senderOpenId}`);
      await this.sendCardToUser(senderOpenId, {
        message: replyText,
      });
    }

    this.logger.log(`✅ 卡片发送完成: ${message.message_id || 'unknown'}`);

    await this.memoryService.addConversationTurn(
      userId,
      'assistant',
      replyText,
      {
        messageId: message.message_id,
        intent: intentForMemory,
      },
    );
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
        msg_type: 'interactive',
        content: JSON.stringify({
          config: {
            wide_screen_mode: true,
          },
          elements: [
            {
              tag: 'div',
              text: {
                content: text || '',
                tag: 'lark_md',
              },
            },
          ],
        }),
      },
    });
  }

  async sendCard(params: {
    receiveId: string;
    receiveIdType: 'open_id' | 'user_id' | 'chat_id';
    cardData?: LarkCardData;
  }) {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    this.logger.log(`📤 开始发送卡片: receiveId=${params.receiveId}`);

    await this.client.im.message.create({
      data: {
        receive_id: params.receiveId,
        msg_type: 'interactive',
        content: JSON.stringify({
          config: {
            wide_screen_mode: true,
          },
          elements: [
            {
              tag: 'div',
              text: {
                content: params.cardData?.message ?? '',
                tag: 'lark_md',
              },
            },
          ],
        }),
      },
      params: {
        receive_id_type: params.receiveIdType,
      },
    });

    this.logger.log(`✅ 卡片发送成功`);
  }

  async sendCardToUser(openId: string, cardData?: LarkCardData) {
    return this.sendCard({
      receiveId: openId,
      receiveIdType: 'open_id',
      cardData,
    });
  }

  async sendCardToChat(chatId: string, cardData?: LarkCardData) {
    return this.sendCard({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      cardData,
    });
  }
}
