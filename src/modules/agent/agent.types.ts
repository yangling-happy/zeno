export type IntentType =
  | 'chitchat'
  | 'qa'
  | 'task_execute'
  | 'agent_identity'
  | 'sensitive_or_disallowed'
  | 'unknown';

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

export interface AgentRunResult {
  intent: IntentType;
  confidence: number;
  personaId: string;
  response: string;
  trace: string[];
}
