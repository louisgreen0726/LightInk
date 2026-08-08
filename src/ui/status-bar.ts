/**
 * `status-bar` — 底部状态栏（R6）：实时显示当前文档字数/字符数。
 *
 * 计数口径（与常见编辑器/WPS 统计一致）：
 *   - 字数 = CJK 字符逐个计数 + 非空白分隔的拉丁/其他词元数；
 *   - 字符数 = 可见正文字符（不含空白）。
 * 正文文本取自 Markdown 解析后的 MDAST 叶子节点（text/inlineCode/code），
 * 天然剥离 `#`、`**`、`[]()` 等 Markdown 语法符号，避免符号污染计数。
 * 计数为纯逻辑（`countDocumentStats`），可在 node 环境直接单测。
 *
 * 视图 `StatusBarView` 是轻量 DOM，由 main.ts 经既有内容变更回调
 * （`onActiveContentChanged`，切换/新建/活动标签内容变化时触发）刷新，
 * 不抢占编辑区高度（布局见 `src/ui/theme.css`：状态栏固定高度，编辑区 flex:1）。
 */

import type { Root as MdastRoot } from 'mdast';

import { parseMarkdownToMdast } from '../editor/parser.js';

export interface DocumentStats {
  /** 字数：CJK 字符逐个 + 拉丁/其他词元。 */
  words: number;
  /** 字符数：可见正文（不含空白）。 */
  characters: number;
}

/**
 * CJK 与日韩文：每个字符计为一个词（Han/平假名/片假名/谚文）。
 * `u` 标志 + Unicode 属性转义，目标 ES2020/现代 WebView 原生支持。
 */
const WORD_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu;

/** 从 Markdown 源码提取可见正文（叶子文本/行内代码/代码块文本），剥离 Markdown 语法。 */
export function extractProseText(source: string): string {
  let root: MdastRoot;
  try {
    root = parseMarkdownToMdast(source);
  } catch {
    // 解析失败（畸形输入）时退回原始源码计数。
    return source;
  }
  let out = '';
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { type?: string; value?: unknown; children?: unknown };
    if (
      (n.type === 'text' ||
        n.type === 'inlineCode' ||
        n.type === 'code' ||
        n.type === 'math' ||
        n.type === 'inlineMath') &&
      typeof n.value === 'string'
    ) {
      out += `${n.value} `;
    }
    const children = n.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * 统计文档字数/字符数。空文档返回 0/0（满足 R6「空文档显示为 0」）。
 * 字数 = CJK 字符数 + 非空白分隔的拉丁/其他词元数；字符数 = 去空白后的可见字符数。
 */
export function countDocumentStats(source: string): DocumentStats {
  if (typeof source !== 'string' || source.length === 0) {
    return { words: 0, characters: 0 };
  }
  const text = extractProseText(source);
  const cjkMatches = text.match(WORD_SCRIPT);
  const cjkCount = cjkMatches === null ? 0 : cjkMatches.length;
  const withoutCjk = text.replace(WORD_SCRIPT, ' ');
  const otherTokens = withoutCjk.split(/\s+/).filter((t) => t.length > 0);
  const characters = text.replace(/\s+/g, '').length;
  return { words: cjkCount + otherTokens.length, characters };
}

export interface StatusBarView {
  readonly root: HTMLElement;
  /** 设置字数/字符数；传 null 清空（无活动标签）。 */
  setStats(stats: DocumentStats | null): void;
  destroy(): void;
}

/** 创建底部状态栏视图（两个字段：字数 / 字符数）。 */
export function createStatusBarView(doc: Document): StatusBarView {
  const root = doc.createElement('div');
  root.className = 'lightink-statusbar';
  const words = doc.createElement('span');
  words.className = 'lightink-statusbar-words';
  const chars = doc.createElement('span');
  chars.className = 'lightink-statusbar-chars';
  root.append(words, chars);
  const render = (stats: DocumentStats | null): void => {
    if (stats === null) {
      words.textContent = '';
      chars.textContent = '';
      return;
    }
    words.textContent = `字数 ${stats.words}`;
    chars.textContent = `字符 ${stats.characters}`;
  };
  render(null);
  return { root, setStats: render, destroy: () => root.remove() };
}
