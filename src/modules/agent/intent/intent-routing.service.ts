import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import { IntentType, SkillExecutionPlan } from '../agent.types';
import { IntentClassification, IntentSchema } from '../zod/agent-zod.schema';
import {
  INTENT_RECOGNITION_EXAMPLES,
  INTENT_RECOGNITION_REGEX_RULES,
  buildSkillPromptContext,
} from '../skill/skill.registry';
import { detectRequestNature } from '../../common/agent.utils';

type RoutingSource = 'regex' | 'vector' | 'llm' | 'gate';

type VectorCandidate = {
  intent: IntentType;
  score: number;
  exemplar: string;
};

interface RouteResult {
  classification: IntentClassification;
  source: RoutingSource;
  candidates?: VectorCandidate[];
}

@Injectable()
export class IntentRoutingService {
  private readonly logger = new Logger(IntentRoutingService.name);
  private readonly embeddingCache = new Map<string, Map<string, number>>();
  private readonly exemplarVectors = this.buildExemplarVectors();
  private readonly vectorAcceptThreshold = 0.75;
  private readonly vectorReviewThreshold = 0.6;

  constructor(private readonly aiService: AiService) {}

  async route(text: string): Promise<RouteResult> {
    const normalizedText = text.trim();
    const requestNature = detectRequestNature(normalizedText);

    if (requestNature.isConsultativeQuestion) {
      const classification: IntentClassification = {
        intent: 'CHITCHAT',
        confidence: 0.96,
        reason: `咨询型问题命中 ${requestNature.matchedDomainPhrases.join('、')}，应优先按问答而不是执行请求处理`,
        parameters: {
          routingSource: 'gate',
          requestKind: 'consultation',
          matchedDomainPhrases: requestNature.matchedDomainPhrases,
          matchedConsultativePhrases: requestNature.matchedConsultativePhrases,
        },
      };

      return { classification, source: 'gate' };
    }

    const regexMatch = this.matchByRegex(normalizedText);
    if (regexMatch) {
      return {
        classification: {
          intent: regexMatch.intent,
          confidence: 0.98,
          reason: `正则规则命中：${regexMatch.rule}`,
          parameters: {
            routingSource: 'regex',
            matchedRule: regexMatch.rule,
          },
        },
        source: 'regex',
      };
    }

    const vectorMatch = this.matchByVector(normalizedText);
    if (vectorMatch && vectorMatch.score >= this.vectorAcceptThreshold) {
      return {
        classification: {
          intent: vectorMatch.intent,
          confidence: Number(vectorMatch.score.toFixed(2)),
          reason: `向量检索高置信命中：${vectorMatch.exemplar}`,
          parameters: {
            routingSource: 'vector',
            similarity: Number(vectorMatch.score.toFixed(3)),
            exemplar: vectorMatch.exemplar,
          },
        },
        source: 'vector',
        candidates: [vectorMatch],
      };
    }

    if (vectorMatch && vectorMatch.score >= this.vectorReviewThreshold) {
      const classification = await this.judgeWithLlm(normalizedText, [
        vectorMatch,
      ]);
      return {
        classification,
        source: 'llm',
        candidates: [vectorMatch],
      };
    }

    const topCandidates = this.getTopVectorCandidates(normalizedText, 3);
    const classification = await this.judgeWithLlm(
      normalizedText,
      topCandidates,
    );
    return {
      classification,
      source: 'llm',
      candidates: topCandidates,
    };
  }

  private matchByRegex(
    text: string,
  ): { intent: IntentType; rule: string } | null {
    for (const [intent, rules] of Object.entries(
      INTENT_RECOGNITION_REGEX_RULES,
    ) as [IntentType, RegExp[]][]) {
      for (const rule of rules) {
        if (rule.test(text)) {
          return { intent, rule: rule.source };
        }
      }
    }

    return null;
  }

  private matchByVector(text: string): VectorCandidate | null {
    const candidates = this.getTopVectorCandidates(text, 1);
    return candidates[0] ?? null;
  }

  private getTopVectorCandidates(
    text: string,
    limit: number,
  ): VectorCandidate[] {
    const queryVector = this.getEmbedding(text);
    const scored: VectorCandidate[] = [];

    for (const item of this.exemplarVectors) {
      const score = this.cosineSimilarity(queryVector, item.vector);
      scored.push({
        intent: item.intent,
        score,
        exemplar: item.exemplar,
      });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async judgeWithLlm(
    text: string,
    candidates: VectorCandidate[],
  ): Promise<IntentClassification> {
    const candidateText = candidates
      .map(
        (candidate, index) =>
          `${index + 1}. ${candidate.intent} (相似度=${candidate.score.toFixed(3)}) 示例：${candidate.exemplar}`,
      )
      .join('\n');

    const prompt = `你是 Zeno 的意图判定器。
你的核心职责是区分：执行请求、咨询问题、身份问答、以及安全拒答。
请特别注意：咨询、建议、最佳实践、为什么这样写、怎么写、如何写，这类表达优先判为 CHITCHAT，而不是创建类任务。

候选意图如下：
${candidateText || '无'}

意图定义：
${buildSkillPromptContext()}

请只返回严格 JSON：
{"intent":"...","confidence":0-1,"reason":"...","parameters":{}}

用户输入：${text}`;

    try {
      const response = await this.aiService.chat(prompt);
      const parsed = JSON.parse(response);
      const result = IntentSchema.parse(parsed);

      return {
        ...result,
        confidence: Math.max(0.5, Math.min(1, result.confidence)),
        parameters: {
          ...(result.parameters ?? {}),
          routingSource: 'llm',
          retrievedCandidates: candidates.map((candidate) => ({
            intent: candidate.intent,
            score: Number(candidate.score.toFixed(3)),
            exemplar: candidate.exemplar,
          })),
        },
      };
    } catch (error) {
      this.logger.warn(
        `LLM 意图判定失败，降级为 CLARIFY: ${(error as Error).message}`,
      );

      return {
        intent: 'CLARIFY',
        confidence: 0.5,
        reason: 'LLM 判定失败，触发澄清',
        parameters: {
          routingSource: 'llm',
          fallback: true,
        },
      };
    }
  }

  private buildExemplarVectors(): Array<{
    intent: IntentType;
    exemplar: string;
    vector: Map<string, number>;
  }> {
    const vectors: Array<{
      intent: IntentType;
      exemplar: string;
      vector: Map<string, number>;
    }> = [];

    for (const [intent, examples] of Object.entries(
      INTENT_RECOGNITION_EXAMPLES,
    ) as [IntentType, string[]][]) {
      for (const exemplar of examples) {
        vectors.push({
          intent,
          exemplar,
          vector: this.getEmbedding(exemplar),
        });
      }
    }

    return vectors;
  }

  private getEmbedding(text: string): Map<string, number> {
    const cacheKey = text.trim().toLowerCase();
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const vector = new Map<string, number>();
    const normalized = cacheKey.replace(/\s+/g, '');
    const tokens = new Set<string>();

    for (let i = 0; i < normalized.length; i++) {
      tokens.add(normalized.slice(i, i + 1));
      if (i + 2 <= normalized.length) {
        tokens.add(normalized.slice(i, i + 2));
      }
      if (i + 3 <= normalized.length) {
        tokens.add(normalized.slice(i, i + 3));
      }
    }

    const splitTokens = normalized
      .split(/[^\u4e00-\u9fa5a-z0-9]+/i)
      .filter(Boolean);
    for (const token of splitTokens) {
      tokens.add(token);
    }

    const domainKeywords = [
      '文档',
      '计划',
      'PPT',
      '演示',
      '同步',
      '总结',
      '交付',
      '身份',
      '建议',
      '怎么写',
      '如何写',
      '最佳实践',
    ];

    for (const keyword of domainKeywords) {
      if (normalized.includes(keyword.toLowerCase())) {
        tokens.add(keyword.toLowerCase());
      }
    }

    for (const token of tokens) {
      const weight = token.length >= 3 ? 1.4 : token.length === 2 ? 1.1 : 0.3;
      vector.set(token, (vector.get(token) || 0) + weight);
    }

    this.normalizeVector(vector);
    this.embeddingCache.set(cacheKey, vector);
    return vector;
  }

  private normalizeVector(vector: Map<string, number>) {
    let norm = 0;
    for (const value of vector.values()) {
      norm += value * value;
    }

    if (norm <= 0) {
      return;
    }

    const length = Math.sqrt(norm);
    for (const [key, value] of vector.entries()) {
      vector.set(key, value / length);
    }
  }

  private cosineSimilarity(
    a: Map<string, number>,
    b: Map<string, number>,
  ): number {
    let dot = 0;
    for (const [key, value] of a.entries()) {
      dot += value * (b.get(key) || 0);
    }
    return dot;
  }
}
