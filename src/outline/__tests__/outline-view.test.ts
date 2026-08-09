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
import { createOutlineView, type OutlineView } from '../outline-view.js';

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

  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
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
  return {
    createElement: (tag: string) => new FakeElement(tag),
  } as unknown as Document;
}

function rootOf(view: OutlineView): FakeElement {
  return view.root as unknown as FakeElement;
}

function headerOf(view: OutlineView): FakeElement {
  return rootOf(view).children[0] as FakeElement;
}

function bodyOf(view: OutlineView): FakeElement {
  return rootOf(view).children[1] as FakeElement;
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
      getLinkAtCursor: () => null,
      getLinkAtPoint: () => null,
      toggleMark: () => undefined,
      setLink: () => undefined,
      insertImage: () => undefined,
      focus: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
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
      getActiveMarkdown: () => manager.activeTab?.editor.getMarkdown() ?? null,
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
