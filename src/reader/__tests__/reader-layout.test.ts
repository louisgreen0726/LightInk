/**
 * Reader flow layout is keyed separately from the editor Markdown layout.
 *
 * Contract for `src/reader/reader-layout.ts`:
 * - `READER_FLOW_LAYOUT_STORAGE_KEY` is `lightink.reader.flow.layout`
 * - default / missing / corrupt storage is `paginated`
 * - load/save never read or write `lightink.reading.layout`
 * - column math reuses `readingColumnLayout` with the stored measure
 * - paginated flow inline padding is narrower than the previous 0.7rem default
 * - PDF and comics do not use text dual-column
 */
import { describe, expect, it } from 'vitest';

import { READING_LAYOUT_STORAGE_KEY, saveReadingLayout } from '../../ui/reading-layout.js';
import {
  READER_FLOW_LAYOUT_STORAGE_KEY,
  READER_FLOW_PAGED_PADDING_X_REM,
  applyReaderDocumentLayout,
  applyReaderLayout,
  loadReaderLayout,
  parseReaderLayout,
  readerFlowColumnLayout,
  readerFlowSpreadFromTypography,
  readerFlowUsesTextColumns,
  saveReaderLayout,
} from '../reader-layout.js';
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';

function memoryStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
} {
  const store = { ...initial };
  return {
    store,
    storage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    },
  };
}

describe('parseReaderLayout', () => {
  it('defaults a long flowing book to paginated, not continuous scroll', () => {
    expect(parseReaderLayout(null)).toBe('paginated');
    expect(parseReaderLayout(undefined)).toBe('paginated');
    expect(parseReaderLayout('')).toBe('paginated');
    expect(parseReaderLayout('paginated')).toBe('paginated');
    expect(parseReaderLayout('scroll')).toBe('scroll');
    expect(parseReaderLayout('other')).toBe('paginated');
  });
});

describe('load/saveReaderLayout', () => {
  it('persists the reader flow key and does not rewrite the editor layout key', () => {
    const { store, storage } = memoryStorage();
    saveReadingLayout(storage, 'scroll');
    expect(loadReaderLayout(storage)).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');

    saveReaderLayout(storage, 'paginated');
    expect(store[READER_FLOW_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');
    expect(loadReaderLayout(storage)).toBe('paginated');

    saveReaderLayout(storage, 'scroll');
    expect(loadReaderLayout(storage)).toBe('scroll');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');
  });

  it('returns paginated when storage is missing, throws, or holds corrupt JSON', () => {
    expect(loadReaderLayout(null)).toBe('paginated');
    expect(loadReaderLayout(undefined)).toBe('paginated');
    expect(
      loadReaderLayout({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => undefined,
      }),
    ).toBe('paginated');
    expect(
      loadReaderLayout({
        getItem: () => '{',
        setItem: () => undefined,
      }),
    ).toBe('paginated');
  });

  it('ignores save failures and never writes the editor key', () => {
    const written: string[] = [];
    saveReaderLayout(
      {
        getItem: () => null,
        setItem: (key: string) => {
          written.push(key);
          throw new Error('quota');
        },
      },
      'scroll',
    );
    expect(written).toEqual([READER_FLOW_LAYOUT_STORAGE_KEY]);
  });
});

describe('applyReaderDocumentLayout', () => {
  function fakeRoot(): {
    dataset: DOMStringMap;
    classList: DOMTokenList;
    classNames: Set<string>;
  } {
    const classNames = new Set<string>();
    return {
      dataset: {} as DOMStringMap,
      classNames,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
  }

  it('mirrors the reader flow key onto the document host in reader workspace', () => {
    const root = fakeRoot();
    expect(applyReaderDocumentLayout(root, 'reader', 'paginated', 'scroll')).toBe('paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(root.classNames.has('is-paginated')).toBe(true);

    applyReaderDocumentLayout(root, 'reader', 'scroll', 'paginated');
    expect(root.dataset.readingLayout).toBe('scroll');
    expect(root.classNames.has('is-paginated')).toBe(false);
  });

  it('restores the editor layout when leaving reader workspace and does not write keys', () => {
    const root = fakeRoot();
    const { store, storage } = memoryStorage({
      [READING_LAYOUT_STORAGE_KEY]: 'paginated',
      [READER_FLOW_LAYOUT_STORAGE_KEY]: 'paginated',
    });
    applyReaderDocumentLayout(root, 'editor', 'paginated', 'scroll');
    expect(root.dataset.readingLayout).toBe('scroll');
    expect(root.classNames.has('is-paginated')).toBe(false);
    applyReaderDocumentLayout(root, 'editor', 'scroll', 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(store[READER_FLOW_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(loadReaderLayout(storage)).toBe('paginated');
  });
});

describe('applyReaderLayout', () => {
  it('stamps the flow root so the first screen can paginate independently of the editor', () => {
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
    applyReaderLayout(root, 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(classNames.has('is-paginated')).toBe(true);
    applyReaderLayout(root, 'scroll');
    expect(root.dataset.readingLayout).toBe('scroll');
    expect(classNames.has('is-paginated')).toBe(false);
  });
});

describe('readerFlowColumnLayout', () => {
  it('opens two columns in a 1200–1400 CSS-pixel pane at the default 22rem measure', () => {
    expect(readerFlowColumnLayout(1200, 16, 22).columns).toBe(2);
    expect(readerFlowColumnLayout(1300, 16, 22).columns).toBe(2);
    expect(readerFlowColumnLayout(1400, 16, 22).columns).toBe(2);
  });

  it('falls back to one column when the pane cannot hold a comfortable measure', () => {
    expect(readerFlowColumnLayout(700, 16, 22).columns).toBe(1);
    expect(readerFlowColumnLayout(1300, 16, 40).columns).toBe(1);
  });
});

describe('readerFlowUsesTextColumns', () => {
  it('keeps text dual-column on flow only; PDF and comics stay on their own engines', () => {
    expect(readerFlowUsesTextColumns('flow')).toBe(true);
    expect(readerFlowUsesTextColumns('pdf')).toBe(false);
    expect(readerFlowUsesTextColumns('comic')).toBe(false);
  });
});

describe('READER_FLOW_PAGED_PADDING_X_REM', () => {
  it('is narrower than the previous 0.7rem paginated flow gutter', () => {
    expect(READER_FLOW_PAGED_PADDING_X_REM).toBeLessThan(0.7);
    expect(READER_FLOW_PAGED_PADDING_X_REM).toBeGreaterThanOrEqual(0.35);
    expect(READER_FLOW_PAGED_PADDING_X_REM).toBeLessThanOrEqual(0.45);
  });
});

describe('readerFlowSpreadFromTypography', () => {
  it('reopens or closes the second column when the stored measure changes', () => {
    const comfortable = { ...DEFAULT_READER_TYPOGRAPHY, measureRem: 22 };
    const longer = { ...DEFAULT_READER_TYPOGRAPHY, measureRem: 32 };
    expect(readerFlowSpreadFromTypography(1000, 16, comfortable).columns).toBe(2);
    expect(readerFlowSpreadFromTypography(1000, 16, longer).columns).toBe(1);
  });
});
