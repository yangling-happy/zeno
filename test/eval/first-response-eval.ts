/**
 * 首响应延迟评测：webhook 事件到达 → 用户收到 ACK 回执。
 * 直接打点测量 enqueueIncomingMessage + sendQueuedProcessingAcknowledgment。
 *
 * 运行：pnpm run eval:first-response
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { LarkMessageQueue } from '../../src/modules/queue/lark-message.queue';
import { LarkReplyService } from '../../src/modules/lark/lark-reply.service';

interface Sample {
  durationMs: number;
  ok: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

async function measureOnce(
  queue: LarkMessageQueue,
  reply: LarkReplyService,
  messageId: string,
  text: string,
): Promise<Sample> {
  const start = performance.now();
  let ok = true;
  try {
    await queue.enqueueMessage({
      message: { message_id: messageId, content: text },
      senderOpenId: 'eval-user',
      text,
      receivedAt: Date.now(),
    });
    await (
      reply as unknown as {
        sendQueuedProcessingAcknowledgment: (
          m: { message_id: string },
          s: string,
        ) => Promise<void>;
      }
    ).sendQueuedProcessingAcknowledgment(
      { message_id: messageId },
      'eval-user',
    );
  } catch {
    ok = false;
  }
  return { durationMs: performance.now() - start, ok };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.init();

  const queue = app.get(LarkMessageQueue);
  const reply = app.get(LarkReplyService);

  const N = Number(process.env.FIRST_RESPONSE_SAMPLES ?? 50);
  const samples: Sample[] = [];
  for (let i = 0; i < N; i++) {
    const id = `eval-fr-${i}-${Date.now()}`;
    samples.push(await measureOnce(queue, reply, id, `评测消息 ${i}`));
  }

  const okSamples = samples
    .filter((s) => s.ok)
    .map((s) => s.durationMs)
    .sort((a, b) => a - b);

  console.log(`\n=== 首响应延迟评测 ===`);
  console.log(`样本数: ${N}（成功 ${okSamples.length}）`);
  if (okSamples.length > 0) {
    console.log(`P50: ${percentile(okSamples, 50).toFixed(0)}ms`);
    console.log(`P95: ${percentile(okSamples, 95).toFixed(0)}ms`);
    console.log(`P99: ${percentile(okSamples, 99).toFixed(0)}ms`);
    console.log(`Max: ${okSamples[okSamples.length - 1].toFixed(0)}ms`);
  }

  await app.close();
}

bootstrap().catch(async (err) => {
  console.error('评测失败:', err);
  process.exit(1);
});
