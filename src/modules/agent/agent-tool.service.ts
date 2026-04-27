import { Injectable, Logger } from '@nestjs/common';
import {
  ActionInstruction,
  IntentType,
  SkillExecutionPlan,
  SkillId,
} from './agent.types';
import { isLikelyActionRequest } from '../common/agent.utils';

@Injectable()
export class AgentToolService {
  private readonly logger = new Logger(AgentToolService.name);

  private readonly skillToIntentMap: Record<SkillId, IntentType> = {
    'planning.skill': 'SCENE_PLAN',
    'documentation.skill': 'SCENE_DOC',
    'presentation.skill': 'SCENE_PRESENT',
    'sync.skill': 'SCENE_SYNC',
    'delivery.skill': 'SCENE_DELIVERY',
    'identity.skill': 'AGENT_IDENTITY',
    'safety.skill': 'SAFE_REFUSAL',
    'clarify.skill': 'CLARIFY',
    'chitchat.skill': 'CHITCHAT',
  };

  buildActionInstruction(
    intent: IntentType,
    params: Record<string, any> | undefined,
    normalizedText: string,
    confidence?: number,
  ): ActionInstruction {
    const CONFIDENCE_THRESHOLD = 0.6;
    const isHighConfidence =
      confidence !== undefined && confidence >= CONFIDENCE_THRESHOLD;
    if (!isHighConfidence && !isLikelyActionRequest(normalizedText)) {
      this.logger.debug(`非执行请求，跳过动作指令生成: ${normalizedText}`);
      return { type: 'NONE' };
    }

    const docTitle =
      typeof params?.docTitle === 'string' && params.docTitle.trim().length > 0
        ? params.docTitle.trim()
        : `Zeno 文档-${new Date().toLocaleString('zh-CN')}`;

    const presentTitle =
      typeof params?.presentTitle === 'string' &&
      params.presentTitle.trim().length > 0
        ? params.presentTitle.trim()
        : `Zeno 演示-${new Date().toLocaleString('zh-CN')}`;

    if (intent === 'SCENE_DOC') {
      return {
        type: 'LARK_DOC_CREATE',
        params: {
          title: docTitle,
          summary:
            typeof params?.summary === 'string'
              ? params.summary
              : normalizedText.slice(0, 120),
        },
      };
    }

    if (intent === 'SCENE_PRESENT') {
      if (
        typeof params?.whiteboardId === 'string' &&
        params.whiteboardId.trim().length > 0
      ) {
        return {
          type: 'LARK_WHITEBOARD_APPEND',
          params: {
            whiteboardId: params.whiteboardId.trim(),
            text:
              typeof params?.summary === 'string'
                ? params.summary
                : normalizedText.slice(0, 200),
          },
        };
      }

      return {
        type: 'LARK_DOC_PRESENT_LINK',
        params: {
          title: presentTitle,
          summary:
            typeof params?.summary === 'string'
              ? params.summary
              : normalizedText.slice(0, 120),
        },
      };
    }

    return { type: 'NONE' };
  }

  buildActionInstructionFromSkillPlan(
    plan: SkillExecutionPlan | undefined,
    normalizedText: string,
  ): ActionInstruction {
    if (!plan) {
      return { type: 'NONE' };
    }

    const primary = plan.primarySkill;
    const intent = this.skillToIntentMap[primary.skillId] ?? primary.intent;
    return this.buildActionInstruction(
      intent,
      primary.parameters,
      normalizedText,
      primary.confidence,
    );
  }
}
