import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import {
  LARK_MESSAGE_JOB_NAME,
  LARK_MESSAGE_QUEUE_NAME,
} from './queue.constants';
import { LarkMessageJobData, LarkMessageQueue } from './lark-message.queue';
import { LarkService } from '../lark/lark.service';

@Injectable()
export class LarkMessageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LarkMessageWorker.name);
  private worker: Worker<LarkMessageJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly queue: LarkMessageQueue,
    @Inject(forwardRef(() => LarkService))
    private readonly larkService: LarkService,
  ) {}

  onModuleInit() {
    const workerEnabled =
      this.configService.get<string>('LARK_QUEUE_WORKER_ENABLED') !== 'false';
    if (!workerEnabled) {
      this.logger.warn('Lark 队列 worker 已通过配置关闭');
      return;
    }

    const concurrency = this.getPositiveNumber('LARK_QUEUE_CONCURRENCY', 2);
    this.worker = new Worker<LarkMessageJobData>(
      LARK_MESSAGE_QUEUE_NAME,
      async (job) => this.processJob(job),
      {
        connection: this.queue.getWorkerConnectionOptions(),
        prefix: this.queue.getQueuePrefix(),
        concurrency,
      },
    );

    this.worker.on('ready', () => {
      this.logger.log(`Lark 队列 worker 已启动，并发=${concurrency}`);
    });
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `Lark 队列任务失败: ${job?.id || 'unknown'} - ${error.message}`,
      );
    });
    this.worker.on('error', (error) => {
      this.logger.error('Lark 队列 worker 异常', error);
    });
  }

  private async processJob(job: Job<LarkMessageJobData>): Promise<void> {
    if (job.name !== LARK_MESSAGE_JOB_NAME) {
      this.logger.warn(`收到未知任务类型: ${job.name}`);
      return;
    }

    const messageId = job.data.message.message_id || 'unknown';
    this.logger.log(`开始消费队列消息: job=${job.id} message=${messageId}`);
    await this.larkService.handleQueuedMessage(job.data, {
      jobId: job.id || undefined,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts,
    });
  }

  private getPositiveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
