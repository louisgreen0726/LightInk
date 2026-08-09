/**
 * `emoji-complete` — `:` 短码 emoji 自动补全（T3 / R7），`$prose` 插件。
 *
 * 设计（03-execution-plan.md T3）：行中输入 `:` + 至少 2 字符查询即弹出候选浮层，
 * 回车/Tab/点击把 `:query` 替换为对应 Unicode emoji 字符；Esc 取消且不动文档，
 * 相同触发文本保持关闭，继续输入（query 变化）后重开；无匹配不弹窗也不插入。
 *
 * 实现复用 slash-menu 模式：
 *   - 菜单开闭与 query **派生自文档+选区**（apply 从 tr 重算），无独立开关命令；
 *   - 菜单 portaled 到 `document.body`（position:fixed），复用 slash-menu 的
 *     定位（placeSlashMenu）、行高（slashMenuHeightForItems）、环形选择（nextIndex）
 *     与滚动跟随（scrollSlashItemIntoView）纯函数，DOM 复用 `lightink-slash-menu`
 *     样式类并叠加 `lightink-emoji-menu` 标识类；
 *   - emoji 数据来自 emojilib（MIT，纯数据 JSON），构建期一次性建索引。
 *
 * 纯逻辑 `parseEmojiTrigger` / `filterEmoji` / `buildEmojiCommitTr` 与插件状态
 * 推导（computeState 经 EMOJI_PLUGIN_KEY.getState 观察）headless 可测。
 */

import { $prose } from '@milkdown/utils';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import emojilib from 'emojilib';

import {
  nextIndex,
  placeSlashMenu,
  scrollSlashItemIntoView,
  slashMenuHeightForItems,
} from './slash-menu.js';

export const EMOJI_PLUGIN_KEY = new PluginKey<EmojiState>('lightink-emoji-complete');

/** 触发查询最短长度：`:s` 不弹窗，`:sm` 起才检索（T3 outcome）。 */
export const EMOJI_MIN_QUERY_LENGTH = 2;
/** 候选条数上限：emojilib 全集约 1900 条，过多候选无可读性。 */
export const EMOJI_MAX_RESULTS = 50;

export interface EmojiCandidate {
  /** Unicode emoji 字符（commit 时插入）。 */
  readonly char: string;
  /** 主名（emojilib 关键词表首项，如 `grinning_face`）。 */
  readonly name: string;
  /** 全部检索关键词。 */
  readonly keywords: readonly string[];
}

/** 构建期一次性索引：emoji 字符 → 关键词表。 */
const EMOJI_INDEX: readonly EmojiCandidate[] = Object.entries(emojilib).map(
  ([char, keywords]) => ({
    char,
    name: keywords[0] ?? char,
    keywords,
  }),
);

/**
 * 纯逻辑：按查询检索候选。主名前缀匹配优先，其次任意关键词前缀匹配，
 * 最后主名子串匹配；各组内保持数据集原序，结果截断到 limit。
 */
export function filterEmoji(query: string, limit = EMOJI_MAX_RESULTS): EmojiCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === '' || limit <= 0) return [];
  const namePrefix: EmojiCandidate[] = [];
  const keywordPrefix: EmojiCandidate[] = [];
  const nameSubstring: EmojiCandidate[] = [];
  for (const entry of EMOJI_INDEX) {
    if (entry.name.startsWith(q)) {
      namePrefix.push(entry);
    } else if (entry.keywords.some((keyword) => keyword.startsWith(q))) {
      keywordPrefix.push(entry);
    } else if (entry.name.includes(q)) {
      nameSubstring.push(entry);
    }
  }
  return [...namePrefix, ...keywordPrefix, ...nameSubstring].slice(0, limit);
}

export interface EmojiTrigger {
  readonly query: string;
}

/**
 * 纯逻辑：给定「行首→光标」文本，判定是否为 emoji 触发。
 * 形如 `…<边界>:query`：`:` 前不得是查询字符（ASCII 字母/数字/`_+-`），
 * 即行首、空白、中文等 CJK 字符或标点之后均可触发——中文写作不在字间敲
 * 空格，仅放行「行首/空白」会让中文用户永远触发不了（2026-08-09 用户实测
 * 反馈）。`foo:sm`（前贴英文字母）与 `12:30`（前贴数字）仍不触发。
 * query 无空白且长度 ≥ EMOJI_MIN_QUERY_LENGTH 时返回 {query}；否则 null。
 */
export function parseEmojiTrigger(linePrefix: string): EmojiTrigger | null {
  const match = /(?:^|[^A-Za-z0-9_+-]):([A-Za-z0-9_+-]{2,})$/.exec(linePrefix);
  if (match === null || match[1].length < EMOJI_MIN_QUERY_LENGTH) return null;
  return { query: match[1] };
}

export interface EmojiState {
  readonly open: boolean;
  /** `:` 字符的文档位置（commit 替换区间起点）。 */
  readonly colonPos: number;
  readonly query: string;
  readonly selectedIndex: number;
  /**
   * Esc 取消的触发文本（`:query`）：Esc 不删文本，只要触发文本不变就保持
   * 关闭，避免每次派生都重开；继续输入改变 query 即自动重开。
   */
  readonly cancelled: string | null;
}

const CLOSED: EmojiState = {
  open: false,
  colonPos: -1,
  query: '',
  selectedIndex: 0,
  cancelled: null,
};

interface EmojiMeta {
  readonly delta?: number;
  readonly cancel?: boolean;
}

/** apply 上下文：从 transaction（doc + selection + meta）派生 emoji 菜单状态。 */
function computeState(tr: Transaction, prev: EmojiState): EmojiState {
  const meta = tr.getMeta(EMOJI_PLUGIN_KEY) as EmojiMeta | undefined;
  if (meta?.cancel === true) {
    const cancelled = prev.open ? `:${prev.query}` : prev.cancelled;
    return { ...CLOSED, cancelled };
  }
  const { $from, empty } = tr.selection;
  if (!empty) return { ...CLOSED, cancelled: null };
  const lineStart = $from.start();
  const linePrefix = tr.doc.textBetween(lineStart, $from.pos, '\n');
  const parsed = parseEmojiTrigger(linePrefix);
  if (parsed === null) return { ...CLOSED, cancelled: null };
  if (`:${parsed.query}` === prev.cancelled) {
    return { ...CLOSED, cancelled: prev.cancelled };
  }
  // 无匹配不弹窗（T3 outcome）：候选为空即保持关闭，Enter/输入行为不受影响。
  const matches = filterEmoji(parsed.query);
  if (matches.length === 0) return { ...CLOSED, cancelled: null };
  let selectedIndex = parsed.query === prev.query ? prev.selectedIndex : 0;
  if (typeof meta?.delta === 'number') {
    selectedIndex = nextIndex(selectedIndex, meta.delta, matches.length);
  }
  return {
    open: true,
    colonPos: $from.pos - (parsed.query.length + 1),
    query: parsed.query,
    selectedIndex,
    cancelled: null,
  };
}

/**
 * 纯逻辑：构造把 `:query` 替换为 emoji 字符的事务（insertText 自动把光标
 * 放到插入字符之后）。菜单未打开、char 为空或区间越界时返回 null。
 */
export function buildEmojiCommitTr(
  state: EditorState,
  char: string,
): Transaction | null {
  const emoji = EMOJI_PLUGIN_KEY.getState(state);
  if (emoji === undefined || !emoji.open || char === '') return null;
  const from = emoji.colonPos;
  const to = state.selection.head;
  if (from < 0 || to < from || to > state.doc.content.size) return null;
  return state.tr.insertText(char, from, to);
}

/** 回车 / Tab / 点击共用：把 `:query` 替换为候选 emoji。 */
function commitEmoji(view: EditorView, candidate: EmojiCandidate): void {
  const tr = buildEmojiCommitTr(view.state, candidate.char);
  if (tr === null) return;
  view.dispatch(tr);
  view.focus();
}

/**
 * Build the portal menu DOM (not inserted into the ProseMirror document).
 * 复用 `lightink-slash-menu` 样式类，叠加 `lightink-emoji-menu` 标识类。
 */
function buildMenuElement(state: EmojiState, view: EditorView): HTMLElement {
  const list = filterEmoji(state.query);
  const el = document.createElement('div');
  el.className = 'lightink-slash-menu lightink-emoji-menu';
  el.setAttribute('role', 'listbox');
  el.setAttribute('data-lightink-emoji-menu', '');
  list.forEach((candidate, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lightink-slash-menu__item lightink-emoji-menu__item';
    if (index === state.selectedIndex) {
      item.className += ' lightink-slash-menu__item--active';
      item.setAttribute('aria-selected', 'true');
    }
    item.setAttribute('role', 'option');
    // 图标与文案分列：emoji 单字符放固定宽 glyph，避免与长 label 挤在一起被裁切。
    const glyph = document.createElement('span');
    glyph.className = 'lightink-emoji-menu__glyph';
    glyph.textContent = candidate.char;
    glyph.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'lightink-slash-menu__label lightink-emoji-menu__label';
    label.textContent = candidate.name.replace(/_/g, ' ');
    const hint = document.createElement('span');
    hint.className = 'lightink-slash-menu__hint lightink-emoji-menu__hint';
    hint.textContent = `:${candidate.name}:`;
    item.append(glyph, label, hint);
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => commitEmoji(view, candidate));
    el.appendChild(item);
  });
  return el;
}

function applySelectedIndex(menu: HTMLElement, selectedIndex: number): void {
  const items = menu.querySelectorAll<HTMLElement>('.lightink-emoji-menu__item');
  items.forEach((item, index) => {
    const active = index === selectedIndex;
    item.classList.toggle('lightink-slash-menu__item--active', active);
    if (active) {
      item.setAttribute('aria-selected', 'true');
      scrollSlashItemIntoView(menu, item);
    } else {
      item.removeAttribute('aria-selected');
    }
  });
}

/** 工厂导出：headless 测试可直接挂到 EditorState（无 EditorView 时不建 DOM）。 */
export function createEmojiCompletePlugin(): Plugin<EmojiState> {
  let editorView: EditorView | null = null;
  let menuEl: HTMLElement | null = null;
  /** Identity of the open list (not selection) — rebuild only when this changes. */
  let listKey = '';
  /** Last applied highlight index. */
  let lastSelected = -1;
  /** Last placed geometry so arrow keys do not re-layout. */
  let lastPlacementKey = '';
  /** Suppress recursive scroll sync while we adjust menu.scrollTop. */
  let ignoreScroll = false;

  const removeMenu = (): void => {
    if (menuEl !== null) {
      menuEl.remove();
      menuEl = null;
    }
    listKey = '';
    lastSelected = -1;
    lastPlacementKey = '';
  };

  const positionMenu = (
    view: EditorView,
    emoji: EmojiState,
    el: HTMLElement,
    force = false,
  ): void => {
    let coords: { left: number; top: number; bottom: number };
    try {
      coords = view.coordsAtPos(emoji.colonPos);
    } catch {
      coords = view.coordsAtPos(view.state.selection.from);
    }
    const placementKey = `${emoji.colonPos}|${Math.round(coords.left)}|${Math.round(coords.bottom)}|${window.innerWidth}x${window.innerHeight}`;
    if (!force && placementKey === lastPlacementKey) {
      return;
    }
    const itemCount = el.querySelectorAll('.lightink-emoji-menu__item').length;
    const naturalH =
      itemCount > 0
        ? slashMenuHeightForItems(itemCount)
        : slashMenuHeightForItems(1);
    const width = Math.max(el.offsetWidth || 0, 220);
    const placement = placeSlashMenu(
      { left: coords.left, top: coords.top, bottom: coords.bottom },
      { width, height: naturalH },
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.style.position = 'fixed';
    el.style.left = `${Math.round(placement.left)}px`;
    el.style.top = `${Math.round(placement.top)}px`;
    el.style.zIndex = '10050';
    el.style.maxHeight = `${placement.maxHeight}px`;
    el.style.overflowY = 'auto';
    el.dataset.flip = placement.flipUp ? 'up' : 'down';
    lastPlacementKey = placementKey;
  };

  const syncMenu = (view: EditorView, opts: { forcePlace?: boolean } = {}): void => {
    const emoji = EMOJI_PLUGIN_KEY.getState(view.state);
    if (emoji === undefined || !emoji.open) {
      removeMenu();
      return;
    }
    // Rebuild only when the filtered list changes — never on selectedIndex alone.
    const nextListKey = `${emoji.colonPos}|${emoji.query}`;
    if (menuEl === null || nextListKey !== listKey) {
      removeMenu();
      menuEl = buildMenuElement(emoji, view);
      document.body.appendChild(menuEl);
      listKey = nextListKey;
      lastSelected = -1;
      lastPlacementKey = '';
      positionMenu(view, emoji, menuEl, true);
      applySelectedIndex(menuEl, emoji.selectedIndex);
      lastSelected = emoji.selectedIndex;
      return;
    }
    if (opts.forcePlace) {
      positionMenu(view, emoji, menuEl, true);
    }
    if (emoji.selectedIndex !== lastSelected) {
      ignoreScroll = true;
      applySelectedIndex(menuEl, emoji.selectedIndex);
      lastSelected = emoji.selectedIndex;
      // Release on next frame so our own scrollTop write does not re-enter sync.
      requestAnimationFrame(() => {
        ignoreScroll = false;
      });
    }
  };

  return new Plugin<EmojiState>({
    key: EMOJI_PLUGIN_KEY,
    state: {
      init: () => CLOSED,
      apply: (tr, prev) => computeState(tr, prev),
    },
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        const emoji = EMOJI_PLUGIN_KEY.getState(view.state);
        if (emoji === undefined || !emoji.open) return false;
        if (event.key === 'Escape') {
          // 取消：不动文档（`:query` 保留，输入不受影响），仅记住触发文本。
          view.dispatch(view.state.tr.setMeta(EMOJI_PLUGIN_KEY, { cancel: true }));
          event.preventDefault();
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const candidate = filterEmoji(emoji.query)[emoji.selectedIndex];
          if (candidate !== undefined) {
            commitEmoji(view, candidate);
          }
          event.preventDefault();
          return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          view.dispatch(
            view.state.tr.setMeta(EMOJI_PLUGIN_KEY, {
              delta: event.key === 'ArrowDown' ? 1 : -1,
            }),
          );
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    view(view: EditorView) {
      editorView = view;
      const onScroll = (event: Event): void => {
        if (ignoreScroll || editorView === null) return;
        // Ignore scrolls that originate inside the menu itself.
        if (menuEl !== null && event.target instanceof Node && menuEl.contains(event.target)) {
          return;
        }
        // Editor/window scroll: only re-place, do not rebuild.
        syncMenu(editorView, { forcePlace: true });
      };
      const onResize = (): void => {
        if (editorView !== null) syncMenu(editorView, { forcePlace: true });
      };
      // Capture scroll from nested editor scroller (#lightink-editor-area).
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      // Initial sync in case the doc already has a `:query` trigger.
      queueMicrotask(() => {
        if (editorView !== null) syncMenu(editorView);
      });
      return {
        update(v) {
          editorView = v;
          syncMenu(v);
        },
        destroy() {
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
          removeMenu();
          editorView = null;
        },
      };
    },
  });
}

/** Milkdown 侧注册入口（src/editor/index.ts）。 */
export const emojiCompletePlugin = $prose(() => createEmojiCompletePlugin());
