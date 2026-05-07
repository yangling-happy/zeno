---
name: zeno-architecture-map
description: >-
  概括 Zeno 仓库模块边界与数据流（NestJS、Lark、Agent、Memory、AiService、Prisma、Redis、OTel）。
  在新成员上手、做大范围重构或写设计说明时使用。
disable-model-invocation: true
---

# Zeno 架构速查

## 启动与根模块

- `src/main.ts`：`startOtel()` → `NestFactory.create(AppModule)` → `listen(PORT)`。
- `src/app.module.ts`：全局 `ConfigModule.forRoot`，导入 `LarkModule`；控制器保留在根应用层。

## 业务聚合

- **`LarkModule`**：组合飞书 doc/slides/broad + `AgentModule` + `SessionModule` + `CommonModule` + `MemoryModule`，对外导出 `LarkService`。
- **`AgentModule`**：意图、技能注册表、LangGraph、工具、会话、场景回复、缓存等；依赖 `AiService` 与记忆。
- **`AiModule`**：Ark 对话、重试与降级（`ai.service.ts`）。
- **`MemoryModule`**：与 Prisma/Redis 相关的记忆读写。
- **`CommonModule`**：飞书文档工具、指令检测、共享 agent 工具函数。

## 数据与外部系统

- **Prisma**：`ConversationHistory`、`FactSnippet`、`UserSession`（`prisma/schema.prisma`）。
- **环境**：以 `.env.example` 为准（Lark、Ark、Redis、DB、Ollama、意图转换器等）。

## 推荐阅读顺序

1. `README.md` / `README.zh-CN.md` 功能与意图表
2. `lark.module.ts` → `agent.module.ts`
3. `skill/skill.registry.ts` + `intent/`
4. `ai.service.ts` + `memory/`
