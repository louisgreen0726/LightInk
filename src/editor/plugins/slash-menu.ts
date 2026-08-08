/**
 * `slash-menu` — 行首斜杠快速插入菜单（R11），`$prose` 插件。
 *
 * 设计（02-technical-solution.md R11）：行首输入 `/` 后弹出可搜索浮动菜单，元素集合与
 * R2「插入」菜单同源（复用 `insert-commands.ts` 的 `INSERT_ELEMENTS`）；键入关键词过滤，
 * 回车在光标处插入标题/列表/表格/代码块/公式/流程图/图片/链接；Esc 退出且删除 `/query`
 * 不留残字符。
 *
 * 实现要点：
 *   - 菜单开闭与 query **派生自文档+选区**（apply 从 tr 重算）：当前行光标前文本形如
 *     `/query`（行首 `/` + 无空格 query）即开；否则关。键入自然驱动 query，移动光标或
 *     键入空格自然关闭，无需手工同步。selectedIndex 为 UI 态（query 变化归零，方向键调整）。
 *   - 菜单为 `Decoration.widget`（PM 文本流外的浮层），位于 `/` 处。
 *   - 回车/点击用 `replaceRange(snippet, {from: slashPos, to: head})(ctx)` 把 `/query` 替换为
 *     解析后的元素；Esc 用 `tr.deleteRange` 删除 `/query`（不留残字符）。
 *   - decorations 只拿到 state，故经插件 `view` 生命周期捕获 EditorView 供 widget 点击使用。
 *
 * 纯逻辑 `parseSlashQuery`（行首 `/query` 识别）与 `nextIndex`（菜单环形选择）headless 可测；
 * Decoration/键位/ctx 装配属编辑器集成面（同既有插件，仅断言工厂形态）。
 */

import { $prose, replaceRange } from '@milkdown/utils';
import type { Ctx } from '@milkdown/ctx';
import { Plugin, PluginKey, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { EditorView } from '@milkdown/prose/view';

import { filterInsertElements, type InsertElementId } from '../insert-commands.js';

const PLUGIN_KEY = new PluginKey<SlashState>('lightink-slash-menu');

export interface SlashQuery {
  readonly query: string;
}

/**
 * 纯逻辑：给定光标所在行「行首→光标」的文本，判定是否为斜杠触发。
 * 形如 `/query`（行首一个 `/` + 不含空格的 query）返回 {query}；否则 null。
 */
export function parseSlashQuery(linePrefix: string): SlashQuery | null {
  const match = /^\/(\S*)$/.exec(linePrefix);
  if (match === null) return null;
  return { query: match[1] };
}

/** 纯逻辑：菜单环形选择（上下），length<=0 时恒为 0。 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  return ((next % length) + length) % length;
}

interface SlashState {
  readonly open: boolean;
  readonly slashPos: number;
  readonly query: string;
  readonly selectedIndex: number;
}

const CLOSED: SlashState = { open: false, slashPos: -1, query: '', selectedIndex: 0 };

interface SelectMeta {
  readonly delta?: number;
}

/** apply 上下文：从 transaction（doc + selection + meta）派生斜杠菜单状态。 */
function computeState(tr: Transaction, prev: SlashState): SlashState {
  const { $from } = tr.selection;
  const lineStart = $from.start();
  const linePrefix = tr.doc.textBetween(lineStart, $from.pos, '\n');
  const parsed = parseSlashQuery(linePrefix);
  if (parsed === null) return CLOSED;
  let selectedIndex = parsed.query === prev.query ? prev.selectedIndex : 0;
  const meta = tr.getMeta(PLUGIN_KEY) as SelectMeta | undefined;
  if (meta !== undefined && typeof meta.delta === 'number') {
    selectedIndex = nextIndex(selectedIndex, meta.delta, filterInsertElements(parsed.query).length);
  }
  return { open: true, slashPos: lineStart, query: parsed.query, selectedIndex };
}

/** 把 `/query` 替换为元素解析内容（回车 / 点击菜单项共用）。 */
function insertElement(view: EditorView, ctx: Ctx, id: InsertElementId): void {
  const state = PLUGIN_KEY.getState(view.state);
  if (state === undefined || !state.open) return;
  const element = filterInsertElements(state.query).find((e) => e.id === id);
  if (element === undefined) return;
  try {
    replaceRange(element.snippet(), { from: state.slashPos, to: view.state.selection.head })(ctx);
    view.focus();
  } catch {
    // 解析失败：静默（保留 /query）。
  }
}

/** 创建菜单 widget DOM（filtered 元素列表，高亮 selectedIndex）。仅挂载态调用。 */
function createMenuWidget(state: SlashState, view: EditorView, ctx: Ctx): HTMLElement {
  const list = filterInsertElements(state.query);
  const el = document.createElement('div');
  el.className = 'lightink-slash-menu';
  el.setAttribute('role', 'listbox');
  el.style.position = 'absolute';
  el.style.zIndex = '1000';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lightink-slash-menu__empty';
    empty.textContent = '无匹配项';
    el.appendChild(empty);
    return el;
  }
  list.forEach((element, index) => {
    const item = document.createElement('div');
    item.className = 'lightink-slash-menu__item';
    if (index === state.selectedIndex) {
      item.className += ' lightink-slash-menu__item--active';
      item.setAttribute('aria-selected', 'true');
    }
    item.setAttribute('role', 'option');
    item.textContent = element.label;
    // mousedown preventDefault 防止点击菜单项抢走编辑器焦点；click 执行插入。
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => insertElement(view, ctx, element.id));
    el.appendChild(item);
  });
  return el;
}

export const slashMenuPlugin = $prose((ctx: Ctx) => {
  // decorations(state) 无 view 入参，经 view 生命周期捕获。
  let editorView: EditorView | null = null;
  return new Plugin<SlashState>({
    key: PLUGIN_KEY,
    state: {
      init: () => CLOSED,
      apply: (tr, prev) => computeState(tr, prev),
    },
    props: {
      decorations(state) {
        const slash = PLUGIN_KEY.getState(state);
        if (slash === undefined || !slash.open || editorView === null) {
          return DecorationSet.empty;
        }
        const view = editorView;
        const widget = Decoration.widget(
          slash.slashPos,
          () => createMenuWidget(slash, view, ctx),
          { side: -1, key: `lightink-slash-${slash.query}-${slash.selectedIndex}` },
        );
        return DecorationSet.create(state.doc, [widget]);
      },
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        const slash = PLUGIN_KEY.getState(view.state);
        if (slash === undefined || !slash.open) return false;
        if (event.key === 'Escape') {
          // 删除 `/query`，不留残字符。
          view.dispatch(view.state.tr.deleteRange(slash.slashPos, view.state.selection.head));
          event.preventDefault();
          return true;
        }
        if (event.key === 'Enter') {
          const element = filterInsertElements(slash.query)[slash.selectedIndex];
          if (element !== undefined) {
            insertElement(view, ctx, element.id);
          }
          event.preventDefault();
          return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          view.dispatch(view.state.tr.setMeta(PLUGIN_KEY, { delta: event.key === 'ArrowDown' ? 1 : -1 }));
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    view(view: EditorView) {
      editorView = view;
      return {
        update() {
          // 状态派生自 doc/selection，无需在此处理。
        },
        destroy() {
          editorView = null;
        },
      };
    },
  });
});
