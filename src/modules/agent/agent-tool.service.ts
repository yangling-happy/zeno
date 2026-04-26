import { Injectable, Logger } from '@nestjs/common';
import { ActionInstruction, IntentType } from './agent.types';

@Injectable()
export class AgentToolService {
  private readonly logger = new Logger(AgentToolService.name);

  buildActionInstruction(
    intent: IntentType,
    params: Record<string, any> | undefined,
    normalizedText: string,
  ): ActionInstruction {
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
}
