// 1. 重新定义意图类型，直接对标场景 A-F
export type IntentType =
  | 'SCENE_PLAN' // 场景 B: 任务理解与规划
  | 'SCENE_DOC' // 场景 C: 文档/白板编辑
  | 'SCENE_PRESENT' // 场景 D: PPT/演示生成
  | 'SCENE_SYNC' // 场景 E: 多端协同同步
  | 'SCENE_DELIVERY' // 场景 F: 总结与交付
  | 'AGENT_IDENTITY' // 身份查询
  | 'SAFE_REFUSAL' // 安全拒答
  | 'CLARIFY' // 意图模糊需追问
  | 'CHITCHAT'; // 基础闲聊

export type SkillId =
  | 'planning.skill'
  | 'documentation.skill'
  | 'presentation.skill'
  | 'sync.skill'
  | 'delivery.skill'
  | 'identity.skill'
  | 'safety.skill'
  | 'clarify.skill'
  | 'chitchat.skill';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface SkillDefinition {
  id: SkillId;
  intent: IntentType;
  domainGoal: string;
  boundedContext:
    | 'Planning'
    | 'Documentation'
    | 'Presentation/Whiteboard'
    | 'Sync'
    | 'Delivery'
    | 'Conversation/Safety';
  triggerHints: string[];
  antiPatterns?: string[];
  requiredParams: string[];
  optionalParams?: string[];
  confidenceThreshold: number;
  riskLevel: RiskLevel;
  fallbackIntent: IntentType;
}

export interface SkillMatch {
  skillId: SkillId;
  intent: IntentType;
  confidence: number;
  reason: string;
  riskLevel: RiskLevel;
  parameters: Record<string, unknown>;
  missingRequiredParams: string[];
  fallbackReason?: string;
}

export interface SkillExecutionPlan {
  primarySkill: SkillMatch;
  secondarySkills: SkillMatch[];
}

export interface PersonaProfile {
  id: string;
  name: string;
  role: string;
  tone: string;
  styleRules: string[];
  boundaries: string[];
}

export interface AgentRunInput {
  text: string;
  userId?: string;
  channel?: string;
  /** 渠道侧最近创建/操作的云文档 ID，用于「在文末追加」等延续请求 */
  lastDocId?: string;
  memoryContext?: {
    recentConversations: Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
    }>;
    retrievedFacts: Array<{
      id: string;
      userId: string;
      content: string;
      category: string;
      embedding: number[];
      createdAt: number;
    }>;
    conversationTurnCount: number;
  };
}

export type ActionInstruction =
  | {
      type: 'NONE';
      params?: Record<string, unknown>;
    }
  | {
      type: 'LARK_DOC_CREATE';
      params: {
        title: string;
        summary?: string;
      };
    }
  | {
      type: 'LARK_DOC_APPEND';
      params: {
        documentId: string;
        /** 用户原文意图，下游将生成 Markdown 后追加 */
        text: string;
      };
    }
  | {
      type: 'LARK_PRESENT_CREATE';
      params: {
        title: string;
        summary?: string;
      };
    }
  | {
      type: 'LARK_WHITEBOARD_APPEND';
      params: {
        whiteboardId: string;
        text: string;
      };
    }
  | {
      type: 'LARK_BOARD_CREATE';
      params: {
        title: string;
        summary?: string;
      };
    }
  | {
      type: 'LARK_DOC_PRESENT_LINK';
      params: {
        title: string;
        summary?: string;
      };
    };

export interface AgentRunResult {
  intent: IntentType;
  confidence: number;
  response: string;
  trace: string[];
  // 结构化指令，用于飞书前端渲染卡片或执行跨端操作
  actionInstruction?: ActionInstruction;
  // 技能化执行计划（V1：主技能为单项，次技能队列为空）
  skillExecutionPlan?: SkillExecutionPlan;
}
