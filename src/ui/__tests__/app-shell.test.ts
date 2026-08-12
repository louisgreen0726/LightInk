/**
 * app-shell buildMenus 生产结构回归测试（R2）+ immersive chrome DOM（R2/R3）：
 * 基于生产 buildMenus 产出（而非手写 spec）断言分隔项与菜单结构，
 * 防止「分隔符漏设 separator:true 而渲染为空白可点击按钮」的回归；
 * 并覆盖菜单/标签 chrome 默认折叠与 class 同步（node + minimal fake document）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { InsertElementId } from '../../editor/insert-commands.js';
import type { BuiltinThemeId } from '../../theme/theme-service.js';
import {
  abbreviatePath,
  buildMenus,
  buildRecentsMenuItems,
  createAppShell,
  pathBaseName,
  pathDirName,
  type AppShellActions,
} from '../app-shell.js';

function stubActions(currentThemeId = 'warm-light'): AppShellActions {
  const noop = (): void => undefined;
  return {
    onNew: noop,
    onOpen: noop,
    listRecents: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(false),
    clearRecents: () => Promise.resolve(),
    onShowVersions: noop,
    hasActiveFile: () => false,
    onSave: noop,
    onSaveAs: noop,
    onExportHtml: noop,
    onExportPdf: noop,
    onUndo: noop,
    onRedo: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
    onInsertElement: (_id: InsertElementId) => undefined,
    onToggleTheme: noop,
    onApplyTheme: (_id: BuiltinThemeId) => undefined,
    getCurrentThemeId: () => currentThemeId,
    onReloadCustomTheme: noop,
    onSelectCustomTheme: noop,
    onResetCustomTheme: noop,
    canReloadCustomTheme: () => false,
    canResetCustomTheme: () => false,
    onToggleOutline: noop,
    onToggleSourceMode: noop,
    onToggleFullscreen: noop,
    isChromePinned: () => false,
    onToggleChromePinned: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoomReset: noop,
    getFontScaleLabel: () => '100%',
    t: (key: string) => key,
    formatShortcut: (combo: string) => combo,
    getLocale: () => 'zh-CN' as const,
    setLocale: () => undefined,
  };
}

/** Minimal DOM for createAppShell in node (no happy-dom/jsdom in project). */
class FakeEl {
  id = '';
  className = '';
  tabIndex = 0;
  type = '';
  hidden = false;
  disabled = false;
  private ownText = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).filter(Boolean).includes(c),
    add: (c: string): void => {
      if (!this.classList.contains(c)) {
        this.className = this.className === '' ? c : `${this.className} ${c}`;
      }
    },
    toggle: (c: string, force?: boolean): boolean => {
      const has = this.classList.contains(c);
      const next = force === undefined ? !has : force;
      if (next && !has) this.classList.add(c);
      if (!next && has) {
        this.className = this.className
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(' ');
      }
      return next;
    },
  };

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...kids: FakeEl[]): void {
    for (const kid of kids) {
      this.appendChild(kid);
    }
  }

  replaceChildren(...kids: FakeEl[]): void {
    for (const kid of this.children) {
      kid.parent = null;
    }
    this.children = [];
    for (const kid of kids) {
      this.appendChild(kid);
    }
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  getBoundingClientRect(): { right: number; width: number; left: number; top: number } {
    return { right: 0, width: 0, left: 0, top: 0 };
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {
    /* no-op for shell tests */
  }

  focus(): void {
    /* no-op */
  }

  querySelector(selector: string): FakeEl | null {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return this.find((el) => el.id === id);
    }
    return null;
  }

  private find(pred: (el: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) return this;
    for (const child of this.children) {
      const hit = child.find(pred);
      if (hit) return hit;
    }
    return null;
  }
}

class FakeDoc {
  body = new FakeEl('body');
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();

  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    this.listeners.set(
      type,
      list.filter((x) => x !== fn),
    );
  }
}

const originalDocument = (globalThis as { document?: unknown }).document;

function installFakeDocument(): FakeDoc {
  const doc = new FakeDoc();
  (globalThis as { document: unknown }).document = doc;
  return doc;
}

function restoreDocument(): void {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document: unknown }).document = originalDocument;
  }
}

describe('createAppShell immersive chrome', () => {
  afterEach(() => {
    restoreDocument();
  });

  it('defaults menu and tabs chrome pinned open (fixed navigation)', () => {
    installFakeDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    // Disable storage so first-run defaults apply (not a prior unpinned session).
    const shell = createAppShell(root, stubActions(), {
      shortcutBindings: () => [],
      storage: null,
    });
    const fakeRoot = root as unknown as FakeEl;

    expect(shell.isChromePinned()).toBe(true);
    expect(shell.chrome.isRevealed('menu')).toBe(true);
    expect(shell.chrome.isRevealed('tabs')).toBe(true);
    expect(fakeRoot.querySelector('#lightink-chrome-host')?.classList.contains('is-menu-revealed')).toBe(
      true,
    );
    expect(fakeRoot.querySelector('#lightink-tabs-host')?.classList.contains('is-tabs-revealed')).toBe(
      true,
    );
    expect(fakeRoot.querySelector('#lightink-menu-trigger')).not.toBeNull();
    expect(fakeRoot.querySelector('#lightink-tabs-trigger')).not.toBeNull();
  });

  it('toggleTabsChrome and setTabsHold sync is-tabs-revealed when unpinned', () => {
    installFakeDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    const shell = createAppShell(root, stubActions(), {
      shortcutBindings: () => [],
      storage: null,
      initialPinPrefs: { menu: false, tabs: false },
    });
    const tabsHost = (root as unknown as FakeEl).querySelector('#lightink-tabs-host');

    shell.toggleTabsChrome();
    expect(shell.chrome.isRevealed('tabs')).toBe(true);
    expect(tabsHost?.classList.contains('is-tabs-revealed')).toBe(true);

    shell.setTabsHold(true);
    expect(shell.chrome.isRevealed('tabs')).toBe(true);
    shell.toggleTabsChrome();
    // hold blocks dismiss via toggle → dismiss path
    expect(shell.chrome.isRevealed('tabs')).toBe(true);

    shell.setTabsHold(false);
    shell.toggleTabsChrome();
    expect(shell.chrome.isRevealed('tabs')).toBe(false);
    expect(tabsHost?.classList.contains('is-tabs-revealed')).toBe(false);
  });

  it('toggleMenuChrome syncs is-menu-revealed when unpinned', () => {
    installFakeDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    const shell = createAppShell(root, stubActions(), {
      shortcutBindings: () => [],
      storage: null,
      initialPinPrefs: { menu: false, tabs: false },
    });
    const chromeHost = (root as unknown as FakeEl).querySelector('#lightink-chrome-host');

    shell.toggleMenuChrome();
    expect(shell.chrome.isRevealed('menu')).toBe(true);
    expect(chromeHost?.classList.contains('is-menu-revealed')).toBe(true);
    shell.toggleMenuChrome();
    expect(shell.chrome.isRevealed('menu')).toBe(false);
    expect(chromeHost?.classList.contains('is-menu-revealed')).toBe(false);
  });

  it('setChromePinned pins menu and tabs and marks hosts', () => {
    installFakeDocument();
    const storage = {
      store: {} as Record<string, string>,
      getItem(key: string) {
        return this.store[key] ?? null;
      },
      setItem(key: string, value: string) {
        this.store[key] = value;
      },
    };
    const root = document.createElement('div') as unknown as HTMLElement;
    const shell = createAppShell(root, stubActions(), {
      shortcutBindings: () => [],
      storage,
      initialPinPrefs: { menu: false, tabs: false },
    });
    const chromeHost = (root as unknown as FakeEl).querySelector('#lightink-chrome-host');
    const tabsHost = (root as unknown as FakeEl).querySelector('#lightink-tabs-host');

    expect(shell.isChromePinned()).toBe(false);
    shell.setChromePinned(true);
    expect(shell.isChromePinned()).toBe(true);
    expect(shell.chrome.isRevealed('menu')).toBe(true);
    expect(shell.chrome.isRevealed('tabs')).toBe(true);
    expect(chromeHost?.classList.contains('is-chrome-pinned')).toBe(true);
    expect(tabsHost?.classList.contains('is-chrome-pinned')).toBe(true);
    expect(storage.store['lightink.chrome.pinned']).toContain('true');

    shell.setChromePinned(false);
    expect(shell.isChromePinned()).toBe(false);
    expect(chromeHost?.classList.contains('is-chrome-pinned')).toBe(false);
  });

  it('renderTabBar renders every open tab (not only the active one)', () => {
    installFakeDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    const shell = createAppShell(root, stubActions(), {
      shortcutBindings: () => [],
      storage: null,
      initialPinPrefs: { menu: true, tabs: true },
    });
    shell.renderTabBar(
      [
        { id: 'tab-1', title: 'a.md', dirty: false },
        { id: 'tab-2', title: 'b.md', dirty: true },
        { id: 'tab-3', title: 'c.md', dirty: false },
      ],
      'tab-2',
      { onSwitch: () => undefined, onClose: () => undefined },
    );
    const tabBar = (root as unknown as FakeEl).querySelector('#lightink-tabbar');
    expect(tabBar?.children).toHaveLength(3);
    expect(tabBar?.children.map((c) => c.dataset.tabId)).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(tabBar?.getAttribute('role')).toBe('tablist');
    const activeButton = tabBar?.children[1]?.children[0];
    expect(activeButton?.getAttribute('role')).toBe('tab');
    expect(activeButton?.getAttribute('aria-selected')).toBe('true');
    expect(tabBar?.children[1]?.children[1]?.tagName).toBe('button');
  });

  it('restores pinned chrome from initialPinPrefs', () => {
    installFakeDocument();
    const root = document.createElement('div') as unknown as HTMLElement;
    const shell = createAppShell(root, stubActions(), {
      shortcutBindings: () => [],
      storage: null,
      initialPinPrefs: { menu: true, tabs: true },
    });
    expect(shell.isChromePinned()).toBe(true);
    expect(shell.chrome.isRevealed('menu')).toBe(true);
    expect(shell.chrome.isRevealed('tabs')).toBe(true);
  });
});

describe('buildMenus 生产结构', () => {
  const menus = buildMenus(stubActions());
  const file = menus.find((m) => m.id === 'file');
  const edit = menus.find((m) => m.id === 'edit');

  it('五个顶级菜单齐全', () => {
    expect(menus.map((m) => m.id)).toEqual(['file', 'edit', 'insert', 'view', 'help']);
  });

  it('文件/编辑菜单的分隔项带 separator:true（P2[blocking] 回归）', () => {
    expect(file?.items.filter((i) => i.separator === true).length).toBeGreaterThanOrEqual(2);
    expect(edit?.items.some((i) => i.separator === true)).toBe(true);
  });

  it('文件菜单含「最近打开」子菜单入口（R12，VS Code 式）', () => {
    const item = file?.items.find((i) => i.id === 'file-recents');
    // Labels may be factories (i18n); resolve for assertion.
    const label = typeof item?.label === 'function' ? item.label() : item?.label;
    expect(label).toMatch(/最近打开|file\.recents/);
    expect(typeof item?.submenu).toBe('function');
  });

  it('文件菜单含「版本历史…」入口，无活动文件时禁用（R13）', () => {
    const item = file?.items.find((i) => i.id === 'file-versions');
    const label = typeof item?.label === 'function' ? item.label() : item?.label;
    expect(label).toMatch(/版本历史|file\.versions/);
    expect(item?.enabled?.()).toBe(false); // stub hasActiveFile → false
  });

  it('非分隔项不带 separator 且有非空 label（无空白按钮）', () => {
    for (const menu of menus) {
      for (const item of menu.items) {
        if (item.separator === true) {
          continue;
        }
        expect(item.separator ?? false).toBe(false);
        expect(item.label).not.toBe('');
      }
    }
  });

  it('视图菜单把主题收纳为子菜单，预设主题当前项禁用（R15）', () => {
    const viewMenus = buildMenus(stubActions('midnight'));
    const view = viewMenus.find((m) => m.id === 'view');
    const themeEntry = view?.items.find((i) => i.id === 'view-theme');
    expect(themeEntry?.submenu).toBeTypeOf('function');
    // Top-level View no longer lists each theme inline.
    expect(view?.items.some((i) => i.id === 'view-theme-midnight')).toBe(false);

    const themeItems = themeEntry!.submenu!();
    // submenu may be sync or Promise — production uses sync factory.
    expect(Array.isArray(themeItems)).toBe(true);
    const items = themeItems as import('../menus.js').MenuItem[];
    const presetIds = ['warm-light', 'cool-light', 'dark', 'midnight'].map(
      (id) => `view-theme-${id}`,
    );
    const presetItems = items.filter(
      (i) => i.separator !== true && i.id !== 'view-theme-toggle' && presetIds.includes(i.id),
    );
    expect(presetItems.map((i) => i.id)).toEqual(presetIds);
    // 当前主题 midnight 禁用、其余启用。
    expect(presetItems.find((i) => i.id === 'view-theme-midnight')?.enabled?.()).toBe(false);
    expect(presetItems.find((i) => i.id === 'view-theme-warm-light')?.enabled?.()).toBe(true);
    // 热重载自定义主题入口存在。
    expect(items.some((i) => i.id === 'view-reload-custom-theme')).toBe(true);
    // Toggle still present inside the submenu.
    expect(items.some((i) => i.id === 'view-theme-toggle')).toBe(true);
  });

  });

describe('buildRecentsMenuItems（R12 最近打开子菜单）', () => {
  it('路径拆分为文件名 + 目录（兼容 / 与 \\）', () => {
    expect(pathBaseName('C:\\docs\\笔记.md')).toBe('笔记.md');
    expect(pathBaseName('/home/u/a.md')).toBe('a.md');
    expect(pathDirName('C:\\docs\\笔记.md')).toBe('C:\\docs');
    expect(pathDirName('/home/u/a.md')).toBe('/home/u');
    // 无目录段 → 空串（description 不渲染）。
    expect(pathDirName('a.md')).toBe('');
  });

  it('abbreviatePath keeps root + last segments without RTL mangling', () => {
    expect(abbreviatePath('C:\\docs')).toBe('C:\\docs');
    expect(
      abbreviatePath(
        'C:\\Users\\12976\\project\\LightInk\\docs\\requirements',
        42,
      ),
    ).toMatch(/^C:\\…\\/);
    expect(abbreviatePath('short/path', 42)).toBe('short/path');
  });

  it('空列表返回占位禁用项', () => {
    const items = buildRecentsMenuItems([], { open: () => undefined, clear: () => undefined });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('recents-empty');
    expect(items[0].enabled?.()).toBe(false);
  });

  it('每项 = 文件名 + 次行目录 + 完整路径 title；末尾接清空入口', () => {
    const opened: string[] = [];
    let cleared = 0;
    const items = buildRecentsMenuItems(['C:\\docs\\a.md', '/home/u/b.md'], {
      open: (p) => opened.push(p),
      clear: () => {
        cleared += 1;
      },
    });
    expect(items.map((i) => i.id)).toEqual(['recent-0', 'recent-1', 'recents-sep', 'recents-clear']);
    expect(items[0].label).toBe('a.md');
    expect(items[0].description).toBe('C:\\docs');
    expect(items[0].title).toBe('C:\\docs\\a.md');
    expect(items[0].hint).toBeUndefined();
    expect(items[1].label).toBe('b.md');
    expect(items[1].description).toBe('/home/u');
    expect(items[2].separator).toBe(true);
    items[0].action();
    items[3].action();
    expect(opened).toEqual(['C:\\docs\\a.md']);
    expect(cleared).toBe(1);
  });
});
