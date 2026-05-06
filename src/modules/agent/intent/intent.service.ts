import { Injectable, Logger } from '@nestjs/common';
import {
  IntentSchema,
  type IntentClassification,
} from '../zod/agent-zod.schema';
import { CacheService } from '../cache/cache.service';
import { IntentRoutingService } from './intent-routing.service';
import { EXPLICIT_BOARD_OR_CANVAS_CREATION_RE } from '../intent/explicit-board-pattern';
import {
  buildSkillPromptContext,
  getSkillByIntent,
  toSkillPlan,
} from '../skill/skill.registry';
import type { SkillMatch, SkillExecutionPlan } from '../agent.types';

@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);
  private readonly cacheExpiry = 5 * 60 * 1000;

  constructor(
    private readonly cacheService: CacheService,
    private readonly intentRoutingService: IntentRoutingService,
  ) {}

  private applyBenignBoardCorrection(
    text: string,
    classification: IntentClassification,
  ): IntentClassification {
    if (classification.intent !== 'SAFE_REFUSAL') return classification;
    if (!EXPLICIT_BOARD_OR_CANVAS_CREATION_RE.test(text.trim())) {
      return classification;
    }
    return {
      ...classification,
      intent: 'SCENE_PRESENT',
      confidence: Math.max(classification.confidence, 0.93),
      reason: `显式画板/画布/白板创建语境，纠正误判的安全拒答（原判定：${classification.reason}）`,
      parameters: {
        ...(classification.parameters ?? {}),
        routingSource: 'safe-refusal-board-correction',
      },
    };
  }

  async classifyIntent(text: string): Promise<IntentClassification> {
    const cacheKey = `intent:${text.trim().toLowerCase()}`;

    const cachedRaw = this.cacheService.get<unknown>(cacheKey);
    if (cachedRaw !== null && cachedRaw !== undefined) {
      this.logger.debug(`从缓存获取意图分类结果: ${cacheKey}`);
      const cachedResult = IntentSchema.parse(cachedRaw);
      const fixed = this.applyBenignBoardCorrection(text, cachedResult);
      if (fixed.intent !== cachedResult.intent) {
        this.cacheService.set(cacheKey, fixed, this.cacheExpiry);
        this.logger.debug(
          `意图缓存纠偏: ${cacheKey} ${cachedResult.intent} -> ${fixed.intent}`,
        );
      }
      return fixed;
    }

    const routeResult = await this.intentRoutingService.route(text);
    const result = IntentSchema.parse(routeResult.classification);
    const finalResult = this.applyBenignBoardCorrection(text, result);

    this.cacheService.set(cacheKey, finalResult, this.cacheExpiry);
    this.logger.debug(`缓存意图分类结果: ${cacheKey} [${routeResult.source}]`);

    return finalResult;
  }

  buildSkillPromptContext(): string {
    return buildSkillPromptContext();
  }

  matchSkills(classification: IntentClassification): SkillMatch[] {
    const skillDef = getSkillByIntent(classification.intent);
    const parameters = classification.parameters ?? {};
    const missingRequiredParams = skillDef.requiredParams.filter(
      (param) => !(param in parameters),
    );

    let normalizedIntent = classification.intent;
    let normalizedConfidence = classification.confidence;
    let fallbackReason: string | undefined;

    if (
      classification.intent !== 'CLARIFY' &&
      (classification.confidence < skillDef.confidenceThreshold ||
        missingRequiredParams.length > 0)
    ) {
      normalizedIntent = skillDef.fallbackIntent;
      normalizedConfidence = Math.min(classification.confidence, 0.59);
      fallbackReason =
        missingRequiredParams.length > 0
          ? `缺少关键参数: ${missingRequiredParams.join(', ')}`
          : `置信度低于技能阈值(${skillDef.confidenceThreshold})`;
    }

    const normalizedSkillDef = getSkillByIntent(normalizedIntent);

    const primarySkill: SkillMatch = {
      skillId: normalizedSkillDef.id,
      intent: normalizedIntent,
      confidence: normalizedConfidence,
      reason: classification.reason,
      riskLevel: normalizedSkillDef.riskLevel,
      parameters,
      missingRequiredParams,
      fallbackReason,
    };

    return [primarySkill];
  }

  arbitrateSkills(matches: SkillMatch[]): SkillExecutionPlan {
    if (matches.length === 0) {
      const fallback: SkillMatch = {
        skillId: 'clarify.skill',
        intent: 'CLARIFY',
        confidence: 0.5,
        reason: '未命中可执行技能',
        riskLevel: 'low',
        parameters: {},
        missingRequiredParams: [],
        fallbackReason: '技能候选为空，降级澄清',
      };
      return toSkillPlan(fallback);
    }

    const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);
    return toSkillPlan(sorted[0]);
  }

  buildExecutionPlan(classification: IntentClassification) {
    const matched = this.matchSkills(classification);
    return this.arbitrateSkills(matched);
  }

  resolveRoute(intent: string, confidence: number) {
    if (confidence < 0.6) return 'clarify';
    if (intent === 'SCENE_PLAN') return 'plan';
    if (intent === 'SCENE_SYNC') return 'sync';
    if (intent === 'SCENE_DOC') return 'doc';
    if (intent === 'SCENE_PRESENT') return 'present';
    return 'chat';
  }
}
