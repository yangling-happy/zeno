import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface FactSnippet {
  id: string;
  userId: string;
  content: string;
  category: 'preference' | 'decision' | 'key_data' | 'general';
  embedding: number[];
  createdAt: number;
  sourceConversationTurn?: number;
}

export interface MemoryContext {
  recentConversations: ConversationTurn[];
  retrievedFacts: FactSnippet[];
  conversationTurnCount: number;
}

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryService.name);
  private redisClient: Redis | null = null;
  private prisma: PrismaClient | null = null;
  private vectorStore: any = null;
  private readonly redisKeyPrefix = 'zeno:memory:';
  private readonly maxRecentTurns = 10;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    await this.initializeConnections();
  }

  async onModuleDestroy() {
    await this.cleanup();
  }

  private async initializeConnections() {
    await this.initRedis();
    await this.initPrisma();
    await this.initVectorStore();
  }

  private async initRedis() {
    try {
      const redisUrl = this.configService.get<string>('REDIS_URL');
      if (!redisUrl) {
        this.logger.warn('⚠️ REDIS_URL 未配置，即时上下文功能将不可用');
        return;
      }
      this.redisClient = new Redis(redisUrl);
      this.redisClient.on('error', (err) => {
        this.logger.error('❌ Redis 连接错误:', err);
      });
      this.logger.log('✅ Redis 连接成功');
    } catch (error) {
      this.logger.error('❌ Redis 初始化失败:', error);
    }
  }

  private async initPrisma() {
    try {
      this.prisma = new PrismaClient();
      await this.prisma.$connect();
      this.logger.log('✅ Prisma 连接成功');
    } catch (error) {
      this.logger.error('❌ Prisma 初始化失败:', error);
    }
  }

  private async initVectorStore() {
    if (!this.prisma) {
      this.logger.warn('⚠️ Prisma 未连接，向量存储功能将不可用');
      return;
    }
    try {
      const { OllamaEmbeddings } = require('@langchain/ollama');
      this.vectorStore = {
        embeddings: new OllamaEmbeddings({
          model: 'nomic-embed-text',
          baseUrl:
            this.configService.get<string>('OLLAMA_BASE_URL') ||
            'http://localhost:11434',
        }),
      };
      this.logger.log('✅ 向量存储初始化成功');
    } catch (error) {
      this.logger.warn('⚠️ 向量存储初始化失败:', error);
    }
  }

  async addConversationTurn(
    userId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata?: Record<string, any>,
  ): Promise<number> {
    const turn: ConversationTurn = {
      role,
      content,
      timestamp: Date.now(),
      metadata,
    };

    if (this.redisClient) {
      const key = `${this.redisKeyPrefix}recent:${userId}`;
      await this.redisClient.lpush(key, JSON.stringify(turn));
      await this.redisClient.ltrim(key, 0, this.maxRecentTurns - 1);
      await this.redisClient.expire(key, 7 * 24 * 60 * 60);
    }

    if (this.prisma) {
      await this.prisma.conversationHistory.create({
        data: {
          userId,
          role,
          content,
          metadata,
        },
      });
    }

    const turnCount = await this.getConversationTurnCount(userId);
    this.logger.debug(`📝 用户 ${userId} 对话轮次: ${turnCount}`);

    return turnCount;
  }

  async getRecentConversations(userId: string): Promise<ConversationTurn[]> {
    if (!this.redisClient) {
      return [];
    }

    const key = `${this.redisKeyPrefix}recent:${userId}`;
    const turns = await this.redisClient.lrange(
      key,
      0,
      this.maxRecentTurns - 1,
    );
    return turns.map((turn: string) => JSON.parse(turn)).reverse();
  }

  async getConversationTurnCount(userId: string): Promise<number> {
    if (!this.redisClient) {
      return 0;
    }
    const key = `${this.redisKeyPrefix}turn_count:${userId}`;
    const count = await this.redisClient.incr(key);
    await this.redisClient.expire(key, 30 * 24 * 60 * 60);
    return count;
  }

  async shouldTriggerSummarization(userId: string): Promise<boolean> {
    const count = await this.getConversationTurnCount(userId);
    return count > 0 && count % 10 === 0;
  }

  async extractAndStoreFacts(
    userId: string,
    conversations: ConversationTurn[],
  ): Promise<FactSnippet[]> {
    if (!this.vectorStore || !this.prisma) {
      this.logger.warn('⚠️ 向量存储或数据库不可用');
      return [];
    }

    const facts = await this.extractValuableFacts(userId, conversations);

    for (const fact of facts) {
      await this.storeFact(fact);
    }

    if (facts.length > 0) {
      await this.clearRecentConversations(userId);
    }

    return facts;
  }

  private async extractValuableFacts(
    userId: string,
    conversations: ConversationTurn[],
  ): Promise<FactSnippet[]> {
    const facts: FactSnippet[] = [];
    const preferenceKeywords = [
      '喜欢',
      '偏好',
      '希望',
      '想要',
      '倾向于',
      '喜欢用',
      'prefer',
      'like',
      'want',
    ];
    const decisionKeywords = [
      '决定',
      '选择',
      '确定',
      '结论',
      'agreed',
      'decided',
      'confirmed',
    ];
    const dataKeywords = [
      '数据',
      '数字',
      '日期',
      '金额',
      '数量',
      'data',
      'number',
      'date',
      'amount',
    ];

    for (let i = 0; i < conversations.length; i++) {
      const turn = conversations[i];
      if (turn.role !== 'user') continue;

      let category: FactSnippet['category'] = 'general';
      const content = turn.content;

      if (preferenceKeywords.some((kw) => content.includes(kw))) {
        category = 'preference';
      } else if (decisionKeywords.some((kw) => content.includes(kw))) {
        category = 'decision';
      } else if (dataKeywords.some((kw) => content.includes(kw))) {
        category = 'key_data';
      }

      if (category !== 'general') {
        try {
          const embedding =
            await this.vectorStore.embeddings.embedQuery(content);
          facts.push({
            id: `${userId}_${Date.now()}_${i}`,
            userId,
            content,
            category,
            embedding,
            createdAt: Date.now(),
            sourceConversationTurn: i,
          });
        } catch (error) {
          this.logger.warn(`⚠️ 生成 embedding 失败: ${error}`);
        }
      }
    }

    return facts;
  }

  private async storeFact(fact: FactSnippet): Promise<void> {
    if (!this.prisma) return;

    await this.prisma.factSnippet.create({
      data: {
        id: fact.id,
        userId: fact.userId,
        content: fact.content,
        category: fact.category,
        embedding: JSON.stringify(fact.embedding),
        createdAt: new Date(fact.createdAt),
        sourceConversationTurn: fact.sourceConversationTurn,
      },
    });
  }

  async retrieveRelevantFacts(
    userId: string,
    query: string,
    limit: number = 5,
  ): Promise<FactSnippet[]> {
    if (!this.prisma) {
      return [];
    }

    const facts = await this.prisma.factSnippet.findMany({
      where: { userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return facts.map((fact) => ({
      id: fact.id,
      userId: fact.userId,
      content: fact.content,
      category: fact.category as FactSnippet['category'],
      embedding: JSON.parse(fact.embedding),
      createdAt: fact.createdAt.getTime(),
      sourceConversationTurn: fact.sourceConversationTurn ?? undefined,
    }));
  }

  async buildContextBackground(
    userId: string,
    currentQuery: string,
  ): Promise<MemoryContext> {
    const recentConversations = await this.getRecentConversations(userId);
    const retrievedFacts = await this.retrieveRelevantFacts(
      userId,
      currentQuery,
    );
    const conversationTurnCount = await this.getConversationTurnCount(userId);

    return {
      recentConversations,
      retrievedFacts,
      conversationTurnCount,
    };
  }

  private async clearRecentConversations(userId: string): Promise<void> {
    if (!this.redisClient) return;

    const key = `${this.redisKeyPrefix}recent:${userId}`;
    await this.redisClient.del(key);
    this.logger.debug(`🗑️ 已清空用户 ${userId} 的最近对话`);
  }

  async getConversationHistory(
    userId: string,
    limit: number = 100,
  ): Promise<ConversationTurn[]> {
    if (!this.prisma) return [];

    const history = await this.prisma.conversationHistory.findMany({
      where: { userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return history.map((item) => ({
      role: item.role as 'user' | 'assistant',
      content: item.content,
      timestamp: item.createdAt.getTime(),
      metadata: item.metadata as Record<string, any> | undefined,
    }));
  }

  private async cleanup() {
    if (this.redisClient) {
      await this.redisClient.quit();
    }
    if (this.prisma) {
      await this.prisma.$disconnect();
    }
  }
}
