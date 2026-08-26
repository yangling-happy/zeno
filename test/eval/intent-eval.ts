/**
 * 意图识别评测：基线（仅 LLM zero-shot）vs 完整路由链路。
 * 指标：Top-1 准确率、误触发率（错误触发执行类动作 / 总样本）。
 *
 * 运行：pnpm run eval:intent
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IntentRoutingService } from '../../src/modules/agent/intent/intent-routing.service';
import { IntentTransformerService } from '../../src/modules/agent/intent/intent-transformer.service';
import { AiService } from '../../src/modules/ai/ai.service';
import { IntentSchema } from '../../src/modules/agent/zod/agent-zod.schema';
import {
  INTENT_FIXTURES,
  FIXTURE_STATS,
  IntentFixture,
} from './intent-fixtures';

interface EvalRow {
  text: string;
  expected: string;
  predicted: string;
  confidence: number;
  source: string;
}

const ACTION_INTENTS = new Set([
  'SCENE_DOC',
  'SCENE_PRESENT',
  'SCENE_DELIVERY',
]);

function isMisTriggered(row: EvalRow, fixture: IntentFixture): boolean {
  // 误触发：模型预测为执行类动作，但预期不是执行类动作
  const predictedIsAction = ACTION_INTENTS.has(row.predicted);
  const expectedIsAction = fixture.isActionIntent;
  return predictedIsAction && !expectedIsAction;
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function runBaseline(
  aiService: AiService,
  fixtures: IntentFixture[],
): Promise<EvalRow[]> {
  // 基线：只用 LLM zero-shot，跳过正则与向量检索
  const rows: EvalRow[] = [];
  const prompt = (text: string) => `你是意图分类器。只返回严格 JSON：
{"intent":"...","confidence":0-1,"reason":"...","parameters":{}}
用户输入：${text}`;

  for (const f of fixtures) {
    try {
      const resp = await aiService.chat(prompt(f.text));
      const parsed = IntentSchema.parse(JSON.parse(resp));
      rows.push({
        text: f.text,
        expected: f.expected,
        predicted: parsed.intent,
        confidence: parsed.confidence,
        source: 'llm-baseline',
      });
    } catch {
      rows.push({
        text: f.text,
        expected: f.expected,
        predicted: 'CLARIFY',
        confidence: 0,
        source: 'llm-baseline-error',
      });
    }
  }
  return rows;
}

async function runFullRouting(
  routing: IntentRoutingService,
  fixtures: IntentFixture[],
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const f of fixtures) {
    try {
      const { classification, source } = await routing.route(f.text);
      rows.push({
        text: f.text,
        expected: f.expected,
        predicted: classification.intent,
        confidence: classification.confidence,
        source,
      });
    } catch {
      rows.push({
        text: f.text,
        expected: f.expected,
        predicted: 'CLARIFY',
        confidence: 0,
        source: 'routing-error',
      });
    }
  }
  return rows;
}

function report(label: string, rows: EvalRow[], fixtures: IntentFixture[]) {
  const total = rows.length;
  let correct = 0;
  let misTriggered = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const f = fixtures[i];
    if (r.predicted === f.expected) correct++;
    if (isMisTriggered(r, f)) misTriggered++;
  }

  const bySource = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\n=== ${label} ===`);
  console.log(`样本数: ${total}`);
  console.log(`Top-1 准确率: ${pct(correct, total)} (${correct}/${total})`);
  console.log(
    `误触发率: ${pct(misTriggered, total)} (${misTriggered}/${total})`,
  );
  console.log(`路由来源分布:`, bySource);
}

async function bootstrap() {
  console.log(`评测样本: ${FIXTURE_STATS.total} 条`);
  console.log(`执行类样本数: ${FIXTURE_STATS.actionCount}`);
  console.log(`分布:`, FIXTURE_STATS.byIntent);

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  await app.init();

  const aiService = app.get(AiService);
  const transformer = app.get(IntentTransformerService, { strict: false });
  const routing = new IntentRoutingService(aiService, transformer ?? undefined);

  const baselineRows = await runBaseline(aiService, INTENT_FIXTURES);
  report('基线 (LLM zero-shot)', baselineRows, INTENT_FIXTURES);

  const fullRows = await runFullRouting(routing, INTENT_FIXTURES);
  report('完整路由 (regex + vector + LLM)', fullRows, INTENT_FIXTURES);

  await app.close();
}

bootstrap().catch((err) => {
  console.error('评测失败:', err);
  process.exit(1);
});
