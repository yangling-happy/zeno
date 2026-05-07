# 在 Zeno 中新增 Nest 功能片段

1. **归属模块**：优先放入现有 `src/modules/<domain>/`，新建 `*.module.ts` 并在父模块 `imports` 中挂载，而非直接膨胀 `AppModule`。
2. **依赖**：通过构造函数注入 `ConfigService`、Prisma、Redis 等；配置键与 `.env.example` 对齐。
3. **导出**：仅在确需跨模块使用时 `exports` 对应 provider。
4. **测试**：新增 `*.spec.ts`；若涉及 HTTP，考虑在 `test/` 增加最小 e2e 或用 `TestingModule` 集成测。
