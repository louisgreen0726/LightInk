/**
 * 大纲模型（T7, R7）：从 markdown 文本派生标题大纲。
 *
 * 实现策略：复用 `src/editor/parser.ts` 的 `parseMarkdownToMdast`
 * （unified + remark-parse + remark-gfm，与 Milkdown 的 commonmark+gfm
 * 预设同源）解析出 MDAST，按文档顺序收集 heading 节点。代码块/行内代码
 * 中的 `#` 行由解析器天然排除，无需特判。
 *
 * 锚点（anchor）策略：标题在文档中的序号（第 n 个 heading，从 0 起）。
 *   - 选择理由：渲染侧 Milkdown 把每个 ProseMirror heading 节点渲染为
 *     宿主 DOM 中按文档顺序排列的 h1-h6 元素，`querySelectorAll` 的结果
 *     顺序与 MDAST 文档顺序一致，序号可在两侧无歧义对应；
 *     对重复标题文本天然免疫（不依赖文本匹配）。
 *   - 已知限制：若两次重算之间文档结构被编辑，旧序号可能指向别的标题；
 *     大纲在内容变化后防抖重算，下一次变更即自愈（见 outline-view）。
 */

import type { Heading, PhrasingContent, Root, RootContent } from 'mdast';

import { parseMarkdownToMdast } from '../editor/parser.js';

/** 大纲条目：标题层级（1-6）、纯文本标题、序号锚点。 */
export interface OutlineItem {
  /** 标题层级（h1-h6 → 1-6）。 */
  readonly level: number;
  /** 标题纯文本（行内格式已剥离：粗体/斜体取文字，行内代码取代码文本）。 */
  readonly text: string;
  /** 序号锚点：该标题是文档中第 n 个 heading（从 0 起，含各层级）。 */
  readonly anchor: number;
  /** 阅读器定位：PDF 页码（1-based）或流式章节序号（0-based）。 */
  readonly page?: number;
  readonly chapter?: number;
}

/** 递归提取行内节点的纯文本（text/inlineCode 取 value，image 取 alt）。 */
function phrasingText(nodes: readonly PhrasingContent[]): string {
  let out = '';
  for (const node of nodes) {
    const withValue = node as { value?: unknown; alt?: unknown };
    if (typeof withValue.value === 'string') {
      out += withValue.value;
    } else if (typeof withValue.alt === 'string') {
      out += withValue.alt;
    }
    const children = (node as { children?: PhrasingContent[] }).children;
    if (Array.isArray(children)) {
      out += phrasingText(children);
    }
  }
  return out;
}

/** 按文档顺序收集块级子树中的全部 heading（含 blockquote 内嵌套标题）。 */
function collectHeadings(children: readonly RootContent[], out: Heading[]): void {
  for (const child of children) {
    if (child.type === 'heading') {
      out.push(child);
      continue;
    }
    const nested = (child as { children?: RootContent[] }).children;
    if (Array.isArray(nested)) {
      collectHeadings(nested, out);
    }
  }
}

/**
 * 从 markdown 文本构建大纲。无标题时返回空数组。
 * 纯函数，不依赖 DOM/编辑器实例，node 环境可直接测试。
 */
export function buildOutline(markdown: string): OutlineItem[] {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return [];
  }
  const root: Root = parseMarkdownToMdast(markdown);
  const headings: Heading[] = [];
  collectHeadings(root.children, headings);
  return headings.map((heading, index) => ({
    level: heading.depth,
    text: phrasingText(heading.children),
    anchor: index,
  }));
}

/**
 * 计算大纲中的「叶子标题」序号锚点集合：某标题之后到下一个同级或更高级标题
 * 之前没有任何更深子标题（level 更大），即该标题无子标题。无子标题的标题
 * 在大纲中不渲染展开/折叠三角（outline-view 据此跳过折叠标记）。
 */
export function leafHeadingAnchors(items: readonly OutlineItem[]): Set<number> {
  const leaves = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const next = items[i + 1];
    // 下一个标题更深 → 有子标题；否则（同级 / 更高级 / 已是末尾）→ 叶子。
    if (next === undefined || next.level <= items[i].level) {
      leaves.add(items[i].anchor);
    }
  }
  return leaves;
}
