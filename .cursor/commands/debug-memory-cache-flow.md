# 调试记忆与缓存（Redis / Prisma）

1. 确认 `REDIS_URL`、`DATABASE_URL` 与 README 中三层记忆设计一致。
2. 阅读 `src/modules/memory/` 与调用方（Agent、Lark）如何写入 `ConversationHistory` / `FactSnippet` / `UserSession`。
3. 排查顺序：连接是否成功 → 序列化/JSON 字段 → 过期与键命名冲突 → 与向量检索相关的数据形态（若启用）。
4. 加日志时带上 `userId` 或会话 id（避免记录完整消息内容若含隐私）。
