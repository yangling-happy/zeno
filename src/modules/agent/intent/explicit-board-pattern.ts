/** 显式创建画板/画布/白板（良性协作），避免语义路由将「幻觉」等写作主题误判为 SAFE_REFUSAL。 */
export const EXPLICIT_BOARD_OR_CANVAS_CREATION_RE =
  /(?:创建|新建|生成|做|打开).{0,24}(?:画板|画布|白板)|(?:画板|画布|白板).{0,24}(?:创建|新建|生成)/;
