export interface SlidePage {
  pageId: string;
  title?: string;
}

export interface SlideBlock {
  blockId?: string;
  blockType: number;
  text?: {
    elements: Array<{
      text_run?: {
        content?: string;
        text_element_style?: {
          bold?: boolean;
          italic?: boolean;
          underline?: boolean;
          strikethrough?: boolean;
          code?: boolean;
          text_color?: number;
          background_color?: number;
        };
      };
      mention_user?: {
        user_id?: string;
      };
    }>;
  };
}

export interface SlidesCreationResult {
  presentationId: string;
  url: string;
  pages: SlidePage[];
  /**
   * 若「创建演示文稿」响应中带出首页 slide_id，可直接写入块而无需调用
   * 「列出演示文稿页面」（部分环境下该列表路由会对网关返回 404）。
   */
  firstSlideId?: string;
}

export interface SlideTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  text_color?: number;
  background_color?: number;
}

export interface TextRun {
  content: string;
  style?: SlideTextStyle;
  link?: {
    url: string;
  };
}

export interface SlideBlockElement {
  text_run?: TextRun;
  mention_user?: {
    user_id: string;
  };
}

export interface SlideBlockContent {
  elements?: SlideBlockElement[];
  text_elements?: SlideBlockElement[];
}

export interface CreateSlideBlock {
  block_type: number;
  block_id?: string;
  text?: SlideBlockContent;
  image?: {
    width?: number;
    height?: number;
  };
  shape?: {
    shape_type?: number;
  };
}

export const SLIDE_BLOCK_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  SHAPE: 3,
  TABLE: 4,
  CHART: 5,
  VIDEO: 6,
  AUDIO: 7,
  DOC: 8,
  LINK: 9,
  CALLOUT: 10,
  QUOTE: 11,
  CODE: 12,
  AI_ASSISTANT: 13,
  FORM: 14,
  MINDMAP: 15,
  SEPARATOR: 16,
  TABLE_OF_CONTENTS: 17,
  DATE: 18,
  PERSON: 19,
  DURATION: 20,
  WIDGET: 21,
};

export const SLIDE_SHAPE_TYPE = {
  RECTANGLE: 1,
  ROUNDED_RECTANGLE: 2,
  ELLIPSE: 3,
  DIAMOND: 4,
  TRIANGLE: 5,
  RIGHT_TRIANGLE: 6,
  PARALLELOGRAM: 7,
  TRAPEZOID: 8,
  HEXAGON: 9,
  PENTAGON: 10,
  CROSS: 11,
  CLOUD: 12,
  LINE: 13,
  ARROW: 14,
  CALLOUT: 15,
  ACTION_BUTTON: 16,
};
