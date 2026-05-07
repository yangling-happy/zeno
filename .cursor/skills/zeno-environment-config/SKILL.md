---
name: zeno-environment-config
description: >-
  列出并解释 Zeno 的 `.env.example` 变量（飞书、Ark、Redis、Postgres、Ollama、意图转换、端口）。
  在配置故障、部署文档或本地起服务排障时使用。
disable-model-invocation: true
---

# 环境变量（对照 `.env.example`）

| 变量                                               | 用途                             |
| -------------------------------------------------- | -------------------------------- |
| `LARK_APP_ID` / `LARK_APP_SECRET`                  | 飞书应用凭证                     |
| `LARK_CLOUD_FOLDER_TOKEN`                          | 云空间/目录相关能力（若使用）    |
| `ARK_API_KEY` / `ARK_ENDPOINT_ID` / `ARK_BASE_URL` | 火山 Ark 对话（`AiService`）     |
| `INTENT_TRANSFORMER_*`                             | 意图转换子路径可选模型与开关     |
| `HUGGINGFACE_API_TOKEN`                            | 社区模型/嵌入等（若启用）        |
| `PORT`                                             | HTTP 端口，默认 `3000`           |
| `REDIS_URL`                                        | Redis 连接                       |
| `DATABASE_URL`                                     | PostgreSQL（Prisma）             |
| `OLLAMA_BASE_URL`                                  | 本地/侧车 Ollama（LangChain 等） |

## 实践

- 勿将真实 `.env` 提交入库；复制 `.env.example` 后逐项填写。
- 密钥类只经 `ConfigService` 读取；日志与 trace 中禁止打印完整 key。
- 变更默认值时同步更新 README 或运维 Runbook（若存在）。
