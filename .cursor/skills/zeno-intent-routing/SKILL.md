---
name: zeno-intent-routing
description: >-
  说明 Zeno 意图路由链路：正则、IntentTransformer 嵌入、向量 exemplar、LLM 与 gate；
  以及 INTENT_TRANSFORMER_* 配置。在改 intent-routing、intent-transformer 或调阈值时使用。
disable-model-invocation: true
---

# 意图路由（IntentRoutingService）

## 路由来源

`src/modules/agent/intent/intent-routing.service.ts` 中 `RoutingSource` 包括：`regex`、`transformer`、`vector`、`llm`、`gate`（以代码为准）。

- **regex**：`INTENT_RECOGNITION_REGEX_RULES` 等规则路径。
- **transformer / vector**：与 `IntentTransformerService`、exemplar 向量及若干 **accept/review 阈值**（如 `transformerAcceptThreshold`、`vectorAcceptThreshold`，见实现内常量）相关；改行为前对照单测 `intent-routing.service.spec.ts`。
- **llm**：经 `AiService` 的分类调用。
- 上下文与技能说明来自 `skill/skill.registry.ts`（如 `buildSkillPromptContext`、`INTENT_RECOGNITION_EXAMPLES`）。

## IntentTransformerService 配置

`src/modules/agent/intent/intent-transformer.service.ts` 读取（见 `.env.example`）：

- `INTENT_TRANSFORMER_ENABLED`（默认逻辑以代码为准）
- `INTENT_TRANSFORMER_MODEL`、`INTENT_TRANSFORMER_BASE_URL`

实现内对不兼容模型、弃用 HuggingFace 域名等有**自动纠正与告警日志**，改 URL/模型时需读该文件避免重复踩坑。

## Zod

结构化分类类型见 `src/modules/agent/zod/agent-zod.schema.ts`，与路由结果字段保持一致。
