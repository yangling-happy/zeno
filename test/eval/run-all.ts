/**
 * 一键跑全部评测。
 * 运行：pnpm run eval
 */
import { spawn } from 'node:child_process';

const targets = [
  { name: '意图识别', cmd: 'pnpm run eval:intent' },
  { name: '首响应延迟', cmd: 'pnpm run eval:first-response' },
  { name: '故障注入', cmd: 'pnpm run eval:fault' },
  { name: '上下文召回', cmd: 'pnpm run eval:context' },
];

async function run(name: string, cmd: string): Promise<void> {
  console.log(`\n>>> [${name}] ${cmd}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: 'inherit' });
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} 退出码 ${code}`)),
    );
    child.on('error', reject);
  });
}

(async () => {
  for (const t of targets) {
    try {
      await run(t.name, t.cmd);
    } catch (err) {
      console.error(`【${t.name}】失败:`, err);
    }
  }
  console.log('\n全部评测结束');
})();
