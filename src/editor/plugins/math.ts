/**
 * LaTeX math rendering plugin (T8 / R8).
 *
 * Design (per docs/sakullla-workflow/.../02-technical-solution.md「公式：
 * KaTeX，按需加载」):
 *
 *   - Rendering engine is KaTeX (faster and smaller than MathJax). It is
 *     loaded **lazily**: `createKatexLoader` wraps a dynamic `import('katex')`
 *     in a memoized promise, and the ProseMirror plugin only invokes it when
 *     the document actually contains math — documents without `$` never pay
 *     the KaTeX cost. The KaTeX stylesheet (`katex/dist/katex.min.css`,
 *     ~23KB) is imported statically: it is CSS-only, needed by every render,
 *     and Vite bundles it (including fonts) into the app so the Tauri WebView
 *     never hits the network.
 *
 *   - The pure logic layer is headless-testable:
 *       scanTextMath(text, baseOffset)   — `$…$` / `$$…$$` → segments
 *       extractMathSegments(markdown)    — same, but walks the MDAST from
 *                                          parser.ts so code blocks / inline
 *                                          code / raw HTML are excluded
 *       renderMathHtml(latex, mode, kx)  — KaTeX HTML, or the raw source in
 *                                          a `<code class="lightink-math-error">`
 *                                          wrapper on syntax error (R8: 语法
 *                                          错误时原样显示源码)
 *       hasMath(markdown)                — cheap gate for the lazy loader
 *
 *   - Delimiter rules are conservative (pandoc-ish) so currency text like
 *     "价格是 $5 和 $10" is NOT math: an inline `$` opener must be followed
 *     immediately by a non-space character, the closer must be preceded by a
 *     non-space character and must not be followed immediately by a digit,
 *     and the content must be non-empty. `$$…$$` requires non-blank content.
 *     `\$` escapes are honored. Trade-off: `$5$` (digit content) still parses
 *     as math — see test notes.
 *
 *   - The ProseMirror wiring follows the same `$prose` decoration pattern as
 *     code-highlight.ts: decorations never mutate the document, so the raw
 *     markdown source stays intact and editable. For each segment we add an
 *     inline decoration over the source range (`lightink-math-inline-source`
 *     / `lightink-math-block-source`, or `lightink-math-error` on failure —
 *     the error case gets NO rendered widget, so the source displays as-is,
 *     isolated to that node) plus, on success, a widget decoration right
 *     after the source carrying the rendered KaTeX HTML. Error isolation is
 *     per-segment: a bad formula never affects siblings or surrounding text.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

import { parseMarkdownToMdast } from '../parser.js';

// KaTeX 样式（含字体）由 Vite 打包进应用，Tauri WebView 离线可用。
// CSS 与 JS 不同无法按需动态生效（渲染前必须就位），故静态引入。
import 'katex/dist/katex.min.css';

// ---------------------------------------------------------------------------
// 纯逻辑层：分段扫描（headless 可测）
// ---------------------------------------------------------------------------

/** 一段公式：`inline`（$…$）或 `block`（$$…$$），from/to 为源码偏移（含定界符）。 */
export interface MathSegment {
  readonly type: 'inline' | 'block';
  /** 定界符之间的 LaTeX 源码（已 trim 首尾空白）。 */
  readonly latex: string;
  /** 起始定界符 `$` 的偏移。 */
  readonly from: number;
  /** 结束定界符之后的偏移（半开区间）。 */
  readonly to: number;
}

/** HTML 转义（错误分支显示源码用，保证 `<script>` 不被注入）。 */
export function escapeMathHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9]/.test(ch);
}

/** `text[i]` 是否为未被 `\` 转义的 `$`。 */
function isDollar(text: string, i: number): boolean {
  return text[i] === '$' && text[i - 1] !== '\\';
}

/**
 * 扫描一段纯文本中的公式（不感知 markdown 结构；code 排除由
 * `extractMathSegments` 的 MDAST 层负责）。`baseOffset` 会加到所有偏移上，
 * PM 层用它把 textblock 内偏移映射到文档位置。
 */
export function scanTextMath(text: string, baseOffset = 0): MathSegment[] {
  const out: MathSegment[] = [];
  scanTextMathInto(text, (i) => baseOffset + i, out);
  return out;
}

/**
 * 扫描内核。`locate` 把 text 内下标映射到输出偏移（MDAST 重建文本时
 * 下标 ≠ 源码偏移，靠 map 表还原；纯文本时是 baseOffset + i）。
 */
function scanTextMathInto(
  text: string,
  locate: (index: number) => number,
  out: MathSegment[],
): void {
  const n = text.length;
  const consumed = new Array<boolean>(n).fill(false);

  // 第一遍：$$…$$ 块级（优先于行内，避免 `$$` 被拆成两个空行内）。
  let i = 0;
  while (i + 1 < n) {
    if (isDollar(text, i) && text[i + 1] === '$') {
      let j = i + 2;
      while (j + 1 < n && !(isDollar(text, j) && text[j + 1] === '$')) {
        j++;
      }
      if (j + 1 < n) {
        const latex = text.slice(i + 2, j).trim();
        if (latex.length > 0) {
          out.push({ type: 'block', latex, from: locate(i), to: locate(j + 1) + 1 });
          for (let k = i; k <= j + 1; k++) consumed[k] = true;
          i = j + 2;
          continue;
        }
      }
      // 未闭合或内容空白：不是块公式，前进一位让行内遍/后续再判断。
      i++;
      continue;
    }
    i++;
  }

  // 第二遍：$…$ 行内（保守规则，见文件头注释）。
  i = 0;
  while (i < n) {
    if (consumed[i] || !isDollar(text, i)) {
      i++;
      continue;
    }
    const open = i;
    // 起始 `$` 之后必须紧跟非空白、非 `$` 且未被块级消费。
    if (open + 1 >= n || consumed[open + 1] || isSpace(text[open + 1]) || text[open + 1] === '$') {
      i++;
      continue;
    }
    let close = -1;
    for (let j = open + 1; j < n; j++) {
      if (consumed[j] || !isDollar(text, j)) continue;
      // 结束 `$` 前必须是非空白，且其后不能紧跟数字（货币保护）。
      if (isSpace(text[j - 1]) || isDigit(text[j + 1])) continue;
      close = j;
      break;
    }
    if (close === -1 || close === open + 1) {
      i++;
      continue;
    }
    const latex = text.slice(open + 1, close);
    out.push({ type: 'inline', latex, from: locate(open), to: locate(close) + 1 });
    i = close + 1;
  }

  // 按源码顺序排序（块级遍先行会打乱顺序）。
  out.sort((a, b) => a.from - b.from);
}

// ---------------------------------------------------------------------------
// 纯逻辑层：markdown → 公式段（经 MDAST，排除 code / inlineCode / html）
// ---------------------------------------------------------------------------

interface MdastNodeLike {
  type: string;
  value?: string;
  children?: MdastNodeLike[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** 这些节点的文本内容绝不参与公式识别（代码、原始 HTML）。 */
const MDAST_SKIP_TYPES: ReadonlySet<string> = new Set(['code', 'inlineCode', 'html']);

/**
 * 这些节点截断公式缓冲区（其文本不可作为公式的一部分）：
 * 行内代码、原始 HTML、图片等原子节点。注意 `inlineCode`/`html` 同时也在
 * SKIP 集合里——这里需要的是「flush 并跳过」，而非「整体不进子树」。
 */
const INLINE_BARRIER_TYPES: ReadonlySet<string> = new Set([
  'inlineCode',
  'html',
  'image',
  'imageReference',
  'footnoteReference',
]);

/**
 * 从 markdown 源码提取全部公式段（含源码偏移）。经 parser.ts 的 MDAST
 * 遍历， fenced code / inline code / raw HTML 内的 `$` 不会被误识别。
 */
export function extractMathSegments(markdown: string): MathSegment[] {
  const root = parseMarkdownToMdast(markdown) as unknown as MdastNodeLike;
  const out: MathSegment[] = [];
  walkBlock(root, markdown, out);
  out.sort((a, b) => a.from - b.from);
  return out;
}

function walkBlock(node: MdastNodeLike, source: string, out: MathSegment[]): void {
  if (MDAST_SKIP_TYPES.has(node.type)) return;
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
    collectInlineMath(node.children ?? [], source, out);
    return;
  }
  for (const child of node.children ?? []) walkBlock(child, source, out);
}

/**
 * 把一个 textblock 的行内子树重建为连续文本后扫描公式。text 节点取
 * **原始源码切片**（而非 MDAST 解码后的 value），以保留 LaTeX 必需的
 * 反斜杠（`\,`、`\$` 等会被 CommonMark 转义解码吃掉）；`break` 重建为
 * `\n`（使多行 $$…$$ 可识别）；emphasis/strong/delete/link 等透明下钻；
 * 屏障节点 flush 缓冲，保证公式不会跨越 inlineCode 边界拼接。
 */
function collectInlineMath(
  children: readonly MdastNodeLike[],
  source: string,
  out: MathSegment[],
): void {
  let buf = '';
  let map: number[] = []; // buf 下标 → 源码偏移
  const flush = (): void => {
    if (buf.length > 0) {
      scanTextMathInto(buf, (idx) => map[idx] ?? 0, out);
    }
    buf = '';
    map = [];
  };
  const append = (value: string, offset: number): void => {
    for (let k = 0; k < value.length; k++) {
      buf += value[k];
      map.push(offset + k);
    }
  };
  const visit = (child: MdastNodeLike): void => {
    if (INLINE_BARRIER_TYPES.has(child.type)) {
      flush();
      return;
    }
    if (child.type === 'text') {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start !== undefined && end !== undefined && end >= start) {
        append(source.slice(start, end), start);
      } else {
        append(child.value ?? '', start ?? 0);
      }
      return;
    }
    if (child.type === 'break') {
      append('\n', child.position?.start?.offset ?? 0);
      return;
    }
    for (const grand of child.children ?? []) visit(grand);
  };
  for (const child of children) visit(child);
  flush();
}

/** markdown 中是否含公式（惰性加载的门槛判断）。 */
export function hasMath(markdown: string): boolean {
  return extractMathSegments(markdown).length > 0;
}

// ---------------------------------------------------------------------------
// 纯逻辑层：KaTeX 渲染与错误隔离
// ---------------------------------------------------------------------------

/** KaTeX 模块的最小契约（真实模块与测试替身共用这个形状）。 */
export interface KatexRenderer {
  renderToString(
    latex: string,
    options?: { throwOnError?: boolean; displayMode?: boolean },
  ): string;
}

interface RenderOutcome {
  readonly html: string;
  readonly error: boolean;
}

/**
 * 以 throwOnError:true 渲染；语法错误时返回 error 标记而不产出 KaTeX
 * HTML（调用方据此原样显示源码，而不是用 KaTeX 的红字错误样式）。
 */
function tryRenderKatex(latex: string, displayMode: boolean, katex: KatexRenderer): RenderOutcome {
  try {
    return { html: katex.renderToString(latex, { throwOnError: true, displayMode }), error: false };
  } catch {
    return { html: '', error: true };
  }
}

/**
 * 渲染单个公式为 HTML 字符串：成功 → KaTeX HTML；语法错误 →
 * `<code class="lightink-math-error">` 包裹的转义源码（错误被隔离在该
 * 片段内，不影响文档其他部分）。
 */
export function renderMathHtml(latex: string, displayMode: boolean, katex: KatexRenderer): string {
  const outcome = tryRenderKatex(latex, displayMode, katex);
  if (outcome.error) {
    return `<code class="lightink-math-error">${escapeMathHtml(latex)}</code>`;
  }
  return outcome.html;
}

// ---------------------------------------------------------------------------
// 惰性加载：仅当文档确有公式时才 import('katex')，且只加载一次
// ---------------------------------------------------------------------------

/**
 * 构造一个 memoized 的 KaTeX 加载器。`load` 工厂可注入替身以便测试断言
 * 「无公式时从不触发 import」。加载失败（网络/打包异常）的 rejected
 * promise 也会被缓存，避免每次编辑都重试。
 */
export function createKatexLoader(
  load: () => Promise<unknown> = () => import('katex'),
): () => Promise<KatexRenderer> {
  let cached: Promise<KatexRenderer> | null = null;
  return () => {
    if (cached === null) {
      cached = Promise.resolve()
        .then(load)
        .then((mod) => {
          const shaped = mod as Partial<KatexRenderer> & { default?: Partial<KatexRenderer> };
          const renderer = (shaped.default ?? shaped) as Partial<KatexRenderer>;
          if (typeof renderer.renderToString !== 'function') {
            throw new Error('katex module does not expose renderToString');
          }
          return renderer as KatexRenderer;
        });
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------
// ProseMirror decoration 层
// ---------------------------------------------------------------------------

/** 公式插件状态：已加载的 KaTeX（未加载时为 null）+ 当前 decorations。 */
export interface MathPluginState {
  readonly katex: KatexRenderer | null;
  readonly decorations: DecorationSet;
}

export const mathPluginKey = new PluginKey<MathPluginState>('lightink-math');

/** PM 事务元数据形状：KaTeX 加载完成后由 view 回灌触发重装饰。 */
interface KatexLoadedMeta {
  katex: KatexRenderer;
}

/** 快速判断 PM 文档是否含公式（不构建 decoration，供惰性加载门槛用）。 */
function docHasMath(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    // 代码块内容永远不当公式扫描（R8：公式只作用于正文）
    if (node.type.name === 'code_block') return false;
    if (!node.isTextblock) return true;
    if (scanMathInTextblock(node).length > 0) {
      found = true;
    }
    return false;
  });
  return found;
}

/**
 * 在 textblock 内扫描公式段，排除 inline code（code mark）覆盖的区间。
 * 返回段的 from/to 为「textblock 内文本偏移」，由调用方加 pos+1 换算为
 * 文档位置。
 *
 * 已知取舍：remark 在解析期把 `\$` 解码为字面 `$`，PM 文本层看不到转义
 * 反斜杠，故源码 `\$x$` 在本层会被当作公式渲染；严格语义需源码级映射，
 * 当前按 PM 层近似接受（罕见的刻意转义场景）。
 */
function scanMathInTextblock(
  node: PMNode,
): Array<{ type: 'inline' | 'block'; latex: string; from: number; to: number }> {
  const text = node.textBetween(0, node.content.size, '\n', '\n');
  // 收集 inline code（code mark）覆盖的文本区间（与 textBetween 的
  // 叶节点 1 字符占位对齐：非文本叶子计 1）。
  const excluded: Array<readonly [number, number]> = [];
  let offset = 0;
  node.forEach((child) => {
    if (child.isText && child.text !== undefined) {
      const size = child.text.length;
      if (child.marks.some((m) => m.type.name === 'code')) {
        excluded.push([offset, offset + size] as const);
      }
      offset += size;
    } else {
      // 非文本叶子（hardBreak/image 等）与 textBetween 的 1 字符占位对齐
      offset += 1;
    }
  });
  return scanTextMath(text, 0).filter((seg) => {
    if (excluded.length === 0) return true;
    return !excluded.some(([s, e]) => seg.from < e && seg.to > s);
  });
}

/**
 * 为整篇文档构建公式 decorations。`katex` 为 null（尚未加载）时返回空集
 * —— 此时公式以源码形态原样显示，加载完成后由插件重新构建。
 *
 * 每个公式段产生：
 *   - source 范围的 inline decoration（成功：`lightink-math-inline-source`
 *     / `lightink-math-block-source`；失败：`lightink-math-error`）；
 *   - 成功时追加一个 widget decoration，承载渲染好的 KaTeX HTML。
 * 文档本身不被修改，源码始终可编辑；错误只影响该段自身。
 */
export function buildMathDecorations(doc: PMNode, katex: KatexRenderer | null): DecorationSet {
  if (katex === null) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    // 代码块内容永远不当公式渲染（R8：公式只作用于正文）
    if (node.type.name === 'code_block') return false;
    if (!node.isTextblock) return true;
    // textblock 内文本从 pos+1 开始；扫描时排除 inline code（code mark）
    // 区间（leaf 节点以单字符占位，保证「文本下标 ↔ 文档位置」一一对应）。
    const segments = scanMathInTextblock(node).map((seg) => ({
      ...seg,
      from: seg.from + pos + 1,
      to: seg.to + pos + 1,
    }));
    for (const seg of segments) {
      const displayMode = seg.type === 'block';
      const outcome = tryRenderKatex(seg.latex, displayMode, katex);
      if (outcome.error) {
        // R8：语法错误 → 原样显示源码，仅加错误样式类，不插入渲染结果。
        decorations.push(
          Decoration.inline(seg.from, seg.to, {
            class: 'lightink-math-error',
            'data-math-error': 'true',
          }),
        );
        continue;
      }
      decorations.push(
        Decoration.inline(seg.from, seg.to, {
          class: displayMode ? 'lightink-math-block-source' : 'lightink-math-inline-source',
          'data-math-rendered': 'true',
        }),
      );
      const html = outcome.html;
      decorations.push(
        Decoration.widget(
          seg.to,
          () => {
            const el = document.createElement(displayMode ? 'div' : 'span');
            el.className = displayMode ? 'lightink-math-block' : 'lightink-math-inline';
            el.innerHTML = html;
            return el;
          },
          { side: 1, key: `lightink-math-${seg.from}` },
        ),
      );
    }
    return false; // textblock 的文本已整体扫描，无需下降
  });
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * Milkdown 插件（`$prose`）：行内/块级 LaTeX 公式即时渲染。
 * 在 mountEditor 中于 commonmark/gfm/history 之后注册。
 *
 * 加载策略：`view` 在挂载与每次更新后检查文档；仅当存在公式且 KaTeX 未
 * 加载时才触发一次动态 import，完成后通过带 meta 的事务回灌插件状态并
 * 重建 decorations。加载失败时静默保持源码显示（不阻塞编辑）。
 */
export const mathPlugin = $prose(() => {
  const loadKatex = createKatexLoader();
  let loadRequested = false;

  return new Plugin<MathPluginState>({
    key: mathPluginKey,
    state: {
      init: (_config, state) => ({
        katex: null,
        decorations: buildMathDecorations(state.doc, null),
      }),
      apply: (tr, old, _oldState, newState) => {
        const meta = tr.getMeta(mathPluginKey) as KatexLoadedMeta | undefined;
        const katex = meta?.katex ?? old.katex;
        if (meta?.katex !== undefined || tr.docChanged) {
          return { katex, decorations: buildMathDecorations(newState.doc, katex) };
        }
        return { katex, decorations: old.decorations.map(tr.mapping, tr.doc) };
      },
    },
    view: (view) => {
      const ensureKatex = (): void => {
        const pluginState = mathPluginKey.getState(view.state);
        if (pluginState === undefined || pluginState.katex !== null || loadRequested) return;
        if (!docHasMath(view.state.doc)) return;
        loadRequested = true;
        loadKatex()
          .then((katex) => {
            // 视图可能已销毁；dispatch 前状态检查由 PM 自身保证安全。
            view.dispatch(view.state.tr.setMeta(mathPluginKey, { katex } satisfies KatexLoadedMeta));
          })
          .catch(() => {
            // 加载失败：保持源码显示，不打扰编辑；重试留给下次挂载。
            loadRequested = false;
          });
      };
      ensureKatex();
      return { update: () => ensureKatex() };
    },
    props: {
      decorations(state) {
        return mathPluginKey.getState(state)?.decorations;
      },
    },
  });
});
