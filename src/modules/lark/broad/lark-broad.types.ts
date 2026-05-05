/** 新版文档中「画板」Block 类型值，见飞书画板 OpenAPI 概述 */
export const LARK_BOARD_BLOCK_TYPE = 43;

export interface LarkBroadCreateBoardResult {
  documentId: string;
  whiteboardId: string;
  docUrl: string;
}

export interface LarkBroadAppendMarkdownResult {
  nodeIds: string[];
}
