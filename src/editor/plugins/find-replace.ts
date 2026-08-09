/**
 * 查找与替换插件（T4 / R2）。
 *
 * 组成：
 *
 *   - `$prose` 插件（WYSIWYG）：按查询串在 live ProseMirror 文档内收集全部命中
 *     （逐 text 节点、大小写不敏感、不跨节点），以 inline decoration 高亮全部
 *     命中，当前命中叠加独立样式；查询/当前项经 plugin meta 事务驱动。
 *
 *   - 事务构建器（headless 可测）：`findQueryTr` / `stepMatchTr` /
 *     `replaceCurrentTr` / `replaceAllTr` 均以「单个 ProseMirror 事务」完成
 *     选区移动或替换（参考 EditorInstance.setLink 的单事务模式），因此替换可
 *     经既有 history 撤销一次回到替换前。
 *
 *   - 视图注册表：Milkdown 的 EditorInstance 不暴露底层 EditorView，本模块在
 *     插件 view 钩子中把 `view.dom → EditorView` 登记进模块级 Map，壳层经
 *     `findReplaceViewForHost(tab.hostElement)` 反查当前标签的视图。
 *
 *   - 源码模式纯逻辑：`collectSourceMatches` 在 textarea 文本上收集命中；
 *     壳层用原生 selection + document.execCommand('insertText') 执行替换以
 *     保留 textarea 原生 undo（不用 setRangeText，它会清空原生撤销栈）。
 *
 *   - 壳层面板 `createFindReplacePanel`：查找/替换输入、上一处/下一处、
 *     「替换」「全部替换」两个可区分按钮、命中计数；无匹配时显示可观察空态
 *     （data 属性 + 文案）并禁用替换按钮。面板自身不触模型，全部经 handlers
 *     回调由壳层按当前模式分派。
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

export const FIND_REPLACE_PLUGIN_KEY = new PluginKey<FindReplaceState>('lightink-find-replace');

/** 一处命中在 PM 文档中的位置区间。 */
export interface FindMatch {
  readonly from: number;
  readonly to: number;
}

/** 插件状态：当前查询串、命中列表、当前命中下标（-1 = 无）、decoration 集。 */
export interface FindReplaceState {
  readonly query: string;
  readonly matches: readonly FindMatch[];
  readonly active: number;
  readonly decorations: DecorationSet;
}

type FindReplaceMeta =
  | { readonly type: 'query'; readonly query: string }
  | { readonly type: 'active'; readonly index: number };

/** 全部命中的 decoration class；当前命中额外叠加 current class。 */
export const FIND_MATCH_CLASS = 'lightink-find-match';
export const FIND_MATCH_CURRENT_CLASS = 'lightink-find-match-current';

// ---------------------------------------------------------------------------
// 纯逻辑层（headless 可测）
// ---------------------------------------------------------------------------

/**
 * 在 PM 文档内收集查询串的全部命中（逐 text 节点、大小写不敏感、不重叠、
 * 不跨节点边界）。空查询返回空数组。
 */
export function collectMatches(doc: PMNode, query: string): FindMatch[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const haystack = (node.text ?? '').toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      out.push({ from: pos + idx, to: pos + idx + needle.length });
      idx = haystack.indexOf(needle, idx + needle.length);
    }
  });
  return out;
}

/** 源码模式：在纯文本上收集命中（与 collectMatches 同一大小写口径）。 */
export interface SourceTextMatch {
  readonly start: number;
  readonly end: number;
}

export function collectSourceMatches(text: string, query: string): SourceTextMatch[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const out: SourceTextMatch[] = [];
  const haystack = text.toLowerCase();
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push({ start: idx, end: idx + needle.length });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** 环形步进：total 为 0 返回 -1；active 越界时按方向落到首/尾。 */
export function nextMatchIndex(total: number, active: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (active < 0 || active >= total) return dir === 1 ? 0 : total - 1;
  return (active + dir + total) % total;
}

function buildFindDecorations(
  doc: PMNode,
  matches: readonly FindMatch[],
  active: number,
): DecorationSet {
  const decorations = matches.map((match, index) => {
    const current = index === active;
    return Decoration.inline(match.from, match.to, {
      class: current ? `${FIND_MATCH_CLASS} ${FIND_MATCH_CURRENT_CLASS}` : FIND_MATCH_CLASS,
      style: current
        ? 'background-color: rgba(242, 153, 74, 0.75); outline: 1px solid rgba(180, 110, 20, 0.9); border-radius: 2px;'
        : 'background-color: rgba(242, 201, 76, 0.45); border-radius: 2px;',
    });
  });
  return DecorationSet.create(doc, decorations);
}

const EMPTY_STATE: FindReplaceState = {
  query: '',
  matches: [],
  active: -1,
  decorations: DecorationSet.empty,
};

/**
 * 构建原生 ProseMirror 插件（导出供 headless 单测直接挂到 EditorState）。
 * 文档变更且查询非空时全量重收命中（替换/编辑后命中位置即 fresh），
 * 当前下标收敛到有效范围。
 */
export function createFindReplaceProsePlugin(): Plugin {
  return new Plugin({
    key: FIND_REPLACE_PLUGIN_KEY,
    state: {
      init: (): FindReplaceState => EMPTY_STATE,
      apply: (tr, old, _oldState, newState): FindReplaceState => {
        const meta = tr.getMeta(FIND_REPLACE_PLUGIN_KEY) as FindReplaceMeta | undefined;
        let query = old.query;
        let matches = old.matches;
        let active = old.active;
        let decorations = old.decorations;
        let rebuilt = false;

        const recompute = (nextQuery: string, preferredActive: number): void => {
          query = nextQuery;
          matches = collectMatches(newState.doc, query);
          if (matches.length === 0) {
            active = -1;
          } else if (preferredActive < 0) {
            active = 0;
          } else {
            active = Math.min(preferredActive, matches.length - 1);
          }
          decorations = buildFindDecorations(newState.doc, matches, active);
          rebuilt = true;
        };

        if (meta?.type === 'query') {
          // 显式设置查询：跳到首命中（-1 语义 → 0）。
          recompute(meta.query, -1);
        } else if (tr.docChanged && query !== '') {
          // 编辑/替换后按当前查询重收，保持当前下标（收敛到范围内）。
          recompute(query, active);
        }

        if (meta?.type === 'active') {
          active = matches.length === 0 ? -1 : Math.min(Math.max(meta.index, 0), matches.length - 1);
          decorations = buildFindDecorations(newState.doc, matches, active);
          rebuilt = true;
        }

        if (!rebuilt && tr.docChanged && matches.length > 0) {
          // 防御：理论上 docChanged 且 query 非空必然 recompute；兜底映射。
          decorations = decorations.map(tr.mapping, tr.doc);
        }
        return { query, matches, active, decorations };
      },
    },
    props: {
      decorations(state) {
        return FIND_REPLACE_PLUGIN_KEY.getState(state)?.decorations ?? null;
      },
    },
    view(editorView) {
      findReplaceViews.set(editorView.dom, editorView);
      return {
        destroy() {
          findReplaceViews.delete(editorView.dom);
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// 事务构建器（headless 可测；view 包装层仅 dispatch）
// ---------------------------------------------------------------------------

function pluginStateOf(state: EditorState): FindReplaceState | null {
  return FIND_REPLACE_PLUGIN_KEY.getState(state) ?? null;
}

/**
 * 设置查询串的事务：meta 驱动命中重收；有命中时把选区移到首命中并滚动可见
 * （选区事务不产生 history 撤销步）。查询为空即清除全部高亮。
 */
export function findQueryTr(state: EditorState, query: string): Transaction {
  const tr = state.tr.setMeta(FIND_REPLACE_PLUGIN_KEY, {
    type: 'query',
    query,
  } satisfies FindReplaceMeta);
  const matches = collectMatches(state.doc, query);
  const first = matches[0];
  if (first !== undefined) {
    tr.setSelection(TextSelection.create(state.doc, first.from, first.to)).scrollIntoView();
  }
  return tr;
}

/** 步进到上/下一命中的事务（环形）；无命中返回 null。 */
export function stepMatchTr(state: EditorState, dir: 1 | -1): Transaction | null {
  const fr = pluginStateOf(state);
  if (fr === null || fr.matches.length === 0) return null;
  const next = nextMatchIndex(fr.matches.length, fr.active, dir);
  const match = fr.matches[next];
  if (match === undefined) return null;
  return state.tr
    .setMeta(FIND_REPLACE_PLUGIN_KEY, { type: 'active', index: next } satisfies FindReplaceMeta)
    .setSelection(TextSelection.create(state.doc, match.from, match.to))
    .scrollIntoView();
}

/**
 * 「替换当前」：单个事务把当前命中替换为 replacement，光标落在替换文本末尾。
 * 插件 apply 会因 docChanged 自动重收命中并保持下标（下一次替换即原位置的
 * 下一命中）。无当前命中返回 null。
 */
export function replaceCurrentTr(state: EditorState, replacement: string): Transaction | null {
  const fr = pluginStateOf(state);
  if (fr === null || fr.active < 0 || fr.active >= fr.matches.length) return null;
  const match = fr.matches[fr.active];
  if (match === undefined) return null;
  const tr = state.tr.insertText(replacement, match.from, match.to);
  tr.setSelection(TextSelection.create(tr.doc, match.from + replacement.length)).scrollIntoView();
  return tr;
}

/**
 * 「全部替换」：全部命中在单个事务内自后向前替换（位置不被前序替换带偏），
 * 因此一次 undo 即回到替换前。返回事务与替换处数；无命中返回 null。
 */
export function replaceAllTr(
  state: EditorState,
  replacement: string,
): { tr: Transaction; count: number } | null {
  const fr = pluginStateOf(state);
  if (fr === null || fr.matches.length === 0) return null;
  const tr = state.tr;
  for (let i = fr.matches.length - 1; i >= 0; i -= 1) {
    const match = fr.matches[i];
    if (match !== undefined) {
      tr.insertText(replacement, match.from, match.to);
    }
  }
  tr.scrollIntoView();
  return { tr, count: fr.matches.length };
}

// ---------------------------------------------------------------------------
// EditorView 包装层 + 视图注册表（壳层经 host 反查当前标签视图）
// ---------------------------------------------------------------------------

const findReplaceViews = new Map<HTMLElement, EditorView>();

/** 反查标签宿主内 WYSIWYG 视图的 EditorView（源码覆盖层/未挂载时返回 null）。 */
export function findReplaceViewForHost(host: HTMLElement): EditorView | null {
  const dom = host.querySelector('.ProseMirror');
  if (!(dom instanceof HTMLElement)) return null;
  return findReplaceViews.get(dom) ?? null;
}

/** 读取当前查询状态（壳层面板计数用）。 */
export function readFindReplaceState(
  view: EditorView,
): { query: string; active: number; total: number } | null {
  const fr = pluginStateOf(view.state);
  if (fr === null) return null;
  return { query: fr.query, active: fr.active, total: fr.matches.length };
}

export function setFindQuery(view: EditorView, query: string): void {
  view.dispatch(findQueryTr(view.state, query));
}

export function stepFindMatch(view: EditorView, dir: 1 | -1): void {
  const tr = stepMatchTr(view.state, dir);
  if (tr !== null) view.dispatch(tr);
}

/** 「替换当前」。返回是否实际执行了替换。 */
export function replaceCurrentMatch(view: EditorView, replacement: string): boolean {
  const tr = replaceCurrentTr(view.state, replacement);
  if (tr === null) return false;
  view.dispatch(tr);
  return true;
}

/** 「全部替换」（单事务、一次 undo 可回）。返回替换处数。 */
export function replaceAllMatches(view: EditorView, replacement: string): number {
  const result = replaceAllTr(view.state, replacement);
  if (result === null) return 0;
  view.dispatch(result.tr);
  return result.count;
}

/** 清除高亮（关闭面板时调用）。 */
export function clearFindReplace(view: EditorView): void {
  if (pluginStateOf(view.state)?.query !== '') {
    view.dispatch(findQueryTr(view.state, ''));
  }
}

/**
 * Milkdown `$prose` 插件：WYSIWYG 查找高亮。在 `index.ts` 中随其余
 * decoration 插件注册（`editor.use(findReplacePlugin)`）。
 */
export const findReplacePlugin = $prose(() => createFindReplaceProsePlugin());

// ---------------------------------------------------------------------------
// 壳层面板（DOM 层；纯逻辑在上，面板只发 handlers 回调）
// ---------------------------------------------------------------------------

export interface FindReplaceLabels {
  readonly findPlaceholder: string;
  readonly replacePlaceholder: string;
  readonly prev: string;
  readonly next: string;
  readonly replace: string;
  readonly replaceAll: string;
  readonly close: string;
  /** 无匹配空态文案。 */
  readonly empty: string;
  /** 命中计数文案（active 为 0 基下标）。 */
  count(active: number, total: number): string;
}

export interface FindReplacePanelHandlers {
  onQueryChange(query: string): void;
  onNext(): void;
  onPrev(): void;
  onReplace(replacement: string): void;
  onReplaceAll(replacement: string): void;
  onClose(): void;
}

export interface FindReplacePanel {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 刷新计数/空态/替换按钮可用性（total=0 且无命中时禁用替换）。 */
  setStatus(total: number, active: number): void;
  getQuery(): string;
  focusFind(): void;
}

function styleButton(button: HTMLButtonElement): void {
  button.style.font = 'inherit';
  button.style.padding = '2px 8px';
  button.style.borderRadius = '4px';
  button.style.border = '1px solid var(--lightink-border, rgba(128, 128, 128, 0.4))';
  button.style.background = 'transparent';
  button.style.color = 'inherit';
  button.style.cursor = 'pointer';
}

/**
 * 创建查找替换面板（初始隐藏，由壳层 append 到编辑区并绝对定位）。
 * 面板不感知模式：查询/步进/替换全部经 handlers 由壳层按 WYSIWYG/源码分派。
 */
export function createFindReplacePanel(
  doc: Document,
  labels: FindReplaceLabels,
  handlers: FindReplacePanelHandlers,
): FindReplacePanel {
  const root = doc.createElement('div');
  root.className = 'lightink-find-panel';
  root.style.position = 'absolute';
  root.style.top = '8px';
  root.style.right = '16px';
  root.style.zIndex = '40';
  root.style.display = 'none';
  root.style.flexDirection = 'column';
  root.style.gap = '6px';
  root.style.padding = '8px';
  root.style.borderRadius = '8px';
  root.style.background = 'var(--lightink-bg-elevated, var(--lightink-bg, #fff))';
  root.style.color = 'var(--lightink-fg, #222)';
  root.style.border = '1px solid var(--lightink-border, rgba(128, 128, 128, 0.4))';
  root.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.18)';
  root.style.fontSize = '13px';

  const rowStyle = (row: HTMLDivElement): void => {
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '4px';
  };
  const inputStyle = (input: HTMLInputElement): void => {
    input.style.font = 'inherit';
    input.style.padding = '2px 6px';
    input.style.borderRadius = '4px';
    input.style.border = '1px solid var(--lightink-border, rgba(128, 128, 128, 0.4))';
    input.style.background = 'var(--lightink-bg, #fff)';
    input.style.color = 'inherit';
    input.style.width = '160px';
  };

  const findInput = doc.createElement('input');
  findInput.type = 'text';
  findInput.className = 'lightink-find-input';
  findInput.placeholder = labels.findPlaceholder;
  inputStyle(findInput);

  const status = doc.createElement('span');
  status.className = 'lightink-find-status';
  status.style.minWidth = '48px';
  status.style.textAlign = 'center';
  status.style.opacity = '0.75';

  const prevBtn = doc.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'lightink-find-prev';
  prevBtn.textContent = labels.prev;
  styleButton(prevBtn);

  const nextBtn = doc.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'lightink-find-next';
  nextBtn.textContent = labels.next;
  styleButton(nextBtn);

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightink-find-close';
  closeBtn.textContent = labels.close;
  styleButton(closeBtn);

  const row1 = doc.createElement('div');
  rowStyle(row1);
  row1.append(findInput, status, prevBtn, nextBtn, closeBtn);

  const replaceInput = doc.createElement('input');
  replaceInput.type = 'text';
  replaceInput.className = 'lightink-replace-input';
  replaceInput.placeholder = labels.replacePlaceholder;
  inputStyle(replaceInput);

  const replaceBtn = doc.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'lightink-replace-current';
  replaceBtn.textContent = labels.replace;
  styleButton(replaceBtn);

  const replaceAllBtn = doc.createElement('button');
  replaceAllBtn.type = 'button';
  replaceAllBtn.className = 'lightink-replace-all';
  replaceAllBtn.textContent = labels.replaceAll;
  styleButton(replaceAllBtn);

  const row2 = doc.createElement('div');
  rowStyle(row2);
  row2.append(replaceInput, replaceBtn, replaceAllBtn);

  root.append(row1, row2);

  let open = false;

  findInput.addEventListener('input', () => {
    handlers.onQueryChange(findInput.value);
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        handlers.onPrev();
      } else {
        handlers.onNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      panel.close();
    }
  });
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handlers.onReplace(replaceInput.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      panel.close();
    }
  });
  prevBtn.addEventListener('click', () => handlers.onPrev());
  nextBtn.addEventListener('click', () => handlers.onNext());
  replaceBtn.addEventListener('click', () => handlers.onReplace(replaceInput.value));
  replaceAllBtn.addEventListener('click', () => handlers.onReplaceAll(replaceInput.value));
  closeBtn.addEventListener('click', () => panel.close());

  const panel: FindReplacePanel = {
    element: root,
    open(): void {
      open = true;
      root.style.display = 'flex';
      panel.focusFind();
    },
    close(): void {
      if (!open) return;
      open = false;
      root.style.display = 'none';
      handlers.onClose();
    },
    isOpen(): boolean {
      return open;
    },
    setStatus(total: number, active: number): void {
      const hasQuery = findInput.value !== '';
      const empty = hasQuery && total === 0;
      // 可观察空态：data 属性 + is-empty class + 空态文案；替换按钮禁用。
      root.dataset['findTotal'] = String(total);
      root.dataset['findEmpty'] = empty ? 'true' : 'false';
      root.classList.toggle('is-empty', empty);
      status.textContent = empty
        ? labels.empty
        : total > 0
          ? labels.count(active, total)
          : '';
      replaceBtn.disabled = total === 0;
      replaceAllBtn.disabled = total === 0;
      prevBtn.disabled = total === 0;
      nextBtn.disabled = total === 0;
    },
    getQuery(): string {
      return findInput.value;
    },
    focusFind(): void {
      findInput.focus();
      findInput.select();
    },
  };
  return panel;
}
