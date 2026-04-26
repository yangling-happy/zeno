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
}
