/**
 * 大纲视图测试（node 环境，fake DOM 注入）：
 *   - 渲染：按 markdown 生成缩进层级条目、空态文案（无标签/无标题）；
 *   - 点击跳转：按序号锚点定位宿主中第 n 个 h1-h6 并 scrollIntoView；
 *   - 实时更新：scheduleRefresh 防抖合并、refreshNow 立即生效；
 *   - 折叠：toggleCollapse / 折叠按钮切换 collapsed 态；
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
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = {
    add: (...cs: string[]): void => {
      for (const c of cs) this.classes.add(c);
    },
    remove: (...cs: string[]): void => {
      for (const c of cs) this.classes.delete(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
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

  setAttribute(_name: string, _value: string): void {
    /* fake：不记录属性 */
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

function makeHost(headingTags: string[]): FakeElement {
  const host = new FakeElement('div');
  host.headings = headingTags.map((tag) => new FakeElement(tag));
  return host;
}

describe('createOutlineView 渲染', () => {
  it('按 markdown 渲染条目文本与层级类', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题一\n\n## 小节\n\n### 子小节\n',
    });
    expect(itemTexts(view)).toEqual(['标题一', '小节', '子小节']);
    const items = bodyOf(view).children;
    expect(items[0]?.classList.contains('lightink-outline-item')).toBe(true);
    expect(items[0]?.classList.contains('level-1')).toBe(true);
    expect(items[1]?.classList.contains('level-2')).toBe(true);
    expect(items[2]?.classList.contains('level-3')).toBe(true);
    view.destroy();
  });

  it('无活动标签（markdown 为 null）显示对应空态', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => null,
    });
    expect(itemTexts(view)).toEqual(['无活动标签']);
    view.destroy();
  });

  it('有内容但无标题时显示「暂无标题」', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '只有段落，没有标题。\n',
    });
    expect(itemTexts(view)).toEqual(['暂无标题']);
    view.destroy();
  });
});

describe('createOutlineView 点击跳转', () => {
  it('点击条目按序号锚点滚动对应标题（重复文本靠序号区分）', () => {
    const host = makeHost(['h1', 'h2', 'h1']);
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => host as unknown as HTMLElement,
      getActiveMarkdown: () => '# 总结\n\n## 细节\n\n# 总结\n',
    });
    const items = bodyOf(view).children;

    items[2]?.click();
    expect(host.headings[2]?.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(host.headings[0]?.scrollIntoView).not.toHaveBeenCalled();

    items[1]?.click();
    expect(host.headings[1]?.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    view.destroy();
  });

  it('无活动宿主时点击静默跳过', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题\n',
    });
    expect(() => bodyOf(view).children[0]?.click()).not.toThrow();
    view.destroy();
  });
});

describe('createOutlineView 实时更新（防抖）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scheduleRefresh 防抖：到期才重算，多次调度合并为一次', () => {
    const state = { markdown: '# 旧标题\n' };
    const view = createOutlineView({
      doc: fakeDocument(),
      debounceMs: 200,
      getActiveHost: () => null,
      getActiveMarkdown: () => state.markdown,
    });
    expect(itemTexts(view)).toEqual(['旧标题']);

    state.markdown = '# 新标题\n\n## 小节\n';
    view.scheduleRefresh();
    vi.advanceTimersByTime(199);
    expect(itemTexts(view)).toEqual(['旧标题']); // 未到期不刷新

    view.scheduleRefresh(); // 重新计时（合并）
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['新标题', '小节']);
    view.destroy();
  });

  it('refreshNow 绕过防抖立即重算', () => {
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

describe('createOutlineView 折叠', () => {
  it('toggleCollapse 切换 collapsed 类与状态', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题\n',
    });
    expect(view.collapsed).toBe(false);
    expect(rootOf(view).classList.contains('collapsed')).toBe(false);

    view.toggleCollapse();
    expect(view.collapsed).toBe(true);
    expect(rootOf(view).classList.contains('collapsed')).toBe(true);

    view.toggleCollapse();
    expect(view.collapsed).toBe(false);
    expect(rootOf(view).classList.contains('collapsed')).toBe(false);
    view.destroy();
  });

  it('头部折叠按钮点击触发折叠/展开', () => {
    const view = createOutlineView({
      doc: fakeDocument(),
      getActiveHost: () => null,
      getActiveMarkdown: () => '# 标题\n',
    });
    const toggle = headerOf(view).children[1] as FakeElement;
    expect(toggle.classList.contains('lightink-outline-toggle')).toBe(true);
    toggle.click();
    expect(view.collapsed).toBe(true);
    toggle.click();
    expect(view.collapsed).toBe(false);
    view.destroy();
  });
});

describe('大纲与 TabManager 接线', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    };
    const manager = new TabManager(deps);
    view = createOutlineView({
      doc: fakeDocument(),
      debounceMs: 200,
      getActiveHost: () => manager.activeTab?.hostElement ?? null,
      getActiveMarkdown: () => manager.activeTab?.editor.getMarkdown() ?? null,
    });
    return { manager, view, editors };
  }

  it('新建标签后大纲经防抖刷新为活动标签内容', async () => {
    const { manager, view } = makeHarness();
    expect(itemTexts(view)).toEqual(['无活动标签']);
    await manager.newTab('# 标题A\n\n## 小节A\n');
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['标题A', '小节A']);
    view.destroy();
  });

  it('切换标签后大纲换成新活动标签的标题', async () => {
    const { manager, view } = makeHarness();
    const tabA = await manager.newTab('# 标题A\n');
    await manager.newTab('# 标题B\n\n## 小节B\n');
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['标题B', '小节B']);

    manager.switchTab(tabA.id);
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['标题A']);
    view.destroy();
  });

  it('活动标签内容变化触发刷新；非活动标签变化不触发', async () => {
    const { manager, view, editors } = makeHarness();
    const tabA = await manager.newTab('# 标题A\n');
    const tabB = await manager.newTab('# 标题B\n');
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['标题B']);

    // 非活动标签（A）内容变化：不触发大纲刷新。
    const editorA = editors[0]!;
    editorA.content = '# 标题A\n\n## A 的新小节\n';
    manager.handleContentChanged(tabA.id);
    vi.advanceTimersByTime(500);
    expect(itemTexts(view)).toEqual(['标题B']);

    // 活动标签（B）内容变化：防抖后刷新。
    const editorB = editors[1]!;
    editorB.content = '# 标题B\n\n## B 的新小节\n';
    manager.handleContentChanged(tabB.id);
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['标题B', 'B 的新小节']);
    view.destroy();
  });

  it('关闭全部标签后大纲回到无活动标签空态', async () => {
    const { manager, view } = makeHarness();
    const tab = await manager.newTab('# 标题A\n');
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['标题A']);

    await manager.closeTab(tab.id);
    vi.advanceTimersByTime(200);
    expect(itemTexts(view)).toEqual(['无活动标签']);
    view.destroy();
  });
});
