import { describe, expect, it, vi } from 'vitest';

import {
  advancePagedScroller,
  applyPagedProgress,
  applyReadingLayout,
  createPagedWheelGate,
  createResizeSettle,
  isReadingNavKey,
  loadReadingLayout,
  pagedColumnStep,
  pagedProgressRatio,
  pagedSpreadMetrics,
  parseReadingLayout,
  READING_LAYOUT_STORAGE_KEY,
  readingColumnLayout,
  readingNavDirection,
  saveReadingLayout,
  snapPagedScroller,
} from '../reading-layout.js';

describe('parseReadingLayout', () => {
  it('defaults to scroll and accepts paginated', () => {
    expect(parseReadingLayout(null)).toBe('scroll');
    expect(parseReadingLayout('paginated')).toBe('paginated');
    expect(parseReadingLayout('other')).toBe('scroll');
  });
});

describe('load/saveReadingLayout', () => {
  it('round-trips through storage', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    expect(loadReadingLayout(storage)).toBe('scroll');
    saveReadingLayout(storage, 'paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(loadReadingLayout(storage)).toBe('paginated');
  });
});

describe('paged navigation', () => {
  it('advances one viewport at a time and stops at the end', () => {
    const scroller = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1)).toBe(true);
    expect(scroller.scrollLeft).toBe(400);
    expect(advancePagedScroller(scroller, 1)).toBe(true);
    expect(scroller.scrollLeft).toBe(500);
    expect(advancePagedScroller(scroller, 1)).toBe(false);
  });

  it('leaves a leftover column sliver so the next chapter can open', () => {
    const scroller = { scrollLeft: 800, scrollWidth: 820, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1)).toBe(false);
  });

  it('accepts an explicit page step so multi-column turns include the gap', () => {
    const scroller = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1, 428)).toBe(true);
    expect(scroller.scrollLeft).toBe(428);
  });

  it('round-trips in-chapter page progress', () => {
    const scroller = { scrollLeft: 250, scrollWidth: 900, clientWidth: 400 };
    expect(pagedProgressRatio(scroller)).toBe(0.5);
    applyPagedProgress(scroller, 1);
    expect(scroller.scrollLeft).toBe(500);
  });

  it('snaps a leftover sliver back to a whole page', () => {
    const scroller = { scrollLeft: 430, scrollWidth: 1600, clientWidth: 800 };
    snapPagedScroller(scroller);
    expect(scroller.scrollLeft).toBe(800);
  });

  it('turns by viewport plus column gap so a third column does not leak in', () => {
    expect(pagedColumnStep(800, 32)).toBe(832);
    const scroller = { scrollLeft: 0, scrollWidth: 2496, clientWidth: 800 };
    expect(advancePagedScroller(scroller, 1, pagedColumnStep(800, 32))).toBe(true);
    expect(scroller.scrollLeft).toBe(832);
    snapPagedScroller(scroller, pagedColumnStep(800, 32));
    expect(scroller.scrollLeft).toBe(832);
  });

  it('aligns a facing spread so two columns plus gap equal the used width', () => {
    const spread = pagedSpreadMetrics(803, 16);
    expect(spread.columns).toBe(2);
    expect(spread.width).toBe(spread.columnWidth * 2 + spread.gap);
    expect(spread.step).toBe(spread.width + spread.gap);
    expect(spread.width).toBeLessThanOrEqual(803);
  });
});

describe('reading nav keys', () => {
  it('maps arrows, page keys and space to a direction', () => {
    expect(isReadingNavKey('ArrowUp')).toBe(true);
    expect(isReadingNavKey('ArrowDown')).toBe(true);
    expect(readingNavDirection('ArrowRight')).toBe(1);
    expect(readingNavDirection('ArrowDown')).toBe(1);
    expect(readingNavDirection('ArrowLeft')).toBe(-1);
    expect(readingNavDirection('ArrowUp')).toBe(-1);
    expect(readingNavDirection(' ', true)).toBe(-1);
  });

  it('coalesces paged wheel turns', () => {
    const gate = createPagedWheelGate(1_000);
    const advance = (direction: 1 | -1): boolean => direction === 1;
    expect(gate(1, advance)).toBe(true);
    expect(gate(1, advance)).toBe(false);
  });

  it('runs once after a resize burst settles', () => {
    vi.useFakeTimers();
    const settle = createResizeSettle(180);
    let count = 0;
    settle(() => {
      count += 1;
    });
    settle(() => {
      count += 1;
    });
    expect(count).toBe(0);
    vi.advanceTimersByTime(179);
    expect(count).toBe(0);
    vi.advanceTimersByTime(1);
    expect(count).toBe(1);
    vi.useRealTimers();
  });
});

describe('readingColumnLayout', () => {
  it('opens a second column on a typical desktop pane', () => {
    expect(readingColumnLayout(600, 16).columns).toBe(1);
    expect(readingColumnLayout(760, 16).columns).toBe(2);
    expect(readingColumnLayout(1400, 40).columns).toBe(1);
    expect(readingColumnLayout(2200, 16).columns).toBe(2);
  });
});

describe('applyReadingLayout', () => {
  it('stamps dataset and class on the root', () => {
    const classNames = new Set<string>();
    const root = {
      dataset: {} as DOMStringMap,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
    applyReadingLayout(root, 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(classNames.has('is-paginated')).toBe(true);
  });
});
