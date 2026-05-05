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
        /(?:新建|创建).*画板|画板.*(?:文档)?.*(?:创建|新建)|(?:单独|独立).*画板/.test(
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
