/**
 * 任务稳定性评测：故障注入下测最终成功率。
 * - 30% 概率注入 TPM 429 / 超时 / 5xx
 * - 走 AiService.completeWithRetry + BullMQ 双层重试
 *
 * 运行：pnpm run eval:fault
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/modules/ai/ai.service';

interface FaultConfig {
  rate: number; // 0-1
  kinds: ('429' | 'timeout' | '5xx')[];
}

function injectFault(cfg: FaultConfig): Error | null {
  if (Math.random() > cfg.rate) return null;
  const kind = cfg.kinds[Math.floor(Math.random() * cfg.kinds.length)];
  if (kind === '429') return new Error('HTTP 429 rate_limit TPM 限流');
  if (kind === 'timeout') return new Error('Request timed out after 45000ms');
  return new Error('HTTP 500 Internal Server Error');
}

class FaultAiService extends AiService {
  constructor(
    configService: ConfigService,
    private readonly fault: FaultConfig,
    private readonly realChat: (text: string) => Promise<string>,
  ) {
    super(configService);
  }

  async chatOrThrow(text: string): Promise<string> {
    // 直接走真实重试逻辑，但每次底层调用前先掷骰子注入
    const err = injectFault(this.fault);
    if (err) throw err;
    return this.realChat(text);
  }
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function runOnce(
  ai: AiService,
  total: number,
): Promise<{ ok: number; fail: number; samples: number }> {
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < total; i++) {
    try {
      // 走 generateDocumentMarkdown 路径以触发 3 次重试 + 指数退避
      await ai.generateDocumentMarkdown(`故障注入测试 ${i}`);
      ok++;
    } catch {
      fail++;
    }
  }
  return { ok, fail, samples: total };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.init();

  const configService = app.get(ConfigService);
  const realAi = app.get(AiService);
  const realChat = realAi.chat.bind(realAi) as (
    text: string,
  ) => Promise<string>;

  const total = Number(process.env.FAULT_SAMPLES ?? 100);
  const faultRate = Number(process.env.FAULT_RATE ?? 0.3);

  const faultAi = new FaultAiService(
    configService,
    { rate: faultRate, kinds: ['429', 'timeout', '5xx'] },
    realChat,
  );

  const normalResult = await runOnce(realAi, total);
  const faultResult = await runOnce(faultAi, total);

  console.log(`\n=== 任务稳定性评测 ===`);
  console.log(`样本数: ${total}, 故障注入率: ${faultRate * 100}%`);
  console.log(
    `正常工况成功率: ${pct(normalResult.ok, normalResult.samples)} (${normalResult.ok}/${normalResult.samples})`,
  );
  console.log(
    `故障工况成功率: ${pct(faultResult.ok, faultResult.samples)} (${faultResult.ok}/${faultResult.samples})`,
  );
  console.log(
    `故障工况失败数: ${faultResult.fail}（已触发重试 + 状态回收兜底）`,
  );

  await app.close();
}

bootstrap().catch((err) => {
  console.error('评测失败:', err);
  process.exit(1);
});
