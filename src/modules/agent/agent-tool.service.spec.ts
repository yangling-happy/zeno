import { AgentToolService } from './agent-tool.service';

describe('AgentToolService', () => {
  let service: AgentToolService;

  beforeEach(() => {
    service = new AgentToolService();
  });

  it('should extract explicit topic instead of treating 写入 target as topic', () => {
    const action = service.buildActionInstruction(
      'SCENE_DOC',
      undefined,
      '帮我创建一个文档，写入一篇文章，主题是 LLM 幻觉',
      0.9,
    );

    expect(action.type).toBe('LARK_DOC_CREATE');
    if (action.type === 'LARK_DOC_CREATE') {
      expect(action.params.summary).toBe('LLM 幻觉');
    }
  });

  it('should not extract 入一篇文章 as fallback topic', () => {
    const action = service.buildActionInstruction(
      'SCENE_DOC',
      undefined,
      '帮我创建一个文档，写入一篇文章',
      0.9,
    );

    expect(action.type).toBe('LARK_DOC_CREATE');
    if (action.type === 'LARK_DOC_CREATE') {
      expect(action.params.summary).toBeUndefined();
    }
  });
});
