import { detectRequestNature, isLikelyActionRequest } from './agent.utils';
import {
  compactLarkDocAppendInstruction,
  extractFirstFeishuDocToken,
} from './lark-feishu-doc.utils';
import { shouldAppendToLastLarkDoc } from './lark-doc-append.utils';

describe('agent.utils request nature', () => {
  it('should detect 写入内容 as actionable request', () => {
    const text = '在这个文档里面写入内容，关于ai科普的，500字';
    const nature = detectRequestNature(text);

    expect(nature.isActionRequest).toBe(true);
    expect(isLikelyActionRequest(text)).toBe(true);
    expect(nature.matchedActionPhrases).toContain('写入');
  });
});

describe('shouldAppendToLastLarkDoc', () => {
  it('should match 追加结尾 with lastDocId (delivery mis-route guard)', () => {
    expect(shouldAppendToLastLarkDoc('追加结尾，ai生成仅供参考', 'doc_x')).toBe(
      true,
    );
  });

  it('should not append when user asks for a brand-new doc', () => {
    expect(shouldAppendToLastLarkDoc('重新写一篇验收文档', 'doc_x')).toBe(
      false,
    );
  });
});

describe('Feishu doc token & append instruction cleanup', () => {
  it('should extract token from pasted bot reply line', () => {
    const raw =
      '📄 文档已创建：\n\nhttps://feishu.cn/docx/WY93dB01Hoz0m5xA1nVCzLbENHO 追加结尾，ai生成仅供参考';
    expect(extractFirstFeishuDocToken(raw)).toBe('WY93dB01Hoz0m5xA1nVCzLbENHO');
    expect(compactLarkDocAppendInstruction(raw)).toContain('追加结尾');
    expect(compactLarkDocAppendInstruction(raw)).not.toMatch(/feishu\.cn/);
  });
});
