import { Injectable, Logger } from '@nestjs/common';
import {
  BlockType,
  TextElement,
  BlockChildren,
  BatchCreateBlock,
  BLOCK_TYPE_MAP,
  BlockCreationResult,
  BatchBlockCreationResult,
  ImageUploadResult,
} from './lark-doc-block.types';

@Injectable()
export class LarkDocWriterService {
  private readonly logger = new Logger(LarkDocWriterService.name);

  createTextBlock(
    content: string,
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const element: TextElement = {
      text_run: {
        content,
      },
    };

    if (style) {
      element.text_run.text_element_style = style;
    }

    return {
      block_type: BLOCK_TYPE_MAP.TEXT,
      text: {
        elements: [element],
      },
    };
  }

  createHeadingBlock(
    level: 1 | 2 | 3 | 4 | 5 | 6,
    content: string,
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const typeMap: Record<1 | 2 | 3 | 4 | 5 | 6, BlockType> = {
      1: 'HEADING1',
      2: 'HEADING2',
      3: 'HEADING3',
      4: 'HEADING4',
      5: 'HEADING5',
      6: 'HEADING6',
    };

    const fieldMap: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
      1: 'heading1',
      2: 'heading2',
      3: 'heading3',
      4: 'heading4',
      5: 'heading5',
      6: 'heading6',
    };

    const element: TextElement = {
      text_run: {
        content,
      },
    };

    if (style) {
      element.text_run.text_element_style = style;
    }

    const blockType = BLOCK_TYPE_MAP[typeMap[level]];
    const fieldName = fieldMap[level];

    return {
      block_type: blockType,
      [fieldName]: {
        elements: [element],
      },
    };
  }

  createBulletBlock(
    content: string,
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const element: TextElement = {
      text_run: {
        content,
      },
    };

    if (style) {
      element.text_run.text_element_style = style;
    }

    return {
      block_type: BLOCK_TYPE_MAP.BULLET,
      bullet: {
        elements: [element],
      },
    };
  }

  createOrderedBlock(
    content: string,
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const element: TextElement = {
      text_run: {
        content,
      },
    };

    if (style) {
      element.text_run.text_element_style = style;
    }

    return {
      block_type: BLOCK_TYPE_MAP.ORDERED,
      ordered: {
        elements: [element],
      },
    };
  }

  createTodoBlock(
    content: string,
    checked: boolean = false,
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const element: TextElement = {
      text_run: {
        content,
      },
    };

    if (style) {
      element.text_run.text_element_style = style;
    }

    return {
      block_type: BLOCK_TYPE_MAP.TODO,
      todo: {
        elements: [element],
        style: {
          done: checked,
        },
      },
    };
  }

  createCodeBlock(
    content: string,
    language: string = 'plaintext',
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const element: TextElement = {
      text_run: {
        content,
        text_element_style: {
          ...style,
          code: true,
        },
      },
    };

    return {
      block_type: BLOCK_TYPE_MAP.CODE,
      code: {
        elements: [element],
      },
    };
  }

  createQuoteBlock(
    content: string,
    style?: TextElement['text_run']['text_element_style'],
  ): BlockChildren {
    const element: TextElement = {
      text_run: {
        content,
      },
    };

    if (style) {
      element.text_run.text_element_style = style;
    }

    return {
      block_type: BLOCK_TYPE_MAP.QUOTE,
      quote: {
        elements: [element],
      },
    };
  }

  createDividerBlock(): BlockChildren {
    return {
      block_type: BLOCK_TYPE_MAP.DIVIDER,
      divider: {},
    };
  }

  createImageBlock(imageToken: string): BlockChildren {
    return {
      block_type: BLOCK_TYPE_MAP.IMAGE,
      image: {
        tokens: [imageToken],
      },
    };
  }

  createTableBlock(
    rows: string[][],
    rowSize?: number,
    columnSize?: number,
  ): BlockChildren {
    return {
      block_type: BLOCK_TYPE_MAP.TABLE,
      table: {
        cells: rows,
        property: {
          row_size: rowSize || rows.length,
          column_size: columnSize || rows[0]?.length || 0,
        },
      },
    };
  }

  buildTextWithStyle(
    content: string,
    options: {
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
      underline?: boolean;
      code?: boolean;
      link?: string;
    } = {},
  ): TextElement {
    const textElementStyle: TextElement['text_run']['text_element_style'] = {};

    if (options.bold) textElementStyle.bold = true;
    if (options.italic) textElementStyle.italic = true;
    if (options.strikethrough) textElementStyle.strikethrough = true;
    if (options.underline) textElementStyle.underline = true;
    if (options.code) textElementStyle.code = true;
    if (options.link) textElementStyle.link = { url: options.link };

    return {
      text_run: {
        content,
        text_element_style:
          Object.keys(textElementStyle).length > 0
            ? textElementStyle
            : undefined,
      },
    };
  }

  createRichTextBlock(elements: TextElement[]): BlockChildren {
    return {
      block_type: BLOCK_TYPE_MAP.TEXT,
      text: {
        elements,
      },
    };
  }

  buildNestedBlocks(structure: BatchCreateBlock): BatchCreateBlock {
    return structure;
  }

  parseMarkdownToBlocks(markdown: string): BlockChildren[] {
    const lines = markdown.split('\n');
    const blocks: BlockChildren[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('### ')) {
        blocks.push(this.createHeadingBlock(3, trimmed.slice(4)));
      } else if (trimmed.startsWith('## ')) {
        blocks.push(this.createHeadingBlock(2, trimmed.slice(3)));
      } else if (trimmed.startsWith('# ')) {
        blocks.push(this.createHeadingBlock(1, trimmed.slice(2)));
      } else if (trimmed.startsWith('- [ ] ')) {
        blocks.push(this.createTodoBlock(trimmed.slice(6), false));
      } else if (trimmed.startsWith('- [x] ')) {
        blocks.push(this.createTodoBlock(trimmed.slice(6), true));
      } else if (trimmed.startsWith('- ')) {
        blocks.push(this.createBulletBlock(trimmed.slice(2)));
      } else if (/^\d+\.\s/.test(trimmed)) {
        blocks.push(this.createOrderedBlock(trimmed.replace(/^\d+\.\s/, '')));
      } else if (trimmed === '---') {
        blocks.push(this.createDividerBlock());
      } else if (trimmed.startsWith('> ')) {
        blocks.push(this.createQuoteBlock(trimmed.slice(2)));
      } else if (trimmed.startsWith('```')) {
        continue;
      } else {
        blocks.push(this.createTextBlock(trimmed));
      }
    }

    return blocks;
  }
}
