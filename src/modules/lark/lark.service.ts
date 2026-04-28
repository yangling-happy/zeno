import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { AgentService } from '../agent/agent.service';
import { ActionInstruction } from '../agent/agent.types';
import { LarkDocService } from './doc/lark-doc.service';
import { LarkSlidesService } from './slides/lark-slides.service';
import { InstructionDetectorService } from '../common/instruction-detector.service';
import { MemoryService } from '../memory/memory.service';

export interface LarkWebhookMessage {
  chat_id?: string;
  open_id?: string;
  content?: string;
  message_id?: string;
}

export interface LarkWebhookEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message?: LarkWebhookMessage;
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
  private readonly docService: LarkDocService;
  private readonly slidesService: LarkSlidesService;
  private readonly userContextMap = new Map<
    string,
    { docId?: string; presentId?: string; lastDocId?: string }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: AgentService,
    private readonly instructionDetector: InstructionDetectorService,
    private readonly memoryService: MemoryService,
  ) {
    this.docService = new LarkDocService(configService, instructionDetector);
    this.slidesService = new LarkSlidesService(
      configService,
      instructionDetector,
    );
  }

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
    this.docService.initClient(this.client);
    this.slidesService.initClient(this.client);

    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        try {
          const message = data?.message as LarkWebhookMessage | undefined;
          const senderOpenId = data?.sender?.sender_id?.open_id;

          if (!message) {
            this.logger.warn('⚠️ 接收到的消息数据不完整');
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
            this.logger.warn('⚠️ 消息内容为空，跳过处理');
            return;
          }

          this.logger.log(`📩 收到消息: ${text}`);

          // 这里不要阻塞事件回调，避免因为 AI 调用耗时导致飞书重试同一条事件。
          void this.processMessage(message, text, senderOpenId);
        } catch (error) {
          this.logger.error('❌ 处理消息事件失败:', error);
        }
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
      const parsed = JSON.parse(content) as {
        text?: string;
        content?: string;
        markdown?: string;
      };
      // 尝试获取 text 字段（普通文本消息）
      if (parsed.text) {
        return parsed.text.trim();
      }
      // 尝试获取 content 字段（某些消息类型）
      if (parsed.content) {
        return parsed.content.trim();
      }
      // 尝试获取 markdown 字段（markdown 格式消息）
      if (parsed.markdown) {
        return parsed.markdown.trim();
      }
      return '';
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
        this.logger.log('✅飞书长连接已成功建立并开始监听事件');
      })
      .catch((err) => {
        this.logger.error('❌ 飞书长连接启动失败:', err);
        // 启动失败后尝试重连
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect() {
    // 延迟3秒后重连，避免频繁重连
    setTimeout(() => {
      this.logger.log('🔄 尝试重新建立飞书长连接...');
      this.startWS();
    }, 3000);
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

  private async processMessage(
    message: LarkWebhookMessage,
    text: string,
    senderOpenId?: string,
  ) {
    this.logger.log(`📋 开始处理消息: ${message.message_id || 'unknown'}`);
    const userId = senderOpenId || 'anonymous';

    try {
      await this.memoryService.addConversationTurn(userId, 'user', text, {
        messageId: message.message_id,
      });

      const shouldSummarize =
        await this.memoryService.shouldTriggerSummarization(userId);
      if (shouldSummarize) {
        this.logger.log(`📊 达到10轮对话，触发 Summary & Vectorize`);
        const recentConversations =
          await this.memoryService.getRecentConversations(userId);
        await this.memoryService.extractAndStoreFacts(
          userId,
          recentConversations,
        );
      }

      const memoryContext = await this.memoryService.buildContextBackground(
        userId,
        text,
      );

      this.logger.log(`🤖 调用 Agent 服务处理消息`);
      const result = await this.agentService.run({
        text,
        userId,
        channel: 'lark',
        memoryContext,
      });
      this.logger.log(
        `🧭 意图识别结果: ${result.intent} (${result.confidence.toFixed(2)})`,
      );
      if (result.skillExecutionPlan) {
        this.logger.log(
          `🗺️ Skill执行计划: primary=${result.skillExecutionPlan.primarySkill.skillId}, secondary=${result.skillExecutionPlan.secondarySkills.length}`,
        );
      }

      let replyText = result.response;
      if (
        result.actionInstruction &&
        result.actionInstruction.type !== 'NONE'
      ) {
        this.logger.log(`⚡ 执行动作指令: ${result.actionInstruction.type}`);
        const actionResult = await this.executeActionInstruction(
          result.actionInstruction,
          message,
        );
        if (actionResult) {
          replyText = `${replyText}\n\n${actionResult}`;
        }

        if (result.actionInstruction.type === 'LARK_DOC_CREATE') {
          const docId = this.extractDocIdFromActionResult(actionResult);
          if (docId) {
            const userId = message.open_id || 'anonymous';
            const context = this.userContextMap.get(userId) || {};
            context.lastDocId = docId;
            this.userContextMap.set(userId, context);
          }
        }
      } else if (result.actionInstruction?.type === 'NONE') {
        const isInstruction =
          await this.instructionDetector.isInstruction(text);
        if (isInstruction) {
          this.logger.log(`🤖 检测到指令，正在处理: ${text}`);
          const userId = message.open_id || 'anonymous';
          const context = this.userContextMap.get(userId);
          const generatedContent =
            await this.instructionDetector.processInstruction(
              text,
              context?.lastDocId
                ? `用户正在操作的文档ID: ${context.lastDocId}`
                : undefined,
            );

          if (context?.lastDocId) {
            try {
              const docResult = await this.docService.appendMarkdownToDocument(
                context.lastDocId,
                generatedContent,
              );
              replyText = `✅ 已根据您的指令生成内容并添加到文档中，共添加 ${docResult.blockIds.length} 个内容块。`;
            } catch (error) {
              this.logger.error(
                `添加内容到文档失败: ${(error as Error).message}`,
              );
              replyText = `✅ 已生成内容：\n\n${generatedContent}`;
            }
          } else {
            replyText = `✅ 已生成内容：\n\n${generatedContent}`;
          }
        }
      }

      // 即使没有 open_id，也可以通过 message_id 回复消息
      if (!senderOpenId && !message.message_id) {
        this.logger.warn('⚠️ 缺少 open_id 和 message_id，无法发送卡片');
        return;
      }

      this.logger.debug(`📨 回复内容预览: ${replyText.slice(0, 300)}`);
      this.logger.log(`💬 准备发送卡片: ${message.message_id || 'unknown'}`);

      // 优先使用 reply 方法回复消息，这样可以保持消息的上下文关系
      if (message.message_id) {
        this.logger.log(`📢 使用 reply 方法回复消息: ${message.message_id}`);
        await this.reply(message.message_id, replyText);
      } else if (message.chat_id) {
        // 如果没有 message_id，则使用 sendCardToChat 方法发送到群聊
        this.logger.log(`📢 消息来自群聊，发送到群聊: ${message.chat_id}`);
        await this.sendCardToChat(message.chat_id, {
          message: replyText,
        });
      } else if (senderOpenId) {
        // 如果没有 message_id 和 chat_id，则使用 sendCardToUser 方法发送到私聊
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
          intent: result.intent,
        },
      );
    } catch (error) {
      if (message.message_id) {
        this.processedMessageTimestamps.delete(message.message_id);
        this.logger.warn(`♻️ 释放消息去重标记: ${message.message_id}`);
      }
      this.logger.error('❌ 处理飞书消息失败:', error);
    }
  }

  private extractDocIdFromActionResult(actionResult: string): string | null {
    const urlMatch = actionResult.match(
      /https:\/\/feishu\.cn\/docx\/([A-Za-z0-9]+)/i,
    );
    return urlMatch ? urlMatch[1] : null;
  }

  private async executeActionInstruction(
    action: ActionInstruction,
    _message: LarkWebhookMessage,
  ): Promise<string> {
    if (!this.client || action.type === 'NONE') {
      return '';
    }

    try {
      switch (action.type) {
        case 'LARK_DOC_CREATE': {
          const doc = await this.docService.createDocument(action.params.title);
          const docUrl =
            doc.url && doc.url.startsWith('http')
              ? doc.url
              : `https://feishu.cn/docx/${doc.documentId}`;
          if (action.params.summary) {
            await this.docService.appendMarkdownToDocument(
              doc.documentId,
              action.params.summary,
            );
          }
          return `📄 文档已创建：${docUrl}`;
        }

        case 'LARK_PRESENT_CREATE': {
          const present = await this.slidesService.createPresentation(
            action.params.title,
          );
          return `🖼️ 演示内容已创建：${present.url}`;
        }

        case 'LARK_WHITEBOARD_APPEND': {
          const nodeId = await this.appendToWhiteboard(
            action.params.whiteboardId,
            action.params.text,
          );
          return `🧩 已写入自由画布（whiteboard=${action.params.whiteboardId}, node=${nodeId}）`;
        }

        case 'LARK_DOC_PRESENT_LINK': {
          const doc = await this.docService.createDocument(action.params.title);
          const present = await this.slidesService.createPresentation(
            `${action.params.title}-演示`,
          );

          if (action.params.summary) {
            await this.docService.appendMarkdownToDocument(
              doc.documentId,
              action.params.summary,
            );
          }

          return [
            `🔗 已完成文档+演示串联：`,
            `- 文档：${doc.url}`,
            `- 演示/画布：${present.url}`,
          ].join('\n');
        }

        default:
          return '';
      }
    } catch (error) {
      this.logger.error(`❌ 执行动作失败: ${action.type}`, error as Error);
      return `⚠️ 已识别出动作 ${action.type}，但执行失败：${(error as Error).message}`;
    }
  }

  private async appendToWhiteboard(
    whiteboardId: string,
    text: string,
  ): Promise<string> {
    const response = await (this.client as any).board.v1.whiteboardNode.create({
      path: {
        whiteboard_id: whiteboardId,
      },
      data: {
        type: 'TEXT',
        text,
      },
    });

    const nodeId = response?.data?.node_id || response?.data?.id;
    if (!nodeId) {
      throw new Error('白板写入失败，未返回 node_id');
    }

    return nodeId;
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
    cardData?: Record<string, any>;
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
                content: params.cardData?.message || '',
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

  async sendCardToUser(openId: string, cardData?: Record<string, any>) {
    return this.sendCard({
      receiveId: openId,
      receiveIdType: 'open_id',
      cardData,
    });
  }

  async sendCardToChat(chatId: string, cardData?: Record<string, any>) {
    return this.sendCard({
      receiveId: chatId,
      receiveIdType: 'chat_id',
      cardData,
    });
  }

  async onModuleDestroy() {
    this.logger.log('🔌 正在释放飞书长连接资源...');
    if (this.wsClient && (this.wsClient as any).stop) {
      await (this.wsClient as any).stop();
    }
  }
}
