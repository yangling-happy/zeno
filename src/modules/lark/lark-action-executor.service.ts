import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionInstruction } from '../agent/agent.types';
import { InstructionDetectorService } from '../common/instruction-detector.service';
import { shouldExpandTopicToContent } from '../common/topic-extraction.utils';
import { LarkBroadService } from './broad/lark-broad.service';
import { LarkDocService } from './doc/lark-doc.service';
import { LarkSlidesService } from './slides/lark-slides.service';

function parseLarkBoardCreateParams(raw: unknown): {
  title: string;
  summary?: string;
} | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== 'string') {
    return null;
  }
  if (o.summary !== undefined && typeof o.summary !== 'string') {
    return null;
  }
  return {
    title: o.title,
    summary: o.summary === undefined ? undefined : o.summary,
  };
}

@Injectable()
export class LarkActionExecutorService {
  private readonly logger = new Logger(LarkActionExecutorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly instructionDetector: InstructionDetectorService,
    private readonly docService: LarkDocService,
    private readonly slidesService: LarkSlidesService,
    private readonly broadService: LarkBroadService,
  ) {}

  async execute(action: ActionInstruction): Promise<string> {
    if (action.type === 'NONE') {
      return '';
    }

    try {
      const cloudFolderToken = this.resolveCloudFolderToken();

      switch (action.type) {
        case 'LARK_DOC_CREATE': {
          const contentToWrite = action.params.summary
            ? await this.resolveDocumentContent(action.params.summary)
            : undefined;

          this.logger.log(`doc_create_started: title=${action.params.title}`);
          const doc = await this.docService.createDocument(
            action.params.title,
            cloudFolderToken,
          );
          this.logger.log(`doc_create_succeeded: documentId=${doc.documentId}`);

          const docUrl =
            doc.url && doc.url.startsWith('http')
              ? doc.url
              : `https://feishu.cn/docx/${doc.documentId}`;

          if (contentToWrite) {
            this.logger.log(`doc_write_started: documentId=${doc.documentId}`);
            await this.docService.appendMarkdownToDocument(
              doc.documentId,
              contentToWrite,
            );
            this.logger.log(
              `doc_write_succeeded: documentId=${doc.documentId}`,
            );
          }
          return `📄 文档已创建：${docUrl}`;
        }

        case 'LARK_DOC_APPEND': {
          const documentId = action.params.documentId.trim();
          const generatedContent =
            await this.instructionDetector.processInstruction(
              action.params.text,
              `用户正在操作的文档ID: ${documentId}`,
            );
          const docResult = await this.docService.appendMarkdownToDocument(
            documentId,
            generatedContent,
          );
          const docUrl = `https://feishu.cn/docx/${documentId}`;
          return `📄 已追加到文档：${docUrl}\n（共添加 ${docResult.blockIds.length} 个内容块）`;
        }

        case 'LARK_PRESENT_CREATE': {
          const present = await this.slidesService.createPresentation(
            action.params.title,
          );
          return `🖼️ 演示内容已创建：${present.url}`;
        }

        case 'LARK_WHITEBOARD_APPEND': {
          const appendResult =
            await this.broadService.appendMarkdownToWhiteboard(
              action.params.whiteboardId,
              action.params.text,
            );
          return `🧩 已写入画板（Markdown→文本节点 whiteboard=${action.params.whiteboardId}，共 ${appendResult.nodeIds.length} 个节点）`;
        }

        case 'LARK_BOARD_CREATE': {
          const params = parseLarkBoardCreateParams(
            Reflect.get(action, 'params'),
          );
          if (!params) {
            return '';
          }
          const baseTitle = params.title.trim();
          const textDocTitle = `${baseTitle}（正文）`;
          const boardDocTitle = `${baseTitle}（画板）`;

          const textDoc = await this.docService.createDocument(
            textDocTitle,
            cloudFolderToken,
          );
          const contentToWrite = params.summary
            ? params.summary.length <= 20
              ? await this.resolveDocumentContent(params.summary)
              : params.summary
            : undefined;
          if (contentToWrite) {
            await this.docService.appendMarkdownToDocument(
              textDoc.documentId,
              contentToWrite,
            );
          }

          const board = await this.broadService.createDocumentWithBoard(
            boardDocTitle,
            contentToWrite,
            cloudFolderToken,
          );

          const textUrl =
            textDoc.url && textDoc.url.startsWith('http')
              ? textDoc.url
              : `https://feishu.cn/docx/${textDoc.documentId}`;

          return [
            `🎨 已创建正文与画板（两个独立链接）：`,
            `- 文档（完整正文）：${textUrl}`,
            `- 画板（含摘要内容，方便浏览与整理）：${board.docUrl}`,
            `- whiteboard_id=${board.whiteboardId}`,
          ].join('\n');
        }

        case 'LARK_DOC_PRESENT_LINK': {
          const doc = await this.docService.createDocument(
            action.params.title,
            cloudFolderToken,
          );

          if (action.params.summary) {
            const contentToWrite = shouldExpandTopicToContent(
              action.params.summary,
            )
              ? await this.resolveDocumentContent(action.params.summary)
              : action.params.summary;
            await this.docService.appendMarkdownToDocument(
              doc.documentId,
              contentToWrite,
            );
          }

          const docUrl =
            doc.url && doc.url.startsWith('http')
              ? doc.url
              : `https://feishu.cn/docx/${doc.documentId}`;

          return `📄 已创建文档：${docUrl}`;
        }

        default:
          return '';
      }
    } catch (error) {
      this.logger.error(`❌ 执行动作失败: ${action.type}`, error as Error);
      throw error;
    }
  }

  extractDocIdFromActionResult(actionResult: string): string | null {
    const urlMatch = actionResult.match(
      /https:\/\/feishu\.cn\/docx\/([A-Za-z0-9]+)/i,
    );
    return urlMatch ? urlMatch[1] : null;
  }

  extractWhiteboardIdFromActionResult(actionResult: string): string | null {
    const m = actionResult.match(/whiteboard_id=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  private resolveCloudFolderToken(): string | undefined {
    const raw = this.configService.get<string>('LARK_CLOUD_FOLDER_TOKEN');
    return typeof raw === 'string' && raw.trim().length > 0
      ? raw.trim()
      : undefined;
  }

  private async resolveDocumentContent(summary: string): Promise<string> {
    if (!shouldExpandTopicToContent(summary)) {
      return summary;
    }

    const content = await this.instructionDetector.generateDocumentMarkdown(
      `生成关于"${summary}"的完整文档内容，包括定义、要点、应用场景和总结，用Markdown格式输出`,
    );
    return content;
  }
}
