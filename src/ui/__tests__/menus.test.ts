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
  private ownText = '';
  className = '';
  hidden = false;
  disabled = false;
  type = '';
  title = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly listeners = new Map<string, Array<(e: FakeEvent) => void>>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
    add: (c: string): void => {
      if (!this.classList.contains(c)) {
        this.className = this.className === '' ? c : `${this.className} ${c}`;
      }
    },
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  appendChild<T extends FakeEl>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...kids: FakeEl[]): void {
    for (const kid of kids) {
      kid.parent = this;
    }
    this.children.push(...kids);
  }

  replaceChildren(...kids: FakeEl[]): void {
    for (const kid of kids) {
      kid.parent = this;
    }
    this.children = [...kids];
  }

  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }

  getBoundingClientRect(): { right: number; width: number } {
    return { right: 0, width: 0 };
  }

  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  fire(type: string, overrides: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = {
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
      ...overrides,
    };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }

  click(overrides: Partial<FakeEvent> = {}): void {
    this.fire('click', overrides);
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

// ---------------------------------------------------------------------------
// 子菜单（VS Code 式「最近打开」）与菜单栏悬停跟踪
// ---------------------------------------------------------------------------

interface SubSpec {
  specObj: MenuBarSpec;
  subItems: Array<{ id: string; label: string; action: ReturnType<typeof vi.fn> }>;
}

function specWithSubmenu(): SubSpec {
  const subItems = [
    { id: 'recent-0', label: 'a.md', action: vi.fn() },
    { id: 'recents-clear', label: '清空最近打开', action: vi.fn() },
  ];
  return {
    subItems,
    specObj: {
      menus: [
        {
          id: 'file',
          label: '文件',
          items: [
            { id: 'new', label: '新建', action: vi.fn() },
            {
              id: 'recents',
              label: '最近打开',
              action: vi.fn(),
              submenu: () => Promise.resolve(subItems),
            },
          ],
        },
        { id: 'edit', label: '编辑', items: [{ id: 'undo', label: '撤销', action: vi.fn() }] },
      ],
    },
  };
}

function panelByMenuId(bar: { element: HTMLDivElement }, menuId: string): FakeEl {
  const wraps = asEl(bar.element).children;
  const wrap = wraps.find((w) => w.children[0]?.dataset.menuId === menuId) as FakeEl;
  return wrap.children[1];
}

function flyoutOf(bar: { element: HTMLDivElement }, menuId: string): FakeEl | undefined {
  return panelByMenuId(bar, menuId).children.find((c) =>
    c.classList.contains('lightink-menu-flyout'),
  );
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('子菜单浮层', () => {
  it('悬停子菜单触发器展开浮层并异步填充子项', async () => {
    const { specObj } = specWithSubmenu();
    const bar = createMenuBar(specObj, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    const triggerItem = panelByMenuId(bar, 'file').children.find(
      (c) => c.dataset.itemId === 'recents',
    ) as FakeEl;
    triggerItem.fire('mouseenter');
    // 立即出现加载占位。
    expect(flyoutOf(bar, 'file')).toBeDefined();
    await flushMicrotasks();
    const flyout = flyoutOf(bar, 'file') as FakeEl;
    expect(flyout.children.map((c) => c.dataset.itemId)).toEqual(['recent-0', 'recents-clear']);
  });

  it('点击子项派发其 action 并关闭整个菜单', async () => {
    const { specObj, subItems } = specWithSubmenu();
    const bar = createMenuBar(specObj, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    const triggerItem = panelByMenuId(bar, 'file').children.find(
      (c) => c.dataset.itemId === 'recents',
    ) as FakeEl;
    triggerItem.fire('mouseenter');
    await flushMicrotasks();
    const flyout = flyoutOf(bar, 'file') as FakeEl;
    (flyout.children[0] as FakeEl).click();
    expect(subItems[0].action).toHaveBeenCalledTimes(1);
    expect(panelByMenuId(bar, 'file').hidden).toBe(true);
    expect(flyoutOf(bar, 'file')).toBeUndefined();
  });

  it('悬停同面板的普通项时关闭浮层', async () => {
    const { specObj } = specWithSubmenu();
    const bar = createMenuBar(specObj, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    const panel = panelByMenuId(bar, 'file');
    (panel.children.find((c) => c.dataset.itemId === 'recents') as FakeEl).fire('mouseenter');
    await flushMicrotasks();
    expect(flyoutOf(bar, 'file')).toBeDefined();
    (panel.children.find((c) => c.dataset.itemId === 'new') as FakeEl).fire('mouseenter');
    expect(flyoutOf(bar, 'file')).toBeUndefined();
  });
});

describe('菜单栏悬停跟踪（VS Code 式）', () => {
  it('已有菜单展开时悬停其他触发器自动切换', () => {
    const { specObj } = specWithSubmenu();
    const bar = createMenuBar(specObj, new FakeDoc() as unknown as Document);
    bar.openMenu('file');
    const editTrigger = asEl(bar.element).children[1].children[0];
    editTrigger.fire('mouseenter');
    expect(panelByMenuId(bar, 'file').hidden).toBe(true);
    expect(panelByMenuId(bar, 'edit').hidden).toBe(false);
  });

  it('无菜单展开时悬停不打开', () => {
    const { specObj } = specWithSubmenu();
    const bar = createMenuBar(specObj, new FakeDoc() as unknown as Document);
    const editTrigger = asEl(bar.element).children[1].children[0];
    editTrigger.fire('mouseenter');
    expect(panelByMenuId(bar, 'edit').hidden).toBe(true);
  });
});
