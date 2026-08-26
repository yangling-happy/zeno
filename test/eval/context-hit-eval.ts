/**
 * 上下文召回评测：连续会话下 buildContextBackground 返回非空的比例。
 * - recentConversations.length > 0 || retrievedFacts.length > 0  即算 hit
 * - 首条消息无上下文属正常漏召，统计时单独剔除
 *
 * 运行：pnpm run eval:context
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { MemoryService } from '../../src/modules/memory/memory.service';

const SCENARIO: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: '帮我创建一个文档，写关于意图识别的' },
  { role: 'assistant', content: '已为你创建文档：意图识别设计' },
  { role: 'user', content: '为什么用向量检索而不用纯关键词匹配' },
  { role: 'assistant', content: '因为语义相似度能覆盖同义表达' },
  { role: 'user', content: '我偏好用规则前置过滤再做语义判定' },
  { role: 'assistant', content: '已记录你的偏好，下次按这个顺序处理' },
  { role: 'user', content: '决定采用 BullMQ 而不是 Kafka，体量没那么大' },
  { role: 'assistant', content: '已记录决策：队列选型 BullMQ' },
  { role: 'user', content: '请帮我同步这次修改到飞书' },
  { role: 'assistant', content: '已触发多端同步任务' },
  { role: 'user', content: '总结一下我们这次的设计要点' },
  { role: 'assistant', content: '要点：意图分层、异步队列、状态回收' },
  { role: 'user', content: '再补充一点：接入 OpenTelemetry' },
  { role: 'assistant', content: '已补充到记忆中' },
  { role: 'user', content: '请基于以上背景规划下一次迭代' },
];

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.init();

  const memory = app.get(MemoryService);
  const userId = `eval-ctx-${Date.now()}`;

  let hit = 0;
  let miss = 0;
  let firstMiss = 0;

  for (let i = 0; i < SCENARIO.length; i++) {
    const turn = SCENARIO[i];
    if (turn.role === 'user') {
      // 先写入上一轮对话，再查询
      if (i > 0) {
        await memory.addConversationTurn(
          userId,
          SCENARIO[i - 1].role,
          SCENARIO[i - 1].content,
        );
      }
      const ctx = await memory.buildContextBackground(userId, turn.content);
      const isHit =
        ctx.recentConversations.length > 0 || ctx.retrievedFacts.length > 0;
      if (isHit) {
        hit++;
      } else if (i === 0) {
        firstMiss++;
      } else {
        miss++;
      }
    }
  }

  const userTurns = SCENARIO.filter((t) => t.role === 'user').length;
  const measurable = userTurns - firstMiss;
  console.log(`\n=== 上下文召回评测 ===`);
  console.log(
    `用户轮次: ${userTurns}（首条无上下文 ${firstMiss}，可测量 ${measurable}）`,
  );
  console.log(`Hit: ${hit}/${measurable} = ${pct(hit, measurable)}`);
  console.log(`Miss: ${miss}/${measurable} = ${pct(miss, measurable)}`);

  await app.close();
}

bootstrap().catch((err) => {
  console.error('评测失败:', err);
  process.exit(1);
});
