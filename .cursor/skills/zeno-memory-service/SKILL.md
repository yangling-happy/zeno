---
name: zeno-memory-service
description: >-
  说明 MemoryService 中 Redis 近期对话、Prisma 持久化、Ollama 嵌入与 FactSnippet 流程。
  在改记忆读写、摘要触发或事实抽取时使用。
disable-model-invocation: true
---

# MemoryService 行为要点

实现文件：`src/modules/memory/memory.service.ts`。模型定义：`prisma/schema.prisma`（`ConversationHistory`、`FactSnippet`、`UserSession`）。

## 连接与可选降级

- **Redis**：`REDIS_URL` 未配置时记录 warn，**即时上下文**（如 `getRecentConversations`）可走空结果路径。
- **Prisma**：`PrismaClient` 连接失败时记录 error；无 Prisma 时**向量相关**逻辑会提前返回（见 `initVectorStore`）。
- **嵌入**：`OllamaEmbeddings`，默认 `model: 'nomic-embed-text'`，`baseUrl` 来自 `OLLAMA_BASE_URL` 或 `http://localhost:11434`。

## 近期对话（Redis）

- Key 前缀：`zeno:memory:`；近期列表键形如 `recent:${userId}`，`lpush` + `ltrim` 保留约 `maxRecentTurns`（代码内为 10），TTL 约 7 天（以实现为准）。
- **轮次计数**：`turn_count:${userId}` 等，与 `shouldTriggerSummarization`（如每 10 轮）联动。

## 事实与向量

- `extractAndStoreFacts` 依赖 `vectorStore` 与 `prisma` 同时可用；否则会 warn 并返回空数组。
- 抽取成功后可能调用 `clearRecentConversations`（以方法实现为准），避免与产品预期冲突时先读完整方法体。

## 运行前

确保 `.env.example` 中 `REDIS_URL`、`DATABASE_URL`、`OLLAMA_BASE_URL` 与本地/部署环境一致后再调试记忆链路。
