import {
  collectStringsDeepFromLarkContent,
  extractFirstFeishuDocToken,
  mergeVisibleAndLarkJsonForDocOps,
  compactLarkDocAppendInstruction,
} from './lark-feishu-doc.utils';

describe('mergeVisibleAndLarkJsonForDocOps', () => {
  it('finds doc token when URL only lives in nested Lark JSON (common for link preview)', () => {
    const raw = JSON.stringify({
      text: '追加结尾，ai生成仅供参考',
      post: {
        href: 'https://feishu.cn/docx/wy93db01hoz0m5xA1nvczlbenho',
      },
    });
    const visible = '追加结尾，ai生成仅供参考';
    const merged = mergeVisibleAndLarkJsonForDocOps(visible, raw);
    expect(extractFirstFeishuDocToken(merged)).toBe(
      'wy93db01hoz0m5xA1nvczlbenho',
    );
    expect(compactLarkDocAppendInstruction(merged)).toContain('追加结尾');
  });
});

describe('collectStringsDeepFromLarkContent', () => {
  it('collects nested strings', () => {
    const s = collectStringsDeepFromLarkContent(
      JSON.stringify({ a: { b: 'https://feishu.cn/docx/AbC123' } }),
    );
    expect(s).toContain('https://feishu.cn/docx/AbC123');
  });
});
