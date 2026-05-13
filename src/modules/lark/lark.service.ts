import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { LarkBroadService } from './broad/lark-broad.service';
import { AgentService } from '../agent/agent.service';
import { ActionInstruction } from '../agent/agent.types';
import { LarkDocService } from './doc/lark-doc.service';
import { LarkActionExecutorService } from './lark-action-executor.service';
import { LarkReplyService } from './lark-reply.service';
import { LarkSlidesService } from './slides/lark-slides.service';
import { LarkQueuedAckSender, LarkWebhookMessage } from './lark.types';
import { InstructionDetectorService } from '../common/instruction-detector.service';
import { mergeVisibleAndLarkJsonForDocOps } from '../common/lark-doc-haystack.utils';
import {
  compactLarkDocAppendInstruction,
  extractFirstFeishuDocToken,
} from '../common/lark-feishu-doc.utils';
import { shouldAppendToLastLarkDoc } from '../common/lark-doc-append.utils';
import { MemoryService } from '../memory/memory.service';
import { SessionService } from '../agent/session/session.service';
import {
  LarkMessageJobData,
  LarkMessageQueue,
} from '../queue/lark-message.queue';

interface StoppableWsClient {
  stop?: () => void | Promise<void>;
}

interface QueueProcessingContext {
  jobId?: string;
  attempt?: number;
  maxAttempts?: number;
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
    private readonly sessionService: SessionService,
    private readonly actionExecutor: LarkActionExecutorService,
    private readonly replyService: LarkReplyService,
    private readonly docService: LarkDocService,
    private readonly slidesService: LarkSlidesService,
    private readonly broadService: LarkBroadService,
    @Inject(forwardRef(() => LarkMessageQueue))
    private readonly messageQueue: LarkMessageQueue,
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
    this.replyService.initClient(this.client);

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
          void this.enqueueIncomingMessage(message, text, senderOpenId);
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

  private async enqueueIncomingMessage(
    message: LarkWebhookMessage,
    text: string,
    senderOpenId?: string,
  ): Promise<void> {
    try {
      const { jobId, wasAdded } = await this.messageQueue.enqueueMessage({
        message,
        senderOpenId,
        text,
        receivedAt: Date.now(),
      });

      if (!wasAdded) {
        this.logger.warn(`队列中已存在相同消息，跳过重复入队: ${jobId}`);
        return;
      }

      this.logger.log(`消息已入队: job=${jobId} message=${message.message_id}`);
      await this.sendQueuedAck(message, senderOpenId);
    } catch (error) {
      if (message.message_id) {
        this.processedMessageTimestamps.delete(message.message_id);
      }
      this.logger.error('❌ 飞书消息入队失败:', error);
      await this.sendFinalFailureReply(message, senderOpenId, '入队失败');
    }
  }

  async handleQueuedMessage(
    payload: LarkMessageJobData,
    queueContext?: QueueProcessingContext,
  ) {
    const { message, text, senderOpenId } = payload;
    this.logger.log(`📋 开始处理消息: ${message.message_id || 'unknown'}`);
    if (queueContext?.jobId) {
      this.logger.log(
        `🧵 队列上下文: job=${queueContext.jobId}, attempt=${queueContext.attempt}/${queueContext.maxAttempts || '?'}`,
      );
    }
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

      const priorContext = this.userContextMap.get(userId);
      const trimmedText = text.trim();
      const docHaystack = mergeVisibleAndLarkJsonForDocOps(
        text,
        message.content,
      );
      const docTokenFromMessage = extractFirstFeishuDocToken(docHaystack);
      const effectiveDocId =
        priorContext?.lastDocId?.trim() || docTokenFromMessage;

      if (
        effectiveDocId &&
        shouldAppendToLastLarkDoc(docHaystack, effectiveDocId)
      ) {
        this.logger.log(
          docTokenFromMessage && !priorContext?.lastDocId?.trim()
            ? '📌 从消息内解析云文档 token，延续追加（内存无 lastDocId，常见于粘贴机器人回复或实例重启后）'
            : '📌 延续云文档追加：跳过意图分类，直达飞书写入（避免交付等场景误判与模型编造链接）',
        );
        const docId = effectiveDocId.trim();
        const instructionForAppend =
          compactLarkDocAppendInstruction(docHaystack) || trimmedText;
        this.sessionService.addMessage(userId, 'user', text);
        const appendAction: ActionInstruction = {
          type: 'LARK_DOC_APPEND',
          params: { documentId: docId, text: instructionForAppend },
        };
        const actionResult = await this.actionExecutor.execute(appendAction);
        const replyText = actionResult
          ? `已按你的说明将内容追加到上一篇云文档。\n\n${actionResult}`
          : '已尝试追加云文档，但未获得执行结果（请确认飞书长连接与 API 已正确配置）。';

        this.sessionService.addMessage(userId, 'assistant', replyText);

        const ctx = this.userContextMap.get(userId) || {};
        ctx.lastDocId = docId;
        this.userContextMap.set(userId, ctx);

        await this.replyService.sendReplyAndPersistAssistant({
          message,
          senderOpenId,
          userId,
          replyText,
          intentForMemory: 'SCENE_DOC',
        });
        return;
      }

      this.logger.log(`🤖 调用 Agent 服务处理消息`);
      const result = await this.agentService.run({
        text,
        userId,
        channel: 'lark',
        memoryContext,
        lastDocId:
          priorContext?.lastDocId?.trim() ||
          extractFirstFeishuDocToken(docHaystack),
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
        const actionResult = await this.actionExecutor.execute(
          result.actionInstruction,
        );
        if (actionResult) {
          replyText = `${replyText}\n\n${actionResult}`;
        }

        if (result.actionInstruction.type === 'LARK_DOC_CREATE') {
          const docId =
            this.actionExecutor.extractDocIdFromActionResult(actionResult);
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
          const wbId =
            this.actionExecutor.extractWhiteboardIdFromActionResult(
              actionResult,
            );
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

      await this.replyService.sendReplyAndPersistAssistant({
        message,
        senderOpenId,
        userId,
        replyText,
        intentForMemory: result.intent,
      });
    } catch (error) {
      if (message.message_id) {
        this.processedMessageTimestamps.delete(message.message_id);
        this.logger.warn(`♻️ 释放消息去重标记: ${message.message_id}`);
      }
      this.logger.error(
        `❌ 处理飞书消息失败: job=${queueContext?.jobId || 'unknown'}`,
        error,
      );
      const isLastAttempt =
        !!queueContext?.maxAttempts &&
        (queueContext.attempt || 1) >= queueContext.maxAttempts;
      if (isLastAttempt) {
        await this.sendFinalFailureReply(message, senderOpenId);
        return;
      }
      throw error;
    }
  }

  private async sendQueuedAck(
    message: LarkWebhookMessage,
    senderOpenId?: string,
  ): Promise<void> {
    const ackEnabled =
      this.configService.get<string>('LARK_QUEUE_ACK_ENABLED') !== 'false';
    if (!ackEnabled) {
      return;
    }

    try {
      await (
        this.replyService as LarkQueuedAckSender
      ).sendQueuedProcessingAcknowledgment(message, senderOpenId);
    } catch (error) {
      this.logger.warn(`发送排队确认消息失败: ${(error as Error).message}`);
    }
  }

  private async sendFinalFailureReply(
    message: LarkWebhookMessage,
    senderOpenId?: string,
    reason: string = '处理失败',
  ): Promise<void> {
    try {
      await this.replyService.sendReplyAndPersistAssistant({
        message,
        senderOpenId,
        userId: senderOpenId || 'anonymous',
        replyText: `系统暂时无法完成这条请求（${reason}），请稍后重试。`,
        intentForMemory: 'FAILED',
      });
    } catch (error) {
      this.logger.error(`发送最终降级回复失败: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    this.logger.log('🔌 正在释放飞书长连接资源...');
    const stoppableWsClient = this.wsClient as StoppableWsClient | null;
    if (stoppableWsClient?.stop) {
      await stoppableWsClient.stop();
    }
  }
}
