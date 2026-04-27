import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  SlidesCreationResult,
  SLIDE_BLOCK_TYPE,
  SlideBlockElement,
  SlideTextStyle,
  CreateSlideBlock,
} from './lark-slides.types';
import { InstructionDetectorService } from '../../common/instruction-detector.service';

@Injectable()
export class LarkSlidesService {
  private readonly logger = new Logger(LarkSlidesService.name);
  private client: Lark.Client | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly instructionDetector: InstructionDetectorService,
  ) {}

  initClient(client: Lark.Client) {
    this.client = client;
  }

  async createPresentation(title: string): Promise<SlidesCreationResult> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    this.logger.log(`🚀 开始创建幻灯片: ${title}`);

    const response = await this.client.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations',
      data: {
        title,
      },
    });

    const presentationId =
      response?.data?.presentation?.presentation_id ||
      response?.data?.presentation_id;

    if (!presentationId) {
      throw new Error('幻灯片创建失败，未获取到 presentation_id');
    }

    this.logger.log(`✅ 幻灯片创建成功: ${presentationId}`);

    return {
      presentationId,
      url: `https://feishu.cn/slides/${presentationId}`,
      pages: [],
    };
  }

  async addSlideBlock(
    presentationId: string,
    pageId: string,
    block: CreateSlideBlock,
  ): Promise<string> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const response = await (this.client as any).slides.v1.slideBlock.create({
      path: {
        presentation_id: presentationId,
        slide_id: pageId,
      },
      data: {
        block_type: block.block_type,
        block_id: block.block_id,
        text: block.text,
        image: block.image,
        shape: block.shape,
      },
    });

    const blockId = response?.data?.block?.block_id || response?.data?.block_id;
    if (!blockId) {
      throw new Error('幻灯片块创建失败，未返回 block_id');
    }

    this.logger.log(`✅ 幻灯片块添加成功: ${blockId}`);
    return blockId;
  }

  async batchAddSlideBlocks(
    presentationId: string,
    pageId: string,
    blocks: CreateSlideBlock[],
  ): Promise<string[]> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const response = await (
      this.client as any
    ).slides.v1.slideBlock.batch_create({
      path: {
        presentation_id: presentationId,
        slide_id: pageId,
      },
      data: {
        slides: blocks.map((block) => ({
          block_type: block.block_type,
          block_id: block.block_id,
          text: block.text,
          image: block.image,
          shape: block.shape,
        })),
      },
    });

    const blockIds = response?.data?.blocks?.map((b: any) => b.block_id) || [];
    this.logger.log(`✅ 批量添加 ${blockIds.length} 个幻灯片块`);

    return blockIds;
  }

  async updateSlideBlock(
    presentationId: string,
    pageId: string,
    blockId: string,
    updates: {
      text?: SlideBlockElement[];
    },
  ): Promise<void> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    await (this.client as any).slides.v1.slideBlock.update({
      path: {
        presentation_id: presentationId,
        slide_id: pageId,
        block_id: blockId,
      },
      data: {
        text: {
          elements: updates.text,
        },
      },
    });

    this.logger.log(`✅ 更新幻灯片块: ${blockId}`);
  }

  async deleteSlideBlock(
    presentationId: string,
    pageId: string,
    blockId: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    await (this.client as any).slides.v1.slideBlock.delete({
      path: {
        presentation_id: presentationId,
        slide_id: pageId,
        block_id: blockId,
      },
    });

    this.logger.log(`✅ 删除幻灯片块: ${blockId}`);
  }

  createTextSlideBlock(
    content: string,
    style?: SlideTextStyle,
  ): CreateSlideBlock {
    const element: SlideBlockElement = {
      text_run: {
        content,
        style,
      },
    };

    return {
      block_type: SLIDE_BLOCK_TYPE.TEXT,
      text: {
        elements: [element],
      },
    };
  }

  createTitleSlideBlock(title: string, subtitle?: string): CreateSlideBlock {
    const elements: SlideBlockElement[] = [
      {
        text_run: {
          content: title,
          style: { bold: true },
        },
      },
    ];

    if (subtitle) {
      elements.push({
        text_run: {
          content: subtitle,
          style: { italic: true },
        },
      });
    }

    return {
      block_type: SLIDE_BLOCK_TYPE.TEXT,
      text: {
        elements,
      },
    };
  }

  createBulletSlideBlock(
    items: string[],
    style?: SlideTextStyle,
  ): CreateSlideBlock[] {
    return items.map((item) => this.createTextSlideBlock(`• ${item}`, style));
  }

  createHeadingSlideBlock(
    level: 1 | 2 | 3,
    content: string,
    style?: SlideTextStyle,
  ): CreateSlideBlock {
    const prefix = level === 1 ? '# ' : level === 2 ? '## ' : '### ';
    return this.createTextSlideBlock(`${prefix}${content}`, {
      bold: true,
      ...style,
    });
  }

  parseMarkdownToSlideBlocks(markdown: string): CreateSlideBlock[] {
    const lines = markdown.split('\n');
    const blocks: CreateSlideBlock[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('### ')) {
        blocks.push(this.createHeadingSlideBlock(3, trimmed.slice(4)));
      } else if (trimmed.startsWith('## ')) {
        blocks.push(this.createHeadingSlideBlock(2, trimmed.slice(3)));
      } else if (trimmed.startsWith('# ')) {
        blocks.push(this.createHeadingSlideBlock(1, trimmed.slice(2)));
      } else if (trimmed.startsWith('- ')) {
        blocks.push(this.createTextSlideBlock(`• ${trimmed.slice(2)}`));
      } else if (trimmed.startsWith('- [ ] ')) {
        blocks.push(this.createTextSlideBlock(`☐ ${trimmed.slice(6)}`));
      } else if (trimmed.startsWith('- [x] ')) {
        blocks.push(this.createTextSlideBlock(`☑ ${trimmed.slice(6)}`));
      } else if (/^\d+\.\s/.test(trimmed)) {
        blocks.push(this.createTextSlideBlock(trimmed));
      } else {
        blocks.push(this.createTextSlideBlock(trimmed));
      }
    }

    return blocks;
  }

  async appendTextToSlide(
    presentationId: string,
    pageId: string,
    text: string,
    style?: SlideTextStyle,
  ): Promise<string> {
    // 检测是否为指令
    const isInstruction = await this.instructionDetector.isInstruction(text);

    let content = text;
    if (isInstruction) {
      this.logger.log(`检测到指令，正在处理: ${text}`);
      // 处理指令，生成内容
      content = await this.instructionDetector.processInstruction(text);
    }

    const block = this.createTextSlideBlock(content, style);
    return this.addSlideBlock(presentationId, pageId, block);
  }

  async appendMarkdownToSlide(
    presentationId: string,
    pageId: string,
    markdown: string,
  ): Promise<string[]> {
    const blocks = this.parseMarkdownToSlideBlocks(markdown);
    return this.batchAddSlideBlocks(presentationId, pageId, blocks);
  }
}
