# 分析复杂 AI 交互问题

读取并严格遵循 `.cursor/skills/ai-interaction-problem-analysis/SKILL.md`，按「现象描述 → 预期行为 → 根因定位 → 多方案选型 → 验收标准 → 技术改造要点」六级标题交付全文。

向用户确认或收集：**现象**、**元提示词**（可脱敏）、**相关 logs**（时间序、请求 ID、错误栈）。信息不足时在对应章节写「待补充」，并单列需补充项。

结合本仓库时，优先对照 `src/modules/ai/ai.service.ts`（Ark 配置、`fetchWithTimeout`、TPM/重试、`getFallbackResponse`）。
