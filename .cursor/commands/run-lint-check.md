# 运行 ESLint（检查）

在项目根执行：

```bash
pnpm run lint:check
```

若需自动修复可写：

```bash
pnpm run lint
```

`lint-staged` 对 `*.ts` 使用 `eslint --fix --max-warnings 0`；`pnpm run lint:check` 同样带 `--max-warnings 0`，与之一致即可。规则入口：`eslint.config.mjs`（含 `typescript-eslint`、Prettier、`eslint-plugin-security` 等）。
