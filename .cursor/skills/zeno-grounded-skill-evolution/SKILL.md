---
name: zeno-grounded-skill-evolution
description: >-
  指导 AI 与人协作迭代编写或修订 .cursor/skills：先锚定仓库事实再写 SKILL，多轮校对防失真。
  在新建技能、把口头流程固化成 SKILL、或发现 skill 与代码不一致要修正时使用。
disable-model-invocation: true
---

# 以项目为锚的 Skill 迭代工作流

**最高原则**：`SKILL.md` 里关于本仓库的陈述，必须能指回**真实文件、真实配置、真实脚本**；宁可写「见某文件」也不要写未核验的推断。

## 1. 锚定事实（写或改 SKILL 之前）

- 用 **Read / Grep / 打开实现** 确认：路径、类名、环境变量、pnpm 脚本、模块边界。
- 权威来源优先级：**`package.json`**、**`eslint.config.mjs`**、**`.env.example`**、**`prisma/schema.prisma`**、对应 **`src/**`** 源码；README 仅作补充，与代码冲突时**以代码为准\*\*。
- 禁止：凭「一般 Nest 项目」或旧对话记忆补全 Zeno 特有行为（如某依赖是否已使用、某 URL 是否来自 env）。

## 2. 起草 SKILL

- `description`（第三人称）写清 **做什么 + 何时用**，并含触发词，便于以后点名或检索。
- 正文只保留**可执行步骤**与**可验证引用**（例如「见 `src/modules/memory/memory.service.ts` 的 `initVectorStore`」）。
- 通用套路（提交规范、Code Review）可与 Zeno 叠用时，**单独一句**指向本仓库实际约定（如 pnpm、`.cursor/rules`），避免整段纯网络模板零本地化。

## 3. 自我校对轮（迭代核心）

每一轮至少做下面之一，直到无「未证实句」：

| 检查         | 动作                          |
| ------------ | ----------------------------- |
| 路径是否存在 | Glob / 列表目录               |
| 符号是否存在 | Grep 类名、方法名、配置键     |
| 行为是否仍真 | Read 关键函数片段             |
| 命令是否仍真 | 对照 `package.json` `scripts` |

若发现 SKILL 与仓库不一致：**删或改陈述**，不要保留「可能」「通常」来掩盖错误。

## 4. 收束与维护

- 大段易过期内容用「见某路径」代替复述实现细节；细节留在代码旁注释或单文件 skill 附录（可选 `reference.md`）。
- 重大重构后：把受影响的 `SKILL.md` 列入同一变更的检查项，复跑第 3 节。

## 5. 反模式（显式禁止）

- 把未在仓库出现的目录、脚本、环境变量写进「本项目」段落。
- 把其它产品/旧版本的 OpenTelemetry、飞书、Prisma 用法直接贴进 Zeno skill 而不核对 `src`。
- 为「好看」编造架构图或数据流，而不对应 `lark.module.ts`、`agent.module.ts` 等实际 import 关系。

## 最短闭环（可复制）

1. Grep/Read → 2. 改 `SKILL.md` → 3. 用 Grep 核对文中所列路径与符号 → 4. 删除无法核对的句子 → 5. 提交。
