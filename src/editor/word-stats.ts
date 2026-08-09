/**
 * `word-stats` — R3 状态栏的 CJK 感知字数/字符统计（纯函数）。
 *
 * 口径（界面文案「字数 N · 字符 M」与此一致，可理解）：
 *   - 字数 = CJK 表意字符数 + 拉丁词数（连续字母/数字串算一词，词内
 *     撇号/连字符不拆分，如 don't、well-known 各算一词）；
 *   - 字符数 = 非空白字符数（含标点与 Markdown 标记，不含空格/换行）。
 *
 * 注意：与 `parser.ts` 的 `countWords`（空白启发式、性能测试 size proxy）
 * 口径不同且互不替代；此处为面向用户的中文写作惯例口径，不改旧实现。
 */

export interface WordStats {
  /** 字数：CJK 表意字符数 + 拉丁词数。 */
  words: number;
  /** 字符数：非空白字符数。 */
  characters: number;
}

/** CJK 表意字符：基本区 + 扩展 A/B + 兼容表意（u 标志处理代理对）。 */
const CJK_IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}]/gu;

/** 拉丁词：字母/数字串，词内撇号/连字符不拆分。 */
const LATIN_WORD = /[A-Za-z0-9]+(?:['’\-–][A-Za-z0-9]+)*/g;

/** 非空白字符（u 标志：代理对算一个字符）。 */
const NON_WHITESPACE = /\S/gu;

/** 统计给定文本（通常取 `editor.getMarkdown()`）的字数与字符数。 */
export function computeWordStats(text: string): WordStats {
  if (text === '') {
    return { words: 0, characters: 0 };
  }
  const cjkCount = text.match(CJK_IDEOGRAPH)?.length ?? 0;
  // 表意字符替换为空白后再数拉丁词，避免中日混排时粘连成假词。
  const latinCount = text.replace(CJK_IDEOGRAPH, ' ').match(LATIN_WORD)?.length ?? 0;
  const characters = text.match(NON_WHITESPACE)?.length ?? 0;
  return { words: cjkCount + latinCount, characters };
}
