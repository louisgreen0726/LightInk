/**
 * 按标题折叠插件（T4 / R2）。
 *
 * 设计（docs/sakullla-workflow/.../02-technical-solution.md §R2）：
 *
 *   - 折叠态用 ProseMirror `PluginKey` 持久「折叠的 heading 文档位置集合」，
 *     **非** heading attr（避免 toMarkdown 序列化污染，R6 合规）。PluginKey 态
 *     永不序列化（与 toc / image-size 同一先例），故保存重开自动恢复全展开。
 *
 *   - 渲染只挂 decoration（不改文档）：每个标题前一个三角 widget（可点击切换），
 *     折叠区间内的顶层块用 `Decoration.node(style:display:none)` 隐藏。导出基于
 *     未改动的 live doc（`getMarkdown`），折叠不影响导出内容。
 *
 *   - 折叠范围 = 该标题之后到「下一个同级或更高级标题」之前的全部顶层内容
 *     （更深的子标题及其内容一并落入父标题的折叠区间）。
 *
 *   - 文档变更时折叠位置经 `tr.mapping.map` 迁移并复验仍为 heading（照搬 toc.ts
 *     的 mapping + 防抖重建范式）；decoration 在防抖窗口内随 mapping 平移，由
 *     view 层注入 refresh meta 事务统一重建，避免每次击键重建 widget DOM。
 *
 *   - 光标守卫：折叠（display:none）区间不能承载光标——`appendTransaction` 在
 *     每次事务后检测选区是否落入折叠区间，若是则移到该标题内（可见），满足 R2
 *     「不进入隐藏内容、不丢内容」。点击因 display:none 无 DOM 命中而天然安全。
 *
 *   - 大纲↔编辑器双向联动：编辑器侧只暴露序号（ordinal）口径的
 *     `toggleFoldAtOrdinal` / `getFoldedOrdinals`（命令面，不暴露私有 view），
 *     大纲据此渲染/切换；编辑器内三角切换经 `onFoldChanged` 回调通知宿主刷新大纲。
 *
 * 纯逻辑层（`collectHeadings` / `foldRangeForHeading` / `computeFoldedRanges` /
 * `migrateFolded` / `toggleFold` / `createHeadingFoldProsePlugin`）headless 可测；
 * 仅三角 widget DOM 渲染依赖浏览器。
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

/** 折叠区间重建防抖窗口（毫秒）：文档变更后合并重建一次（同 toc.ts）。 */
export const FOLD_REBUILD_DEBOUNCE_MS = 150;

/** 触发 decoration 全量重建的 plugin meta 值（防抖 refresh）。 */
export const FOLD_REFRESH_META = 'refresh';

/** toggle 动作的 plugin meta（点击三角 / 大纲切换时 dispatch）。 */
export interface FoldToggleMeta {
  /** 要切换折叠态的标题文档位置。 */
  toggle: number;
}

/** 插件态：折叠的标题位置集合 + 由其派生的 decoration 缓存。 */
export interface FoldState {
  /** 当前折叠的标题文档位置（source of truth；保存重开自动清空）。 */
  folded: Set<number>;
  /** 由 folded + doc 派生的 decoration（apply 内维护，props.decorations 直读）。 */
  decorations: DecorationSet;
}

export const FOLD_PLUGIN_KEY = new PluginKey<FoldState>('lightink-heading-fold');

/** 标题条目：层级、纯文本、文档位置（与 outline-model 序号语义同源）。 */
export interface FoldHeading {
  readonly level: number;
  readonly text: string;
  readonly pos: number;
}

/** 折叠区间：被隐藏的顶层内容 [from, to) 与所属标题位置。 */
export interface FoldRange {
  /** 折叠标题之后首个被隐藏位置（标题 nodeSize 之后）。 */
  readonly from: number;
  /** 折叠区间结束位置（下一个同级/更高级标题前 / 文档末）。 */
  readonly to: number;
  /** 折叠的标题文档位置。 */
  readonly headingPos: number;
}

// ---------------------------------------------------------------------------
// 纯逻辑层（headless 可测）
// ---------------------------------------------------------------------------

/**
 * 按文档顺序收集 heading（与 outline-model / toc 的 collectTocHeadings 同源语义，
 * 应用于 live PM doc）。返回 level（1-6）/ 纯文本 / 文档位置。
 */
export function collectHeadings(doc: PMNode): FoldHeading[] {
  const out: FoldHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    const rawLevel: unknown = node.attrs['level'];
    const level =
      typeof rawLevel === 'number' && rawLevel >= 1 && rawLevel <= 6
        ? rawLevel
        : 1;
    out.push({ level, text: node.textContent, pos });
  });
  return out;
}

/**
 * 计算标题的折叠区间 [from, to)：从该标题之后到「下一个同级或更高级标题」之前。
 * 更深的子标题及其内容落入父标题的区间（在遇到同级/更高级标题前不停止）。
 * 标题紧接同级/更高级标题（无可折叠内容）或位置已非标题时返回 null。
 *
 * 按「顶层标题 + 顶层兄弟」计算（commonmark heading 为顶层块；blockquote 内
 * 嵌套标题的折叠不在本最小实现覆盖范围）。
 */
export function foldRangeForHeading(doc: PMNode, headingPos: number): { from: number; to: number } | null {
  if (headingPos < 0 || headingPos > doc.content.size) return null;
  const node = doc.nodeAt(headingPos);
  if (node === null || node.type.name !== 'heading') return null;
  const rawLevel: unknown = node.attrs['level'];
  const level = typeof rawLevel === 'number' && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 1;
  const from = headingPos + node.nodeSize;
  let to = doc.content.size;
  doc.forEach((child, offset) => {
    if (offset <= headingPos) return;
    if (child.type.name === 'heading') {
      const childLevel: unknown = child.attrs['level'];
      const cl = typeof childLevel === 'number' && childLevel >= 1 && childLevel <= 6 ? childLevel : 1;
      if (cl <= level && offset < to) {
        to = offset;
      }
    }
  });
  if (to <= from) return null;
  return { from, to };
}

/** 对每个折叠标题计算其折叠区间（位置已非标题或无内容时跳过）。 */
export function computeFoldedRanges(doc: PMNode, folded: ReadonlySet<number>): FoldRange[] {
  const out: FoldRange[] = [];
  for (const pos of folded) {
    const range = foldRangeForHeading(doc, pos);
    if (range !== null) {
      out.push({ ...range, headingPos: pos });
    }
  }
  return out;
}

/**
 * 文档变更后迁移折叠位置：每个 pos 经 `tr.mapping.map` 平移，并复验映射后仍落在
 * heading 上（编辑改变了结构则丢弃失效位置）。返回新集合（输入不变则同引用语义
 * 由调用方处理，这里始终返回新 Set 以简化）。
 */
export function migrateFolded(folded: ReadonlySet<number>, tr: Transaction): Set<number> {
  const next = new Set<number>();
  for (const pos of folded) {
    const mapped = tr.mapping.map(pos);
    const node = tr.doc.nodeAt(mapped);
    if (node !== null && node.type.name === 'heading') {
      next.add(mapped);
    }
  }
  return next;
}

/**
 * 切换某标题的折叠态。位置在新文档中已非标题时不改变集合（防失效点击）。
 */
export function toggleFold(folded: ReadonlySet<number>, headingPos: number, doc: PMNode): Set<number> {
  const next = new Set(folded);
  if (headingPos < 0 || headingPos > doc.content.size) return next;
  const node = doc.nodeAt(headingPos);
  if (node !== null && node.type.name === 'heading') {
    if (next.has(headingPos)) {
      next.delete(headingPos);
    } else {
      next.add(headingPos);
    }
  }
  return next;
}

/** 两 Set 内容相等（顺序无关）。 */
export function foldSetEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/** Trailing-edge debounce（同 toc.ts 语义；本插件自包含不复用 toc 工具）。 */
export interface DebouncedFn {
  (): void;
  cancel(): void;
}
export function debounce(fn: () => void, wait: number): DebouncedFn {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, wait);
  };
  wrapped.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/** 判断事务是否携带 toggle meta。 */
function asToggleMeta(meta: unknown): FoldToggleMeta | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const toggle = (meta as { toggle?: unknown }).toggle;
  if (typeof toggle === 'number') return { toggle };
  return null;
}

// ---------------------------------------------------------------------------
// Widget DOM（仅浏览器路径；headless 测试不触发 factory）
// ---------------------------------------------------------------------------

function createFoldMarker(
  headingPos: number,
  isFolded: boolean,
  getView: () => EditorView | null,
): HTMLElement {
  const el = document.createElement('span');
  el.className = 'lightink-fold-marker' + (isFolded ? ' is-folded' : '');
  el.contentEditable = 'false';
  el.textContent = isFolded ? '▾' : '▸';
  el.style.cssText =
    'cursor:pointer;user-select:none;display:inline-block;width:1em;' +
    'margin-right:2px;opacity:.55;font-size:.85em;';
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', isFolded ? '展开' : '折叠');
  // 阻止 PM 抢占焦点 / 放置光标（同 toc widget 先例）。
  el.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const view = getView();
    if (view !== null) {
      view.dispatch(view.state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: headingPos }));
    }
  });
  return el;
}

/**
 * 由 folded 集合 + doc 派生 decoration：未被折叠区间隐藏的标题挂三角 widget
 * （折叠态加 heading class），折叠区间内每个顶层块挂 display:none node decoration。
 * 落在某个折叠区间内的（更深的）子标题既被 display:none 隐藏，也不再产生三角
 * widget——否则会留下孤立可点击标记，点击后切换不可见内容（R2 正文折叠主路径）。
 */
export function buildFoldDecorations(
  doc: PMNode,
  folded: ReadonlySet<number>,
  getView: () => EditorView | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  const headings = collectHeadings(doc);
  const ranges = computeFoldedRanges(doc, folded);
  // 收集所有被折叠区间隐藏的「标题」位置：这些子标题不渲染三角 widget。
  const hiddenHeadingPos = new Set<number>();
  for (const r of ranges) {
    let pos = r.from;
    while (pos < r.to) {
      const child = doc.nodeAt(pos);
      if (child === null) break;
      if (child.type.name === 'heading') {
        hiddenHeadingPos.add(pos);
      }
      pos += child.nodeSize;
    }
  }
  for (const h of headings) {
    if (hiddenHeadingPos.has(h.pos)) {
      continue; // 已被父折叠隐藏的子标题：不留三角标记
    }
    const isFolded = folded.has(h.pos);
    decorations.push(
      Decoration.widget(h.pos, () => createFoldMarker(h.pos, isFolded, getView), {
        side: -1,
        key: `lightink-fold-${h.pos}`,
        ignoreSelection: true,
      }),
    );
    if (isFolded) {
      const headingNode = doc.nodeAt(h.pos);
      if (headingNode !== null) {
        decorations.push(
          Decoration.node(h.pos, h.pos + headingNode.nodeSize, {
            class: 'lightink-heading-folded',
          }),
        );
      }
    }
  }
  for (const r of ranges) {
    let pos = r.from;
    while (pos < r.to) {
      const child = doc.nodeAt(pos);
      if (child === null) break;
      decorations.push(
        Decoration.node(pos, pos + child.nodeSize, {
          class: 'lightink-folded-region',
          style: 'display:none',
        }),
      );
      pos += child.nodeSize;
    }
  }
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// ProseMirror / Milkdown 插件
// ---------------------------------------------------------------------------

export interface HeadingFoldPluginOptions {
  /** 折叠集合变化时回调（main.ts 接大纲刷新；点击三角后通知另一侧同步）。 */
  onFoldChanged?: () => void;
}

/**
 * 构建原生 ProseMirror 插件（导出供 headless 单测直接挂到 EditorState）。
 * 折叠集合（source of truth）即时随 toggle/mapping 更新；decoration 在 toggle
 * 时立即重建，文档变更时先 mapping 平移再由 view 层防抖 refresh meta 统一重建
 * （同 toc.ts 范式，避免每次击键重建 widget）。
 */
export function createHeadingFoldProsePlugin(
  options: HeadingFoldPluginOptions = {},
): Plugin {
  let viewRef: EditorView | null = null;
  const getView = (): EditorView | null => viewRef;

  return new Plugin({
    key: FOLD_PLUGIN_KEY,
    state: {
      init: (_config, state) => ({
        folded: new Set<number>(),
        decorations: buildFoldDecorations(state.doc, new Set<number>(), getView),
      }),
      apply: (tr, value, _oldState, newState) => {
        const toggle = asToggleMeta(tr.getMeta(FOLD_PLUGIN_KEY));
        if (toggle !== null) {
          // 点击三角 / 大纲切换：即时更新集合并重建 decoration。
          const folded = toggleFold(value.folded, toggle.toggle, newState.doc);
          return { folded, decorations: buildFoldDecorations(newState.doc, folded, getView) };
        }
        if (tr.getMeta(FOLD_PLUGIN_KEY) === FOLD_REFRESH_META) {
          // 防抖 refresh：按当前集合重建 decoration（折叠集合不变）。
          return {
            folded: value.folded,
            decorations: buildFoldDecorations(newState.doc, value.folded, getView),
          };
        }
        if (tr.docChanged) {
          // 文档变更：折叠位置 mapping 迁移 + 复验；decoration 先随 mapping 平移。
          const folded = migrateFolded(value.folded, tr);
          const decorations = value.decorations.map(tr.mapping, tr.doc);
          return { folded, decorations };
        }
        return value;
      },
    },
    props: {
      decorations: (state) => FOLD_PLUGIN_KEY.getState(state)?.decorations,
    },
    // 光标守卫（plugin 级，非 props）：折叠区间（display:none）不能承载光标。
    // 每次事务后若空选区落在折叠区间内，移到该标题内（可见）。范围选区不动
    // （用户主动跨区选择）。
    appendTransaction: (_trs, _oldState, newState) => {
      const value = FOLD_PLUGIN_KEY.getState(newState);
      if (value === undefined || value.folded.size === 0) return null;
      const sel = newState.selection;
      if (!sel.empty) return null;
      for (const r of computeFoldedRanges(newState.doc, value.folded)) {
        if (sel.from > r.from && sel.from < r.to) {
          const $pos = newState.doc.resolve(r.from);
          const near = TextSelection.near($pos, -1);
          return newState.tr.setSelection(near);
        }
      }
      return null;
    },
    view(editorView) {
      viewRef = editorView;
      const schedule = debounce(() => {
        const view = viewRef;
        if (view !== null) {
          view.dispatch(view.state.tr.setMeta(FOLD_PLUGIN_KEY, FOLD_REFRESH_META));
        }
      }, FOLD_REBUILD_DEBOUNCE_MS);
      return {
        update(view, prevState) {
          viewRef = view;
          if (!view.state.doc.eq(prevState.doc)) {
            schedule();
          }
          // 折叠集合变化（toggle / 迁移导致增删）→ 通知宿主（大纲）刷新。
          const prev = FOLD_PLUGIN_KEY.getState(prevState);
          const cur = FOLD_PLUGIN_KEY.getState(view.state);
          if (prev !== undefined && cur !== undefined && !foldSetEqual(prev.folded, cur.folded)) {
            options.onFoldChanged?.();
          }
        },
        destroy() {
          schedule.cancel();
          viewRef = null;
        },
      };
    },
  });
}

/**
 * Milkdown `$prose` 插件：按标题折叠正文 + 三角切换。在 `index.ts` 中注册
 * （`editor.use(headingFoldPlugin({ onFoldChanged }))`）。
 */
export const headingFoldPlugin = (options: HeadingFoldPluginOptions = {}): ReturnType<typeof $prose> =>
  $prose(() => createHeadingFoldProsePlugin(options));
