import { ConfigService } from '@nestjs/config';
import { LarkActionExecutorService } from './lark-action-executor.service';

describe('LarkActionExecutorService', () => {
  const configService = {
    get: jest.fn().mockReturnValue(''),
  } as unknown as ConfigService;

  const instructionDetector = {
    processInstruction: jest.fn(),
  };

  const docService = {
    createDocument: jest.fn(),
    appendMarkdownToDocument: jest.fn(),
  };

  const slidesService = {
    createPresentation: jest.fn(),
  };

  const broadService = {
    appendMarkdownToWhiteboard: jest.fn(),
    createDocumentWithBoard: jest.fn(),
  };

  let service: LarkActionExecutorService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LarkActionExecutorService(
      configService,
      instructionDetector as any,
      docService as any,
      slidesService as any,
      broadService as any,
    );

    docService.createDocument.mockResolvedValue({
      documentId: 'doc_test_123',
      url: 'https://feishu.cn/docx/doc_test_123',
    });
    docService.appendMarkdownToDocument.mockResolvedValue({
      blockIds: ['block_1'],
    });
  });

  it('should expand a single-line long topic into document content', async () => {
    instructionDetector.processInstruction.mockResolvedValueOnce(
      '# 发布说明\n\n这里是正文。',
    );

    await service.execute({
      type: 'LARK_DOC_CREATE',
      params: {
        title: '版本发布文档',
        summary: '面向程序员群体、核心更新为消息批量删除功能的版本发布文档',
      },
    });

    expect(instructionDetector.processInstruction).toHaveBeenCalledWith(
      '生成关于"面向程序员群体、核心更新为消息批量删除功能的版本发布文档"的完整文档内容，包括定义、要点、应用场景和总结，用Markdown格式输出',
    );
    expect(docService.appendMarkdownToDocument).toHaveBeenCalledWith(
      'doc_test_123',
      '# 发布说明\n\n这里是正文。',
    );
  });

  it('should append markdown summary directly without re-generating', async () => {
    await service.execute({
      type: 'LARK_DOC_CREATE',
      params: {
        title: '版本发布文档',
        summary: '# 标题\n\n- 要点一\n- 要点二',
      },
    });

    expect(instructionDetector.processInstruction).not.toHaveBeenCalled();
    expect(docService.appendMarkdownToDocument).toHaveBeenCalledWith(
      'doc_test_123',
      '# 标题\n\n- 要点一\n- 要点二',
    );
  });
});
