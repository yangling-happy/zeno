# 本地验证 OpenTelemetry

1. 确认 `src/main.ts` 启动路径调用 `startOtel()`，异常退出时 `shutdownOtel()`。
2. 对照 `package.json` 中 `@opentelemetry/*` 版本阅读官方迁移说明（升级时）。
3. 导出端点当前写在 `src/opentelemetry.ts`（Jaeger HTTP）；改后端地址时改此处或再抽配置。
4. 结合自动埋点与日志排查即可；勿在 trace/log 中写入密钥或完整敏感正文。
