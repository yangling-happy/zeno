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

function readIdLikeString(value: unknown): string | undefined {
  const s = readOptionalString(value);
  if (s) return s;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = String(value);
    return n.length > 0 ? n : undefined;
  }
  return undefined;
}

/** 值侧 token：飞书部分环境的页 token 为全小写字母串（无语义级大写/数字），此前误判丢弃导致采集为空。 */
function looksLikeFeishuOpaqueTokenValue(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{12,}$/.test(value)) return false;
  return !/^[a-z]+(_[a-z]+)+$/.test(value);
}

/** 映射键：允许全小写随机串，但排除典型 API 字段名误当作页 token。 */
const RESERVED_SLIDE_MAP_KEYS = new Set(
  [
    'presentation_id',
    'revision_id',
    'layout_id',
    'master_id',
    'page_size',
    'folder_token',
    'parent_id',
    'document_id',
  ].map((s) => s.toLowerCase()),
);

function looksLikeFeishuOpaqueTokenMapKey(key: string): boolean {
  if (RESERVED_SLIDE_MAP_KEYS.has(key.toLowerCase())) return false;
  return looksLikeFeishuOpaqueTokenValue(key);
}

function summarizeSlidesBranchForLog(slides: unknown): string {
  if (slides === undefined) return 'undefined';
  if (slides === null) return 'null';
  if (Array.isArray(slides)) {
    if (slides.length === 0) return 'array(len=0)';
    const first: unknown = slides[0];
    if (isRecord(first)) {
      const keys = Object.keys(first);
      const head = keys.slice(0, 20).join(',');
      return `array(len=${slides.length},firstKeys=[${head}${keys.length > 20 ? ',…' : ''}])`;
    }
    return `array(len=${slides.length},firstType=${typeof first})`;
  }
  if (isRecord(slides)) {
    const keys = Object.keys(slides);
    const head = keys.slice(0, 20).join(',');
    return `object(keys=[${head}${keys.length > 20 ? ',…' : ''}])`;
  }
  return `type=${typeof slides}`;
}

/**
 * `presentation.slides` 有时为「token → 页元数据」映射而非数组；
 * 仅在值均为对象且键形似 token 时把键当作 slide_id。
 */
function extractSlideIdsFromKeyedSlideMap(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const entries = Object.entries(value);
  if (entries.length === 0) return [];

  const keysAsIds: string[] = [];
  let objectValueCount = 0;
  for (const [k, v] of entries) {
    if (!looksLikeFeishuOpaqueTokenMapKey(k)) {
      return [];
    }
    if (isRecord(v)) {
      objectValueCount += 1;
      keysAsIds.push(k);
    }
  }
  if (objectValueCount === 0 || objectValueCount !== entries.length) {
    return [];
  }
  return keysAsIds;
}

/**
 * 将各种形态的 slides 字段规整为可遍历的列表（数组、items 包裹、纯 Record 列表值等）。
 */
function coerceSlidesIterable(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  const nestedKeys = [
    'items',
    'slide_list',
    'slides',
    'pages',
    'slide_pages',
    'values',
    'list',
  ] as const;
  for (const k of nestedKeys) {
    const inner = value[k];
    if (Array.isArray(inner)) return inner;
  }

  const fromKeyedMap = extractSlideIdsFromKeyedSlideMap(value);
  if (fromKeyedMap.length > 0) {
    return fromKeyedMap.map((id) => ({ slide_id: id }));
  }

  const vals = Object.values(value);
  if (vals.length > 0 && vals.every((x) => isRecord(x))) {
    return vals;
  }
  return [];
}

function readSlideIdFromSlideRecord(
  item: Record<string, unknown>,
  depth: number,
): string | undefined {
  if (depth <= 0) return undefined;

  const direct =
    readIdLikeString(item['slide_id']) ??
    readIdLikeString(item['slideId']) ??
    readIdLikeString(item['slide_page_id']) ??
    readIdLikeString(item['page_id']) ??
    readIdLikeString(item['slide_token']) ??
    readIdLikeString(item['slideToken']) ??
    readIdLikeString(item['page_token']) ??
    readIdLikeString(item['object_token']) ??
    readIdLikeString(item['token']) ??
    readIdLikeString(item['id']);

  if (direct) return direct;

  const nestedKeys = ['slide', 'page', 'slide_page', 'properties'] as const;
  for (const nk of nestedKeys) {
    const inner = item[nk];
    if (isRecord(inner)) {
      const nested = readSlideIdFromSlideRecord(inner, depth - 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** 兼容部分网关/序列化把 code 写成字符串的情况 */
function readFeishuEnvelopeCode(
  raw: Record<string, unknown>,
): number | undefined {
  const c = raw['code'];
  if (typeof c === 'number' && Number.isFinite(c)) {
    return c;
  }
  if (typeof c === 'string' && /^\d+$/.test(c)) {
    return parseInt(c, 10);
  }
  return undefined;
}

/**
 * Lark {@link Lark.Client.request} 返回 axios 完整响应（含 status/config/data），
 * 飞书 JSON 体在 `response.data`；单测等处也可直接传入 `{ code, data }` 信封。
 */
function unwrapLarkHttpResponse(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const looksLikeAxios =
    typeof raw['status'] === 'number' &&
    raw['config'] !== undefined &&
    'data' in raw;
  const envelope = looksLikeAxios ? raw['data'] : raw;
  return isRecord(envelope) ? envelope : null;
}

/** 建页 POST 非成功传输层（纯文本/HTML、HTTP≥400），便于与业务 code≠0 区分。 */
function describeSlideCreateTransportFailure(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t.length > 0 ? t.slice(0, 160) : 'empty string body';
  }
  if (!isRecord(raw)) return undefined;
  const status = raw['status'];
  if (typeof status === 'number' && status >= 400) {
    const data = raw['data'];
    if (typeof data === 'string') {
      const t = data.trim();
      return `HTTP ${status} ${t.slice(0, 160)}`;
    }
    const inner = unwrapLarkHttpResponse(raw);
    if (inner) {
      const code = readFeishuEnvelopeCode(inner);
      const msg = readOptionalString(inner['msg']);
      if (code !== undefined) {
        return `HTTP ${status} body code=${code} msg=${msg ?? 'unknown'}`;
      }
    }
    return `HTTP ${status}`;
  }
  return undefined;
}

function readHeaderValueCaseInsensitive(
  headers: Record<string, unknown> | null,
  headerName: string,
): string | undefined {
  if (!headers) return undefined;
  const expected = headerName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== expected) continue;
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === 'string' &&
      v[0].trim().length > 0
    ) {
      return v[0].trim();
    }
  }
  return undefined;
}

function summarizeCreatePageProbe(raw: unknown): string {
  if (typeof raw === 'string') {
    const body = raw.trim();
    const preview = body.length > 0 ? body.slice(0, 160) : 'empty string body';
    return `status=n/a x-tt-logid=n/a body=${preview}`;
  }
  if (!isRecord(raw)) {
    return `status=n/a x-tt-logid=n/a body=non-object(${typeof raw})`;
  }

  const status =
    typeof raw['status'] === 'number' ? String(raw['status']) : 'n/a';
  const headers = isRecord(raw['headers']) ? raw['headers'] : null;
  const xTtLogId =
    readHeaderValueCaseInsensitive(headers, 'x-tt-logid') ??
    readHeaderValueCaseInsensitive(headers, 'x-tt-logid-bin') ??
    'n/a';

  const envelope = unwrapLarkHttpResponse(raw);
  if (envelope) {
    const code = readFeishuEnvelopeCode(envelope);
    const msg = readOptionalString(envelope['msg']) ?? 'n/a';
    const data = envelope['data'];
    const dataShape = Array.isArray(data)
      ? `array(len=${data.length})`
      : isRecord(data)
        ? `object(keys=${Object.keys(data).slice(0, 8).join(',')})`
        : typeof data;
    return `status=${status} x-tt-logid=${xTtLogId} code=${code ?? 'n/a'} msg=${msg} data=${dataShape}`;
  }

  const data = raw['data'];
  if (typeof data === 'string') {
    return `status=${status} x-tt-logid=${xTtLogId} body=${data.trim().slice(0, 160)}`;
  }
  return `status=${status} x-tt-logid=${xTtLogId} bodyType=${typeof data}`;
}

function readRevisionIdFromPresentationEnvelope(
  raw: unknown,
): string | undefined {
  const envelope = unwrapLarkHttpResponse(raw);
  if (!envelope) return undefined;
  const biz = isRecord(envelope['data']) ? envelope['data'] : null;
  if (!biz) return undefined;
  const pres = isRecord(biz['presentation']) ? biz['presentation'] : null;
  return pres ? readIdLikeString(pres['revision_id']) : undefined;
}

/** 字段值严禁当作页 token 采集（名称稳定、语义明确）。 */
const HARVEST_TOKEN_KEY_BLOCKLIST = new Set(
  [
    'presentation_id',
    'revision_id',
    'layout_id',
    'master_id',
    'theme_id',
    'template_id',
    'font_id',
    'page_size',
    'folder_token',
    'parent_id',
    'document_id',
    'style_id',
    'color_id',
    'width',
    'height',
  ].map((s) => s.toLowerCase()),
);

/**
 * 线网元数据里页 token 偶发落在非常规字段名上；仅在 slides/layouts/masters 子树内，
 * 按字段名启发式采集。空白 slides + 仅 layouts 有数据时，字段名未必含 slide/page，
 * 故补充 `_id` / `_token` 后缀兜底（仍排除 layout/master 语义字段）。
 */
function keyMayHoldSlidePageToken(key: string): boolean {
  const k = key.toLowerCase();
  if (HARVEST_TOKEN_KEY_BLOCKLIST.has(k)) return false;
  if (k.includes('layout') && !k.includes('slide')) return false;
  if (k.includes('master') && !k.includes('slide')) return false;
  if (k === 'id' || k === 'token') return true;
  if (k.includes('slide') && (k.includes('id') || k.includes('token')))
    return true;
  if (k.includes('page') && (k.includes('id') || k.includes('token')))
    return true;
  if (k.endsWith('_token') || k.endsWith('_id')) return true;
  return false;
}

function harvestSlidePageTokensFromPresentationBranches(
  presentation: Record<string, unknown>,
  excludePresentationId: string | undefined,
): string[] {
  const revisionId = readIdLikeString(presentation['revision_id']);
  const exclude = new Set<string>();
  const presId = readOptionalString(excludePresentationId);
  if (presId) exclude.add(presId);
  if (revisionId) exclude.add(revisionId);

  const found: string[] = [];
  const seen = new Set<string>();
  let nodesVisited = 0;
  const MAX_NODES = 800;

  const visit = (v: unknown): void => {
    if (nodesVisited++ > MAX_NODES) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isRecord(v)) return;
    for (const [key, val] of Object.entries(v)) {
      if (typeof val === 'string' && keyMayHoldSlidePageToken(key)) {
        if (
          looksLikeFeishuOpaqueTokenValue(val) &&
          !exclude.has(val) &&
          !seen.has(val)
        ) {
          seen.add(val);
          found.push(val);
        }
      }
      visit(val);
    }
  };

  for (const branchKey of ['slides', 'layouts', 'masters'] as const) {
    const branch = presentation[branchKey];
    if (branch !== undefined && branch !== null) {
      visit(branch);
    }
  }
  return found;
}

function parsePresentationCreateResponse(raw: unknown): string | undefined {
  const envelope = unwrapLarkHttpResponse(raw);
  if (!envelope) return undefined;
  const biz = isRecord(envelope['data']) ? envelope['data'] : null;
  if (!biz) return undefined;
  const presentation = biz['presentation'];
  if (isRecord(presentation)) {
    const id = readOptionalString(presentation['presentation_id']);
    if (id) return id;
  }
  return readOptionalString(biz['presentation_id']);
}

function extractSlideIdsFromUnknownList(value: unknown): string[] {
  const iterable = coerceSlidesIterable(value);
  const ids: string[] = [];
  for (const item of iterable) {
    if (typeof item === 'string' || typeof item === 'number') {
      const id = readIdLikeString(item);
      if (id) ids.push(id);
      continue;
    }
    if (!isRecord(item)) continue;
    const id = readSlideIdFromSlideRecord(item, 4);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * 线网「获取演示文稿」响应里 slide 列表可能嵌套在 revision / slide_list 等路径下，
 * 或仅用 slide_page_id 等字段命名；在浅层解析为空时做有限深度 DFS。
 */
function deepCollectSlideIdsFromEnvelope(
  value: unknown,
  options: { maxDepth: number; excludeToken?: string },
): string[] {
  const visited = new WeakSet<object>();
  const SLIDE_KEY_HINTS = [
    'slide_id',
    'slideId',
    'slide_page_id',
    'slide_token',
    'slideToken',
    'page_token',
    'object_token',
    'default_slide_id',
    'first_slide_id',
    'primary_slide_id',
    'page_id',
  ] as const;

  const found = new Set<string>();
  const exclude = readOptionalString(options.excludeToken);

  const walk = (v: unknown, d: number): void => {
    if (d > options.maxDepth || v === null || v === undefined) {
      return;
    }
    if (Array.isArray(v)) {
      for (const el of v) {
        walk(el, d + 1);
      }
      return;
    }
    if (!isRecord(v)) {
      return;
    }
    if (visited.has(v)) {
      return;
    }
    visited.add(v);

    for (const key of SLIDE_KEY_HINTS) {
      const s = readOptionalString(v[key]);
      if (s && (!exclude || s !== exclude)) {
        found.add(s);
      }
    }

    for (const child of Object.values(v)) {
      walk(child, d + 1);
    }
  };

  walk(value, 0);
  return [...found];
}

function mergeSlideIdLists(preferred: string[], extra: string[]): string[] {
  const out = [...preferred];
  for (const id of extra) {
    if (!out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** 从创建演示文稿的响应体中尽量解析 slide_id 列表（顺序：presentation 内嵌 → data 根字段）。 */
function parsePresentationCreateSlideIds(
  raw: unknown,
  excludePresentationId?: string,
): string[] {
  const envelope = unwrapLarkHttpResponse(raw);
  if (!envelope) return [];

  const biz = isRecord(envelope['data']) ? envelope['data'] : null;
  if (!biz) {
    return deepCollectSlideIdsFromEnvelope(envelope, {
      maxDepth: 14,
      excludeToken: excludePresentationId,
    });
  }

  const ordered: string[] = [];
  const pushUnique = (next: string[]) => {
    for (const id of next) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  };

  const pres = isRecord(biz['presentation']) ? biz['presentation'] : null;
  if (pres) {
    pushUnique(extractSlideIdsFromUnknownList(pres['slides']));
    pushUnique(extractSlideIdsFromUnknownList(pres['slide_list']));
    pushUnique(extractSlideIdsFromUnknownList(pres['pages']));
    pushUnique(extractSlideIdsFromUnknownList(pres['slide_pages']));
    pushUnique(extractSlideIdsFromUnknownList(pres['revision_slides']));
    const rev = pres['revision'];
    if (isRecord(rev)) {
      pushUnique(extractSlideIdsFromUnknownList(rev['slides']));
      pushUnique(extractSlideIdsFromUnknownList(rev['slide_list']));
      pushUnique(extractSlideIdsFromUnknownList(rev['pages']));
      pushUnique(extractSlideIdsFromUnknownList(rev['revision_slides']));
    }
    const one =
      readOptionalString(pres['slide_id']) ??
      readOptionalString(pres['default_slide_id']);
    if (one) pushUnique([one]);

    pushUnique(
      harvestSlidePageTokensFromPresentationBranches(
        pres,
        excludePresentationId,
      ),
    );
  }

  pushUnique(extractSlideIdsFromUnknownList(biz['slides']));
  pushUnique(extractSlideIdsFromUnknownList(biz['slide_list']));
  pushUnique(extractSlideIdsFromUnknownList(biz['pages']));
  pushUnique(extractSlideIdsFromUnknownList(biz['slide_pages']));
  pushUnique(extractSlideIdsFromUnknownList(biz['revision_slides']));
  const rootOne =
    readOptionalString(biz['slide_id']) ??
    readOptionalString(biz['default_slide_id']);
  if (rootOne) pushUnique([rootOne]);

  return mergeSlideIdLists(
    ordered,
    deepCollectSlideIdsFromEnvelope(envelope, {
      maxDepth: 14,
      excludeToken: excludePresentationId,
    }),
  );
}

function parseListSlideIdsResponse(raw: unknown): string[] {
  const envelope = unwrapLarkHttpResponse(raw);
  if (!envelope) return [];

  const rootData = isRecord(envelope['data']) ? envelope['data'] : envelope;
  const code =
    readFeishuEnvelopeCode(envelope) ??
    (isRecord(rootData) ? readFeishuEnvelopeCode(rootData) : undefined);
  if (code !== undefined && code !== 0) {
    const msg =
      readOptionalString(envelope['msg']) ??
      (isRecord(rootData) ? readOptionalString(rootData['msg']) : undefined) ??
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
  let slidesRaw: unknown[] = [];
  for (const c of slideListCandidates) {
    if (c === undefined) continue;
    const coerced = coerceSlidesIterable(c);
    if (coerced.length > 0) {
      slidesRaw = coerced;
      break;
    }
  }

  return slidesRaw
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return readIdLikeString(item);
      }
      if (!isRecord(item)) return undefined;
      return readSlideIdFromSlideRecord(item, 4);
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
  private httpProbeTenantTokenCache:
    | { token: string; expiresAtMs: number }
    | undefined;
  private static readonly MAX_TEXT_BLOCK_CONTENT_LENGTH = 20_000;
  private static readonly MAX_BLOCKS_PER_REQUEST = 50;
  /**
   * GET 演示文稿元数据失败时的最大连续尝试次数（首次立即，间隔为 0，不做「等页面出现」式退避）。
   * 新建演示文稿后若创建响应未带页列表，会先在 createPresentation 内 POST 新建第一页；
   * 一旦 GET 成功解析到元数据但 slides 为空，立即 POST 新建第一页，不依赖延长等待服务端补齐默认页。
   */
  private static readonly PRESENTATION_META_FETCH_MAX_ATTEMPTS = 4;

  /**
   * Slides OpenAPI 下列出/新建「页」的路径后缀（官方为 `pages`，勿使用 `/slides`）。
   */
  private static readonly PRESENTATION_PAGES_RESOURCE = 'pages';

  /**
   * 单测可设为较小正整数以缩短循环；线网勿用。
   * @internal
   */
  static testPresentationMetaFetchMaxAttempts: number | null = null;

  private presentationMetaFetchMaxAttempts(): number {
    return (
      LarkSlidesService.testPresentationMetaFetchMaxAttempts ??
      LarkSlidesService.PRESENTATION_META_FETCH_MAX_ATTEMPTS
    );
  }

  /**
   * 另：`GET .../presentations/:id/pages` 列页（勿用 `/slides` 后缀）。
   * 默认在「单演示文稿」元数据反复拿不到 slide_id 时再尝试一次列表接口。
   * 若需完全跳过该请求（避免噪音日志），设置 `LARK_SLIDES_DISABLE_LEGACY_LIST_FALLBACK=true`。
   *
   * `LARK_SLIDES_USE_LEGACY_LIST_SLIDES_PATH=true` 仍保留：为 true 时与默认相同；
   * 为 false 时等价于禁用上述 fallback（与 DISABLE 一致）。
   */
  private shouldTryLegacyListSlidesFallback(): boolean {
    if (typeof this.configService?.get !== 'function') {
      return true;
    }
    const disable =
      readOptionalString(
        this.configService.get<string>(
          'LARK_SLIDES_DISABLE_LEGACY_LIST_FALLBACK',
        ),
      ) === 'true';
    if (disable) {
      return false;
    }
    const legacyFlag = readOptionalString(
      this.configService.get<string>('LARK_SLIDES_USE_LEGACY_LIST_SLIDES_PATH'),
    );
    if (legacyFlag === 'false') {
      return false;
    }
    return true;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly instructionDetector: InstructionDetectorService,
  ) {}

  initClient(client: Lark.Client) {
    this.client = client;
  }

  private shouldUseHttpProbe(): boolean {
    if (typeof this.configService?.get !== 'function') {
      return false;
    }
    return (
      readOptionalString(
        this.configService.get<string>('LARK_SLIDES_HTTP_PROBE'),
      ) === 'true'
    );
  }

  private async getTenantAccessTokenForHttpProbe(): Promise<
    string | undefined
  > {
    const now = Date.now();
    const cached = this.httpProbeTenantTokenCache;
    if (cached && cached.expiresAtMs > now) {
      return cached.token;
    }

    const appId = readOptionalString(
      this.configService.get<string>('LARK_APP_ID'),
    );
    const appSecret = readOptionalString(
      this.configService.get<string>('LARK_APP_SECRET'),
    );
    if (!appId || !appSecret) {
      this.logger.warn(
        '[slides-http-probe] 未配置 LARK_APP_ID/LARK_APP_SECRET，无法走原生 HTTP 探针',
      );
      return undefined;
    }

    let resp: Response;
    try {
      resp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        },
      );
    } catch (e) {
      this.logger.warn(
        `[slides-http-probe] 获取 tenant_access_token 请求失败: ${(e as Error).message}`,
      );
      return undefined;
    }

    const text = await resp.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      json = isRecord(parsed) ? parsed : null;
    } catch {
      json = null;
    }

    const code = json ? readFeishuEnvelopeCode(json) : undefined;
    const token = json
      ? readOptionalString(json['tenant_access_token'])
      : undefined;
    if (!resp.ok || (code !== undefined && code !== 0) || !token) {
      const msg = json ? readOptionalString(json['msg']) : undefined;
      this.logger.warn(
        `[slides-http-probe] 获取 tenant_access_token 失败: http=${resp.status} code=${code ?? 'n/a'} msg=${msg ?? text.slice(0, 120)}`,
      );
      return undefined;
    }

    const expire = json?.['expire'];
    const expireSec =
      typeof expire === 'number' && Number.isFinite(expire) ? expire : 7200;
    this.httpProbeTenantTokenCache = {
      token,
      expiresAtMs: now + Math.max(30, expireSec - 60) * 1000,
    };
    return token;
  }

  private async requestWithHttpProbe(args: {
    method: 'GET' | 'POST';
    url: string;
    params?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.getTenantAccessTokenForHttpProbe();
    if (!token) {
      throw new Error('http probe tenant_access_token unavailable');
    }

    const u = new URL(args.url);
    for (const [k, v] of Object.entries(args.params ?? {})) {
      if (v === undefined || v === null) continue;
      const serialized =
        readIdLikeString(v) ?? (typeof v === 'boolean' ? String(v) : undefined);
      if (!serialized) continue;
      u.searchParams.set(k, serialized);
    }

    const resp = await fetch(u.toString(), {
      method: args.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body:
        args.method === 'POST' ? JSON.stringify(args.data ?? {}) : undefined,
    });

    const headersObj = Object.fromEntries(resp.headers.entries());
    const bodyText = await resp.text();
    let body: unknown = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }

    return {
      status: resp.status,
      headers: headersObj,
      config: { url: u.toString(), method: args.method },
      data: body,
    };
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

    let slideIdsFromCreate = parsePresentationCreateSlideIds(
      raw,
      presentationId,
    );
    // 勿在此处单独调用 createPage：resolvePresentationSlideIds 已包含
    // GET 元数据 → slides 为空则 POST 建页 → 列表兜底；前置 createPage 会导致探针与 WARN 重复一整轮。
    if (slideIdsFromCreate.length === 0) {
      slideIdsFromCreate =
        await this.resolvePresentationSlideIds(presentationId);
    }

    const firstSlideIdFromCreate = slideIdsFromCreate[0];

    return {
      presentationId,
      url: `https://feishu.cn/slides/${presentationId}`,
      pages: slideIdsFromCreate.map((pageId) => ({ pageId })),
      firstSlideId: firstSlideIdFromCreate,
    };
  }

  private presentationResourceUrl(presentationId: string): string {
    return `https://open.feishu.cn/open-apis/slides/v1/presentations/${encodeURIComponent(
      presentationId,
    )}`;
  }

  /** 单次 GET 演示文稿，提取 revision_id；用于列表为空后再次建页（POST 须使用 `/pages` 而非 `/slides`）。 */
  private async fetchPresentationRevisionHint(
    presentationId: string,
  ): Promise<string | undefined> {
    if (!this.client) {
      return undefined;
    }
    try {
      const raw: unknown = await this.client.request({
        method: 'GET',
        url: this.presentationResourceUrl(presentationId),
        validateStatus: () => true,
      });
      if (!this.isSuccessfulPresentationMetaFetch(raw)) {
        return undefined;
      }
      return readRevisionIdFromPresentationEnvelope(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * 「列出演示文稿页面」：`GET .../presentations/:id/pages`（及带 revision 的变体）。
   * 若元数据含 `revision_id`，优先尝试 `.../revisions/:revision_id/pages` 与 `.../pages?revision_id=`。
   * @see https://open.feishu.cn/document/server-docs/docs/slides-v1/slide/list
   */
  private async fetchSlideIdsFromLegacyListPath(
    presentationId: string,
    revisionId?: string,
  ): Promise<string[]> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }

    const base = this.presentationResourceUrl(presentationId);
    const attempts: Array<{
      label: string;
      url: string;
      params: Record<string, unknown>;
    }> = [];

    const rev = readIdLikeString(revisionId);
    if (rev) {
      attempts.push({
        label: 'revisions/.../pages',
        url: `${base}/revisions/${encodeURIComponent(rev)}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
        params: { page_size: 100 },
      });
      attempts.push({
        label: 'pages?revision_id',
        url: `${base}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
        params: { page_size: 100, revision_id: rev },
      });
    }
    attempts.push({
      label: 'pages',
      url: `${base}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
      params: { page_size: 100 },
    });

    let lastNonJson: string | undefined;

    for (const a of attempts) {
      try {
        const useProbe = this.shouldUseHttpProbe();
        const raw: unknown = useProbe
          ? await this.requestWithHttpProbe({
              method: 'GET',
              url: a.url,
              params: a.params,
            })
          : await this.client.request({
              method: 'GET',
              url: a.url,
              params: a.params,
              validateStatus: () => true,
            });
        if (useProbe) {
          this.logger.warn(
            `[slides-http-probe] listPages attempt=${a.label} response=${summarizeCreatePageProbe(raw)}`,
          );
        }

        if (typeof raw === 'string') {
          lastNonJson = raw.trim().slice(0, 120);
          continue;
        }
        if (!isRecord(raw)) {
          continue;
        }
        const status = raw['status'];
        const transportBody = raw['data'];
        if (
          typeof status === 'number' &&
          status >= 400 &&
          typeof transportBody === 'string'
        ) {
          lastNonJson = transportBody.trim().slice(0, 120);
          continue;
        }

        const envelope = unwrapLarkHttpResponse(raw);
        const listCode = envelope
          ? readFeishuEnvelopeCode(envelope)
          : undefined;
        if (listCode !== undefined && listCode !== 0) {
          const msg = envelope
            ? readOptionalString(envelope['msg'])
            : undefined;
          this.logger.warn(
            `列出幻灯片页失败 [${a.label}]: presentation_id=${presentationId} code=${listCode} msg=${msg ?? 'unknown'}`,
          );
          continue;
        }

        let ids: string[] = [];
        try {
          ids = parseListSlideIdsResponse(raw);
        } catch (parseErr) {
          this.logger.warn(
            `解析幻灯片列表响应失败 [${a.label}]: ${(parseErr as Error).message}`,
          );
          continue;
        }

        if (ids.length > 0) {
          this.logger.log(
            `📑 已通过列表接口 [${a.label}] 解析 ${ids.length} 个 slide_id`,
          );
          return ids;
        }
      } catch (e) {
        this.logger.warn(
          `请求幻灯片列表失败 [${a.label}]: ${presentationId} — ${(e as Error).message}`,
        );
      }
    }

    const hint =
      lastNonJson !== undefined ? `（末次非 JSON：${lastNonJson}）` : '';
    this.logger.warn(
      `GET 幻灯片列表多路径均未返回可用页面: ${presentationId}${hint}`,
    );
    return [];
  }

  /** GET 演示文稿元数据请求已成功（业务 code=0），而非网络层错误或业务报错。 */
  private isSuccessfulPresentationMetaFetch(raw: unknown): boolean {
    const envelope = unwrapLarkHttpResponse(raw);
    if (!envelope) return false;
    const code = readFeishuEnvelopeCode(envelope);
    return code === undefined || code === 0;
  }

  /**
   * 依次：GET 单演示文稿元数据（失败则立即再试，不睡眠退避）；
   * 若已成功返回但 slides 仍为空则立刻 POST 新建第一页；必要时再走 legacy .../pages 列表兜底。
   */
  private async resolvePresentationSlideIds(
    presentationId: string,
  ): Promise<string[]> {
    const maxAttempts = this.presentationMetaFetchMaxAttempts();
    let lastMetaErr: unknown;
    let lastRawMeta: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (!this.client) {
          throw new Error('飞书客户端未初始化');
        }
        const rawMeta: unknown = await this.client.request({
          method: 'GET',
          url: this.presentationResourceUrl(presentationId),
          validateStatus: () => true,
        });
        lastRawMeta = rawMeta;
        const ids = this.trySlideIdsFromPresentationEnvelope(
          rawMeta,
          presentationId,
        );
        if (ids.length > 0) {
          return ids;
        }
        if (this.isSuccessfulPresentationMetaFetch(rawMeta)) {
          const revisionHint = readRevisionIdFromPresentationEnvelope(rawMeta);
          const created = await this.createPage(presentationId, revisionHint);
          if (created) {
            return [created];
          }
          break;
        }
      } catch (e) {
        lastMetaErr = e;
        if (i < maxAttempts - 1) {
          this.logger.warn(
            `获取演示文稿元数据失败，将重试 (${i + 1}/${maxAttempts}): ${presentationId} — ${(e as Error).message}`,
          );
        }
      }
    }

    if (lastRawMeta !== undefined) {
      this.logPresentationMetadataWithoutSlides(presentationId, lastRawMeta);
    }

    if (lastMetaErr) {
      const metaErrMsg =
        lastMetaErr instanceof Error
          ? lastMetaErr.message
          : typeof lastMetaErr === 'string'
            ? lastMetaErr
            : JSON.stringify(lastMetaErr);
      this.logger.warn(
        `多次 GET 演示文稿仍未解析到 slide_id: ${presentationId} — ${metaErrMsg}`,
      );
    }

    if (this.shouldTryLegacyListSlidesFallback()) {
      const revisionId = readRevisionIdFromPresentationEnvelope(lastRawMeta);
      const fromList = await this.fetchSlideIdsFromLegacyListPath(
        presentationId,
        revisionId,
      );
      if (fromList.length > 0) {
        return fromList;
      }
    }

    return [];
  }

  /**
   * 从「获取演示文稿」或「创建演示文稿」类响应中解析 slide_id（与 parsePresentationCreateSlideIds 同源结构）。
   */
  private trySlideIdsFromPresentationEnvelope(
    raw: unknown,
    presentationId?: string,
  ): string[] {
    if (typeof raw === 'string') {
      return [];
    }
    if (!isRecord(raw)) {
      return [];
    }
    const code = readFeishuEnvelopeCode(raw);
    if (code !== undefined && code !== 0) {
      const msg = readOptionalString(raw['msg']) ?? 'unknown';
      this.logger.warn(
        `获取演示文稿返回错误码，跳过解析 slide_id（presentation_id=${presentationId ?? '?'}）: ${code} ${msg}`,
      );
      return [];
    }
    return parsePresentationCreateSlideIds(raw, presentationId);
  }

  /** 便于对照线网真实响应形状排查权限/字段变更（不包含正文）。 */
  private logPresentationMetadataWithoutSlides(
    presentationId: string,
    raw: unknown,
  ): void {
    const envelope = unwrapLarkHttpResponse(raw);
    if (!envelope) {
      this.logger.warn(
        `GET 演示文稿返回非 JSON 对象，无法解析 slide_id: ${presentationId}`,
      );
      return;
    }
    const code = readFeishuEnvelopeCode(envelope);
    const msg = readOptionalString(envelope['msg']);
    const data = envelope['data'];
    const dataKeys = isRecord(data) ? Object.keys(data).join(',') : typeof data;
    let presentationKeys = '';
    let slidesBranch = 'n/a';
    if (isRecord(data) && isRecord(data['presentation'])) {
      const pres = data['presentation'];
      presentationKeys = Object.keys(pres).join(',');
      slidesBranch = summarizeSlidesBranchForLog(pres['slides']);
    }
    this.logger.warn(
      `演示文稿元数据解析 slide_id 为空（${presentationId}）code=${code ?? 'n/a'} msg=${msg ?? 'n/a'} dataKeys=[${dataKeys}] presentationKeys=[${presentationKeys}] slidesBranch=${slidesBranch}`,
    );
  }

  /**
   * 列出演示文稿中的幻灯片页 ID（用于向指定页追加块）。
   * 依赖 GET /presentations/:id；必要时从 layouts/masters 子树启发式采集，
   * 并依次尝试 revisions/:revision_id/pages、pages?revision_id、pages（可用环境变量关闭列表兜底）。
   */
  async listSlideIds(presentationId: string): Promise<string[]> {
    const ids = await this.resolvePresentationSlideIds(presentationId);
    this.logger.log(`📑 演示文稿 ${presentationId} 共 ${ids.length} 页`);
    return ids;
  }

  /**
   * 在演示文稿下新建一页。
   * 新建页须 `POST .../presentations/:id/pages`（或带 revision 的等价路径）；勿使用 `/slides` 后缀。
   * @returns 新页的 slide_id；失败或响应无法解析时返回 undefined。
   */
  private async createPage(
    presentationId: string,
    revisionId?: string,
  ): Promise<string | undefined> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化');
    }
    const base = this.presentationResourceUrl(presentationId);
    const rev = readIdLikeString(revisionId);
    const attempts: Array<{
      label: string;
      url: string;
      params?: Record<string, unknown>;
      data?: Record<string, unknown>;
    }> = [];
    if (rev) {
      attempts.push({
        label: 'revisions/.../pages',
        url: `${base}/revisions/${encodeURIComponent(rev)}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
        data: {},
      });
      attempts.push({
        label: 'pages?revision_id',
        url: `${base}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
        params: { revision_id: rev },
        data: {},
      });
      if (/^\d+$/.test(rev)) {
        attempts.push({
          label: 'pages JSON revision_id(number)',
          url: `${base}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
          data: { revision_id: Number(rev) },
        });
      } else {
        attempts.push({
          label: 'pages JSON revision_id(string)',
          url: `${base}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
          data: { revision_id: rev },
        });
      }
    }
    attempts.push({
      label: 'pages',
      url: `${base}/${LarkSlidesService.PRESENTATION_PAGES_RESOURCE}`,
      data: {},
    });

    const failures: string[] = [];
    const jsonHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
    };

    for (const a of attempts) {
      let raw: unknown;
      try {
        const useProbe = this.shouldUseHttpProbe();
        raw = useProbe
          ? await this.requestWithHttpProbe({
              method: 'POST',
              url: a.url,
              params: a.params,
              data: a.data ?? {},
            })
          : await this.client.request({
              method: 'POST',
              url: a.url,
              data: a.data ?? {},
              params: a.params,
              headers: jsonHeaders,
              validateStatus: () => true,
            });
        if (useProbe) {
          this.logger.warn(
            `[slides-http-probe] createPage attempt=${a.label} response=${summarizeCreatePageProbe(raw)}`,
          );
        }
      } catch (e) {
        this.logger.warn(
          `[createPage探针] attempt=${a.label} request=POST ${a.url} params=${JSON.stringify(a.params ?? {})} data=${JSON.stringify(a.data ?? {})} error=${(e as Error).message}`,
        );
        failures.push(`${a.label}: ${(e as Error).message}`);
        continue;
      }
      this.logger.warn(
        `[createPage探针] attempt=${a.label} request=POST ${a.url} params=${JSON.stringify(a.params ?? {})} data=${JSON.stringify(a.data ?? {})} response=${summarizeCreatePageProbe(raw)}`,
      );
      const transportBad = describeSlideCreateTransportFailure(raw);
      if (transportBad !== undefined) {
        failures.push(`${a.label}: ${transportBad}`);
        continue;
      }
      const envelope = unwrapLarkHttpResponse(raw);
      const code = envelope ? readFeishuEnvelopeCode(envelope) : undefined;
      if (code !== undefined && code !== 0) {
        const msg = envelope ? readOptionalString(envelope['msg']) : undefined;
        failures.push(`${a.label}: code=${code} msg=${msg ?? 'unknown'}`);
        continue;
      }
      const ids = parsePresentationCreateSlideIds(raw, presentationId);
      const id = ids[0];
      if (!id) {
        failures.push(`${a.label}: 成功响应但未解析到 slide_id`);
        continue;
      }
      if (a.label !== 'pages') {
        this.logger.log(
          `📄 已新建幻灯片页 [${a.label}]: ${presentationId} slide_id=${id}`,
        );
      } else {
        this.logger.log(`📄 已新建幻灯片页: ${presentationId} slide_id=${id}`);
      }
      return id;
    }

    if (failures.length > 0) {
      const joined = failures.join('; ');
      const allGateway404 =
        failures.length > 0 &&
        failures.every((f) => f.includes('404 page not found'));
      const hint = allGateway404
        ? ' （全部为网关 404 时：多在开放平台检查「幻灯片」读写权限；仅用 tenant_access_token 可能无法访问 .../pages 写接口，需 user_access_token 或文档标注的其它凭证。）'
        : '';
      this.logger.warn(
        `创建幻灯片页全部尝试失败: ${presentationId} — ${joined}${hint}`,
      );
    } else {
      this.logger.warn(`创建幻灯片页全部尝试失败: ${presentationId}`);
    }
    return undefined;
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
   * 将 Markdown 同步到演示文稿的第一页；若列表为空会先尝试新建一页再写入。
   * @returns 写入的块 ID 列表；若无法解析到页面则返回 null。
   */
  async appendMarkdownToFirstSlide(
    presentationId: string,
    markdown: string,
    preferredFirstSlideId?: string,
  ): Promise<string[] | null> {
    const hinted = readOptionalString(preferredFirstSlideId);
    let slideIds: string[] = [];
    if (!hinted) {
      try {
        slideIds = await this.listSlideIds(presentationId);
      } catch (e) {
        this.logger.warn(
          `列出幻灯片页失败，无法写入 Markdown: ${presentationId} — ${(e as Error).message}`,
        );
        return null;
      }
      if (slideIds.length === 0) {
        const revisionHint =
          await this.fetchPresentationRevisionHint(presentationId);
        const createdId = await this.createPage(presentationId, revisionHint);
        if (createdId) {
          slideIds = [createdId];
        }
      }
    }
    const firstSlideId = hinted ?? slideIds[0];
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
