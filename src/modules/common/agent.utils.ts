import { Logger } from '@nestjs/common';
import type { ActionInstruction } from '../agent/agent.types';

const ACTION_PHRASES = [
  '写入',
  '写进',
  '帮我写',
  '帮我生成',
  '帮我创建',
  '帮我做',
  '请写',
  '请生成',
  '请创建',
  '请制作',
  '生成',
  '创建',
  '制作',
  '写一篇',
  '写一份',
  '写一段',
  '写一个',
  '起草',
  '撰写',
  '整理成',
  '补充到',
  '追加到',
  '填充',
  '导出',
  '追加',
  '同步',
  '填入',
  '改写',
  '改成',
  '输出',
  '要一个',
  '给我一个',
];

const CONSULTATIVE_PHRASES = [
  '有什么建议',
  '有哪些建议',
  '怎么写',
  '如何写',
  '怎么做',
  '如何做',
  '有什么技巧',
  '有哪些技巧',
  '注意事项',
  '写作建议',
  '文档建议',
  '推荐',
  '规范',
  '区别',
  '为什么',
  '是什么',
  '适合',
  '请教',
  '参考',
  '讲讲',
];

const DOMAIN_PHRASES = [
  '文档',
  'PPT',
  '演示',
  '画布',
  '白板',
  '同步',
  '计划',
  '汇报',
  '纪要',
];

export interface RequestNature {
  isActionRequest: boolean;
  isConsultativeQuestion: boolean;
  matchedActionPhrases: string[];
  matchedConsultativePhrases: string[];
  matchedDomainPhrases: string[];
}

export function detectRequestNature(text: string): RequestNature {
  const normalizedText = text.trim();

  const matchedActionPhrases = ACTION_PHRASES.filter((phrase) =>
    normalizedText.includes(phrase),
  );
  const matchedConsultativePhrases = CONSULTATIVE_PHRASES.filter((phrase) =>
    normalizedText.includes(phrase),
  );
  const matchedDomainPhrases = DOMAIN_PHRASES.filter((phrase) =>
    normalizedText.includes(phrase),
  );

  const hasQuestionMark = /[?？]/.test(normalizedText);
  const hasExplicitActionVerb = /帮我|请|麻烦|给我|想要/.test(normalizedText);
  const looksConsultative =
    hasQuestionMark || matchedConsultativePhrases.length > 0;
  const looksDomainRelated = matchedDomainPhrases.length > 0;

  const isActionRequest =
    matchedActionPhrases.length > 0 &&
    !(looksConsultative && !hasExplicitActionVerb);

  return {
    isActionRequest,
    isConsultativeQuestion:
      looksConsultative && looksDomainRelated && !isActionRequest,
    matchedActionPhrases,
    matchedConsultativePhrases,
    matchedDomainPhrases,
  };
}

export function isLikelyActionRequest(text: string): boolean {
  return detectRequestNature(text).isActionRequest;
}

/**
 * 检查速率限制
 * @param userId 用户ID
 * @param requestTimestamps 请求时间戳映射
 * @param rateLimitWindow 速率限制窗口（毫秒）
 * @param rateLimitMax 每窗口最大请求数
 * @returns 是否允许请求
 */
export function checkRateLimit(
  userId: string,
  requestTimestamps: Map<string, number[]>,
  rateLimitWindow: number,
  rateLimitMax: number,
): boolean {
  const now = Date.now();
  let timestamps = requestTimestamps.get(userId) || [];

  // 过滤出窗口内的请求
  timestamps = timestamps.filter(
    (timestamp) => now - timestamp < rateLimitWindow,
  );

  // 检查是否超过限制
  if (timestamps.length >= rateLimitMax) {
    requestTimestamps.set(userId, timestamps);
    return false;
  }

  // 添加当前请求时间戳
  timestamps.push(now);
  requestTimestamps.set(userId, timestamps);

  return true;
}

/**
 * 构建响应对象
 * @param response 响应文本
 * @param actionInstruction 动作指令
 * @returns 响应对象
 */
export function buildResponse(
  response: string,
  actionInstruction?: ActionInstruction,
): {
  response: string;
  actionInstruction?: ActionInstruction;
} {
  return {
    response,
    actionInstruction,
  };
}

/**
 * 更新状态并添加追踪
 * @param state 当前状态
 * @param updates 要更新的状态
 * @param trace 追踪信息
 * @returns 更新后的状态
 */
export function updateStateWithTrace<T extends { trace?: string[] }>(
  state: T,
  updates: Partial<Omit<T, 'trace'>>,
  traceStep: string,
): T & { trace: string[] } {
  const prevTrace = state.trace ?? [];
  return {
    ...state,
    ...updates,
    trace: [...prevTrace, traceStep],
  };
}

/**
 * 清理过期数据
 * @param dataMap 数据映射
 * @param maxAge 最大年龄（毫秒）
 * @param logger 日志记录器
 * @returns 清理的数量
 */
export function cleanupExpiredData<T>(
  dataMap: Map<string, { lastActive: number } & T>,
  maxAge: number,
  logger: Logger,
): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [key, data] of dataMap.entries()) {
    if (now - data.lastActive > maxAge) {
      dataMap.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.debug(`清理了 ${cleanedCount} 个过期数据`);
  }

  return cleanedCount;
}
