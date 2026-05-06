import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { PersonaProfile } from './agent.types';

type SceneReplyArgs = {
  sceneLabel: string;
  contextItems: string[];
  constraints: string[];
};

@Injectable()
export class SceneReplyService {
  constructor(private readonly aiService: AiService) {}

  private formatPersonaBlock(persona: PersonaProfile): string {
    return [
      `你是 ${persona.name}，身份是 ${persona.role}。`,
      `语气与风格：${persona.tone}。`,
      `表达规则：${persona.styleRules.join('；')}。`,
      `边界（不得违反）：${persona.boundaries.join('；')}。`,
    ].join('\n');
  }

  private formatRecentDialogueSnippet(
    sessionHistory?: Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
    }>,
    maxTurns = 4,
  ): string {
    if (!sessionHistory?.length) return '';
    return sessionHistory
      .slice(-maxTurns)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
  }

  async generateSceneUserReply(
    state: {
      sessionHistory?: Array<{
        role: 'user' | 'assistant';
        content: string;
        timestamp: number;
      }>;
      persona: PersonaProfile;
      normalizedText: string;
    },
    args: SceneReplyArgs,
  ): Promise<string> {
    const dialogue = this.formatRecentDialogueSnippet(state.sessionHistory);
    const sections: string[] = [
      this.formatPersonaBlock(state.persona),
      '',
      `【路由场景】${args.sceneLabel}`,
      '',
      '【任务上下文】',
      ...args.contextItems.map((line) => `- ${line}`),
    ];
    if (dialogue) {
      sections.push('', '【最近对话（仅用于衔接语气，勿冗长复述）】', dialogue);
    }
    sections.push(
      '',
      '【你必须遵守的约束】',
      ...args.constraints.map((line) => `- ${line}`),
      '',
      '【用户本轮输入】',
      state.normalizedText,
      '',
      '请只输出给用户看的正文（自然中文）。不要输出 JSON、不要用 Markdown 一级标题、不要暴露内部字段名或英文路由标识。',
    );
    return this.aiService.chat(sections.join('\n'));
  }
}
