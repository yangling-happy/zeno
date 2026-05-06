export function stripInvisibleUnicode(s: string): string {
  return s.replace(/\u200b|\u200c|\u200d|\ufeff/gu, '');
}

/**
 * 递归收集整条 IM content JSON 里的字符串（链接常在嵌套字段，不在顶层 text）
 */
export function collectStringsDeepFromLarkContent(rawJson: string): string {
  try {
    const root = JSON.parse(rawJson) as unknown;
    const acc: string[] = [];
    const visit = (n: unknown): void => {
      if (typeof n === 'string') {
        acc.push(n);
      } else if (Array.isArray(n)) {
        for (const x of n) visit(x);
      } else if (n && typeof n === 'object') {
        for (const x of Object.values(n as Record<string, unknown>)) {
          visit(x);
        }
      }
    };
    visit(root);
    return acc.join('\n');
  } catch {
    return '';
  }
}

/**
 * 合并 extractText 得到的正文与原始 JSON 内所有字符串，用于解析 doc token / 追加意图
 */
export function mergeVisibleAndLarkJsonForDocOps(
  visibleText: string,
  rawMessageContent?: string,
): string {
  const nested = rawMessageContent
    ? collectStringsDeepFromLarkContent(rawMessageContent)
    : '';
  return stripInvisibleUnicode(
    [visibleText.trim(), nested].filter((s) => s.length > 0).join('\n'),
  );
}
