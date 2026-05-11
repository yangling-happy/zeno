export interface LarkWebhookMessage {
  chat_id?: string;
  open_id?: string;
  content?: string;
  message_id?: string;
}

export interface LarkWebhookEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message?: LarkWebhookMessage;
}

export interface LarkCardData {
  message?: string;
}
