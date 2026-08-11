/** Document persistence, position, encoding, and word statistics status bar. */

import { computeWordStats, type WordStats } from '../editor/word-stats.js';
import type { CursorPosition } from '../editor/types.js';
import type { DocumentSaveStatus } from '../tabs/types.js';
import type { StorageLike } from './chrome-prefs.js';

export const STATUS_BAR_VISIBLE_STORAGE_KEY = 'lightink.statusBar.visible';

const DEFAULT_VISIBLE = true;
const DEFAULT_DEBOUNCE_MS = 120;

export function loadStatusBarVisible(storage: StorageLike | null | undefined): boolean {
  if (storage == null) return DEFAULT_VISIBLE;
  try {
    const raw = storage.getItem(STATUS_BAR_VISIBLE_STORAGE_KEY);
    if (raw === null || raw === '') return DEFAULT_VISIBLE;
    return JSON.parse(raw) === true;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

export function saveStatusBarVisible(
  storage: StorageLike | null | undefined,
  visible: boolean,
): void {
  if (storage == null) return;
  try {
    storage.setItem(STATUS_BAR_VISIBLE_STORAGE_KEY, JSON.stringify(visible === true));
  } catch {
    // Privacy mode or quota failures must not affect editing.
  }
}

export interface StatusBarLabels {
  words: string;
  characters: string;
  line: string;
  column: string;
  encoding: string;
  save: Readonly<Record<DocumentSaveStatus, string>>;
}

export interface MarkdownStatusSnapshot {
  readonly kind: 'markdown';
  readonly markdown: string;
  readonly saveStatus: DocumentSaveStatus;
  readonly cursor: CursorPosition;
}

export type StatusBarSnapshot = MarkdownStatusSnapshot | null;

export function formatWordStats(stats: WordStats, labels: StatusBarLabels): string {
  return `${labels.words} ${formatCount(stats.words)} · ${labels.characters} ${formatCount(stats.characters)}`;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Convert a UTF-16 textarea offset to a one-based Unicode code-point position. */
export function cursorPositionFromOffset(text: string, offset: number): CursorPosition {
  const safeOffset = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const lines = text.slice(0, safeOffset).split(/\r\n?|\n/);
  return {
    line: lines.length,
    column: Array.from(lines[lines.length - 1] ?? '').length + 1,
  };
}

export interface StatusBarOptions {
  storage?: StorageLike | null;
  labels: () => StatusBarLabels;
  debounceMs?: number;
  initiallyVisible?: boolean;
}

export interface StatusBar {
  readonly element: HTMLDivElement;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  toggle(): boolean;
  refresh(getSnapshot: () => StatusBarSnapshot): void;
  scheduleUpdate(getSnapshot: () => StatusBarSnapshot): void;
  destroy(): void;
}

function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Privacy mode.
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
  let lastGetter: (() => StatusBarSnapshot) | null = null;

  const element = doc.createElement('div') as HTMLDivElement;
  element.id = 'lightink-status-bar';
  element.className = 'lightink-status-bar';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');

  const persistence = doc.createElement('span') as HTMLSpanElement;
  persistence.className = 'lightink-status-save';
  const details = doc.createElement('span') as HTMLSpanElement;
  details.className = 'lightink-status-details';
  const position = doc.createElement('span') as HTMLSpanElement;
  position.className = 'lightink-status-position';
  const encoding = doc.createElement('span') as HTMLSpanElement;
  encoding.className = 'lightink-status-encoding';
  const counts = doc.createElement('span') as HTMLSpanElement;
  counts.className = 'lightink-status-counts';
  details.append(position, encoding, counts);
  element.append(persistence, details);

  function applyVisibility(): void {
    if (visible) {
      if (element.parentNode !== host) host.appendChild(element);
    } else {
      element.remove();
    }
  }

  function render(getter: () => StatusBarSnapshot): void {
    lastGetter = getter;
    if (!visible) return;
    let snapshot: StatusBarSnapshot = null;
    try {
      snapshot = getter();
    } catch {
      snapshot = null;
    }
    if (snapshot === null) {
      element.hidden = true;
      delete element.dataset.saveStatus;
      return;
    }

    const labels = options.labels();
    element.hidden = false;
    element.dataset.statusKind = snapshot.kind;
    element.dataset.saveStatus = snapshot.saveStatus;
    persistence.textContent = labels.save[snapshot.saveStatus];
    position.textContent = `${labels.line} ${snapshot.cursor.line}, ${labels.column} ${snapshot.cursor.column}`;
    encoding.textContent = labels.encoding;
    counts.textContent = formatWordStats(computeWordStats(snapshot.markdown), labels);
  }

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  applyVisibility();

  function setVisible(next: boolean): void {
    visible = next;
    saveStatusBarVisible(storage, visible);
    applyVisibility();
    if (visible && lastGetter !== null) render(lastGetter);
  }

  return {
    element,
    isVisible: () => visible,
    setVisible,
    toggle() {
      setVisible(!visible);
      return visible;
    },
    refresh: render,
    scheduleUpdate(getter) {
      lastGetter = getter;
      if (!visible) return;
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
