import { Injectable, Logger } from '@nestjs/common';
import {
  ActionInstruction,
  IntentType,
  SkillExecutionPlan,
  SkillId,
} from '../agent.types';
import { shouldAppendToLastLarkDoc } from '../../common/lark-doc-append.utils';
import { isLikelyActionRequest } from '../../common/agent.utils';
import { extractTopicFromText } from '../../common/topic-extraction.utils';
import { EXPLICIT_BOARD_OR_CANVAS_CREATION_RE } from '../intent/explicit-board-pattern';
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
    options?: { lastDocId?: string },
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
      const lastId = options?.lastDocId?.trim();
      if (lastId && shouldAppendToLastLarkDoc(normalizedText, lastId)) {
        return {
          type: 'LARK_DOC_APPEND',
          params: {
            documentId: lastId,
            text: normalizedText,
          },
        };
      }

      const summaryContent =
        typeof params?.summary === 'string' && params.summary.trim().length > 0
          ? params.summary.trim()
          : extractTopicFromText(normalizedText);
      return {
        type: 'LARK_DOC_CREATE',
        params: {
          title: docTitle,
          ...(summaryContent !== undefined && { summary: summaryContent }),
        },
      };
    }

    if (intent === 'SCENE_PRESENT') {
      const wantsNewBoard =
        EXPLICIT_BOARD_OR_CANVAS_CREATION_RE.test(normalizedText) ||
        /(?:画板|画布|白板).*(?:文档)?.*(?:创建|新建)|(?:单独|独立).*(?:画板|画布|白板)/.test(
          normalizedText,
        );

      if (
        wantsNewBoard &&
        !(
          typeof params?.whiteboardId === 'string' &&
          params.whiteboardId.trim().length > 0
        )
      ) {
        const summaryContent =
          typeof params?.summary === 'string' &&
          params.summary.trim().length > 0
            ? params.summary.trim()
            : extractTopicFromText(normalizedText);
        return {
          type: 'LARK_BOARD_CREATE',
          params: {
            title: presentTitle,
            ...(summaryContent !== undefined && { summary: summaryContent }),
          },
        };
      }

      if (
        typeof params?.whiteboardId === 'string' &&
        params.whiteboardId.trim().length > 0
      ) {
        const textContent =
          typeof params?.summary === 'string' &&
          params.summary.trim().length > 0
            ? params.summary
            : extractTopicFromText(normalizedText);
        if (textContent === undefined) {
          return { type: 'NONE' };
        }
        return {
          type: 'LARK_WHITEBOARD_APPEND',
          params: {
            whiteboardId: params.whiteboardId.trim(),
            text: textContent,
          },
        };
      }

      const summaryContent =
        typeof params?.summary === 'string' && params.summary.trim().length > 0
          ? params.summary.trim()
          : extractTopicFromText(normalizedText);
      return {
        type: 'LARK_DOC_PRESENT_LINK',
        params: {
          title: presentTitle,
          ...(summaryContent !== undefined && { summary: summaryContent }),
        },
      };
    }

    return { type: 'NONE' };
  }

  buildActionInstructionFromSkillPlan(
    plan: SkillExecutionPlan | undefined,
    normalizedText: string,
    options?: { lastDocId?: string },
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
      options,
    );
  }
}
