import { LarkSlidesService } from './lark-slides.service';
import { SLIDE_BLOCK_TYPE } from './lark-slides.types';

describe('LarkSlidesService', () => {
  let service: LarkSlidesService;

  beforeEach(() => {
    service = new LarkSlidesService({} as any, {} as any);
  });

  it('createPresentation attaches folder_token from config and runs list warmup', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { presentation: { presentation_id: 'pres_foldered' } },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { slides: [{ slide_id: 'sld_1' }] },
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
    });

    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/slides/v1/presentations',
      data: { title: 'Deck', folder_token: 'fld_unit_test' },
    });
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      url: expect.stringContaining('/presentations/pres_foldered/slides'),
    });
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
  });

  it('appendMarkdownToFirstSlide returns null when no pages', async () => {
    const request = jest.fn().mockResolvedValue({
      code: 0,
      data: { slides: [] },
    });
    (service as any).client = { request };

    await expect(
      service.appendMarkdownToFirstSlide('pres_x', '# Hi'),
    ).resolves.toBeNull();
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
