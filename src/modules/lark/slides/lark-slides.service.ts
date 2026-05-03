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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parsePresentationCreateResponse(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const data = raw['data'];
  if (!isRecord(data)) return undefined;
  const presentation = data['presentation'];
  if (isRecord(presentation)) {
    const id = readOptionalString(presentation['presentation_id']);
    if (id) return id;
  }
  return readOptionalString(data['presentation_id']);
}

function parseListSlideIdsResponse(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const rootData = isRecord(raw['data']) ? raw['data'] : raw;
  const code =
    typeof raw['code'] === 'number'
      ? raw['code']
      : typeof rootData['code'] === 'number'
        ? rootData['code']
        : undefined;
  if (code !== undefined && code !== 0) {
    const msg =
      readOptionalString(raw['msg']) ??
      readOptionalString(rootData['msg']) ??
      'unknown';
    throw new Error(`列出幻灯片页失败（${code}）: ${msg}`);
  }

  const nested = isRecord(rootData['data']) ? rootData['data'] : undefined;
  const slideListCandidates: unknown[] = [
    rootData['slides'],
    nested?.['slides'],
    rootData['items'],
    nested?.['items'],
    rootData['slide_list'],
  ];
  const slidesRaw =
    slideListCandidates.find((v): v is unknown[] => Array.isArray(v)) ?? [];

  return slidesRaw
    .map((item) => {
      if (!isRecord(item)) return undefined;
      return (
        readOptionalString(item['slide_id']) ??
        readOptionalString(item['slideId']) ??
        readOptionalString(item['id'])
      );
    })
    .filter((id): id is string => id !== undefined);
}

type SlideBlockCreateResponse = {
  data?: {
    block?: { block_id?: string };
    block_id?: string;
  };
};

type SlideBlockBatchCreateResponse = {
  data?: {
    blocks?: Array<{ block_id?: string }>;
  };
};

/** SDK 类型未导出 slides 命名空间时的最小调用面 */
type SlideBlockCreateBody = Pick<
  CreateSlideBlock,
  'block_type' | 'block_id' | 'text' | 'image' | 'shape'
>;

type LarkSlidesV1SlideBlockClient = {
  slides: {
    v1: {
      slideBlock: {
        create: (args: {
          path: { presentation_id: string; slide_id: string };
          data: SlideBlockCreateBody;
        }) => Promise<SlideBlockCreateResponse>;
        batch_create: (args: {
          path: { presentation_id: string; slide_id: string };
          data: { slides: SlideBlockCreateBody[] };
        }) => Promise<SlideBlockBatchCreateResponse>;
        update: (args: {
          path: {
            presentation_id: string;
            slide_id: string;
            block_id: string;
          };
          data: { text?: { elements?: SlideBlockElement[] } };
        }) => Promise<unknown>;
        delete: (args: {
          path: {
            presentation_id: string;
            slide_id: string;
            block_id: string;
          };
        }) => Promise<unknown>;
      };
    };
  };
};

@Injectable()
export class LarkSlidesService {
  private readonly logger = new Logger(LarkSlidesService.name);
  private client: Lark.Client | null = null;
  private static readonly MAX_TEXT_BLOCK_CONTENT_LENGTH = 20_000;
  private static readonly MAX_BLOCKS_PER_REQUEST = 50;
  /** 创建后拉取幻灯片列表的重试间隔（含首次立即请求） */
  private static readonly LIST_SLIDES_WARMUP_DELAYS_MS = [0, 600, 2000];

  constructor(
    private readonly configService: ConfigService,
    private readonly instructionDetector: InstructionDetectorService,
  ) {}

  initClient(client: Lark.Client) {
    this.client = client;
  }

  /**
   * 与 {@link LarkDocService} 共用：自建应用使用 tenant_access_token 时，
   * 宜将云文档写入应用创建的文件夹，避免落根目录后出现「创建成功但后续只读接口 131001」。
   */
  private resolveFolderToken(explicit?: string): string | undefined {
    const fromArg = readOptionalString(explicit);
    if (fromArg) return fromArg;
    return readOptionalString(
      this.configService.get<string>('LARK_CLOUD_FOLDER_TOKEN'),
    );
  }

  private getSlideBlockApi(): LarkSlidesV1SlideBlockClient['slides']['v1']['slideBlock'] {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }
    return (this.client as unknown as LarkSlidesV1SlideBlockClient).slides.v1
      .slideBlock;
  }

  async createPresentation(
    title: string,
    folderToken?: string,
  ): Promise<SlidesCreationResult> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    this.logger.log(`🚀 开始创建幻灯片: ${title}`);

    const folder_token = this.resolveFolderToken(folderToken);
    const data: { title: string; folder_token?: string } = { title };
    if (folder_token) {
      data.folder_token = folder_token;
    }

    const raw: unknown = await this.client.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations',
      data,
    });

    const presentationId = parsePresentationCreateResponse(raw);

    if (!presentationId) {
      throw new Error('幻灯片创建失败，未获取到 presentation_id');
    }

    this.logger.log(`✅ 幻灯片创建成功: ${presentationId}`);

    await this.warmupPresentationListAccess(presentationId);

    return {
      presentationId,
      url: `https://feishu.cn/slides/${presentationId}`,
      pages: [],
    };
  }

  /** 确认「列出幻灯片」对当前身份可用，减轻创建后短时 404/131001。 */
  private async warmupPresentationListAccess(
    presentationId: string,
  ): Promise<void> {
    const delays = LarkSlidesService.LIST_SLIDES_WARMUP_DELAYS_MS;
    let lastErr: unknown;
    for (let i = 0; i < delays.length; i++) {
      const wait = delays[i] ?? 0;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        await this.fetchPresentationSlideIds(presentationId);
        return;
      } catch (e) {
        lastErr = e;
        if (i < delays.length - 1) {
          this.logger.warn(
            `演示文稿列表暂不可读，将重试 (${i + 1}/${delays.length}): ${presentationId} — ${(e as Error).message}`,
          );
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async fetchPresentationSlideIds(
    presentationId: string,
  ): Promise<string[]> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const raw: unknown = await this.client.request({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/slides/v1/presentations/${encodeURIComponent(
        presentationId,
      )}/slides`,
      params: { page_size: 100 },
    });

    if (isRecord(raw)) {
      const code = raw['code'];
      if (typeof code === 'number' && code !== 0) {
        const msg = readOptionalString(raw['msg']) ?? 'unknown';
        this.logger.error(
          `列出幻灯片页失败: presentation_id=${presentationId} code=${code} msg=${msg}`,
        );
      }
    }

    return parseListSlideIdsResponse(raw);
  }

  /**
   * 列出演示文稿中的幻灯片页 ID（用于向指定页追加块）。
   * @see https://open.feishu.cn/document/server-docs/docs/slides-v1/slide/list
   */
  async listSlideIds(presentationId: string): Promise<string[]> {
    const ids = await this.fetchPresentationSlideIds(presentationId);
    this.logger.log(`📑 演示文稿 ${presentationId} 共 ${ids.length} 页`);
    return ids;
  }

  /**
   * 将 Markdown 解析为块后追加到演示文稿的指定页（通常为首页）。
   */
  async appendMarkdownToPresentation(
    presentationId: string,
    slideId: string,
    markdown: string,
  ): Promise<string[]> {
    return this.appendMarkdownToSlide(presentationId, slideId, markdown);
  }

  /**
   * 将 Markdown 同步到演示文稿的第一页（新建演示默认至少有一页）。
   * @returns 写入的块 ID 列表；若无法解析到页面则返回 null。
   */
  async appendMarkdownToFirstSlide(
    presentationId: string,
    markdown: string,
  ): Promise<string[] | null> {
    const slideIds = await this.listSlideIds(presentationId);
    const firstSlideId = slideIds[0];
    if (!firstSlideId) {
      this.logger.warn(
        `演示文稿 ${presentationId} 未返回任何 slide_id，无法写入幻灯片内容`,
      );
      return null;
    }
    return this.appendMarkdownToPresentation(
      presentationId,
      firstSlideId,
      markdown,
    );
  }

  async addSlideBlock(
    presentationId: string,
    pageId: string,
    block: CreateSlideBlock,
  ): Promise<string> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const blocks = this.normalizeSlideBlocksForCreate([block]);
    if (blocks.length > 1) {
      const blockIds = await this.batchAddSlideBlocks(
        presentationId,
        pageId,
        blocks,
      );
      const blockId = blockIds[0];
      if (!blockId) {
        throw new Error('幻灯片块创建失败，未返回 block_id');
      }

      return blockId;
    }

    const response = await this.getSlideBlockApi().create({
      path: {
        presentation_id: presentationId,
        slide_id: pageId,
      },
      data: {
        block_type: blocks[0].block_type,
        block_id: blocks[0].block_id,
        text: blocks[0].text,
        image: blocks[0].image,
        shape: blocks[0].shape,
      },
    });

    const blockId = response.data?.block?.block_id ?? response.data?.block_id;
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

    const normalizedBlocks = this.normalizeSlideBlocksForCreate(blocks);
    const blockIds: string[] = [];

    for (
      let i = 0;
      i < normalizedBlocks.length;
      i += LarkSlidesService.MAX_BLOCKS_PER_REQUEST
    ) {
      const batch = normalizedBlocks.slice(
        i,
        i + LarkSlidesService.MAX_BLOCKS_PER_REQUEST,
      );

      const response = await this.getSlideBlockApi().batch_create({
        path: {
          presentation_id: presentationId,
          slide_id: pageId,
        },
        data: {
          slides: batch.map((block) => ({
            block_type: block.block_type,
            block_id: block.block_id,
            text: block.text,
            image: block.image,
            shape: block.shape,
          })),
        },
      });

      const created = response.data?.blocks ?? [];
      for (const b of created) {
        if (!isRecord(b)) continue;
        const id = readOptionalString(b['block_id']);
        if (id) blockIds.push(id);
      }
    }
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

    await this.getSlideBlockApi().update({
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

    await this.getSlideBlockApi().delete({
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

  normalizeSlideBlocksForCreate(
    blocks: CreateSlideBlock[],
  ): CreateSlideBlock[] {
    return blocks.flatMap((block) => this.splitSlideBlockByTextLimit(block));
  }

  private splitSlideBlockByTextLimit(
    block: CreateSlideBlock,
  ): CreateSlideBlock[] {
    const elements = block.text?.elements;
    if (!elements?.length) {
      return [block];
    }

    const elementGroups = this.splitSlideTextElements(elements);
    if (elementGroups.length <= 1) {
      return [block];
    }

    return elementGroups.map((group) => ({
      ...block,
      text: {
        ...block.text,
        elements: group,
      },
    }));
  }

  private splitSlideTextElements(
    elements: SlideBlockElement[],
  ): SlideBlockElement[][] {
    const groups: SlideBlockElement[][] = [];
    let currentGroup: SlideBlockElement[] = [];
    let currentLength = 0;

    const pushElement = (element: SlideBlockElement) => {
      const contentLength = element.text_run?.content.length ?? 0;
      if (
        currentGroup.length > 0 &&
        currentLength + contentLength >
          LarkSlidesService.MAX_TEXT_BLOCK_CONTENT_LENGTH
      ) {
        groups.push(currentGroup);
        currentGroup = [];
        currentLength = 0;
      }

      currentGroup.push(element);
      currentLength += contentLength;
    };

    for (const element of elements) {
      if (!element.text_run) {
        pushElement(element);
        continue;
      }

      for (const chunk of this.splitTextContent(element.text_run.content)) {
        pushElement(this.cloneSlideElementWithContent(element, chunk));
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private splitTextContent(content: string): string[] {
    if (content.length === 0) {
      return [''];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
      let end = Math.min(
        start + LarkSlidesService.MAX_TEXT_BLOCK_CONTENT_LENGTH,
        content.length,
      );

      if (
        end < content.length &&
        this.isHighSurrogate(content.charCodeAt(end - 1))
      ) {
        end -= 1;
      }

      chunks.push(content.slice(start, end));
      start = end;
    }

    return chunks;
  }

  private isHighSurrogate(charCode: number): boolean {
    return charCode >= 0xd800 && charCode <= 0xdbff;
  }

  private cloneSlideElementWithContent(
    element: SlideBlockElement,
    content: string,
  ): SlideBlockElement {
    return {
      text_run: {
        content,
        style: element.text_run?.style
          ? { ...element.text_run.style }
          : undefined,
        link: element.text_run?.link ? { ...element.text_run.link } : undefined,
      },
    };
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
      } else if (trimmed.startsWith('- [ ] ')) {
        blocks.push(this.createTextSlideBlock(`☐ ${trimmed.slice(6)}`));
      } else if (trimmed.startsWith('- [x] ')) {
        blocks.push(this.createTextSlideBlock(`☑ ${trimmed.slice(6)}`));
      } else if (trimmed.startsWith('- ')) {
        blocks.push(this.createTextSlideBlock(`• ${trimmed.slice(2)}`));
      } else if (/^\d+\.\s/.test(trimmed)) {
        blocks.push(this.createTextSlideBlock(trimmed));
      } else {
        blocks.push(this.createTextSlideBlock(trimmed));
      }
    }

    return this.normalizeSlideBlocksForCreate(blocks);
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
