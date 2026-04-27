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

@Injectable()
export class LarkDocService {
  private readonly logger = new Logger(LarkDocService.name);
  private client: Lark.Client | null = null;
  private readonly docWriter: LarkDocWriterService;

  constructor(
    private readonly configService: ConfigService,
    private readonly instructionDetector: InstructionDetectorService,
  ) {
    this.docWriter = new LarkDocWriterService();
  }

  initClient(client: Lark.Client) {
    this.client = client;
  }

  async createDocument(
    title: string,
  ): Promise<{ documentId: string; url: string }> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const response = await (this.client as any).docx.v1.document.create({
      data: { title },
    });

    const documentId =
      response?.data?.document?.document_id || response?.data?.document_id;

    if (!documentId) {
      throw new Error('未从飞书文档接口返回 document_id');
    }

    this.logger.log(`✅ 文档创建成功: ${documentId}`);

    return {
      documentId,
      url: `https://feishu.cn/docx/${documentId}`,
    };
  }

  async addBlockToDocument(
    documentId: string,
    block: BlockChildren,
    index?: number,
  ): Promise<BlockCreationResult> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const response = await (
      this.client as any
    ).docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: [block],
        index: index ?? 0,
      },
    });

    const blockId = response?.data?.children?.[0]?.block_id;
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
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const response = await (
      this.client as any
    ).docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: blocks,
      },
    });

    const blockIds =
      response?.data?.children?.map((child: any) => child.block_id) || [];
    this.logger.log(`✅ 批量添加 ${blockIds.length} 个块到文档`);

    return {
      blockIds,
      parentBlockId: documentId,
    };
  }

  async createNestedBlocks(
    documentId: string,
    parentBlockId: string,
    blocks: BatchCreateBlock[],
  ): Promise<BatchBlockCreationResult> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const children = blocks.map((block) => this.convertToBlockChildren(block));

    const response = await (
      this.client as any
    ).docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: parentBlockId,
      },
      data: {
        children,
      },
    });

    const blockIds =
      response?.data?.children?.map((child: any) => child.block_id) || [];
    this.logger.log(`✅ 创建嵌套块 ${blockIds.length} 个`);

    return {
      blockIds,
      parentBlockId,
    };
  }

  async uploadImage(
    documentId: string,
    imageBuffer: Buffer,
    imageName: string = 'image.png',
  ): Promise<ImageUploadResult> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const response = await (this.client as any).docx.v1.image.create({
      path: {
        document_id: documentId,
      },
      data: {
        file_name: imageName,
        image_type: 'origin',
      },
    });

    const imageKey = response?.data?.image?.token || response?.data?.token;
    if (!imageKey) {
      throw new Error('图片上传失败，未返回 image token');
    }

    await this.client.request({
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
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    for (const { blockId, update } of updates) {
      await (this.client as any).docx.v1.documentBlock.update({
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
    return this.addBlocksToDocument(documentId, blocks);
  }

  async appendOrderedListToDocument(
    documentId: string,
    items: string[],
    index?: number,
  ): Promise<BatchBlockCreationResult> {
    const blocks = items.map((item) => this.docWriter.createOrderedBlock(item));
    return this.addBlocksToDocument(documentId, blocks);
  }

  async appendMarkdownToDocument(
    documentId: string,
    markdown: string,
    index?: number,
  ): Promise<BatchBlockCreationResult> {
    const blocks = this.docWriter.parseMarkdownToBlocks(markdown);
    if (index !== undefined) {
      const results: BatchBlockCreationResult = {
        blockIds: [],
        parentBlockId: documentId,
      };
      for (let i = 0; i < blocks.length; i++) {
        const result = await this.addBlockToDocument(
          documentId,
          blocks[i],
          index + i,
        );
        results.blockIds.push(result.blockId);
      }
      return results;
    }
    return this.addBlocksToDocument(documentId, blocks);
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
