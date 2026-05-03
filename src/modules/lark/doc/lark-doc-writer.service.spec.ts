import { LarkDocWriterService } from './lark-doc-writer.service';
import { BLOCK_TYPE_MAP } from './lark-doc-block.types';

describe('LarkDocWriterService', () => {
  let service: LarkDocWriterService;

  beforeEach(() => {
    service = new LarkDocWriterService();
  });

  it('maps markdown blocks to current Feishu docx block schema', () => {
    const blocks = service.parseMarkdownToBlocks(
      ['- [x] done', '```ts', 'const value = 1;', '```', '> quote'].join('\n'),
    );

    expect(blocks[0]).toMatchObject({
      block_type: BLOCK_TYPE_MAP.TODO,
      todo: {
        elements: [{ text_run: { content: 'done' } }],
        style: { done: true },
      },
    });
    expect(blocks[1]).toMatchObject({
      block_type: BLOCK_TYPE_MAP.CODE,
      code: {
        elements: [
          {
            text_run: {
              content: 'const value = 1;',
              text_element_style: { inline_code: true },
            },
          },
        ],
      },
    });
    expect(blocks[2]).toMatchObject({
      block_type: BLOCK_TYPE_MAP.QUOTE,
      quote: {
        elements: [{ text_run: { content: 'quote' } }],
      },
    });
  });

  it('uses Feishu docx table and image create schemas', () => {
    expect(service.createTableBlock([['a', 'b']])).toEqual({
      block_type: BLOCK_TYPE_MAP.TABLE,
      table: {
        property: {
          row_size: 1,
          column_size: 2,
        },
      },
    });

    expect(service.createImageBlock('img_token')).toEqual({
      block_type: BLOCK_TYPE_MAP.IMAGE,
      image: {
        token: 'img_token',
      },
    });
  });

  it('splits long text blocks below Feishu docx text content limits', () => {
    const blocks = service.normalizeBlocksForCreate([
      service.createTextBlock('a'.repeat(190_001)),
    ]);

    expect(blocks).toHaveLength(3);
    expect(
      blocks.map((block) => block.text?.elements[0].text_run.content.length),
    ).toEqual([95_000, 95_000, 1]);
  });
});
