---
name: eslint
description: 校验项目的eslint并且如果不成功就修复。Use when the user asks to run/validate ESLint, fix lint errors, or ensure `pnpm run lint:check` passes in this repository.
disable-model-invocation: true
---

# /eslint

## 目标

在本仓库执行 ESLint 校验；如果不通过则自动修复，并在修复后再次校验，直到通过或确认需要人工介入。

## 工作流（必须按顺序执行）

1. 在仓库根目录运行严格校验：
   - `pnpm run lint:check`
2. 如果校验成功：结束。
3. 如果校验失败：执行自动修复：
   - `pnpm run lint`
4. 修复后立刻再次运行严格校验：
   - `pnpm run lint:check`
5. 若仍失败：
   - 优先基于 ESLint 输出定位到具体文件/规则并修复代码（而不是改规则）。
   - 如果错误是类型信息相关（本项目使用 `typescript-eslint` 的 type-checked 配置，`projectService: true`），检查是否是缺失/不正确的 tsconfig、或新文件未被 TS 项目覆盖导致的解析问题；修复配置或文件归属后复跑 `pnpm run lint:check`。
   - 仅当确认是项目策略需要调整时，才修改 `eslint.config.mjs`；修改后必须复跑 `pnpm run lint:check` 证明通过。

## 约束

- 不要跳过校验（例如不要加 `--max-warnings` 放宽、不要用 `--no-eslintrc` 之类绕过配置）。
- 自动修复只能通过 `pnpm run lint`（其包含 `--fix`）；不要手写一堆不同的 ESLint 命令造成参数漂移。
- 若改动了代码，必要时再运行 `pnpm run format`（仅当 Prettier 相关错误仍未被修复时）。

## 输出要求

- 报告最终状态：`lint:check` 是否通过。
- 若不通过：贴出最关键的报错片段（首个/最具代表性的 error），并说明下一步要改哪些文件。
