# 修改 Agent LangGraph / LangChain 编排

1. 从 `agent-graph.service.ts` 与相关 provider 理清节点、边与状态类型（对照 `agent.types.ts`）。
2. 校验与 Zod schema（`zod/agent-zod.schema.ts`）一致，避免运行时才暴露结构错误。
3. 工具调用变更时同步 `tool/agent-tool.service.ts` 与单测；注意飞书侧副作用（写文档、发消息）。
4. 需要换模型或提示时，区分「编排逻辑」与「AiService 调用参数」，Ark/Ollama 相关环境变量见 `.env.example`。
