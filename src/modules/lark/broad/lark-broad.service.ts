import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { BLOCK_TYPE_MAP, BlockChildren } from '../doc/lark-doc-block.types';
import { LarkDocService } from '../doc/lark-doc.service';
import {
  LARK_BOARD_BLOCK_TYPE,
  LarkBroadAppendMarkdownResult,
  LarkBroadCreateBoardResult,
} from './lark-broad.types';
import { InstructionDetectorService } from '../../common/instruction-detector.service';

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

/** 画板「文本图形」节点（与官方示例字段对齐的最小子集） */
interface BoardTextShapeNode {
  id: string;
  type: 'text_shape';
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
  /** 单行过长时拆成多段，避免画布上一行拉得过宽、与上下行视觉重叠 */
  private static readonly BOARD_LINE_MAX_CHARS = 52;
  /** 相邻文本图形纵向间距（px） */
  private static readonly BOARD_LINE_GAP_PX = 26;

  private client: Lark.Client | null = null;
  private readonly docService: LarkDocService;

  constructor(
    configService: ConfigService,
    instructionDetector: InstructionDetectorService,
  ) {
    this.docService = new LarkDocService(configService, instructionDetector);
  }

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
   * 将 Markdown 解析为与文档块相同的结构，再映射为画板上的多段文本节点（纵向排列）。
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

  /** 向画板追加纯文本（单个 text_shape，用于兼容旧逻辑） */
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
        out.push({ text: '```', fontSize: 12, bold: false });
        out.push({ text: body, fontSize: 12, bold: false });
        out.push({ text: '```', fontSize: 12, bold: false });
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

  /** 将超长单行拆成多行文本图形，减少横向挤成一团 */
  private expandBoardLinesForReadability(
    lines: Array<{ text: string; fontSize: number; bold: boolean }>,
  ): Array<{ text: string; fontSize: number; bold: boolean }> {
    const max = LarkBroadService.BOARD_LINE_MAX_CHARS;
    const out: Array<{ text: string; fontSize: number; bold: boolean }> = [];
    for (const line of lines) {
      const t = line.text;
      if (t.length <= max) {
        out.push(line);
        continue;
      }
      for (let i = 0; i < t.length; i += max) {
        out.push({
          text: t.slice(i, i + max),
          fontSize: line.fontSize,
          bold: line.bold,
        });
      }
    }
    return out;
  }

  private async appendBoardLines(
    whiteboardId: string,
    lines: Array<{ text: string; fontSize: number; bold: boolean }>,
  ): Promise<LarkBroadAppendMarkdownResult> {
    const expanded = this.expandBoardLinesForReadability(lines);
    if (expanded.length === 0) {
      return { nodeIds: [] };
    }

    const baseX = 72;
    let y = 80;
    const lineGap = LarkBroadService.BOARD_LINE_GAP_PX;
    const nodes: BoardTextShapeNode[] = [];
    const ts = Date.now();

    for (let i = 0; i < expanded.length; i++) {
      const { text, fontSize, bold } = expanded[i];
      const safe = text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
      const lineHeight = Math.max(28, fontSize * 1.75);
      const width = Math.min(
        880,
        Math.max(120, Math.ceil(safe.length * (fontSize * 0.48))),
      );

      nodes.push({
        id: `zeno:${ts}:${i}`,
        type: 'text_shape',
        x: baseX,
        y,
        angle: 0,
        height: lineHeight,
        width,
        z_index: i,
        text: {
          text: safe,
          font_weight: bold ? 'bold' : 'regular',
          font_size: fontSize,
          horizontal_align: 'left',
          vertical_align: 'top',
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
      });

      y += lineHeight + lineGap;
    }

    const raw: unknown = (await this.requireClient().request({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes`,
      data: { nodes },
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })) as unknown;

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
      `✅ 已向画板提交 ${nodes.length} 个文本节点（服务端返回 id ${nodeIds.length} 条）`,
    );

    return { nodeIds };
  }
}
