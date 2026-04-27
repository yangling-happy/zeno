import { z } from 'zod';

// 1. 定义 Zod Schema 确保意图识别的精准度
export const IntentSchema = z.object({
  intent: z.enum([
    'SCENE_PLAN',
    'SCENE_DOC',
    'SCENE_PRESENT',
    'SCENE_SYNC',
    'SCENE_DELIVERY',
    'AGENT_IDENTITY',
    'SAFE_REFUSAL',
    'CLARIFY',
    'CHITCHAT',
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe('选择该意图的理由'),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('提取出的关键参数，如 docTitle, targetDevice 等'),
});

export type IntentClassification = z.infer<typeof IntentSchema>;

export const SkillMatchSchema = z.object({
  skillId: z.enum([
    'planning.skill',
    'documentation.skill',
    'presentation.skill',
    'sync.skill',
    'delivery.skill',
    'identity.skill',
    'safety.skill',
    'clarify.skill',
    'chitchat.skill',
  ]),
  intent: IntentSchema.shape.intent,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  parameters: z.record(z.string(), z.unknown()),
  missingRequiredParams: z.array(z.string()),
  fallbackReason: z.string().optional(),
});

export const SkillExecutionPlanSchema = z.object({
  primarySkill: SkillMatchSchema,
  secondarySkills: z.array(SkillMatchSchema),
});

export type SkillMatchDto = z.infer<typeof SkillMatchSchema>;
export type SkillExecutionPlanDto = z.infer<typeof SkillExecutionPlanSchema>;
