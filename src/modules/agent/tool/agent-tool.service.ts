import { Injectable, Logger } from '@nestjs/common';
import {
  ActionInstruction,
  IntentType,
  SkillExecutionPlan,
  SkillId,
} from '../agent.types';
import { isLikelyActionRequest } from '../../common/agent.utils';
import { EXPLICIT_BOARD_OR_CANVAS_CREATION_RE } from '../intent/explicit-board-pattern';

/** 用户明显要新建另一篇文档，应忽略 lastDocId 延续 */
const EXPLICIT_NEW_DOC_RE =
  /新建|另起|重新(?:写|创建|生成)|再写(?:一)?篇|写一篇新|新开(?:一)?篇|创建(?:一)?个(?:新)?文档|单独(?:再)?要(?:一)?(?:篇|份)|从零(?:开始)?写/i;

/** 相对上一轮文档做追加、补充、续写 */
const DOC_APPEND_HINT_RE =
  /(?:文末|末尾|结尾|最后|后面|接着|续写|续上|追加|补充|加入|添加|加上|写入|粘贴|填到|粘到|完善|润色|更新|在(?:那)?篇|在文章|在文档|在正文|在(?:上面|刚才|这篇|这份)|这篇|这份|这个文档|刚才|之前|刚生成|刚创建|上面(?:那)?个文档)/i;

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

  private normalizeTopicCandidate(topic: string): string | undefined {
    const normalized = topic
      .trim()
      .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
      .replace(/^(?:是|为|叫|：|:)\s*/, '')
      .replace(/(?:的)?(?:文章|文档|内容|材料|报告|PPT|演示|幻灯片)$/i, '')
      .trim();

    if (
      !normalized ||
      /^(?:写?入)?(?:一篇|一份|一个)?(?:文章|文档|内容|材料|报告)$/i.test(
        normalized,
      )
    ) {
      return undefined;
    }

    return normalized;
  }

  private extractTopicFromText(text: string): string | undefined {
    const patterns = [
      /(?:主题|题目)\s*(?:是|为|叫|：|:)\s*([^，,。!！?？]+)/i,
      /以\s*([^，,。!！?？]+?)\s*为主题/i,
      /(?:关于|围绕|有关)\s*([^，,。!！?？]+)/i,
      /写(?!入)(?:关于|)\s*([^\s，,。!！?？]+(?:的?[^\s，,。!！?？]+)?)/,
      /创建.*文档.*写(?!入)([^，,。!！?？]+)/,
      /生成.*文档.*写(?!入)([^，,。!！?？]+)/,
      /文档.*写(?!入)([^，,。!！?？]+)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const topic = this.normalizeTopicCandidate(match[1]);
        if (topic && topic.length >= 2 && topic.length <= 50) {
          return topic;
        }
      }
    }
    return undefined;
  }

  /** 在已有 lastDocId 时，是否应追加而非新建 */
  shouldAppendToLastDocument(
    normalizedText: string,
    lastDocId: string | undefined,
  ): boolean {
    const t = normalizedText.trim();
    if (!lastDocId || !t) {
      return false;
    }
    if (EXPLICIT_NEW_DOC_RE.test(t)) {
      return false;
    }
    return DOC_APPEND_HINT_RE.test(t);
  }

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
      if (lastId && this.shouldAppendToLastDocument(normalizedText, lastId)) {
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
          : this.extractTopicFromText(normalizedText);
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
            : this.extractTopicFromText(normalizedText);
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
            : this.extractTopicFromText(normalizedText);
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
          : this.extractTopicFromText(normalizedText);
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
