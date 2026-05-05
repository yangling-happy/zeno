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

  it('should prefer creating a doc with embedded board when user asks to create a board', () => {
    const action = service.buildActionInstruction(
      'SCENE_PRESENT',
      {},
      '帮我创建一个画板，主题是迭代规划',
      0.9,
    );

    expect(action.type).toBe('LARK_BOARD_CREATE');
    if (action.type === 'LARK_BOARD_CREATE') {
      expect(action.params.summary).toBe('迭代规划');
    }
  });

  it('should append markdown to an existing whiteboard when whiteboardId is provided', () => {
    const action = service.buildActionInstruction(
      'SCENE_PRESENT',
      { whiteboardId: 'wb_demo_token', summary: '# 标题\n正文' },
      '把这段写入画布',
      0.9,
    );

    expect(action.type).toBe('LARK_WHITEBOARD_APPEND');
    if (action.type === 'LARK_WHITEBOARD_APPEND') {
      expect(action.params.whiteboardId).toBe('wb_demo_token');
    }
  });
});
