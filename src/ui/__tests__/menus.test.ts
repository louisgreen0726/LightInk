/**
 * menus 下拉菜单栏行为测试（R2，node 环境，fake doc 注入）：
 * 渲染触发器、展开/关闭、项点击派发、禁用、分隔符、外部 pointerdown / Esc 关闭。
 */

import { describe, expect, it, vi } from 'vitest';

import { createMenuBar, type MenuBarSpec } from '../menus.js';

interface FakeEvent {
  stopPropagation(): void;
  preventDefault(): void;
  target?: unknown;
  key?: string;
}

class FakeEl {
  readonly tagName: string;
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  type = '';
  title = '';
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  private readonly listeners = new Map<string, Array<(e: FakeEvent) => void>>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  appendChild<T extends FakeEl>(child: T): T {
    this.children.push(child);
    return child;
  }

  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }

  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(overrides: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = {
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
      ...overrides,
    };
    for (const fn of this.listeners.get('click') ?? []) {
      fn(event);
    }
  }

  contains(node: unknown): boolean {
    if (node === this) {
      return true;
    }
    return this.children.some((child) => child.contains(node));
  }
}

class FakeDoc {
  private readonly listeners = new Map<string, Array<(e: FakeEvent) => void>>();

  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }

  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatch(type: string, overrides: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = {
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
      ...overrides,
    };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

function spec(): MenuBarSpec {
  return {
    menus: [
      {
        id: 'file',
        label: '文件',
        items: [
          { id: 'new', label: '新建', shortcut: 'Ctrl+N', action: vi.fn() },
          { id: 'open', label: '打开', action: vi.fn() },
          { id: 'sep1', label: '', separator: true, action: vi.fn() },
          { id: 'save', label: '保存', action: vi.fn(), enabled: () => false },
        ],
      },
    ],
  };
}

function asEl(node: unknown): FakeEl {
  return node as FakeEl;
}

function trigger(bar: { element: HTMLDivElement }): FakeEl {
  return asEl(asEl(bar.element).children[0]).children[0];
}

function panelEl(bar: { element: HTMLDivElement }): FakeEl {
  return asEl(asEl(bar.element).children[0]).children[1];
}

function menuItems(bar: { element: HTMLDivElement }): FakeEl[] {
  return panelEl(bar).children.filter((child) => child.classList.contains('lightink-menu-item'));
}

function itemById(bar: { element: HTMLDivElement }, id: string): FakeEl {
  return menuItems(bar).find((item) => item.dataset.itemId === id) as FakeEl;
}

describe('createMenuBar 渲染', () => {
  it('为每个菜单渲染触发器，面板初始隐藏', () => {
    const bar = createMenuBar(spec(), new FakeDoc() as unknown as Document);
    expect(trigger(bar).textContent).toBe('文件');
    expect(trigger(bar).dataset.menuId).toBe('file');
    expect(panelEl(bar).hidden).toBe(true);
  });

  it('菜单项标注快捷键；分隔符渲染', () => {
    const bar = createMenuBar(spec(), new FakeDoc() as unknown as Document);
    const items = menuItems(bar);
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Ctrl+N');
    expect(panelEl(bar).children.some((c) => c.classList.contains('lightink-menu-separator'))).toBe(true);
  });
});

describe('展开/关闭与派发', () => {
  it('openMenu 展开面板，closeAll 关闭', () => {
    const s = spec();
    const bar = createMenuBar(s, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    expect(panelEl(bar).hidden).toBe(false);
    bar.closeAll();
    expect(panelEl(bar).hidden).toBe(true);
  });

  it('点击菜单项派发 action 并关闭面板', () => {
    const s = spec();
    const bar = createMenuBar(s, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    itemById(bar, 'new').click();
    expect(s.menus[0].items[0].action).toHaveBeenCalledTimes(1);
    expect(panelEl(bar).hidden).toBe(true);
  });

  it('禁用项不派发 action', () => {
    const s = spec();
    const bar = createMenuBar(s, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    const saveItem = itemById(bar, 'save');
    expect(saveItem.disabled).toBe(true);
    const before = (s.menus[0].items[3].action as ReturnType<typeof vi.fn>).mock.calls.length;
    saveItem.click();
    expect((s.menus[0].items[3].action as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('触发器再次点击关闭已开菜单', () => {
    const bar = createMenuBar(spec(), new FakeDoc() as unknown as Document);
    trigger(bar).click();
    expect(panelEl(bar).hidden).toBe(false);
    trigger(bar).click();
    expect(panelEl(bar).hidden).toBe(true);
  });

  it('外部 pointerdown 关闭菜单', () => {
    const doc = new FakeDoc();
    const bar = createMenuBar(spec(), doc as unknown as Document);
    bar.openMenu('file');
    doc.dispatch('pointerdown', { target: new FakeEl('div') });
    expect(panelEl(bar).hidden).toBe(true);
  });

  it('Esc 关闭菜单', () => {
    const doc = new FakeDoc();
    const bar = createMenuBar(spec(), doc as unknown as Document);
    bar.openMenu('file');
    doc.dispatch('keydown', { key: 'Escape' });
    expect(panelEl(bar).hidden).toBe(true);
  });
});
