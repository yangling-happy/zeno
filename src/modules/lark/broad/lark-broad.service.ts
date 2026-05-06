import { Injectable, Logger } from '@nestjs/common';
import * as Lark from '@larksuiteoapi/node-sdk';
import { BLOCK_TYPE_MAP, BlockChildren } from '../doc/lark-doc-block.types';
import { LarkDocService } from '../doc/lark-doc.service';
import {
  LARK_BOARD_BLOCK_TYPE,
  LarkBroadAppendMarkdownResult,
  LarkBroadCreateBoardResult,
} from './lark-broad.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 与 {@link LarkSlidesService} 中 unwrap 行为一致，兼容 axios 包裹 */
function unwrapLarkHttpResponse(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const looksLikeAxios =
    typeof raw['status'] === 'number' &&
    raw['config'] !== undefined &&
    'data' in raw;
  const envelope = looksLikeAxios ? raw['data'] : raw;
  return isRecord(envelope) ? envelope : null;
}

/** 文档块列表/详情中与画板相关的字段（token 多在 board.token） */
function readWhiteboardTokenFromBlockLike(
  block: Record<string, unknown>,
): string | undefined {
  const board = block['board'];
  if (isRecord(board)) {
    const t = board['token'];
    if (typeof t === 'string' && t.trim().length > 0) {
      return t.trim();
    }
  }
  const top = block['token'];
  if (typeof top === 'string' && top.trim().length > 0) {
    return top.trim();
  }
  return undefined;
}

/** 创建节点成功时，官方响应为 data.ids（字符串 id 列表），不是 nodes */
interface LarkBoardNodesCreateResponseData {
  ids?: string[];
  nodes?: Array<{ id?: string; node_id?: string }>;
  client_token?: string;
}

/** 画板圆角矩形节点（composite_shape / round_rect，比纯 text_shape 更易扫读） */
interface BoardRoundRectShapeNode {
  id: string;
  type: 'composite_shape';
  x: number;
  y: number;
  angle: number;
  height: number;
  width: number;
  z_index: number;
  text: {
    text: string;
    font_weight: 'regular' | 'bold';
    font_size: number;
    horizontal_align: 'left' | 'center' | 'right';
    vertical_align: 'top' | 'mid' | 'bottom';
    text_color: string;
    line_through: boolean;
    underline: boolean;
    italic: boolean;
    angle: number;
    theme_text_color_code: number;
    theme_text_background_color_code: number;
    text_color_type: number;
    text_background_color_type: number;
  };
  style: {
    fill_color: string;
    fill_opacity: number;
    border_style: 'solid';
    border_width: 'narrow';
    border_color: string;
    border_opacity: number;
    theme_fill_color_code: number;
    theme_border_color_code: number;
    fill_color_type: number;
    border_color_type: number;
  };
  composite_shape: {
    type: 'round_rect';
  };
}

function readFeishuCodeFromRaw(raw: unknown): number | undefined {
  const env = unwrapLarkHttpResponse(raw);
  if (!env) {
    return undefined;
  }
  const c = env['code'];
  return typeof c === 'number' ? c : undefined;
}

function unwrapBizData<T>(raw: unknown): T | undefined {
  const env = unwrapLarkHttpResponse(raw);
  if (!env) {
    return undefined;
  }
  const code = env['code'];
  if (typeof code === 'number' && code !== 0) {
    return undefined;
  }
  const d = env['data'];
  if (!d || typeof d !== 'object') {
    return undefined;
  }
  return d as T;
}

function readFeishuErrorMsg(raw: unknown): string | undefined {
  const env = unwrapLarkHttpResponse(raw);
  const msg = env?.['msg'];
  return typeof msg === 'string' ? msg : undefined;
}

@Injectable()
export class LarkBroadService {
  private readonly logger = new Logger(LarkBroadService.name);
  /** 相邻卡片纵向间距（px） */
  private static readonly BOARD_LINE_GAP_PX = 36;
  /** 卡片水平内边距（单侧，计入宽高，避免文字贴边或被裁切） */
  private static readonly BOARD_CARD_PAD_X = 28;
  /** 卡片垂直内边距（单侧，计入高度） */
  private static readonly BOARD_CARD_PAD_Y = 22;
  /**
   * 每个版块轮换配色（填充 + 描边），保证相邻块易区分、对比度适中。
   */
  private static readonly BOARD_CARD_PALETTE: ReadonlyArray<{
    fill: string;
    border: string;
  }> = [
    { fill: '#e8f4fc', border: '#3370ff' },
    { fill: '#e8faf0', border: '#00b42a' },
    { fill: '#fff7e8', border: '#ff7d00' },
    { fill: '#fce8f4', border: '#eb2f96' },
    { fill: '#f0e8fc', border: '#722ed1' },
    { fill: '#e6fffb', border: '#13c2c2' },
    { fill: '#fff1f0', border: '#f5222d' },
    { fill: '#f6ffed', border: '#52c41a' },
    { fill: '#e6f7ff', border: '#1890ff' },
    { fill: '#fffbe6', border: '#faad14' },
  ];

  private client: Lark.Client | null = null;

  constructor(private readonly docService: LarkDocService) {}

  initClient(client: Lark.Client) {
    this.client = client;
    this.docService.initClient(client);
  }

  private requireClient(): Lark.Client {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }
    return this.client;
  }

  /**
   * 创建一篇云文档并在根部插入画板块，解析出 whiteboard_id；可选将 Markdown 写入画板。
   */
  async createDocumentWithBoard(
    title: string,
    markdown?: string,
    folderToken?: string,
  ): Promise<LarkBroadCreateBoardResult> {
    const { documentId, url } = await this.docService.createDocument(
      title,
      folderToken,
    );

    const boardBlock = {
      block_type: LARK_BOARD_BLOCK_TYPE,
      board: {
        align: 1,
        width: 720,
        height: 540,
      },
    } as unknown as BlockChildren;

    const { blockId: boardBlockId } = await this.docService.addBlockToDocument(
      documentId,
      boardBlock,
    );

    const whiteboardId = await this.waitForWhiteboardId(
      documentId,
      boardBlockId,
    );
    if (!whiteboardId) {
      throw new Error('未能从文档块中解析画板 token（whiteboard_id）');
    }

    if (markdown?.trim()) {
      await this.appendMarkdownToWhiteboard(whiteboardId, markdown.trim());
    }

    return {
      documentId,
      whiteboardId,
      docUrl: url,
    };
  }

  /**
   * 将 Markdown 解析为文档块结构：每个块对应画板上一张圆角卡片（同一段落/标题/列表项等多行文字在同一卡片内）。
   */
  async appendMarkdownToWhiteboard(
    whiteboardId: string,
    markdown: string,
  ): Promise<LarkBroadAppendMarkdownResult> {
    const blocks = this.docService
      .getDocWriter()
      .parseMarkdownToBlocks(markdown);
    const lines = this.blocksToBoardLines(blocks);
    return this.appendBoardLines(whiteboardId, lines);
  }

  /** 向画板追加纯文本（单块圆角矩形，用于兼容旧逻辑） */
  async appendPlainTextToWhiteboard(
    whiteboardId: string,
    text: string,
  ): Promise<LarkBroadAppendMarkdownResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { nodeIds: [] };
    }
    return this.appendBoardLines(whiteboardId, [
      { text: trimmed, fontSize: 14, bold: false },
    ]);
  }

  /**
   * 尝试更新已有文本图形节点的文字（需开放平台具备对应 patch 能力；失败时抛出明确错误）。
   */
  async updateTextShapeNodeText(
    whiteboardId: string,
    nodeId: string,
    text: string,
  ): Promise<void> {
    const c = this.requireClient();
    const body = {
      text: {
        text: text.length > 1024 ? `${text.slice(0, 1021)}...` : text,
        font_weight: 'regular' as const,
        font_size: 14,
        horizontal_align: 'left' as const,
        vertical_align: 'top' as const,
        text_color: '#1f2329',
        line_through: false,
        underline: false,
        italic: false,
        angle: 0,
        theme_text_color_code: -1,
        theme_text_background_color_code: -1,
        text_color_type: 0,
        text_background_color_type: 0,
      },
    };

    const raw: unknown = (await c.request({
      method: 'PATCH',
      url: `https://open.feishu.cn/open-apis/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes/${encodeURIComponent(nodeId)}`,
      data: body,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })) as unknown;

    const code = readFeishuCodeFromRaw(raw);
    if (code !== undefined && code !== 0) {
      const msg = readFeishuErrorMsg(raw);
      throw new Error(
        `更新画板节点失败: code=${code}${msg ? ` msg=${msg}` : ''}`,
      );
    }
  }

  private async waitForWhiteboardId(
    documentId: string,
    boardBlockId?: string,
    maxAttempts = 8,
  ): Promise<string | undefined> {
    if (boardBlockId) {
      for (let i = 0; i < maxAttempts; i++) {
        const id = await this.fetchWhiteboardTokenFromBoardBlock(
          documentId,
          boardBlockId,
        );
        if (id) {
          return id;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    for (let i = 0; i < maxAttempts; i++) {
      const id = await this.fetchWhiteboardIdFromDocument(documentId);
      if (id) {
        return id;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    return undefined;
  }

  /**
   * 获取块 https://open.feishu.cn/open-apis/docx/v1/documents/:document_id/blocks/:block_id
   * 画板的 whiteboard_id 在响应里的 board.token（不一定在列表接口顶层 token）。
   */
  private async fetchWhiteboardTokenFromBoardBlock(
    documentId: string,
    blockId: string,
  ): Promise<string | undefined> {
    const raw: unknown = (await this.requireClient().request({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
      params: {
        document_revision_id: -1,
      },
    })) as unknown;

    const code = readFeishuCodeFromRaw(raw);
    if (code !== undefined && code !== 0) {
      this.logger.warn(
        `获取画板块详情失败: code=${code} msg=${readFeishuErrorMsg(raw) ?? ''}`,
      );
      return undefined;
    }

    const data = unwrapBizData<Record<string, unknown>>(raw);
    const blockUnknown = data?.['block'];
    const block = isRecord(blockUnknown)
      ? blockUnknown
      : isRecord(data) && typeof data['block_type'] === 'number'
        ? data
        : undefined;

    if (!block) {
      return undefined;
    }

    const bt = block['block_type'];
    if (typeof bt === 'number' && bt !== LARK_BOARD_BLOCK_TYPE) {
      this.logger.warn(
        `画板块 block_type=${bt}，期望 ${LARK_BOARD_BLOCK_TYPE}`,
      );
    }

    const token = readWhiteboardTokenFromBlockLike(block);
    if (token) {
      this.logger.log(`✅ 从画板块详情解析 whiteboard_id: ${token}`);
    }
    return token;
  }

  private async fetchWhiteboardIdFromDocument(
    documentId: string,
  ): Promise<string | undefined> {
    const raw: unknown = (await this.requireClient().request({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
      params: {
        document_revision_id: -1,
        page_size: 50,
      },
    })) as unknown;

    const data = unwrapBizData<{ items?: unknown[] }>(raw);
    const items = data?.items ?? [];

    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      const bt = item['block_type'];
      if (typeof bt !== 'number' || bt !== LARK_BOARD_BLOCK_TYPE) {
        continue;
      }
      const token = readWhiteboardTokenFromBlockLike(item);
      if (token) {
        this.logger.log(`✅ 从文档子块列表解析 whiteboard_id: ${token}`);
        return token;
      }
    }

    return undefined;
  }

  /** 每个文档块 → 画板上一块卡片（不再按字符拆成多张）。 */
  private blocksToBoardLines(
    blocks: BlockChildren[],
  ): Array<{ text: string; fontSize: number; bold: boolean }> {
    const out: Array<{ text: string; fontSize: number; bold: boolean }> = [];

    for (const block of blocks) {
      const bt = block.block_type;
      const plain = this.extractPlainTextFromBlock(block);

      if (bt === BLOCK_TYPE_MAP.HEADING1 && plain) {
        out.push({ text: plain, fontSize: 28, bold: true });
      } else if (bt === BLOCK_TYPE_MAP.HEADING2 && plain) {
        out.push({ text: plain, fontSize: 22, bold: true });
      } else if (bt === BLOCK_TYPE_MAP.HEADING3 && plain) {
        out.push({ text: plain, fontSize: 18, bold: true });
      } else if (bt === BLOCK_TYPE_MAP.HEADING4 && plain) {
        out.push({ text: plain, fontSize: 16, bold: true });
      } else if (bt === BLOCK_TYPE_MAP.HEADING5 && plain) {
        out.push({ text: plain, fontSize: 15, bold: true });
      } else if (bt === BLOCK_TYPE_MAP.HEADING6 && plain) {
        out.push({ text: plain, fontSize: 14, bold: true });
      } else if (bt === BLOCK_TYPE_MAP.BULLET && plain) {
        out.push({ text: `• ${plain}`, fontSize: 14, bold: false });
      } else if (bt === BLOCK_TYPE_MAP.ORDERED && plain) {
        out.push({ text: plain, fontSize: 14, bold: false });
      } else if (bt === BLOCK_TYPE_MAP.CODE) {
        const body = plain || ' ';
        out.push({
          text: `\`\`\`\n${body}\n\`\`\``,
          fontSize: 12,
          bold: false,
        });
      } else if (bt === BLOCK_TYPE_MAP.QUOTE && plain) {
        out.push({ text: `「${plain}」`, fontSize: 14, bold: false });
      } else if (bt === BLOCK_TYPE_MAP.DIVIDER) {
        out.push({ text: '———', fontSize: 14, bold: false });
      } else if (plain.trim()) {
        out.push({ text: plain, fontSize: 14, bold: false });
      }
    }

    return out;
  }

  private extractPlainTextFromBlock(block: BlockChildren): string {
    const pick = (
      key: keyof Pick<
        BlockChildren,
        | 'text'
        | 'heading1'
        | 'heading2'
        | 'heading3'
        | 'heading4'
        | 'heading5'
        | 'heading6'
        | 'bullet'
        | 'ordered'
        | 'todo'
        | 'code'
        | 'quote'
      >,
    ): string => {
      const container = block[key] as
        | { elements?: Array<{ text_run?: { content?: string } }> }
        | undefined;
      const elements = container?.elements;
      if (!elements?.length) {
        return '';
      }
      return elements.map((el) => el.text_run?.content ?? '').join('');
    };

    const bt = block.block_type;
    if (bt === BLOCK_TYPE_MAP.TEXT) return pick('text');
    if (bt === BLOCK_TYPE_MAP.HEADING1) return pick('heading1');
    if (bt === BLOCK_TYPE_MAP.HEADING2) return pick('heading2');
    if (bt === BLOCK_TYPE_MAP.HEADING3) return pick('heading3');
    if (bt === BLOCK_TYPE_MAP.HEADING4) return pick('heading4');
    if (bt === BLOCK_TYPE_MAP.HEADING5) return pick('heading5');
    if (bt === BLOCK_TYPE_MAP.HEADING6) return pick('heading6');
    if (bt === BLOCK_TYPE_MAP.BULLET) return pick('bullet');
    if (bt === BLOCK_TYPE_MAP.ORDERED) return pick('ordered');
    if (bt === BLOCK_TYPE_MAP.TODO) return pick('todo');
    if (bt === BLOCK_TYPE_MAP.CODE) return pick('code');
    if (bt === BLOCK_TYPE_MAP.QUOTE) return pick('quote');
    return '';
  }

  /**
   * 按画布可用宽度估算文本占用的视觉行数（含显式换行与自动折行）。
   */
  private estimateBoardVisualRows(
    text: string,
    fontSize: number,
    contentWidthPx: number,
  ): number {
    const charUnit = Math.max(fontSize * 0.5, 6);
    const charsPerLine = Math.max(4, Math.floor(contentWidthPx / charUnit));
    let rows = 0;
    for (const segment of text.split('\n')) {
      const len = segment.length;
      rows += Math.max(1, Math.ceil(len / charsPerLine));
    }
    return Math.max(1, rows);
  }

  /**
   * 单个版块（一段）的尺寸：宽度随最长一行增大（有上限），高度随行数增大。
   */
  private computeBoardCardLayout(
    text: string,
    fontSize: number,
  ): { width: number; height: number; visualRows: number } {
    const padX = LarkBroadService.BOARD_CARD_PAD_X;
    const padY = LarkBroadService.BOARD_CARD_PAD_Y;
    const minW = 280;
    const maxW = 920;
    const lines = text.split('\n');
    const longestRun = Math.max(1, ...lines.map((l) => l.length));

    const width = Math.min(
      maxW,
      Math.max(minW, Math.ceil(longestRun * fontSize * 0.52) + padX * 2),
    );
    const contentW = width - padX * 2;
    const visualRows = this.estimateBoardVisualRows(text, fontSize, contentW);
    const rowLineHeight = fontSize * 1.58;
    const height =
      padY * 2 + Math.max(fontSize * 2.2, visualRows * rowLineHeight);

    return { width, height, visualRows };
  }

  private async appendBoardLines(
    whiteboardId: string,
    lines: Array<{ text: string; fontSize: number; bold: boolean }>,
  ): Promise<LarkBroadAppendMarkdownResult> {
    if (lines.length === 0) {
      return { nodeIds: [] };
    }

    const baseX = 72;
    let y = 80;
    const lineGap = LarkBroadService.BOARD_LINE_GAP_PX;
    const nodes: BoardRoundRectShapeNode[] = [];
    const ts = Date.now();

    const palette = LarkBroadService.BOARD_CARD_PALETTE;

    for (let i = 0; i < lines.length; i++) {
      const { text, fontSize, bold } = lines[i];
      const safe = text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
      const {
        width,
        height: blockHeight,
        visualRows,
      } = this.computeBoardCardLayout(safe, fontSize);

      const isHeading = bold && fontSize >= 17;
      const multiLineParagraph = visualRows > 1 || safe.includes('\n');
      const colors = palette[i % palette.length];

      nodes.push({
        id: `zeno:${ts}:${i}`,
        type: 'composite_shape',
        x: baseX,
        y,
        angle: 0,
        height: blockHeight,
        width,
        z_index: i,
        text: {
          text: safe,
          font_weight: bold ? 'bold' : 'regular',
          font_size: fontSize,
          horizontal_align: isHeading ? 'center' : 'left',
          vertical_align: multiLineParagraph ? 'top' : 'mid',
          text_color: '#1f2329',
          line_through: false,
          underline: false,
          italic: false,
          angle: 0,
          theme_text_color_code: -1,
          theme_text_background_color_code: -1,
          text_color_type: 0,
          text_background_color_type: 0,
        },
        style: {
          fill_color: colors.fill,
          fill_opacity: 100,
          border_style: 'solid',
          border_width: 'narrow',
          border_color: colors.border,
          border_opacity: 100,
          theme_fill_color_code: -1,
          theme_border_color_code: -1,
          fill_color_type: 0,
          border_color_type: 0,
        },
        composite_shape: {
          type: 'round_rect',
        },
      });

      y += blockHeight + lineGap;
    }

    const raw: unknown = await this.requireClient().request({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes`,
      data: { nodes },
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });

    const code = readFeishuCodeFromRaw(raw);
    if (code !== undefined && code !== 0) {
      const msg = readFeishuErrorMsg(raw);
      throw new Error(`写入画板失败: code=${code}${msg ? ` msg=${msg}` : ''}`);
    }

    const data = unwrapBizData<LarkBoardNodesCreateResponseData>(raw);
    const fromIds = data?.ids?.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const fromNodes =
      data?.nodes
        ?.map((n) => n.node_id ?? n.id)
        .filter((id): id is string => typeof id === 'string') ?? [];
    const nodeIds = fromIds && fromIds.length > 0 ? fromIds : fromNodes;

    this.logger.log(
      `✅ 已向画板提交 ${nodes.length} 个图形节点（composite_shape，服务端返回 id ${nodeIds.length} 条）`,
    );

    return { nodeIds };
  }
}
