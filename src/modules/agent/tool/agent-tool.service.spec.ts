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

  it('should not treat 写进文档里面 as a topic', () => {
    const action = service.buildActionInstruction(
      'SCENE_DOC',
      undefined,
      '你帮我写进文档里面，创建一个文档',
      0.9,
    );

    expect(action.type).toBe('LARK_DOC_CREATE');
    if (action.type === 'LARK_DOC_CREATE') {
      expect(action.params.summary).toBeUndefined();
    }
  });

  it('should extract explicit document theme after create request', () => {
    const action = service.buildActionInstruction(
      'SCENE_DOC',
      undefined,
      '你帮我写进文档里面，创建一个面向程序员群体、核心更新为消息批量删除功能的版本发布文档',
      0.9,
    );

    expect(action.type).toBe('LARK_DOC_CREATE');
    if (action.type === 'LARK_DOC_CREATE') {
      expect(action.params.summary).toContain('面向程序员群体');
      expect(action.params.summary).toContain('消息批量删除功能');
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

  it('should treat 画布 like 画板 for LARK_BOARD_CREATE (not LARK_DOC_PRESENT_LINK)', () => {
    const action = service.buildActionInstruction(
      'SCENE_PRESENT',
      {},
      '给我创建一个画布，写大模型幻觉的',
      0.9,
    );

    expect(action.type).toBe('LARK_BOARD_CREATE');
    if (action.type === 'LARK_BOARD_CREATE') {
      expect(action.params.summary).toMatch(/大模型幻觉/);
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

  it('should append to last doc when user asks to add at end and lastDocId is set', () => {
    const action = service.buildActionInstruction(
      'SCENE_DOC',
      { docTitle: '测试', summary: '占位' },
      '在文章末尾加入一小段总结',
      0.9,
      { lastDocId: 'doc_prev_abc' },
    );

    expect(action.type).toBe('LARK_DOC_APPEND');
    if (action.type === 'LARK_DOC_APPEND') {
      expect(action.params.documentId).toBe('doc_prev_abc');
      expect(action.params.text).toContain('末尾');
    }
  });

  it('should create new doc when user explicitly asks for a new document despite lastDocId', () => {
    const action = service.buildActionInstruction(
      'SCENE_DOC',
      {},
      '帮我重新写一篇关于验收的文档',
      0.9,
      { lastDocId: 'doc_prev_abc' },
    );

    expect(action.type).toBe('LARK_DOC_CREATE');
  });
});
