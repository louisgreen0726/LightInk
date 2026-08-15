/**
 * app-shell buildMenus 生产结构回归测试（R2）+ immersive chrome DOM（R2/R3）：
 * 基于生产 buildMenus 产出（而非手写 spec）断言分隔项与菜单结构，
 * 防止「分隔符漏设 separator:true 而渲染为空白可点击按钮」的回归；
 * 并覆盖菜单/标签 chrome 默认折叠与 class 同步（node + minimal fake document）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { InsertElementId } from '../../editor/insert-commands.js';
import { OPEN_FILTERS } from '../../file/file-dialog.js';
import { translate, type MessageKey } from '../../i18n/messages.js';
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
    getReadingLayout: () => 'scroll' as const,
    onToggleReadingLayout: noop,
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
    expect((activeButton as { title?: string } | undefined)?.title).toBe('b.md');
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
    expect(menus.map((m) => m.id)).toEqual(['file', 'edit', 'insert', 'annotation', 'view', 'help']);
    expect(buildMenus({ ...stubActions(), activeTabKind: () => 'reader' }).map((m) => m.id)).toEqual([
      'file',
      'edit',
      'annotation',
      'view',
      'help',
    ]);
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

  it('reader 标签下视图菜单隐藏「源码模式」，切回 Markdown 恢复（T1）', () => {
    const markdownView = menus.find((m) => m.id === 'view');
    expect(markdownView?.items.some((i) => i.id === 'view-source-mode')).toBe(true);
    const readerView = buildMenus({ ...stubActions(), activeTabKind: () => 'reader' }).find(
      (m) => m.id === 'view',
    );
    expect(readerView?.items.some((i) => i.id === 'view-source-mode')).toBe(false);
  });

  it('视图菜单收纳「字体布局」子菜单：5 项，主菜单原位置移除，快捷键保留（T1）', () => {
    const view = menus.find((m) => m.id === 'view');
    // 主菜单不再平铺缩放与滚动/翻页切换项。
    for (const removed of ['view-zoom-in', 'view-zoom-out', 'view-zoom-reset', 'view-layout-toggle']) {
      expect(view?.items.some((i) => i.id === removed)).toBe(false);
    }
    const entry = view?.items.find((i) => i.id === 'view-font-layout');
    expect(typeof entry?.submenu).toBe('function');
    const label = typeof entry?.label === 'function' ? entry!.label() : entry?.label;
    expect(label).toMatch(/字体布局|view\.fontLayout/);
    const items = entry!.submenu!() as import('../menus.js').MenuItem[];
    const actionable = items.filter((i) => i.separator !== true);
    expect(actionable.map((i) => i.id)).toEqual([
      'view-zoom-in',
      'view-zoom-out',
      'view-zoom-reset',
      'view-layout-scroll',
      'view-layout-paginated',
    ]);
    // 快捷键提示随迁，行为不变。
    expect(actionable[0]?.shortcut).toBe('Ctrl+=');
    expect(actionable[1]?.shortcut).toBe('Ctrl+-');
    expect(actionable[2]?.shortcut).toBe('Ctrl+0');
    expect(actionable[3]?.shortcut).toBe('Ctrl+M');
    // stub getReadingLayout = 'scroll'：滚动为当前模式（打勾禁用），翻页可选。
    const scroll = actionable.find((i) => i.id === 'view-layout-scroll');
    const paginated = actionable.find((i) => i.id === 'view-layout-paginated');
    expect(scroll?.enabled?.()).toBe(false);
    const scrollLabel = typeof scroll!.label === 'function' ? scroll!.label() : scroll!.label;
    expect(scrollLabel).toMatch(/^✓/);
    expect(paginated?.enabled?.()).toBe(true);
  });

  it('子菜单选择非当前布局触发切换；已选模式点击不重复切换（T1）', () => {
    let toggles = 0;
    const view = buildMenus({ ...stubActions(), onToggleReadingLayout: () => { toggles += 1; } }).find(
      (m) => m.id === 'view',
    );
    const entry = view?.items.find((i) => i.id === 'view-font-layout');
    const items = (entry!.submenu!() as import('../menus.js').MenuItem[]).filter(
      (i) => i.separator !== true,
    );
    // 当前模式（scroll）点击不切换；选择翻页触发一次切换。
    items.find((i) => i.id === 'view-layout-scroll')!.action();
    expect(toggles).toBe(0);
    items.find((i) => i.id === 'view-layout-paginated')!.action();
    expect(toggles).toBe(1);
  });

  it('「字体布局」子菜单在 zh/en 双语下标签齐备（语言切换重建，T1）', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const localized = buildMenus({
        ...stubActions(),
        getLocale: () => locale,
        t: (key: MessageKey) => translate(locale, key),
      });
      const view = localized.find((m) => m.id === 'view');
      const entry = view?.items.find((i) => i.id === 'view-font-layout');
      const entryLabel = typeof entry?.label === 'function' ? entry!.label() : entry?.label;
      expect(entryLabel).not.toBe('view.fontLayout'); // 已解析为文案，非裸 key
      const items = (entry!.submenu!() as import('../menus.js').MenuItem[]).filter(
        (i) => i.separator !== true,
      );
      for (const item of items) {
        const text = typeof item.label === 'function' ? item.label() : item.label;
        expect(text.trim()).not.toBe('');
      }
      // reader 态隐藏源码模式在两种 locale 下一致。
      const readerView = buildMenus({
        ...stubActions(),
        getLocale: () => locale,
        t: (key: MessageKey) => translate(locale, key),
        activeTabKind: () => 'reader',
      }).find((m) => m.id === 'view');
      expect(readerView?.items.some((i) => i.id === 'view-source-mode')).toBe(false);
    }
  });

  it('打开对话框过滤只剩单一「所有支持格式」条目 + 所有文件（T1）', () => {
    expect(OPEN_FILTERS).toHaveLength(2);
    expect([...OPEN_FILTERS[0]!.extensions].sort()).toEqual([
      'cbz',
      'epub',
      'fb2',
      'markdown',
      'md',
      'mobi',
      'pdf',
      'txt',
    ]);
    expect(OPEN_FILTERS[1]!.extensions).toEqual(['*']);
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
