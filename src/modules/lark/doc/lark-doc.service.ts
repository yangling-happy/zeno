import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { LarkDocWriterService } from './lark-doc-writer.service';
import {
  BlockChildren,
  BatchCreateBlock,
  BlockCreationResult,
  BatchBlockCreationResult,
  ImageUploadResult,
} from './lark-doc-block.types';
import { InstructionDetectorService } from '../../common/instruction-detector.service';

/** SDK Client 类型未暴露 docx，按需收窄以避免 unsafe any */
interface LarkDocxDocumentCreateResponse {
  data?: {
    document?: { document_id?: string };
    document_id?: string;
  };
}

interface LarkDocxBlockChild {
  block_id?: string;
}

interface LarkDocxDocumentBlockChildrenCreateResponse {
  data?: {
    children?: LarkDocxBlockChild[];
  };
}

interface LarkDocxImageCreateResponse {
  data?: {
    image?: { token?: string };
    token?: string;
  };
}

interface LarkDocxClient {
  docx: {
    v1: {
      document: {
        create(params: {
          data: { title: string; folder_token?: string };
        }): Promise<LarkDocxDocumentCreateResponse>;
      };
      documentBlockChildren: {
        create(params: {
          path: { document_id: string; block_id: string };
          data: {
            children: BlockChildren[];
            index?: number;
          };
        }): Promise<LarkDocxDocumentBlockChildrenCreateResponse>;
      };
      documentBlock: {
        update(params: {
          path: { document_id: string; block_id: string };
          data: {
            update_text_elements?: unknown;
          };
        }): Promise<unknown>;
      };
      image: {
        create(params: {
          path: { document_id: string };
          data: {
            file_name: string;
            image_type: string;
          };
        }): Promise<LarkDocxImageCreateResponse>;
      };
    };
  };
}

function extractCreatedBlockIds(
  response: LarkDocxDocumentBlockChildrenCreateResponse,
): string[] {
  const children = response.data?.children ?? [];
  return children
    .map((child) => child.block_id)
    .filter((id): id is string => typeof id === 'string');
}

function readOptionalConfigFolderToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** SDK 底层多为 axios；不直接依赖 axios 类型，用结构识别以便打出飞书响应体 */
function tryReadHttpClientResponse(error: unknown):
  | {
      status?: number;
      data?: unknown;
    }
  | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const resp = (error as { response?: unknown }).response;
  if (typeof resp !== 'object' || resp === null) {
    return undefined;
  }
  const r = resp as { status?: unknown; data?: unknown };
  const status = typeof r.status === 'number' ? r.status : undefined;
  return { status, data: r.data };
}

function serializeFeishuErrorPayload(data: unknown, maxLen = 2000): string {
  if (data === undefined || data === null) {
    return '';
  }
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return '[Unserializable error payload]';
  }
}

function describeDocumentCreateFailure(error: unknown): string {
  const http = tryReadHttpClientResponse(error);
  if (!http) {
    return error instanceof Error ? error.message : String(error);
  }
  const env =
    http.data !== undefined &&
    typeof http.data === 'object' &&
    http.data !== null &&
    !Array.isArray(http.data)
      ? (http.data as Record<string, unknown>)
      : undefined;
  const code = env && typeof env['code'] === 'number' ? env['code'] : undefined;
  const msg = env && typeof env['msg'] === 'string' ? env['msg'] : undefined;
  const bits = [
    `HTTP ${http.status ?? '?'}`,
    code !== undefined ? `code=${code}` : '',
    msg ? `msg=${msg}` : '',
    serializeFeishuErrorPayload(http.data),
  ].filter(Boolean);
  return bits.join(' ');
}

@Injectable()
export class LarkDocService {
  private readonly logger = new Logger(LarkDocService.name);
  private client: Lark.Client | null = null;
  private readonly docWriter: LarkDocWriterService;

  constructor(
    private readonly configService: ConfigService,
    private readonly instructionDetector: InstructionDetectorService,
    docWriter: LarkDocWriterService,
  ) {
    this.docWriter = docWriter;
  }

  initClient(client: Lark.Client) {
    this.client = client;
  }

  private requireClient(): Lark.Client {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }
    return this.client;
  }

  private getDocx(): LarkDocxClient['docx'] {
    return (this.requireClient() as unknown as LarkDocxClient).docx;
  }

  /**
   * @param folderToken 可选；未传时使用环境变量 `LARK_CLOUD_FOLDER_TOKEN`。
   * tenant_access_token 场景建议传入应用创建的文件夹，与幻灯片写入路径一致。
   */
  async createDocument(
    title: string,
    folderToken?: string,
  ): Promise<{ documentId: string; url: string }> {
    const folder_token =
      readOptionalConfigFolderToken(folderToken) ??
      readOptionalConfigFolderToken(
        this.configService.get<string>('LARK_CLOUD_FOLDER_TOKEN'),
      );

    let safeTitle = title.trim().replaceAll('\u0000', '');
    if (safeTitle.length > 255) {
      safeTitle = safeTitle.slice(0, 255);
      this.logger.warn(
        `文档标题超过 255 字符已截断（飞书创建接口常见上限），截断后长度=${safeTitle.length}`,
      );
    }
    if (!safeTitle) {
      safeTitle = `Zeno 文档-${new Date().toLocaleString('zh-CN')}`;
    }

    const data: { title: string; folder_token?: string } = {
      title: safeTitle,
    };
    if (folder_token) {
      data.folder_token = folder_token;
    }

    try {
      const response = await this.getDocx().v1.document.create({
        data,
      });

      const documentId =
        response.data?.document?.document_id ?? response.data?.document_id;

      if (!documentId) {
        throw new Error('未从飞书文档接口返回 document_id');
      }

      this.logger.log(`✅ 文档创建成功: ${documentId}`);

      return {
        documentId,
        url: `https://feishu.cn/docx/${documentId}`,
      };
    } catch (error) {
      this.logger.error(
        `❌ 飞书创建文档失败 titleLen=${safeTitle.length} folderToken=${folder_token ? 'set' : 'unset'}: ${describeDocumentCreateFailure(error)}`,
      );
      throw error;
    }
  }

  async addBlockToDocument(
    documentId: string,
    block: BlockChildren,
    index?: number,
  ): Promise<BlockCreationResult> {
    const blocks = this.docWriter.normalizeBlocksForCreate([block]);
    if (blocks.length > 1) {
      const result = await this.addBlocksToDocumentWithIndex(
        documentId,
        blocks,
        index,
      );
      const blockId = result.blockIds[0];
      if (!blockId) {
        throw new Error('块创建失败，未返回 block_id');
      }

      return {
        blockId,
        parentBlockId: documentId,
        index: index ?? 0,
      };
    }

    const response = await this.getDocx().v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: blocks,
        index: index ?? 0,
      },
    });

    const blockId = response.data?.children?.[0]?.block_id;
    if (!blockId) {
      throw new Error('块创建失败，未返回 block_id');
    }

    this.logger.log(`✅ 块添加成功: ${blockId}`);

    return {
      blockId,
      parentBlockId: documentId,
      index: index ?? 0,
    };
  }

  async addBlocksToDocument(
    documentId: string,
    blocks: BlockChildren[],
  ): Promise<BatchBlockCreationResult> {
    const normalizedBlocks = this.docWriter.normalizeBlocksForCreate(blocks);
    const MAX_BLOCKS_PER_REQUEST = 50;
    const allBlockIds: string[] = [];

    for (let i = 0; i < normalizedBlocks.length; i += MAX_BLOCKS_PER_REQUEST) {
      const batch = normalizedBlocks.slice(i, i + MAX_BLOCKS_PER_REQUEST);

      const response = await this.getDocx().v1.documentBlockChildren.create({
        path: {
          document_id: documentId,
          block_id: documentId,
        },
        data: {
          children: batch,
        },
      });

      const blockIds = extractCreatedBlockIds(response);
      allBlockIds.push(...blockIds);
    }

    this.logger.log(`✅ 批量添加 ${allBlockIds.length} 个块到文档`);

    return {
      blockIds: allBlockIds,
      parentBlockId: documentId,
    };
  }

  async createNestedBlocks(
    documentId: string,
    parentBlockId: string,
    blocks: BatchCreateBlock[],
  ): Promise<BatchBlockCreationResult> {
    const children = blocks.map((block) => this.convertToBlockChildren(block));
    const MAX_BLOCKS_PER_REQUEST = 50;
    const allBlockIds: string[] = [];

    for (let i = 0; i < children.length; i += MAX_BLOCKS_PER_REQUEST) {
      const batch = children.slice(i, i + MAX_BLOCKS_PER_REQUEST);

      const response = await this.getDocx().v1.documentBlockChildren.create({
        path: {
          document_id: documentId,
          block_id: parentBlockId,
        },
        data: {
          children: batch,
        },
      });

      const blockIds = extractCreatedBlockIds(response);
      allBlockIds.push(...blockIds);
    }

    this.logger.log(`✅ 创建嵌套块 ${allBlockIds.length} 个`);

    return {
      blockIds: allBlockIds,
      parentBlockId,
    };
  }

  async uploadImage(
    documentId: string,
    imageBuffer: Buffer,
    imageName: string = 'image.png',
  ): Promise<ImageUploadResult> {
    const response = await this.getDocx().v1.image.create({
      path: {
        document_id: documentId,
      },
      data: {
        file_name: imageName,
        image_type: 'origin',
      },
    });

    const imageKey =
      response.data?.image?.token ?? response.data?.token ?? undefined;
    if (!imageKey) {
      throw new Error('图片上传失败，未返回 image token');
    }

    await this.requireClient().request({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/drive/v1/medias/upload_all`,
      data: {
        file_name: imageName,
        parent_type: 'docx_image',
        parent_token: documentId,
        override_name: imageName,
        size: imageBuffer.length,
      },
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    this.logger.log(`✅ 图片上传成功: ${imageKey}`);

    return {
      imageToken: imageKey,
      imageUrl: `https://feishu.cn/docx/${documentId}`,
    };
  }

  async batchUpdateBlocks(
    documentId: string,
    updates: Array<{
      blockId: string;
      update: Partial<BlockChildren>;
    }>,
  ): Promise<void> {
    const docx = this.getDocx();

    for (const { blockId, update } of updates) {
      await docx.v1.documentBlock.update({
        path: {
          document_id: documentId,
          block_id: blockId,
        },
        data: {
          update_text_elements: update.text?.elements,
        },
      });
    }

    this.logger.log(`✅ 批量更新 ${updates.length} 个块`);
  }

  async appendTextToDocument(
    documentId: string,
    text: string,
    index?: number,
  ): Promise<BlockCreationResult> {
    // 检测是否为指令
    const isInstruction = await this.instructionDetector.isInstruction(text);

    let content = text;
    if (isInstruction) {
      this.logger.log(`检测到指令，正在处理: ${text}`);
      // 处理指令，生成内容
      content = await this.instructionDetector.processInstruction(text);
    }

    const block = this.docWriter.createTextBlock(content);
    return this.addBlockToDocument(documentId, block, index);
  }

  async appendHeadingToDocument(
    documentId: string,
    level: 1 | 2 | 3 | 4 | 5 | 6,
    text: string,
    index?: number,
  ): Promise<BlockCreationResult> {
    const block = this.docWriter.createHeadingBlock(level, text);
    return this.addBlockToDocument(documentId, block, index);
  }

  async appendBulletListToDocument(
    documentId: string,
    items: string[],
    index?: number,
  ): Promise<BatchBlockCreationResult> {
    const blocks = items.map((item) => this.docWriter.createBulletBlock(item));
    return this.addBlocksToDocumentWithIndex(documentId, blocks, index);
  }

  async appendOrderedListToDocument(
    documentId: string,
    items: string[],
    index?: number,
  ): Promise<BatchBlockCreationResult> {
    const blocks = items.map((item) => this.docWriter.createOrderedBlock(item));
    return this.addBlocksToDocumentWithIndex(documentId, blocks, index);
  }

  async appendMarkdownToDocument(
    documentId: string,
    markdown: string,
    index?: number,
  ): Promise<BatchBlockCreationResult> {
    const blocks = this.docWriter.parseMarkdownToBlocks(markdown);
    return this.addBlocksToDocumentWithIndex(documentId, blocks, index);
  }

  private async addBlocksToDocumentWithIndex(
    documentId: string,
    blocks: BlockChildren[],
    startIndex?: number,
  ): Promise<BatchBlockCreationResult> {
    const normalizedBlocks = this.docWriter.normalizeBlocksForCreate(blocks);
    const MAX_BLOCKS_PER_REQUEST = 50;
    const allBlockIds: string[] = [];
    let currentIndex = startIndex ?? 0;

    for (let i = 0; i < normalizedBlocks.length; i += MAX_BLOCKS_PER_REQUEST) {
      const batch = normalizedBlocks.slice(i, i + MAX_BLOCKS_PER_REQUEST);

      const response = await this.getDocx().v1.documentBlockChildren.create({
        path: {
          document_id: documentId,
          block_id: documentId,
        },
        data: {
          index: currentIndex,
          children: batch,
        },
      });

      const blockIds = extractCreatedBlockIds(response);
      allBlockIds.push(...blockIds);
      currentIndex += blockIds.length;
    }

    this.logger.log(`✅ 批量添加 ${allBlockIds.length} 个块到文档`);

    return {
      blockIds: allBlockIds,
      parentBlockId: documentId,
    };
  }

  async appendTableToDocument(
    documentId: string,
    rows: string[][],
    index?: number,
  ): Promise<BlockCreationResult> {
    const block = this.docWriter.createTableBlock(rows);
    return this.addBlockToDocument(documentId, block, index);
  }

  async appendCodeBlockToDocument(
    documentId: string,
    code: string,
    language: string = 'plaintext',
    index?: number,
  ): Promise<BlockCreationResult> {
    const block = this.docWriter.createCodeBlock(code, language);
    return this.addBlockToDocument(documentId, block, index);
  }

  private convertToBlockChildren(block: BatchCreateBlock): BlockChildren {
    const result: BlockChildren = {
      block_type: block.block_type,
    };

    if (block.text) {
      result.text = block.text;
    }

    if (block.table) {
      result.table = block.table;
    }

    if (block.children && block.children.length > 0) {
      result.text = result.text || { elements: [], style: {} };
    }

    return result;
  }

  getDocWriter(): LarkDocWriterService {
    return this.docWriter;
  }
}
