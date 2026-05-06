import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { LarkBroadService } from './broad/lark-broad.service';
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

interface LarkCardData {
  message?: string;
}

interface StoppableWsClient {
  stop?: () => void | Promise<void>;
}

/** 仅校验运行时形状；绕开 ESLint 将 switch 内 `action.params` 误判为 error 类型的问题 */
function parseLarkBoardCreateParams(raw: unknown): {
  title: string;
  summary?: string;
} | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== 'string') {
    return null;
  }
  if (o.summary !== undefined && typeof o.summary !== 'string') {
    return null;
  }
  return {
    title: o.title,
    summary: o.summary === undefined ? undefined : o.summary,
  };
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
  private readonly userContextMap = new Map<
    string,
    {
      docId?: string;
      presentId?: string;
      lastDocId?: string;
      lastWhiteboardId?: string;
    }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: AgentService,
    private readonly instructionDetector: InstructionDetectorService,
    private readonly memoryService: MemoryService,
    private readonly docService: LarkDocService,
    private readonly slidesService: LarkSlidesService,
    private readonly broadService: LarkBroadService,
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
    this.docService.initClient(this.client);
    this.slidesService.initClient(this.client);
    this.broadService.initClient(this.client);

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
      for (const oldest of this.processedMessageTimestamps.keys()) {
        this.processedMessageTimestamps.delete(oldest);
        break;
      }
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
      const priorContext = this.userContextMap.get(userId);
      const result = await this.agentService.run({
        text,
        userId,
        channel: 'lark',
        memoryContext,
        lastDocId: priorContext?.lastDocId,
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
        );
        if (actionResult) {
          replyText = `${replyText}\n\n${actionResult}`;
        }

        if (result.actionInstruction.type === 'LARK_DOC_CREATE') {
          const docId = this.extractDocIdFromActionResult(actionResult);
          if (docId) {
            const context = this.userContextMap.get(userId) || {};
            context.lastDocId = docId;
            this.userContextMap.set(userId, context);
          }
        }

        if (result.actionInstruction.type === 'LARK_DOC_APPEND') {
          const context = this.userContextMap.get(userId) || {};
          context.lastDocId = result.actionInstruction.params.documentId.trim();
          this.userContextMap.set(userId, context);
        }

        if (result.actionInstruction.type === 'LARK_BOARD_CREATE') {
          const wbId = this.extractWhiteboardIdFromActionResult(actionResult);
          if (wbId) {
            const context = this.userContextMap.get(userId) || {};
            context.lastWhiteboardId = wbId;
            this.userContextMap.set(userId, context);
          }
        }

        if (result.actionInstruction.type === 'LARK_WHITEBOARD_APPEND') {
          const context = this.userContextMap.get(userId) || {};
          context.lastWhiteboardId =
            result.actionInstruction.params.whiteboardId.trim();
          this.userContextMap.set(userId, context);
        }
      } else if (result.actionInstruction?.type === 'NONE') {
        const isInstruction =
          await this.instructionDetector.isInstruction(text);
        if (isInstruction) {
          this.logger.log(`🤖 检测到指令，正在处理: ${text}`);
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

  /** 云文档创建目录；与 {@link LarkDocService#createDocument}、`LARK_CLOUD_FOLDER_TOKEN` 一致 */
  private resolveCloudFolderToken(): string | undefined {
    const raw = this.configService.get<string>('LARK_CLOUD_FOLDER_TOKEN');
    return typeof raw === 'string' && raw.trim().length > 0
      ? raw.trim()
      : undefined;
  }

  private async generateContentFromTopic(topic: string): Promise<string> {
    try {
      const content = await this.instructionDetector.processInstruction(
        `生成关于"${topic}"的完整文档内容，包括定义、要点、应用场景和总结，用Markdown格式输出`,
      );
      return content || `# ${topic}\n\n关于${topic}的详细内容。`;
    } catch (error) {
      this.logger.error(`生成主题内容失败: ${(error as Error).message}`);
      return `# ${topic}\n\n关于${topic}的详细内容。`;
    }
  }

  private async executeActionInstruction(
    action: ActionInstruction,
  ): Promise<string> {
    if (!this.client || action.type === 'NONE') {
      return '';
    }

    try {
      const cloudFolderToken = this.resolveCloudFolderToken();

      switch (action.type) {
        case 'LARK_DOC_CREATE': {
          const doc = await this.docService.createDocument(
            action.params.title,
            cloudFolderToken,
          );
          const docUrl =
            doc.url && doc.url.startsWith('http')
              ? doc.url
              : `https://feishu.cn/docx/${doc.documentId}`;
          if (action.params.summary) {
            const contentToWrite =
              action.params.summary.length <= 20
                ? await this.generateContentFromTopic(action.params.summary)
                : action.params.summary;
            await this.docService.appendMarkdownToDocument(
              doc.documentId,
              contentToWrite,
            );
          }
          return `📄 文档已创建：${docUrl}`;
        }

        case 'LARK_DOC_APPEND': {
          const documentId = action.params.documentId.trim();
          const generatedContent =
            await this.instructionDetector.processInstruction(
              action.params.text,
              `用户正在操作的文档ID: ${documentId}`,
            );
          const docResult = await this.docService.appendMarkdownToDocument(
            documentId,
            generatedContent,
          );
          const docUrl = `https://feishu.cn/docx/${documentId}`;
          return `📄 已追加到文档：${docUrl}\n（共添加 ${docResult.blockIds.length} 个内容块）`;
        }

        case 'LARK_PRESENT_CREATE': {
          const present = await this.slidesService.createPresentation(
            action.params.title,
          );
          return `🖼️ 演示内容已创建：${present.url}`;
        }

        case 'LARK_WHITEBOARD_APPEND': {
          const appendResult =
            await this.broadService.appendMarkdownToWhiteboard(
              action.params.whiteboardId,
              action.params.text,
            );
          return `🧩 已写入画板（Markdown→文本节点 whiteboard=${action.params.whiteboardId}，共 ${appendResult.nodeIds.length} 个节点）`;
        }

        case 'LARK_BOARD_CREATE': {
          if (action.type !== 'LARK_BOARD_CREATE') {
            return '';
          }
          const params = parseLarkBoardCreateParams(
            Reflect.get(action, 'params'),
          );
          if (!params) {
            return '';
          }
          const baseTitle = params.title.trim();
          const textDocTitle = `${baseTitle}（正文）`;
          const boardDocTitle = `${baseTitle}（画板）`;

          const textDoc = await this.docService.createDocument(
            textDocTitle,
            cloudFolderToken,
          );
          const contentToWrite = params.summary
            ? params.summary.length <= 20
              ? await this.generateContentFromTopic(params.summary)
              : params.summary
            : undefined;
          if (contentToWrite) {
            await this.docService.appendMarkdownToDocument(
              textDoc.documentId,
              contentToWrite,
            );
          }

          const board = await this.broadService.createDocumentWithBoard(
            boardDocTitle,
            contentToWrite,
            cloudFolderToken,
          );

          const textUrl =
            textDoc.url && textDoc.url.startsWith('http')
              ? textDoc.url
              : `https://feishu.cn/docx/${textDoc.documentId}`;

          return [
            `🎨 已创建正文与画板（两个独立链接）：`,
            `- 文档（完整正文）：${textUrl}`,
            `- 画板（含摘要内容，方便浏览与整理）：${board.docUrl}`,
            `- whiteboard_id=${board.whiteboardId}`,
          ].join('\n');
        }

        case 'LARK_DOC_PRESENT_LINK': {
          const doc = await this.docService.createDocument(
            action.params.title,
            cloudFolderToken,
          );

          if (action.params.summary) {
            const contentToWrite =
              action.params.summary.length <= 20
                ? await this.generateContentFromTopic(action.params.summary)
                : action.params.summary;
            await this.docService.appendMarkdownToDocument(
              doc.documentId,
              contentToWrite,
            );
          }

          const docUrl =
            doc.url && doc.url.startsWith('http')
              ? doc.url
              : `https://feishu.cn/docx/${doc.documentId}`;

          return `📄 已创建文档：${docUrl}`;
        }

        default:
          return '';
      }
    } catch (error) {
      this.logger.error(`❌ 执行动作失败: ${action.type}`, error as Error);
      return `⚠️ 已识别出动作 ${action.type}，但执行失败：${(error as Error).message}`;
    }
  }

  private extractWhiteboardIdFromActionResult(
    actionResult: string,
  ): string | null {
    const m = actionResult.match(/whiteboard_id=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
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

  async onModuleDestroy() {
    this.logger.log('🔌 正在释放飞书长连接资源...');
    const stoppableWsClient = this.wsClient as StoppableWsClient | null;
    if (stoppableWsClient?.stop) {
      await stoppableWsClient.stop();
    }
  }
}
