import { Injectable, Logger } from '@nestjs/common';

interface Session {
  id: string;
  userId: string;
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
  lastActive: number;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private sessions = new Map<string, Session>();
  private readonly maxSessionAge = 24 * 60 * 60 * 1000; // 24小时
  private readonly maxHistoryLength = 50; // 最大历史记录长度

  /**
   * 获取或创建会话
   * @param userId 用户ID
   * @returns 会话对象
   */
  getOrCreateSession(userId: string): Session {
    this.cleanupExpiredSessions();

    let session = this.sessions.get(userId);
    if (!session) {
      session = {
        id: `session_${userId}_${Date.now()}`,
        userId,
        history: [],
        lastActive: Date.now(),
      };
      this.sessions.set(userId, session);
      this.logger.debug(`创建新会话: ${session.id}`);
    } else {
      session.lastActive = Date.now();
      this.logger.debug(`使用现有会话: ${session.id}`);
    }

    return session;
  }

  /**
   * 添加消息到会话历史
   * @param userId 用户ID
   * @param role 角色
   * @param content 内容
   */
  addMessage(userId: string, role: 'user' | 'assistant', content: string): void {
    const session = this.getOrCreateSession(userId);
    
    session.history.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // 限制历史记录长度
    if (session.history.length > this.maxHistoryLength) {
      session.history = session.history.slice(-this.maxHistoryLength);
    }

    this.logger.debug(`添加消息到会话 ${session.id}: ${role} - ${content.substring(0, 50)}...`);
  }

  /**
   * 获取会话历史
   * @param userId 用户ID
   * @param limit 限制返回的消息数量
   * @returns 会话历史
   */
  getSessionHistory(userId: string, limit: number = 20): Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }> {
    const session = this.getOrCreateSession(userId);
    return session.history.slice(-limit);
  }

  /**
   * 清理过期会话
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [userId, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.maxSessionAge) {
        this.sessions.delete(userId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`清理了 ${cleanedCount} 个过期会话`);
    }
  }

  /**
   * 清除用户会话
   * @param userId 用户ID
   */
  clearSession(userId: string): void {
    this.sessions.delete(userId);
    this.logger.debug(`清除用户 ${userId} 的会话`);
  }

  /**
   * 获取会话数量
   * @returns 会话数量
   */
  getSessionCount(): number {
    this.cleanupExpiredSessions();
    return this.sessions.size;
  }
}