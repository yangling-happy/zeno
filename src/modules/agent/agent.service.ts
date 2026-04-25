import { Injectable, Logger } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AiService } from '../ai/ai.service';
import {
  AgentRunInput,
  AgentRunResult,
  IntentType,
  PersonaProfile,
} from './agent.types';

const AgentGraphState = Annotation.Root({
  userInput: Annotation<AgentRunInput>,
  normalizedText: Annotation<string>,
  intent: Annotation<IntentType>,
  confidence: Annotation<number>,
  reason: Annotation<string>,
  persona: Annotation<PersonaProfile>,
  route: Annotation<'chat' | 'identity' | 'safe_refusal' | 'clarify'>,
  response: Annotation<string>,
  trace: Annotation<string[]>,
});

type GraphState = typeof AgentGraphState.State;

interface IntentClassification {
  intent: IntentType;
  confidence: number;
  reason: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private compiledGraph: {
    invoke: (input: GraphState) => Promise<GraphState>;
  } | null = null;

  private readonly personas: Record<string, PersonaProfile> = {
    zeno: {
      id: 'zeno',
      name: 'Zeno',
      role: '你的智能助理与共创伙伴',
      tone: '专业、友好、简洁',
      styleRules: [
        '先给结论，再给步骤。',
        '不编造事实，不确定时明确说明。',
        '优先给可执行建议。',
      ],
      boundaries: [
        '涉及违法、伤害、仇恨等内容必须拒答。',
        '涉及医学/法律/投资仅提供一般性信息，不作专业结论。',
      ],
    },
  };

  constructor(private readonly aiService: AiService) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const graph = this.getOrCreateGraph();

    const initialState: GraphState = {
      userInput: input,
      normalizedText: '',
      intent: 'unknown',
      confidence: 0,
      reason: '',
      persona: this.personas.zeno,
      route: 'clarify',
      response: '',
      trace: [],
    };

    const result = await graph.invoke(initialState);

    return {
      intent: result.intent,
      confidence: result.confidence,
      personaId: result.persona.id,
      response:
        result.response ||
        '我有点没听清你的意图，你可以换一种说法吗？我会马上继续。',
      trace: result.trace,
    };
  }

  private getOrCreateGraph(): {
    invoke: (input: GraphState) => Promise<GraphState>;
  } {
    if (this.compiledGraph) {
      return this.compiledGraph;
    }

    const graph = new StateGraph(AgentGraphState)
      .addNode('normalize_input', async (state) => {
        const normalizedText = this.normalizeText(state.userInput.text);
        return {
          normalizedText,
          trace: [...state.trace, 'normalize_input'],
        };
      })
      .addNode('intent_classifier', async (state) => {
        const cls = await this.classifyIntent(state.normalizedText);
        return {
          intent: cls.intent,
          confidence: cls.confidence,
          reason: cls.reason,
          trace: [...state.trace, 'intent_classifier'],
        };
      })
      .addNode('identity_resolver', async (state) => {
        const persona = this.resolvePersona(state.intent);
        const route = this.resolveRoute(state.intent, state.confidence);
        return {
          persona,
          route,
          trace: [...state.trace, 'identity_resolver'],
        };
      })
      .addNode('safe_refusal', async (state) => {
        return {
          response:
            '这个请求我不能直接协助，但我可以帮你改成安全、合规且可执行的替代方案。',
          trace: [...state.trace, 'safe_refusal'],
        };
      })
      .addNode('identity_response', async (state) => {
        return {
          response: this.buildIdentityReply(state.persona),
          trace: [...state.trace, 'identity_response'],
        };
      })
      .addNode('clarify_question', async (state) => {
        return {
          response:
            '我理解到你可能有多个意图。你是希望我：1）直接回答问题，2）执行一个任务，还是 3）介绍我是谁与能力边界？',
          trace: [...state.trace, 'clarify_question'],
        };
      })
      .addNode('chat_response', async (state) => {
        const response = await this.generateResponse(
          state.persona,
          state.normalizedText,
          state.intent,
        );

        return {
          response,
          trace: [...state.trace, 'chat_response'],
        };
      })
      .addEdge(START, 'normalize_input')
      .addEdge('normalize_input', 'intent_classifier')
      .addEdge('intent_classifier', 'identity_resolver')
      .addConditionalEdges('identity_resolver', (state) => state.route, {
        chat: 'chat_response',
        identity: 'identity_response',
        safe_refusal: 'safe_refusal',
        clarify: 'clarify_question',
      })
      .addEdge('chat_response', END)
      .addEdge('identity_response', END)
      .addEdge('safe_refusal', END)
      .addEdge('clarify_question', END);

    const compiled = graph.compile() as {
      invoke: (input: GraphState) => Promise<GraphState>;
    };
    this.compiledGraph = compiled;
    return this.compiledGraph;
  }

  private normalizeText(text: string): string {
    return text
      .replace(/@_user_\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async classifyIntent(text: string): Promise<IntentClassification> {
    if (!text) {
      return { intent: 'unknown', confidence: 0.1, reason: '空文本' };
    }

    const lowered = text.toLowerCase();

    if (/(你是谁|你叫什么|你的身份|你能做什么)/.test(text)) {
      return {
        intent: 'agent_identity',
        confidence: 0.98,
        reason: '命中身份规则',
      };
    }

    if (/(做个|帮我写|规划|生成|整理|总结|方案)/.test(text)) {
      return {
        intent: 'task_execute',
        confidence: 0.8,
        reason: '命中任务规则',
      };
    }

    if (/(攻击|诈骗|破解|木马|毒品|暴力|仇恨|成人)/.test(lowered)) {
      return {
        intent: 'sensitive_or_disallowed',
        confidence: 0.95,
        reason: '命中安全规则',
      };
    }

    const prompt = [
      '你是一个意图分类器，只返回一个 JSON 对象。',
      '可选意图：chitchat, qa, task_execute, agent_identity, sensitive_or_disallowed, unknown。',
      '输出格式：{"intent":"...","confidence":0-1,"reason":"..."}',
      '如果不确定，请返回 unknown 且 confidence < 0.65。',
      `用户输入：${text}`,
    ].join('\n');

    try {
      const raw = await this.aiService.chat(prompt);
      const parsed = this.parseIntentJson(raw);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      this.logger.warn(`意图分类降级到兜底逻辑: ${(error as Error).message}`);
    }

    return {
      intent: 'chitchat',
      confidence: 0.6,
      reason: '分类兜底',
    };
  }

  private parseIntentJson(raw: string): IntentClassification | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }

    const intentSet = new Set<IntentType>([
      'chitchat',
      'qa',
      'task_execute',
      'agent_identity',
      'sensitive_or_disallowed',
      'unknown',
    ]);

    try {
      const jsonText = raw.slice(start, end + 1);
      const data = JSON.parse(jsonText) as {
        intent?: IntentType;
        confidence?: number;
        reason?: string;
      };

      const intent = data.intent;
      const confidence = Number(data.confidence);
      const reason = data.reason || 'LLM 分类';

      if (!intent || !intentSet.has(intent)) {
        return null;
      }

      if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
        return null;
      }

      return { intent, confidence, reason };
    } catch {
      return null;
    }
  }

  private resolvePersona(intent: IntentType): PersonaProfile {
    if (intent === 'sensitive_or_disallowed') {
      return this.personas.zeno;
    }

    return this.personas.zeno;
  }

  private resolveRoute(
    intent: IntentType,
    confidence: number,
  ): 'chat' | 'identity' | 'safe_refusal' | 'clarify' {
    if (intent === 'sensitive_or_disallowed') {
      return 'safe_refusal';
    }

    if (intent === 'agent_identity') {
      return 'identity';
    }

    if (intent === 'unknown' || confidence < 0.65) {
      return 'clarify';
    }

    return 'chat';
  }

  private buildIdentityReply(persona: PersonaProfile): string {
    return [
      `我是 ${persona.name}，定位是：${persona.role}。`,
      `我的沟通风格：${persona.tone}。`,
      `我会遵守这些规则：${persona.styleRules.join('；')}`,
      `边界约束：${persona.boundaries.join('；')}`,
    ].join('\n');
  }

  private async generateResponse(
    persona: PersonaProfile,
    text: string,
    intent: IntentType,
  ): Promise<string> {
    const prompt = [
      `你现在的身份是 ${persona.name}，角色：${persona.role}。`,
      `语气：${persona.tone}。`,
      `风格规则：${persona.styleRules.join('；')}`,
      `边界规则：${persona.boundaries.join('；')}`,
      `当前识别意图：${intent}。`,
      '请使用中文，先给结论，再给关键步骤。',
      `用户内容：${text}`,
    ].join('\n');

    const response = await this.aiService.chat(prompt);
    return (
      response.trim() ||
      '我已经理解你的问题了，你可以再补充一点上下文，我会给出更准确的答案。'
    );
  }
}
