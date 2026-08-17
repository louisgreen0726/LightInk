// @vitest-environment jsdom
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
import { afterEach, describe, expect, it } from 'vitest';

import { createFlowRenderer, type FlowRendererHooks } from '../flow-renderer.js';
import { sessionRemoteImagePolicy } from '../../media/remote-image-policy.js';

import {
  applyReadingLayout,
  READING_LAYOUT_STORAGE_KEY,
  saveReadingLayout,
} from '../../ui/reading-layout.js';
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
  afterEach(() => {
    delete document.documentElement.dataset.readingLayout;
    delete document.documentElement.dataset.workspaceMode;
    document.documentElement.classList.remove('is-paginated');
  });

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
    expect(root.dataset.workspaceMode).toBe('reader');
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
    expect(root.dataset.workspaceMode).toBe('editor');
    expect(root.classNames.has('is-paginated')).toBe(false);
    applyReaderDocumentLayout(root, 'editor', 'scroll', 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(store[READER_FLOW_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(loadReaderLayout(storage)).toBe('paginated');
  });

  it('keeps the reader key on the document host when the editor applier runs', () => {
    applyReaderDocumentLayout(document.documentElement, 'reader', 'paginated', 'scroll');
    expect(document.documentElement.dataset.readingLayout).toBe('paginated');
    applyReadingLayout(document.documentElement, 'scroll');
    expect(document.documentElement.dataset.readingLayout).toBe('paginated');
    expect(document.documentElement.classList.contains('is-paginated')).toBe(true);
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

const flowRendererHooks = (
  overrides: Partial<FlowRendererHooks> = {},
): FlowRendererHooks => ({
  t: (key) => key,
  remoteImagePolicy: sessionRemoteImagePolicy,
  syncState: () => undefined,
  applyPendingRestore: () => undefined,
  renderHighlights: () => undefined,
  handleNoteMarkClick: () => false,
  onSelectionMouseUp: () => undefined,
  openSearch: () => undefined,
  advanceReading: () => false,
  advancePagedWheel: () => false,
  dismissSelectionToolbar: () => false,
  isLayoutSwitching: () => false,
  scrollContainer: () => document.body,
  ...overrides,
});

describe('flow host wheel', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    delete document.documentElement.dataset.workspaceMode;
  });

  function mountFlowRoot(): { root: HTMLElement; scrollHost: HTMLElement } {
    const shell = document.createElement('div');
    shell.dataset.workspaceMode = 'reader';
    shell.dataset.workspaceSurface = 'reader';
    const root = document.createElement('div');
    root.className = 'lightink-reader';
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    shell.appendChild(root);
    document.body.appendChild(shell);
    return { root, scrollHost };
  }

  it('delegates to advancePagedWheel and preventDefault only when a page moved', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(dirs).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
    renderer.clear();
  });

  it('does not preventDefault when the active flow cannot turn a page', () => {
    const { root, scrollHost } = mountFlowRoot();
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({ advancePagedWheel: () => false }),
    );
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    renderer.clear();
  });

  it('ignores a hidden inactive-tab flow host', () => {
    const { root, scrollHost } = mountFlowRoot();
    root.parentElement!.style.display = 'none';
    let called = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          called += 1;
          return true;
        },
      }),
    );
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(called).toBe(0);
    renderer.clear();
  });

  it('does not page a PDF or comic host', () => {
    const { root, scrollHost } = mountFlowRoot();
    const pages = document.createElement('div');
    pages.className = 'lightink-reader-pages';
    pages.dataset.readerActive = 'true';
    root.appendChild(pages);
    let called = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          called += 1;
          return true;
        },
      }),
    );
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(called).toBe(0);
    renderer.clear();
  });

  it('removes the document wheel listener on clear', () => {
    const { root, scrollHost } = mountFlowRoot();
    let called = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          called += 1;
          return true;
        },
      }),
    );
    renderer.clear();
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(called).toBe(0);
  });
});
