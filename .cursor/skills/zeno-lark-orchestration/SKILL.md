---
name: zeno-lark-orchestration
description: >-
  说明 Zeno 飞书侧入口：LarkModule 子域、LarkService 与 Agent/Memory/Session 的协作及 SDK 包名。
  在改 lark.service、Webhook 载荷或 doc/slides/broad 联动时使用。
disable-model-invocation: true
---

# 飞书 Lark 编排

## 模块边界

- **`LarkModule`**（`src/modules/lark/lark.module.ts`）聚合：`LarkDocModule`、`LarkSlidesModule`、`LarkBroadModule`，并 `imports` `AgentModule`、`SessionModule`、`CommonModule`、`MemoryModule`；对外 `providers`/`exports` 含 `LarkService`。
- **SDK**：`@larksuiteoapi/node-sdk`（`lark.service.ts` 中 `import * as Lark`）。

## LarkService 协作关系（阅读代码时）

`src/modules/lark/lark.service.ts` 注入并编排例如：`LarkBroadService`、`AgentService`、`LarkDocService`、`LarkSlidesService`、`InstructionDetectorService`、`MemoryService`、`SessionService`，并复用 `common` 下飞书文档工具（如 `lark-feishu-doc.utils`、`lark-doc-append.utils`、`lark-doc-haystack.utils`）。

Webhook / 消息类型以该文件内接口（如 `LarkWebhookEvent`）为准，改字段需同步飞书开放平台事件结构与调用方。

## 凭证与环境

应用级变量见 `.env.example`：`LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_CLOUD_FOLDER_TOKEN` 等；勿在日志中打印密钥。
