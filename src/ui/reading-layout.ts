/**
 * Scroll vs paginated reading layout. Shared by Markdown and flow/PDF readers.
 *
 * Paginated mode follows Readium/Thorium: constrain height to the viewport and
 * fill CSS columns sequentially (column-fill: auto). Scroll mode is a single
 * continuous column. Preference persists in localStorage.
 */

export const READING_LAYOUT_STORAGE_KEY = 'lightink.reading.layout';

export type ReadingLayout = 'scroll' | 'paginated';

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseReadingLayout(raw: string | null | undefined): ReadingLayout {
  return raw === 'paginated' ? 'paginated' : 'scroll';
}

export function loadReadingLayout(storage: LayoutStorage | null | undefined): ReadingLayout {
  if (storage == null) {
    return 'scroll';
  }
  try {
    return parseReadingLayout(storage.getItem(READING_LAYOUT_STORAGE_KEY));
  } catch {
    return 'scroll';
  }
}

export function saveReadingLayout(
  storage: LayoutStorage | null | undefined,
  layout: ReadingLayout,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(READING_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Privacy mode / quota — ignore.
  }
}

export function applyReadingLayout(
  root: { dataset: DOMStringMap; classList: DOMTokenList },
  layout: ReadingLayout,
): void {
  root.dataset.readingLayout = layout;
  root.classList.toggle('is-paginated', layout === 'paginated');
}

export function toggleReadingLayout(layout: ReadingLayout): ReadingLayout {
  return layout === 'paginated' ? 'scroll' : 'paginated';
}

/**
 * Paginated columns follow Readium/Thorium + WCAG 1.4.8:
 * open a second column only when each can hold a comfortable measure
 * (~32em CJK / ~55ch Latin). Never more than two facing pages.
 */
export function readingColumnLayout(
  containerWidth: number,
  fontSizePx: number,
  options?: { minRem?: number; optRem?: number; maxColumns?: number; gapPx?: number },
): { columnWidth: number; columns: number; gap: number } {
  const minRem = options?.minRem ?? 22;
  const gap = options?.gapPx ?? 24;
  const maxColumns = options?.maxColumns ?? 2;
  const width = Math.max(1, containerWidth);
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 16;
  const minColumn = minRem * size;
  const columns = Math.max(
    1,
    Math.min(maxColumns, Math.floor((width + gap) / (minColumn + gap))),
  );
  if (columns === 1) {
    return { columnWidth: width, columns: 1, gap: 0 };
  }
  const columnWidth = Math.max(1, (width - (columns - 1) * gap) / columns);
  return { columnWidth, columns, gap };
}

export function pageStepSize(scroller: { clientWidth: number; clientHeight: number }): {
  x: number;
  y: number;
} {
  return {
    x: Math.max(1, scroller.clientWidth),
    y: Math.max(1, scroller.clientHeight),
  };
}

export function pagedScrollMax(scroller: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): number {
  return Math.max(0, scroller.scrollWidth - scroller.clientWidth);
}

export function pagedProgressRatio(scroller: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): number {
  const max = pagedScrollMax(scroller);
  return max === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollLeft / max));
}

/** One visual page: viewport plus the gap after the last visible column (Readium). */
export function pagedColumnStep(viewportWidth: number, gapPx = 0): number {
  return Math.max(1, viewportWidth + Math.max(0, gapPx));
}

/**
 * Integer-aligned facing-page metrics. Shrinking the used width by a few
 * pixels keeps `columns * columnWidth + (columns - 1) * gap === width`,
 * so a page step cannot land inside the next column.
 */
export function pagedSpreadMetrics(
  containerWidth: number,
  fontSizePx: number,
): { width: number; columnWidth: number; columns: number; gap: number; step: number } {
  const layout = readingColumnLayout(containerWidth, fontSizePx);
  const columns = layout.columns;
  const gap = columns === 1 ? 0 : layout.gap;
  const columnWidth = Math.max(
    1,
    Math.floor((Math.max(1, containerWidth) - (columns - 1) * gap) / columns),
  );
  const width = columnWidth * columns + (columns - 1) * gap;
  return { width, columnWidth, columns, gap, step: pagedColumnStep(width, gap) };
}

export function applyPagedProgress(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  ratio: number,
  stepSize?: number,
): void {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const max = pagedScrollMax(scroller);
  if (max <= 0 || safe <= 0) {
    scroller.scrollLeft = 0;
    return;
  }
  if (safe >= 1) {
    scroller.scrollLeft = max;
    return;
  }
  const step = Math.max(1, stepSize ?? scroller.clientWidth);
  scroller.scrollLeft = Math.min(max, Math.max(0, Math.round((max * safe) / step) * step));
}

/** After a resize, land on a whole page instead of a leftover sliver. */
export function snapPagedScroller(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  stepSize?: number,
): void {
  const step = Math.max(1, stepSize ?? scroller.clientWidth);
  const max = pagedScrollMax(scroller);
  if (max <= 0) {
    scroller.scrollLeft = 0;
    return;
  }
  const page = Math.round(scroller.scrollLeft / step);
  scroller.scrollLeft = Math.min(max, Math.max(0, page * step));
}

export function advancePagedScroller(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  direction: 1 | -1,
  stepSize?: number,
): boolean {
  const step = Math.max(1, stepSize ?? scroller.clientWidth);
  const max = pagedScrollMax(scroller);
  if (max <= 0) {
    return false;
  }
  const remaining = direction > 0 ? max - scroller.scrollLeft : scroller.scrollLeft;
  // Leftover column slivers should not trap paging inside the chapter.
  if (remaining <= Math.max(8, step * 0.08)) {
    return false;
  }
  const next = Math.min(max, Math.max(0, scroller.scrollLeft + direction * step));
  if (next === scroller.scrollLeft) {
    return false;
  }
  scroller.scrollLeft = next;
  return true;
}

export function advanceScrolledScroller(
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  direction: 1 | -1,
): boolean {
  const step = Math.max(1, scroller.clientHeight);
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const next = Math.min(max, Math.max(0, scroller.scrollTop + direction * step));
  if (next === scroller.scrollTop) {
    return false;
  }
  scroller.scrollTop = next;
  return true;
}

export function isReadingNavKey(key: string): boolean {
  return (
    key === ' ' ||
    key === 'Spacebar' ||
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'PageDown' ||
    key === 'PageUp'
  );
}

export function readingNavDirection(key: string, shiftKey = false): 1 | -1 | null {
  if (key === ' ' || key === 'Spacebar') {
    return shiftKey ? -1 : 1;
  }
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') {
    return 1;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') {
    return -1;
  }
  return null;
}

/** Wait until window/pane resize bursts settle, then refresh the reading view. */
export function createResizeSettle(delayMs = 180): (run: () => void) => () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (run) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  };
}

/** Trackpad bursts should turn one page, not skip several. */
export function createPagedWheelGate(minIntervalMs = 160): (
  direction: 1 | -1,
  advance: (direction: 1 | -1) => boolean,
) => boolean {
  let lastAt = 0;
  return (direction, advance) => {
    const now = Date.now();
    if (now - lastAt < minIntervalMs) {
      return false;
    }
    const moved = advance(direction);
    if (moved) {
      lastAt = now;
    }
    return moved;
  };
}
