import { LarkSlidesService } from './lark-slides.service';
import { SLIDE_BLOCK_TYPE } from './lark-slides.types';

describe('LarkSlidesService', () => {
  let service: LarkSlidesService;

  beforeEach(() => {
    service = new LarkSlidesService(
      { get: jest.fn().mockReturnValue(undefined) } as any,
      {} as any,
    );
  });

  it('createPresentation skips list warmup when response embeds slide_id', async () => {
    const request = jest.fn().mockResolvedValueOnce({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_foldered',
          slides: [{ slide_id: 'sld_from_create' }],
        },
      },
    });

    const config = {
      get: jest.fn((key: string) =>
        key === 'LARK_CLOUD_FOLDER_TOKEN' ? 'fld_unit_test' : undefined,
      ),
    };

    const svc = new LarkSlidesService(config as any, {} as any);
    (svc as any).client = { request };

    await expect(svc.createPresentation('Deck')).resolves.toMatchObject({
      presentationId: 'pres_foldered',
      firstSlideId: 'sld_from_create',
      pages: [{ pageId: 'sld_from_create' }],
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations',
      data: { title: 'Deck', folder_token: 'fld_unit_test' },
    });
  });

  it('createPresentation pulls slide_id via GET metadata when create omits slides', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { presentation: { presentation_id: 'pres_foldered' } },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          presentation: {
            presentation_id: 'pres_foldered',
            slides: [{ slide_id: 'sld_meta' }],
          },
        },
      });

    const config = {
      get: jest.fn((key: string) =>
        key === 'LARK_CLOUD_FOLDER_TOKEN' ? 'fld_unit_test' : undefined,
      ),
    };

    const svc = new LarkSlidesService(config as any, {} as any);
    (svc as any).client = { request };

    await expect(svc.createPresentation('Deck')).resolves.toMatchObject({
      presentationId: 'pres_foldered',
      firstSlideId: 'sld_meta',
      pages: [{ pageId: 'sld_meta' }],
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations',
      data: { title: 'Deck', folder_token: 'fld_unit_test' },
    });
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_foldered',
      validateStatus: expect.any(Function),
    });
  });

  it('createPresentation yields empty pages when metadata never contains slides', async () => {
    const createBody = {
      code: 0,
      data: { presentation: { presentation_id: 'pres_foldered' } },
    };
    const emptyMeta = {
      code: 0,
      data: { presentation: { presentation_id: 'pres_foldered' } },
    };
    const emptySlideList = { code: 0, data: { slides: [] } };
    const createPageFail = { code: 3130001, msg: 'param is invalid' };
    const request = jest
      .fn()
      .mockResolvedValueOnce(createBody)
      .mockResolvedValueOnce(emptyMeta)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(emptySlideList);

    const config = {
      get: jest.fn((key: string) =>
        key === 'LARK_CLOUD_FOLDER_TOKEN' ? 'fld_unit_test' : undefined,
      ),
    };

    const svc = new LarkSlidesService(config as any, {} as any);
    (svc as any).client = { request };

    await expect(svc.createPresentation('Deck')).resolves.toMatchObject({
      presentationId: 'pres_foldered',
      pages: [],
    });

    expect(request).toHaveBeenCalledTimes(4);
  });

  it('listSlideIds extracts slide_page_id nested under presentation.revision', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          revision: {
            slides: [{ slide_page_id: 'sld_deep' }],
          },
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual(['sld_deep']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('listSlideIds parses slides shaped as token-keyed map', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          slides: {
            SldAa01bcdEFghijklmnop: { index: 0 },
            SldBb02bcdEFghijklmnop: { index: 1 },
          },
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'SldAa01bcdEFghijklmnop',
      'SldBb02bcdEFghijklmnop',
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('listSlideIds parses lowercase-only token-keyed slides map', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          slides: {
            abcdefghijklmnopqrstuvwx: { index: 0 },
            bcdefghijklmnopqrstuvwxy: { index: 1 },
          },
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'abcdefghijklmnopqrstuvwx',
      'bcdefghijklmnopqrstuvwxy',
    ]);
  });

  it('listSlideIds harvests slide-like token from layouts when slides omit ids', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          revision_id: 'Rev01abcDEFGHIJklmnop',
          slides: [],
          layouts: [{ slide_canvas_id: 'SldHarvest01abcDEFGHIJ' }],
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'SldHarvest01abcDEFGHIJ',
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('listSlideIds harvests token from layouts via generic *_token field name', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          slides: [],
          layouts: [{ canvas_token: 'CanvasTokabcdefghijklmn01' }],
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'CanvasTokabcdefghijklmn01',
    ]);
  });

  it('listSlideIds harvests all-lowercase opaque token from layouts', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          revision_id: 'revonlylowerabcdefghijklmn',
          slides: [],
          layouts: [{ slide_canvas_id: 'abcdefghijklmnopqrstuvwxyz12' }],
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'abcdefghijklmnopqrstuvwxyz12',
    ]);
  });

  it('listSlideIds tries revisions/.../pages before plain /pages when revision_id present', async () => {
    const emptyMeta = {
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          revision_id: 'Rev99abcDEFGHIJklmnop',
          slides: [],
        },
      },
    };
    const slideList = {
      code: 0,
      data: { slides: [{ slide_id: 'sld_via_rev' }] },
    };
    const createPageFail = { code: 3130001, msg: 'param is invalid' };
    const request = jest
      .fn()
      .mockResolvedValueOnce(emptyMeta)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(slideList);

    const svc = new LarkSlidesService(
      { get: jest.fn().mockReturnValue(undefined) } as any,
      {} as any,
    );
    (svc as any).client = { request };

    await expect(svc.listSlideIds('pres_1')).resolves.toEqual(['sld_via_rev']);

    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1/revisions/Rev99abcDEFGHIJklmnop/pages',
    });
    expect(request.mock.calls[5][0]).toMatchObject({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1/revisions/Rev99abcDEFGHIJklmnop/pages',
    });
  });

  it('listSlideIds treats numeric revision_id like string for revisions POST/GET', async () => {
    const emptyMeta = {
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          revision_id: 42,
          slides: [],
        },
      },
    };
    const slideList = {
      code: 0,
      data: { slides: [{ slide_id: 'sld_num_rev' }] },
    };
    const createPageFail = { code: 3130001, msg: 'param is invalid' };
    const request = jest
      .fn()
      .mockResolvedValueOnce(emptyMeta)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(slideList);

    const svc = new LarkSlidesService(
      { get: jest.fn().mockReturnValue(undefined) } as any,
      {} as any,
    );
    (svc as any).client = { request };

    await expect(svc.listSlideIds('pres_1')).resolves.toEqual(['sld_num_rev']);

    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1/revisions/42/pages',
    });
    expect(request.mock.calls[2][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1/pages',
      params: { revision_id: '42' },
    });
    expect(request.mock.calls[3][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1/pages',
      data: { revision_id: 42 },
    });
  });

  it('listSlideIds reads slide_token nested under slide', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        presentation: {
          presentation_id: 'pres_1',
          slides: {
            items: [{ slide: { slide_token: 'SldNested01tokABCDEF' } }],
          },
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'SldNested01tokABCDEF',
    ]);
  });

  it('listSlideIds parses slide_id from Feishu-style response', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: {
        slides: [{ slide_id: 'sld_a' }, { slide_id: 'sld_b' }],
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual([
      'sld_a',
      'sld_b',
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1',
    });
  });

  it('listSlideIds unwraps axios-shaped Client.request payload (data.data.presentation.slides)', async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      config: { transitional: {} },
      data: {
        code: 0,
        msg: 'success',
        data: {
          presentation: {
            presentation_id: 'pres_1',
            slides: [{ slide_id: 'sld_ax' }],
          },
        },
      },
    });
    (service as any).client = { request };

    await expect(service.listSlideIds('pres_1')).resolves.toEqual(['sld_ax']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('listSlideIds uses legacy .../pages after empty metadata (default fallback)', async () => {
    const emptyMeta = {
      code: 0,
      data: { presentation: { presentation_id: 'pres_1' } },
    };
    const createPageFail = { code: 3130001, msg: 'param is invalid' };
    const request = jest
      .fn()
      .mockResolvedValueOnce(emptyMeta)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce({
        code: 0,
        data: {
          slides: [{ slide_id: 'sld_a' }, { slide_id: 'sld_b' }],
        },
      });

    const svc = new LarkSlidesService(
      { get: jest.fn().mockReturnValue(undefined) } as any,
      {} as any,
    );
    (svc as any).client = { request };

    await expect(svc.listSlideIds('pres_1')).resolves.toEqual([
      'sld_a',
      'sld_b',
    ]);

    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1',
    });
    expect(request.mock.calls[2][0]).toMatchObject({
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_1/pages',
    });
  });

  it('listSlideIds skips legacy .../pages when LARK_SLIDES_DISABLE_LEGACY_LIST_FALLBACK=true', async () => {
    const emptyMeta = {
      code: 0,
      data: { presentation: { presentation_id: 'pres_1' } },
    };
    const createPageFail = { code: 3130001, msg: 'param is invalid' };
    const request = jest
      .fn()
      .mockResolvedValueOnce(emptyMeta)
      .mockResolvedValueOnce(createPageFail);

    const config = {
      get: jest.fn((key: string) =>
        key === 'LARK_SLIDES_DISABLE_LEGACY_LIST_FALLBACK' ? 'true' : undefined,
      ),
    };
    const svc = new LarkSlidesService(config as any, {} as any);
    (svc as any).client = { request };

    await expect(svc.listSlideIds('pres_1')).resolves.toEqual([]);

    expect(request).toHaveBeenCalledTimes(2);
    const legacyListSlideUrl = /\/presentations\/[^/]+\/pages(?:\?|$)/;
    expect(
      request.mock.calls.every((c) => {
        const req = c[0] as { method?: string; url?: string };
        if (
          req?.method === 'GET' &&
          legacyListSlideUrl.test(String(req.url ?? ''))
        ) {
          return false;
        }
        return true;
      }),
    ).toBe(true);
  });

  it('appendMarkdownToFirstSlide returns null when no pages', async () => {
    const empty = {
      code: 0,
      data: { presentation: { presentation_id: 'pres_x' } },
    };
    const emptySlideList = { code: 0, data: { slides: [] } };
    const createPageFail = { code: 3130001, msg: 'param is invalid' };
    const request = jest
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(createPageFail)
      .mockResolvedValueOnce(emptySlideList)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(createPageFail);
    (service as any).client = { request };

    await expect(
      service.appendMarkdownToFirstSlide('pres_x', '# Hi'),
    ).resolves.toBeNull();

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[4][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations/pres_x/pages',
      data: {},
    });
  });

  it('appendMarkdownToFirstSlide creates a page when listing returns empty', async () => {
    const empty = {
      code: 0,
      data: { presentation: { presentation_id: 'pres_x' } },
    };
    const createOk = {
      code: 0,
      data: { slides: [{ slide_id: 'sld_new' }] },
    };
    const request = jest
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(createOk);

    const batchCreate = jest
      .fn()
      .mockResolvedValue({ data: { blocks: [{ block_id: 'blk_1' }] } });

    (service as any).client = {
      request,
      slides: { v1: { slideBlock: { batch_create: batchCreate } } },
    };

    await expect(
      service.appendMarkdownToFirstSlide('pres_x', '# Hi'),
    ).resolves.toEqual(['blk_1']);

    expect(request).toHaveBeenCalledTimes(2);
    expect(batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { presentation_id: 'pres_x', slide_id: 'sld_new' },
      }),
    );
  });

  it('appendMarkdownToFirstSlide uses preferredFirstSlideId without listing', async () => {
    const batchCreate = jest.fn().mockResolvedValue({ data: { blocks: [] } });
    (service as any).client = {
      request: jest.fn(),
      slides: { v1: { slideBlock: { batch_create: batchCreate } } },
    };

    await service.appendMarkdownToFirstSlide('pres_x', '# Hi', 'sld_hint');

    expect((service as any).client.request).not.toHaveBeenCalled();
    expect(batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { presentation_id: 'pres_x', slide_id: 'sld_hint' },
      }),
    );
  });

  it('appendMarkdownToFirstSlide returns null when metadata GET keeps failing', async () => {
    (service as any).client = {
      request: jest.fn().mockRejectedValue(new Error('404 page not found')),
    };

    await expect(
      service.appendMarkdownToFirstSlide('pres_x', '# Hi'),
    ).resolves.toBeNull();

    expect((service as any).client.request).toHaveBeenCalledTimes(7);
  });

  it('maps markdown todo items before generic bullet items', () => {
    const blocks = service.parseMarkdownToSlideBlocks(
      ['- [ ] todo', '- [x] done', '- bullet'].join('\n'),
    );

    expect(
      blocks.map((block) => block.text?.elements?.[0].text_run?.content),
    ).toEqual(['☐ todo', '☑ done', '• bullet']);
  });

  it('splits long slide text blocks before writing', () => {
    const blocks = service.normalizeSlideBlocksForCreate([
      service.createTextSlideBlock('a'.repeat(40_001), { bold: true }),
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      block_type: SLIDE_BLOCK_TYPE.TEXT,
      text: {
        elements: [
          {
            text_run: {
              content: 'a'.repeat(20_000),
              style: { bold: true },
            },
          },
        ],
      },
    });
    expect(
      blocks.map((block) => block.text?.elements?.[0].text_run?.content.length),
    ).toEqual([20_000, 20_000, 1]);
  });
});
