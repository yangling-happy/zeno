import { LarkSlidesService } from './lark-slides.service';
import { SLIDE_BLOCK_TYPE } from './lark-slides.types';

describe('LarkSlidesService', () => {
  let service: LarkSlidesService;

  beforeEach(() => {
    service = new LarkSlidesService({} as any, {} as any);
  });

  it('maps markdown todo items before generic bullet items', () => {
    const blocks = service.parseMarkdownToSlideBlocks(
      ['- [ ] todo', '- [x] done', '- bullet'].join('\n'),
    );

    expect(blocks.map((block) => block.text?.elements?.[0].text_run?.content)).toEqual([
      '☐ todo',
      '☑ done',
      '• bullet',
    ]);
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
