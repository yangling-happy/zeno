/** 用户明显要新建另一篇云文档，应忽略 lastDocId 延续 */
const EXPLICIT_NEW_LARK_DOC_RE =
  /新建|另起|重新(?:写|创建|生成)|再写(?:一)?篇|写一篇新|新开(?:一)?篇|创建(?:一)?个(?:新)?文档|单独(?:再)?要(?:一)?(?:篇|份)|从零(?:开始)?写/i;

/**
 * 相对上一轮云文档做追加、补充、续写（与 Agent 文档动作共用）
 */
const LARK_DOC_APPEND_HINT_RE =
  /(?:文末|末尾|结尾|最后|后面|接着|续写|续上|追加|补充|加入|添加|加上|写入|粘贴|填到|粘到|完善|润色|更新|标注|备注|在(?:那)?篇|在文章|在文档|在正文|在(?:上面|刚才|这篇|这份)|这篇|这份|这个文档|刚才|之前|刚生成|刚创建|上面(?:那)?个文档)/i;

/**
 * 是否应在已有云文档上追加，而非新建（需配合会话中的 lastDocId）
 */
export function shouldAppendToLastLarkDoc(
  normalizedText: string,
  lastDocId: string | undefined,
): boolean {
  const t = normalizedText.trim();
  if (!lastDocId || !t) {
    return false;
  }
  if (EXPLICIT_NEW_LARK_DOC_RE.test(t)) {
    return false;
  }
  return LARK_DOC_APPEND_HINT_RE.test(t);
}
