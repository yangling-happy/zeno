# 调试飞书 Lark 集成

1. 核对 `.env.example`：`LARK_APP_ID`、`LARK_APP_SECRET`、以及文档/云目录相关变量（如 `LARK_CLOUD_FOLDER_TOKEN`）。
2. 从 `LarkModule` 依赖树定位：`lark.service.ts`、各子模块 `doc/`、`slides/`、`broad/` 与 `AgentModule`/`MemoryModule` 的调用链。
3. 区分「SDK 鉴权错误」「块结构不兼容」「业务逻辑过滤」：优先抓服务端日志与飞书开放接口返回码。
4. HTTP 入口端口以 `main.ts` 中 `listen(process.env.PORT ?? 3000)` 为准；飞书回调 URL 需与部署环境一致。
