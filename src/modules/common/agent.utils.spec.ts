import { detectRequestNature, isLikelyActionRequest } from './agent.utils';

describe('agent.utils request nature', () => {
  it('should detect 写入内容 as actionable request', () => {
    const text = '在这个文档里面写入内容，关于ai科普的，500字';
    const nature = detectRequestNature(text);

    expect(nature.isActionRequest).toBe(true);
    expect(isLikelyActionRequest(text)).toBe(true);
    expect(nature.matchedActionPhrases).toContain('写入');
  });
});
