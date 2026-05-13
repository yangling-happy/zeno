import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobsOptions,
  Queue,
  QueueEvents,
  type ConnectionOptions,
} from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import {
  DEFAULT_QUEUE_PREFIX,
  LARK_MESSAGE_JOB_NAME,
  LARK_MESSAGE_QUEUE_NAME,
} from './queue.constants';

export interface LarkMessageJobData {
  message: {
    chat_id?: string;
    open_id?: string;
    content?: string;
    message_id?: string;
  };
  senderOpenId?: string;
  text: string;
  receivedAt: number;
}

@Injectable()
export class LarkMessageQueue implements OnModuleDestroy {
  private readonly logger = new Logger(LarkMessageQueue.name);
  private readonly queue: Queue<LarkMessageJobData>;
  private readonly queueEvents: QueueEvents;
  private readonly queueConnection: IORedis;
  private readonly queueEventsConnection: IORedis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      throw new Error('REDIS_URL 未配置，无法启用消息队列');
    }

    const prefix =
      this.configService.get<string>('QUEUE_PREFIX') || DEFAULT_QUEUE_PREFIX;
    const baseConnection = this.createRedisConnection(redisUrl, {
      maxRetriesPerRequest: null,
    });
    const eventsConnection = this.createRedisConnection(redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.queueConnection = new IORedis(baseConnection);
    this.queueEventsConnection = new IORedis(eventsConnection);

    this.queue = new Queue<LarkMessageJobData>(LARK_MESSAGE_QUEUE_NAME, {
      connection: this.queueConnection,
      prefix,
      defaultJobOptions: this.getDefaultJobOptions(),
    });
    this.queueEvents = new QueueEvents(LARK_MESSAGE_QUEUE_NAME, {
      connection: this.queueEventsConnection,
      prefix,
    });

    this.registerEvents();
  }

  async enqueueMessage(data: LarkMessageJobData): Promise<{
    jobId: string;
    wasAdded: boolean;
  }> {
    const jobId = data.message.message_id || `lark-${data.receivedAt}`;
    const existingJob = await this.queue.getJob(jobId);
    if (existingJob) {
      return { jobId, wasAdded: false };
    }

    await this.queue.add(LARK_MESSAGE_JOB_NAME, data, { jobId });
    return { jobId, wasAdded: true };
  }

  getWorkerConnectionOptions(): ConnectionOptions {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      throw new Error('REDIS_URL 未配置，无法创建 worker 连接');
    }

    return this.createRedisConnection(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }

  getQueuePrefix(): string {
    return (
      this.configService.get<string>('QUEUE_PREFIX') || DEFAULT_QUEUE_PREFIX
    );
  }

  private getDefaultJobOptions(): JobsOptions {
    const attempts = this.getPositiveNumber('LARK_QUEUE_ATTEMPTS', 3);
    const backoffDelay = this.getPositiveNumber('LARK_QUEUE_BACKOFF_MS', 5000);
    const removeOnComplete = this.getPositiveNumber(
      'LARK_QUEUE_REMOVE_ON_COMPLETE',
      100,
    );
    const removeOnFail = this.getPositiveNumber(
      'LARK_QUEUE_REMOVE_ON_FAIL',
      200,
    );

    return {
      attempts,
      backoff: {
        type: 'exponential',
        delay: backoffDelay,
      },
      removeOnComplete: {
        count: removeOnComplete,
      },
      removeOnFail: {
        count: removeOnFail,
      },
    };
  }

  private getPositiveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private createRedisConnection(
    redisUrl: string,
    overrides: RedisOptions = {},
  ): RedisOptions {
    const parsedUrl = new URL(redisUrl);
    const protocol = parsedUrl.protocol.replace(':', '');
    const tls = protocol === 'rediss' ? {} : undefined;

    return {
      host: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : 6379,
      username: parsedUrl.username || undefined,
      password: parsedUrl.password || undefined,
      db: parsedUrl.pathname ? Number(parsedUrl.pathname.slice(1) || 0) : 0,
      tls,
      ...overrides,
    };
  }

  private registerEvents() {
    this.queueEvents.on('completed', ({ jobId }) => {
      this.logger.debug(`队列任务处理完成: ${jobId}`);
    });
    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.warn(`队列任务处理失败: ${jobId} - ${failedReason}`);
    });
    this.queueEvents.on('error', (error) => {
      this.logger.error('队列事件监听异常', error);
    });
  }

  async onModuleDestroy() {
    await this.queueEvents.close();
    await this.queue.close();
    await this.queueEventsConnection.quit();
    await this.queueConnection.quit();
  }
}
