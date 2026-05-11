const TOPIC_PATTERNS: RegExp[] = [
  /(?:主题|题目)\s*(?:是|为|叫|：|:)\s*([^，,。!！?？]+)/i,
  /以\s*([^，,。!！?？]+?)\s*为主题/i,
  /(?:关于|围绕|有关)\s*([^，,。!！?？]+)/i,
  /(?:创建|生成)(?:一篇|一份|一个)?\s*([^，,。!！?？]{2,80}?(?:发布文档|技术文档|文档|文章|稿件|稿|方案|纪要|说明|提纲))/i,
  /写(?!入|进|到|在|至)(?:关于|)\s*([^\s，,。!！?？]+(?:的?[^\s，,。!！?？]+)?)/,
  /创建.*文档.*写(?!入|进|到|在|至)([^，,。!！?？]+)/,
  /生成.*文档.*写(?!入|进|到|在|至)([^，,。!！?？]+)/,
  /文档.*写(?!入|进|到|在|至)([^，,。!！?？]+)/,
];

const GENERIC_TOPIC_RE =
  /^(?:一篇|一份|一个)?(?:文章|文档|内容|材料|报告|方案|纪要|说明|提纲)$/i;
const LOCATION_TOPIC_RE =
  /^(?:(?:进|到|在|至)(?:文档|文章|正文|材料|报告)?(?:里面|里|中|内)?|(?:文档|文章|正文|材料|报告)(?:里面|里|中|内)?)$/i;

export function normalizeTopicCandidate(topic: string): string | undefined {
  const normalized = topic
    .trim()
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/^(?:是|为|叫|：|:)\s*/, '')
    .replace(/^(?:一个|一篇|一份)\s*/, '')
    .replace(/(?:的)?(?:文章|内容|材料)$/i, '')
    .trim();

  if (!normalized) {
    return undefined;
  }

  if (GENERIC_TOPIC_RE.test(normalized) || LOCATION_TOPIC_RE.test(normalized)) {
    return undefined;
  }

  return normalized;
}

export function extractTopicFromText(text: string): string | undefined {
  for (const pattern of TOPIC_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const topic = normalizeTopicCandidate(match[1]);
    if (topic && topic.length >= 2 && topic.length <= 80) {
      return topic;
    }
  }

  return undefined;
}

export function shouldExpandTopicToContent(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed.includes('\n') ||
    /^#{1,6}\s/m.test(trimmed) ||
    /^[-*]\s/m.test(trimmed) ||
    /^\d+\.\s/m.test(trimmed) ||
    /```/.test(trimmed)
  ) {
    return false;
  }

  return true;
}
