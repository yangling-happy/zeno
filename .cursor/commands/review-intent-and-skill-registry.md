# 审查意图与技能注册表变更

当修改 `src/modules/agent/skill/skill.registry.ts`、`agent.types.ts` 或 `src/modules/agent/intent/` 下路由/转换逻辑时：

1. 对照 README 中的意图表（SCENE_PLAN、SCENE_DOC 等），确认 `intent` 与 `SkillId` 映射仍一致。
2. 检查 `confidenceThreshold`、`fallbackIntent`、`antiPatterns` 变更是否需更新单测（`intent-*.spec.ts`、`agent.service.spec.ts`）。
3. 若用户可见行为变化，在 PR/说明中写清「误判场景」与回滚方式。
4. 涉及 LLM 子路径时，可结合 `.cursor/skills/ai-interaction-problem-analysis/SKILL.md` 做结构化影响分析。
