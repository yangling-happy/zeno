import { Injectable, Logger } from '@nestjs/common';
import {
  BlockType,
  TextElement,
  BlockChildren,
  BatchCreateBlock,
  BLOCK_TYPE_MAP,
} from './lark-doc-block.types';

@Injectable()
export class LarkDocWriterService {
  private readonly logger = new Logger(LarkDocWriterService.name);
  private static readonly MAX_TEXT_BLOCK_CONTENT_LENGTH = 95_000;
  private static readonly TEXT_FIELD_BY_BLOCK_TYPE: Partial<
    Record<BlockType, keyof BlockChildren>
  > = {
    TEXT: 'text',
    HEADING1: 'heading1',
    HEADING2: 'heading2',
    HEADING3: 'heading3',
    HEADING4: 'heading4',
    HEADING5: 'heading5',
    HEADING6: 'heading6',
    BULLET: 'bullet',
    ORDERED: 'ordered',
    TODO: 'todo',
    CODE: 'code',
    QUOTE: 'quote',
  };

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
    void language;
    const element: TextElement = {
      text_run: {
        content,
        text_element_style: {
          ...style,
          inline_code: true,
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
        token: imageToken,
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
    if (options.code) textElementStyle.inline_code = true;
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

  normalizeBlocksForCreate(blocks: BlockChildren[]): BlockChildren[] {
    return blocks.flatMap((block) => this.splitBlockByTextLimit(block));
  }

  private splitBlockByTextLimit(block: BlockChildren): BlockChildren[] {
    const textField = this.getTextFieldForBlock(block);
    if (!textField) {
      return [block];
    }

    const textContent = block[textField] as
      | { elements: TextElement[]; style?: unknown }
      | undefined;
    if (!textContent?.elements?.length) {
      return [block];
    }

    const elementGroups = this.splitTextElements(textContent.elements);
    if (elementGroups.length <= 1) {
      return [block];
    }

    return elementGroups.map((elements) => ({
      ...block,
      [textField]: {
        ...textContent,
        elements,
      },
    }));
  }

  private getTextFieldForBlock(
    block: BlockChildren,
  ): keyof BlockChildren | null {
    for (const [type, field] of Object.entries(
      LarkDocWriterService.TEXT_FIELD_BY_BLOCK_TYPE,
    ) as Array<[BlockType, keyof BlockChildren]>) {
      if (BLOCK_TYPE_MAP[type] === block.block_type && block[field]) {
        return field;
      }
    }

    return null;
  }

  private splitTextElements(elements: TextElement[]): TextElement[][] {
    const groups: TextElement[][] = [];
    let currentGroup: TextElement[] = [];
    let currentLength = 0;

    const pushElement = (element: TextElement) => {
      const contentLength = element.text_run.content.length;
      if (
        currentGroup.length > 0 &&
        currentLength + contentLength >
          LarkDocWriterService.MAX_TEXT_BLOCK_CONTENT_LENGTH
      ) {
        groups.push(currentGroup);
        currentGroup = [];
        currentLength = 0;
      }

      currentGroup.push(element);
      currentLength += contentLength;
    };

    for (const element of elements) {
      for (const chunk of this.splitTextContent(element.text_run.content)) {
        pushElement(this.cloneTextElementWithContent(element, chunk));
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups.length > 0 ? groups : [[{ text_run: { content: '' } }]];
  }

  private splitTextContent(content: string): string[] {
    if (content.length === 0) {
      return [''];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
      let end = Math.min(
        start + LarkDocWriterService.MAX_TEXT_BLOCK_CONTENT_LENGTH,
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

  private cloneTextElementWithContent(
    element: TextElement,
    content: string,
  ): TextElement {
    const style = element.text_run.text_element_style;
    return {
      text_run: {
        content,
        text_element_style: style ? { ...style } : undefined,
      },
    };
  }

  buildNestedBlocks(structure: BatchCreateBlock): BatchCreateBlock {
    return structure;
  }

  parseMarkdownToBlocks(markdown: string): BlockChildren[] {
    const lines = markdown.split('\n');
    const blocks: BlockChildren[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let codeBlockLanguage = '';

    const processInlineStyles = (text: string): TextElement[] => {
      const elements: TextElement[] = [];
      const regex =
        /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\(([^)]+)\)/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          elements.push({
            text_run: {
              content: text.slice(lastIndex, match.index),
            },
          });
        }

        if (match[1] !== undefined) {
          elements.push({
            text_run: {
              content: match[1],
              text_element_style: { bold: true },
            },
          });
        } else if (match[2] !== undefined) {
          elements.push({
            text_run: {
              content: match[2],
              text_element_style: { italic: true },
            },
          });
        } else if (match[3] !== undefined) {
          elements.push({
            text_run: {
              content: match[3],
              text_element_style: { inline_code: true },
            },
          });
        } else if (match[4] !== undefined) {
          elements.push({
            text_run: {
              content: match[4],
              text_element_style: { strikethrough: true },
            },
          });
        } else if (match[5] !== undefined && match[6] !== undefined) {
          elements.push({
            text_run: {
              content: match[5],
              text_element_style: { link: { url: match[6] } },
            },
          });
        }

        lastIndex = regex.lastIndex;
      }

      if (lastIndex < text.length) {
        elements.push({
          text_run: {
            content: text.slice(lastIndex),
          },
        });
      }

      if (elements.length === 0) {
        elements.push({
          text_run: { content: text },
        });
      }

      return elements;
    };

    const createTextBlockFromInline = (content: string): BlockChildren => {
      return {
        block_type: BLOCK_TYPE_MAP.TEXT,
        text: {
          elements: processInlineStyles(content),
        },
      };
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLanguage = line.slice(3).trim() || 'plaintext';
          codeBlockContent = [];
        } else {
          inCodeBlock = false;
          blocks.push(
            this.createCodeBlock(
              codeBlockContent.join('\n'),
              codeBlockLanguage,
            ),
          );
          codeBlockContent = [];
          codeBlockLanguage = '';
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('### ')) {
        blocks.push(
          this.createHeadingBlock(3, trimmed.slice(4), { bold: true }),
        );
      } else if (trimmed.startsWith('## ')) {
        blocks.push(
          this.createHeadingBlock(2, trimmed.slice(3), { bold: true }),
        );
      } else if (trimmed.startsWith('# ')) {
        blocks.push(
          this.createHeadingBlock(1, trimmed.slice(2), { bold: true }),
        );
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
      } else {
        blocks.push(createTextBlockFromInline(trimmed));
      }
    }

    if (inCodeBlock && codeBlockContent.length > 0) {
      blocks.push(
        this.createCodeBlock(codeBlockContent.join('\n'), codeBlockLanguage),
      );
    }

    return this.normalizeBlocksForCreate(blocks);
  }
}
