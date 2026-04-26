import { Logger } from '@nestjs/common';

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
  actionInstruction?: any,
): {
  response: string;
  actionInstruction?: any;
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
export function updateStateWithTrace<T>(
  state: T,
  updates: Partial<T>,
  trace: string,
): T & { trace: string[] } {
  return {
    ...state,
    ...updates,
    trace: [...(state as any).trace, trace],
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