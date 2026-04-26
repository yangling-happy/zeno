import { Injectable, Logger } from '@nestjs/common';

interface CacheItem<T> {
  value: T;
  timestamp: number;
  expiry: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly cache = new Map<string, CacheItem<any>>();
  private readonly defaultExpiry = 5 * 60 * 1000; // 默认5分钟过期

  /**
   * 设置缓存
   * @param key 缓存键
   * @param value 缓存值
   * @param expiry 过期时间（毫秒）
   */
  set<T>(key: string, value: T, expiry: number = this.defaultExpiry): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      expiry,
    });
    this.logger.debug(`设置缓存: ${key}，过期时间: ${expiry}ms`);
  }

  /**
   * 获取缓存
   * @param key 缓存键
   * @returns 缓存值，如果不存在或已过期则返回 null
   */
  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) {
      return null;
    }

    if (Date.now() - item.timestamp > item.expiry) {
      this.cache.delete(key);
      this.logger.debug(`缓存已过期: ${key}`);
      return null;
    }

    return item.value;
  }

  /**
   * 删除缓存
   * @param key 缓存键
   */
  delete(key: string): void {
    this.cache.delete(key);
    this.logger.debug(`删除缓存: ${key}`);
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.logger.debug('清除所有缓存');
  }

  /**
   * 获取缓存大小
   * @returns 缓存大小
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 清理过期缓存
   */
  cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > item.expiry) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`清理了 ${cleanedCount} 个过期缓存`);
    }
  }
}
