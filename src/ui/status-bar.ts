/**
 * `status-bar` — R3 字数/字符状态栏。
 *
 * 挂载于 shell 根部（app-shell 暴露的 `statusBarHost`），由 main.ts 在
 * `TabManagerDeps.onActiveContentChanged` 回调里 `scheduleUpdate` 防抖驱动；
 * 显隐偏好经 localStorage（克隆 chrome-prefs 模式）跨会话保持，
 * 关闭即从 DOM 移除不渲染。单栏沉浸外壳不变（R1）——状态栏只是根部一行。
 *
 * 样式说明：本任务 scope 不含 theme.css，此处用最小内联样式（muted 小字、
 * 右对齐），后续主题化时再迁入样式表。
 */

import { computeWordStats, type WordStats } from '../editor/word-stats.js';
import type { StorageLike } from './chrome-prefs.js';

export const STATUS_BAR_VISIBLE_STORAGE_KEY = 'lightink.statusBar.visible';

/** 首启默认：沉浸外壳优先，状态栏默认关闭，用户经视图菜单打开。 */
const DEFAULT_VISIBLE = false;

const DEFAULT_DEBOUNCE_MS = 300;

/** Load visibility pref; missing key / corrupt value falls back to default. */
export function loadStatusBarVisible(storage: StorageLike | null | undefined): boolean {
  if (storage == null) {
    return DEFAULT_VISIBLE;
  }
  try {
    const raw = storage.getItem(STATUS_BAR_VISIBLE_STORAGE_KEY);
    if (raw === null || raw === '') {
      return DEFAULT_VISIBLE;
    }
    return JSON.parse(raw) === true;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

/** Persist visibility pref (best-effort). */
export function saveStatusBarVisible(
  storage: StorageLike | null | undefined,
  visible: boolean,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(STATUS_BAR_VISIBLE_STORAGE_KEY, JSON.stringify(visible === true));
  } catch {
    // Privacy mode / quota — ignore.
  }
}

export interface StatusBarLabels {
  /** 「字数」标签（如 zh: 字数 / en: Words）。 */
  words: string;
  /** 「字符」标签（如 zh: 字符 / en: Characters）。 */
  characters: string;
}

/** 状态栏文案：自带口径说明（字数 = 中文字符+西文词；字符 = 非空白字符）。 */
export function formatWordStats(stats: WordStats, labels: StatusBarLabels): string {
  return `${labels.words} ${formatCount(stats.words)} · ${labels.characters} ${formatCount(stats.characters)}`;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export interface StatusBarOptions {
  /** Optional storage (default: localStorage when available). Pass null to disable persistence. */
  storage?: StorageLike | null;
  /** Locale-aware labels, re-evaluated on each render. */
  labels: () => StatusBarLabels;
  /** Debounce interval for scheduleUpdate (default 300ms). */
  debounceMs?: number;
  /** Initial visibility override (tests); otherwise loaded from storage. */
  initiallyVisible?: boolean;
}

export interface StatusBar {
  /** 状态栏元素（可见时挂在 host 下，不可见时从 DOM 移除）。 */
  readonly element: HTMLDivElement;
  isVisible(): boolean;
  /** 设置显隐并持久化；变为可见时用最近一次的内容来源立即重绘。 */
  setVisible(visible: boolean): void;
  /** 切换显隐；返回切换后的可见性。 */
  toggle(): boolean;
  /** 立即按 getMarkdown 的最新内容重绘（不可见时仅记录来源，不渲染）。 */
  refresh(getMarkdown: () => string | null): void;
  /** 防抖重绘（编辑路径；窗口内多次调用只渲染最后一次）。 */
  scheduleUpdate(getMarkdown: () => string | null): void;
  /** 清计时器并移除元素。 */
  destroy(): void;
}

function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    /* privacy mode */
  }
  return null;
}

export function createStatusBar(
  doc: Pick<Document, 'createElement'>,
  host: HTMLElement,
  options: StatusBarOptions,
): StatusBar {
  const storage = resolveStorage(options.storage);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let visible = options.initiallyVisible ?? loadStatusBarVisible(storage);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastGetter: (() => string | null) | null = null;

  const element = doc.createElement('div') as HTMLDivElement;
  element.id = 'lightink-status-bar';
  element.className = 'lightink-status-bar';
  element.setAttribute('role', 'status');
  // Minimal inline styling (theme.css 不在本任务 scope)：muted 小字右对齐。
  element.style.padding = '2px 12px';
  element.style.fontSize = '12px';
  element.style.textAlign = 'right';
  element.style.userSelect = 'none';
  element.style.opacity = '0.65';
  element.style.flex = 'none';

  function applyVisibility(): void {
    if (visible) {
      if (element.parentNode !== host) {
        host.appendChild(element);
      }
    } else {
      element.remove();
    }
  }

  function render(getter: () => string | null): void {
    lastGetter = getter;
    if (!visible) {
      return;
    }
    let markdown: string | null = null;
    try {
      markdown = getter();
    } catch {
      markdown = null;
    }
    element.textContent = formatWordStats(computeWordStats(markdown ?? ''), options.labels());
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  applyVisibility();

  function setVisible(next: boolean): void {
    visible = next;
    saveStatusBarVisible(storage, visible);
    applyVisibility();
    // 重新打开时立即以当前文档重绘，不等下次编辑。
    if (visible && lastGetter !== null) {
      render(lastGetter);
    }
  }

  return {
    element,
    isVisible: () => visible,
    setVisible,
    toggle() {
      const next = !visible;
      setVisible(next);
      return next;
    },
    refresh: render,
    scheduleUpdate(getter: () => string | null) {
      lastGetter = getter;
      if (!visible) {
        return;
      }
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        render(getter);
      }, debounceMs);
    },
    destroy() {
      cancelTimer();
      element.remove();
    },
  };
}
