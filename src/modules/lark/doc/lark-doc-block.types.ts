export type BlockType =
  | 'TEXT'
  | 'HEADING1'
  | 'HEADING2'
  | 'HEADING3'
  | 'HEADING4'
  | 'HEADING5'
  | 'HEADING6'
  | 'BULLET'
  | 'ORDERED'
  | 'TODO'
  | 'CODE'
  | 'QUOTE'
  | 'DIVIDER'
  | 'IMAGE'
  | 'TABLE';

export interface TextElement {
  text_run: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
      underline?: boolean;
      code?: boolean;
      link?: {
        url: string;
      };
      text_color?: number;
      background_color?: number;
    };
  };
}

export interface BlockChildren {
  block_type: number;
  text?: {
    elements: TextElement[];
    style?: {
      align?: 'LEFT' | 'CENTER' | 'RIGHT';
      folded?: boolean;
    };
  };
  table?: {
    cells: string[][];
    property?: {
      row_size?: number;
      column_size?: number;
      merge_info?: Array<{
        row: number;
        column: number;
        row_span?: number;
        column_span?: number;
      }>;
    };
  };
  image?: {
    tokens?: string[];
  };
}

export interface DocumentBlock {
  block_id?: string;
  block_type: number;
  text?: {
    elements: TextElement[];
    style?: {
      align?: 'LEFT' | 'CENTER' | 'RIGHT';
      folded?: boolean;
    };
  };
  table?: {
    cells: string[][];
    property?: {
      row_size?: number;
      column_size?: number;
    };
  };
  image?: {
    token?: string;
  };
}

export interface BatchCreateBlock {
  block_type: number;
  text?: {
    elements: TextElement[];
    style?: {
      align?: 'LEFT' | 'CENTER' | 'RIGHT';
      folded?: boolean;
    };
  };
  table?: {
    cells: string[][];
    property?: {
      row_size?: number;
      column_size?: number;
    };
  };
  children?: BatchCreateBlock[];
}

export const BLOCK_TYPE_MAP: Record<BlockType, number> = {
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  HEADING4: 6,
  HEADING5: 7,
  HEADING6: 8,
  BULLET: 12,
  ORDERED: 13,
  TODO: 14,
  CODE: 17,
  QUOTE: 18,
  DIVIDER: 22,
  IMAGE: 27,
  TABLE: 30,
};

export interface BlockCreationResult {
  blockId: string;
  parentBlockId: string;
  index: number;
}

export interface BatchBlockCreationResult {
  blockIds: string[];
  parentBlockId: string;
}

export interface ImageUploadResult {
  imageToken: string;
  imageUrl: string;
}

export interface FileUploadResult {
  fileToken: string;
  fileUrl: string;
}
