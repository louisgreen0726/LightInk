/**
 * 大纲视图测试（node 环境，fake DOM 注入）：
 *   - 渲染：按 markdown 生成缩进层级条目、空态文案（无标签/无标题）；
 *   - 点击跳转：按序号锚点定位宿主中第 n 个 h1-h6 并 scrollIntoView；
 *   - 实时更新：scheduleRefresh 防抖合并、refreshNow 立即生效；
 *   - 三态：expanded → rail → hidden → expanded；
 *   - 与 TabManager 接线：切换标签/活动标签内容变化驱动大纲刷新，
 *     非活动标签内容变化不触发。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorInstance } from '../../editor/types.js';
import { TabManager, type TabManagerDeps } from '../../tabs/tab-manager.js';
import {
  clampOutlineWidth,
  createOutlineView,
  OUTLINE_WIDTH_DEFAULT,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  OUTLINE_WIDTH_STORAGE_KEY,
  readStoredOutlineWidth,
  writeStoredOutlineWidth,
  type OutlineView,
} from '../outline-view.js';

/** 最小 fake DOM 元素：只实现视图用到的子集。 */
class FakeElement {
  readonly tagName: string;
  textContent = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  /** 宿主 fake 专用：模拟渲染出的 h1-h6（querySelectorAll 返回）。 */
  headings: FakeElement[] = [];
  scrollIntoView = vi.fn();
  private readonly classes = new Set<string>();
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  dataset: Record<string, string> = {};
  readonly classList = {
    add: (...cs: string[]): void => {
      for (const c of cs) this.classes.add(c);
    },
    remove: (...cs: string[]): void => {
      for (const c of cs) this.classes.delete(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, force?: boolean): boolean => {
      const next = force === undefined ? !this.classes.has(c) : force;
      if (next) this.classes.add(c);
      else this.classes.delete(c);
      return next;
    },
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  appendChild<T extends FakeElement>(child: T): T {
    this.children.push(child);
    return child;
  }

  get firstChild(): FakeElement | undefined {
    return this.children[0];
  }

  insertBefore<T extends FakeElement>(child: T, ref: FakeElement | null): T {
    if (ref === null || !this.children.includes(ref)) {
      this.children.push(child);
    } else {
      this.children.splice(this.children.indexOf(ref), 0, child);
    }
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as () => void);
    this.listeners.set(type, list);
  }

  /** Test helper: fire a stored listener with an optional event payload. */
  emit(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) {
      (fn as (event: unknown) => void)(event);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) {
      fn();
    }
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return this.headings;
  }
}

function fakeDocument(): Document {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  return {
    createElement: (tag: string) => new FakeElement(tag),
    body: new FakeElement('body'),
    addEventListener(type: string, listener: (event: Event) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: (event: Event) => void): void {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((fn) => fn !== listener),
      );
    },
    /** Test helper: emit a document-level event to active listeners. */
    dispatchEvent(event: { type: string; clientX?: number; button?: number; preventDefault?: () => void }): boolean {
      for (const fn of listeners.get(event.type) ?? []) {
        fn(event as unknown as Event);
      }
      return true;
    },
  } as unknown as Document;
}

function rootOf(view: OutlineView): FakeElement {
  return view.root as unknown as FakeElement;
}

function headerOf(view: OutlineView): FakeElement {
  return rootOf(view).children[0] as FakeElement;
}

function bodyOf(view: OutlineView): FakeElement {
  // children: [header, body, resizeHandle]
  return rootOf(view).children[1] as FakeElement;
}

function resizeHandleOf(view: OutlineView): FakeElement {
  return rootOf(view).children[2] as FakeElement;
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    key() {
      return null;
    },
  } as Storage;
}

function itemTexts(view: OutlineView): string[] {
  return bodyOf(view).children.map((c) => c.textContent);
}

describe('createOutlineView 渲染', () => {
  it('无活动标签时显示空态', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => null,
    });
    expect(bodyOf(view).children[0]?.textContent).toBe('无活动标签');
    expect(bodyOf(view).children[0]?.classList.contains('lightink-outline-empty')).toBe(true);
    view.destroy();
  });

  it('无标题时显示空态', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '纯段落\n',
    });
    expect(bodyOf(view).children[0]?.textContent).toBe('暂无标题');
    view.destroy();
  });

  it('按层级渲染标题条目', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 一\n\n## 二\n\n### 三\n',
    });
    expect(itemTexts(view)).toEqual(['一', '二', '三']);
    expect(bodyOf(view).children[1].classList.contains('level-2')).toBe(true);
    view.destroy();
  });
});

describe('createOutlineView 折叠标记（T4/R2）', () => {
  it('注入 toggleFoldAtOrdinal 时渲染折叠标记，折叠序号标 is-folded', () => {
    const toggleFoldAtOrdinal = vi.fn();
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      // 同级标题：折叠「一」不影响「二」的可见性。
      getActiveMarkdown: () => '# 一\n\n# 二\n',
      toggleFoldAtOrdinal,
      getFoldedOrdinals: () => [0], // 第 0 个标题「一」已折叠
    });
    const items = bodyOf(view).children;
    const marker0 = items[0]?.firstChild as FakeElement;
    const marker1 = items[1]?.firstChild as FakeElement;
    expect(marker0?.classList.contains('lightink-outline-fold')).toBe(true);
    expect(marker0?.classList.contains('is-folded')).toBe(true);
    expect(marker1?.classList.contains('lightink-outline-fold')).toBe(true);
    expect(marker1?.classList.contains('is-folded')).toBe(false);
    view.destroy();
  });

  it('级联折叠：折叠条目的更深后代隐藏，同级/更高级保持可见', () => {
    const state = { folded: [0] };
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# A\n\n## A1\n\n### A1a\n\n# B\n\n## B1\n',
      toggleFoldAtOrdinal: (ordinal) => {
        state.folded = state.folded.includes(ordinal)
          ? state.folded.filter((o) => o !== ordinal)
          : [...state.folded, ordinal];
      },
      getFoldedOrdinals: () => state.folded,
    });
    // # A 折叠 → ## A1 与 ### A1a 级联隐藏；# B 与 ## B1 可见。
    expect(itemTexts(view)).toEqual(['A', 'B', 'B1']);
    // 展开 # A → 后代恢复可见。
    const marker0 = bodyOf(view).children[0]?.firstChild as FakeElement;
    marker0.emit('click', { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(itemTexts(view)).toEqual(['A', 'A1', 'A1a', 'B', 'B1']);
    view.destroy();
  });

  it('点击折叠标记触发 toggleFoldAtOrdinal(anchor) 且不跳转', () => {
    const toggleFoldAtOrdinal = vi.fn();
    const host = new FakeElement('div');
    host.headings = [new FakeElement('h1'), new FakeElement('h2')];
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => host as unknown as HTMLElement,
      getActiveMarkdown: () => '# 一\n\n## 二\n',
      toggleFoldAtOrdinal,
      getFoldedOrdinals: () => [],
    });
    const marker0 = bodyOf(view).children[0]?.firstChild as FakeElement;
    marker0.emit('click', { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(toggleFoldAtOrdinal).toHaveBeenCalledWith(0);
    // 标记点击 stopPropagation 不触发条目跳转。
    expect(host.headings[0]?.scrollIntoView).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe('createOutlineView 跳转', () => {
  it('点击条目滚动到对应标题', () => {
    const host = new FakeElement('div');
    const h1 = new FakeElement('h1');
    const h2 = new FakeElement('h2');
    host.headings = [h1, h2];
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => host as unknown as HTMLElement,
      getActiveMarkdown: () => '# A\n\n## B\n',
    });
    (bodyOf(view).children[1] as FakeElement).click();
    expect(h2.scrollIntoView).toHaveBeenCalled();
    view.destroy();
  });
});

describe('createOutlineView 刷新', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scheduleRefresh 防抖合并', () => {
    const state = { markdown: '# 旧\n' };
    const view = createOutlineView({
      doc: fakeDocument(),
      debounceMs: 100,
      getActiveHost: () => null,
      getActiveMarkdown: () => state.markdown,
    });
    state.markdown = '# 新\n';
    view.scheduleRefresh();
    view.scheduleRefresh();
    expect(itemTexts(view)).toEqual(['旧']);
    vi.advanceTimersByTime(100);
    expect(itemTexts(view)).toEqual(['新']);
    view.destroy();
  });

  it('refreshNow 立即生效', () => {
    const state = { markdown: '# 旧\n' };
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => state.markdown,
    });
    state.markdown = '# 新\n';
    view.refreshNow();
    expect(itemTexts(view)).toEqual(['新']);
    view.destroy();
  });
});

describe('outline width resize', () => {
  it('clampOutlineWidth bounds width', () => {
    expect(clampOutlineWidth(100)).toBe(OUTLINE_WIDTH_MIN);
    expect(clampOutlineWidth(9999)).toBe(OUTLINE_WIDTH_MAX);
    expect(clampOutlineWidth(240.7)).toBe(241);
    expect(clampOutlineWidth(Number.NaN)).toBe(OUTLINE_WIDTH_DEFAULT);
  });

  it('read/write storage round-trips clamped width', () => {
    const storage = memoryStorage();
    writeStoredOutlineWidth(storage, 300);
    expect(storage.getItem(OUTLINE_WIDTH_STORAGE_KEY)).toBe('300');
    expect(readStoredOutlineWidth(storage)).toBe(300);
    writeStoredOutlineWidth(storage, 50);
    expect(readStoredOutlineWidth(storage)).toBe(OUTLINE_WIDTH_MIN);
  });

  it('restores width from storage and exposes setWidth', () => {
    const storage = memoryStorage({ [OUTLINE_WIDTH_STORAGE_KEY]: '300' });
    const view = createOutlineView({
      doc: fakeDocument(),
      storage,
      getActiveHost: () => null,
      getActiveMarkdown: () => '# A\n',
    });
    expect(view.widthPx).toBe(300);
    expect(rootOf(view).style.width).toBe('300px');
    expect(resizeHandleOf(view).classList.contains('lightink-outline-resize')).toBe(true);

    view.setWidth(180);
    expect(view.widthPx).toBe(180);
    expect(storage.getItem(OUTLINE_WIDTH_STORAGE_KEY)).toBe('180');
    view.destroy();
  });

  it('hides resize handle in rail/hidden; restores width when expanded', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# A\n',
    });
    view.setWidth(260);
    expect(resizeHandleOf(view).style.display).not.toBe('none');

    view.setVisibility('rail');
    expect(resizeHandleOf(view).style.display).toBe('none');
    expect(rootOf(view).style.width).toBe('');

    view.setVisibility('expanded');
    expect(resizeHandleOf(view).style.display).not.toBe('none');
    expect(view.widthPx).toBe(260);
    expect(rootOf(view).style.width).toBe('260px');
    view.destroy();
  });

  it('drag handle pointer events update width and persist on release', () => {
    const storage = memoryStorage();
    const doc = fakeDocument() as Document & {
      dispatchEvent(event: { type: string; clientX?: number }): boolean;
    };
    const view = createOutlineView({
      doc,
      storage,
      getActiveHost: () => null,
      getActiveMarkdown: () => '# A\n',
    });
    expect(view.widthPx).toBe(OUTLINE_WIDTH_DEFAULT);

    // Start drag at x=100; move to x=140 → width +40.
    resizeHandleOf(view).emit('pointerdown', {
      button: 0,
      clientX: 100,
      preventDefault() {},
      stopPropagation() {},
    });
    expect(rootOf(view).classList.contains('is-resizing')).toBe(true);

    doc.dispatchEvent({ type: 'pointermove', clientX: 140 });
    expect(view.widthPx).toBe(OUTLINE_WIDTH_DEFAULT + 40);
    // Not persisted until pointerup.
    expect(storage.getItem(OUTLINE_WIDTH_STORAGE_KEY)).toBeNull();

    doc.dispatchEvent({ type: 'pointerup', clientX: 140 });
    expect(rootOf(view).classList.contains('is-resizing')).toBe(false);
    expect(storage.getItem(OUTLINE_WIDTH_STORAGE_KEY)).toBe(
      String(OUTLINE_WIDTH_DEFAULT + 40),
    );
    view.destroy();
  });
});

describe('createOutlineView 三态', () => {
  it('toggleCollapse 循环 expanded → rail → hidden → expanded', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题\n',
    });
    expect(view.visibility).toBe('expanded');
    expect(view.collapsed).toBe(false);

    view.toggleCollapse();
    expect(view.visibility).toBe('rail');
    expect(view.collapsed).toBe(true);
    expect(rootOf(view).classList.contains('is-rail')).toBe(true);
    expect(rootOf(view).classList.contains('collapsed')).toBe(true);

    view.toggleCollapse();
    expect(view.visibility).toBe('hidden');
    expect(rootOf(view).classList.contains('is-hidden')).toBe(true);

    view.toggleCollapse();
    expect(view.visibility).toBe('expanded');
    expect(view.collapsed).toBe(false);
    expect(rootOf(view).classList.contains('is-rail')).toBe(false);
    expect(rootOf(view).classList.contains('is-hidden')).toBe(false);
    view.destroy();
  });

  it('setVisibility / setCollapsed 显式设置', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题\n',
    });
    view.setVisibility('hidden');
    expect(view.visibility).toBe('hidden');
    view.setVisibility('hidden');
    expect(view.visibility).toBe('hidden');
    view.setCollapsed(true);
    expect(view.visibility).toBe('rail');
    view.setCollapsed(false);
    expect(view.visibility).toBe('expanded');
    view.destroy();
  });

  it('头部按钮：展开→窄条；窄条点击恢复展开', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题\n',
    });
    const toggle = headerOf(view).children[1] as FakeElement;
    expect(toggle.classList.contains('lightink-outline-toggle')).toBe(true);
    toggle.click();
    expect(view.visibility).toBe('rail');
    // Rail strip reopens the panel (does not jump to full hide).
    toggle.click();
    expect(view.visibility).toBe('expanded');
    // Full hide still reachable via toggleCollapse cycle (menu / hotkey).
    view.toggleCollapse(); // rail
    view.toggleCollapse(); // hidden
    expect(view.visibility).toBe('hidden');
    view.setVisibility('expanded');
    expect(view.visibility).toBe('expanded');
    view.destroy();
  });
});

describe('createOutlineView + TabManager', () => {
  function makeFakeEditor(initial: string): EditorInstance & { content: string } {
    const state = { content: initial };
    return {
      ready: Promise.resolve(),
      get content() {
        return state.content;
      },
      set content(md: string) {
        state.content = md;
      },
      setMarkdown(md: string) {
        state.content = md;
      },
      getMarkdown() {
        return state.content;
      },
      getSelection: () => null,
      getCursorPosition: () => null,
      getLinkAtCursor: () => null,
      getLinkAtPoint: () => null,
      toggleMark: () => undefined,
      setLink: () => undefined,
      insertImage: () => undefined,
      insertMarkdown: () => false,
      isInTable: () => false,
      runTableOp: () => false,
      focus: () => undefined,
      selectAll: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
      toggleFoldAtOrdinal: () => undefined,
      getFoldedOrdinals: () => [],
      destroy: vi.fn(async () => undefined),
    };
  }

  interface Harness {
    manager: TabManager;
    view: OutlineView;
    editors: Array<EditorInstance & { content: string }>;
  }

  function makeHarness(): Harness {
    const editors: Array<EditorInstance & { content: string }> = [];
    let view: OutlineView;
    const deps: TabManagerDeps = {
      mountEditor: (_container, options) => {
        const editor = makeFakeEditor(options.initialMarkdown ?? '');
        editors.push(editor);
        return Promise.resolve(editor);
      },
      createHostElement: () => new FakeElement('div') as unknown as HTMLElement,
      attachHost: () => undefined,
      detachHost: () => undefined,
      confirmClose: () => Promise.resolve('discard'),
      promptRestore: () => Promise.resolve(false),
      writeSnapshot: () => Promise.resolve(),
      clearSnapshot: () => Promise.resolve(),
      onActiveContentChanged: () => view.scheduleRefresh(),
      reportError: () => undefined,
    };
    const manager = new TabManager(deps);
    view = createOutlineView({
      doc: fakeDocument(),
      debounceMs: 0,
      getActiveHost: () => manager.activeTab?.hostElement ?? null,
      getActiveMarkdown: () => {
        const tab = manager.activeTab;
        return tab !== null && tab.kind === 'markdown' ? tab.editor.getMarkdown() : null;
      },
    });
    return { manager, view, editors };
  }

  it('切换活动标签驱动大纲刷新', async () => {
    vi.useFakeTimers();
    const { manager, view } = makeHarness();
    await manager.newTab('# A\n');
    await manager.newTab('# B\n');
    vi.runAllTimers();
    expect(itemTexts(view)).toEqual(['B']);
    manager.switchTab(manager.tabList[0].id);
    vi.runAllTimers();
    expect(itemTexts(view)).toEqual(['A']);
    view.destroy();
    vi.useRealTimers();
  });
});
