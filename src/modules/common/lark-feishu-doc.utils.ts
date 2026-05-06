import { stripInvisibleUnicode } from './lark-doc-haystack.utils';

const FEISHU_DOCX_URL_GLOBAL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)?feishu\.cn\/docx\/[A-Za-z0-9]+/gi;

const LARKSUITE_DOCX_URL_GLOBAL_RE =
  /https?:\/\/[\w.-]*larksuite\.com\/docx\/[A-Za-z0-9]+/gi;

export {
  collectStringsDeepFromLarkContent,
  mergeVisibleAndLarkJsonForDocOps,
} from './lark-doc-haystack.utils';

/**
 * 从用户消息中提取首个飞书云文档 document token（用户常粘贴机器人回复里的链接）
 */
export function extractFirstFeishuDocToken(text: string): string | undefined {
  const t = stripInvisibleUnicode(text);
  const patterns = [
    /https?:\/\/(?:[a-z0-9-]+\.)?feishu\.cn\/docx\/([A-Za-z0-9]+)/i,
    /https?:\/\/[\w.-]*larksuite\.com\/docx\/([A-Za-z0-9]+)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

/**
 * 去掉链接与常见机器人前缀，仅保留追加指令正文，便于写入 LLM 生成段落
 */
export function compactLarkDocAppendInstruction(text: string): string {
  let t = stripInvisibleUnicode(text);
  t = t.replace(FEISHU_DOCX_URL_GLOBAL_RE, ' ');
  t = t.replace(LARKSUITE_DOCX_URL_GLOBAL_RE, ' ');
  t = t.replace(/📄\s*文档已创建\s*[：:]*/gi, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
