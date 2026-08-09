/**
 * `app-shell` — 沉浸写作外壳：默认隐藏菜单与标签 chrome，边缘/快捷键按需唤出；
 * 大纲槽位 + 编辑区仍由既有接线驱动。
 *
 * 顶部为下拉菜单（文件/编辑/插入/视图/帮助），菜单项标注快捷键。
 * 插入菜单与斜杠命令共用 `insert-commands` 元素目录。
 * 帮助菜单的快捷键速查动态读取快捷键注册表。
 */

import type { InsertElementId } from '../editor/insert-commands.js';
import { INSERT_ELEMENTS } from '../editor/insert-commands.js';
import { BUILTIN_THEMES, type BuiltinThemeId } from '../theme/theme-service.js';
import { createChromeController, type ChromeController } from './chrome-controller.js';
import {
  loadChromePinPrefs,
  saveChromePinPrefs,
  type ChromePinPrefs,
  type StorageLike,
} from './chrome-prefs.js';
import { renderCheatsheet, type CheatBinding } from './help-cheatsheet.js';
import { createMenuBar, type Menu, type MenuItem } from './menus.js';

export interface ShellTabInfo {
  id: string;
  title: string;
  dirty: boolean;
}

export interface TabBarCallbacks {
  onSwitch(id: string): void;
  onClose(id: string): void;
}

export interface AppShellActions {
  // 文件
  onNew(): void;
  onOpen(): void;
  /** R12：列出最近打开文件路径（MRU 序）。 */
  listRecents(): Promise<string[]>;
  /** R12：打开某个最近文件；返回是否成功打开（false=文件缺失等）。 */
  openRecent(path: string): Promise<boolean>;
  /** R12：清空最近打开列表。 */
  clearRecents(): Promise<void>;
  /** R13：打开活动文件版本历史弹层。 */
  onShowVersions(): void;
  /** R13：是否存在已保存的活动文件（决定「版本历史」是否可用）。 */
  hasActiveFile(): boolean;
  onSave(): void;
  onSaveAs(): void;
  onExportHtml(): void;
  onExportPdf(): void;
  // 编辑
  onUndo(): void;
  onRedo(): void;
  onCut(): void;
  onCopy(): void;
  onPaste(): void;
  // 插入（元素 id）
  onInsertElement(id: InsertElementId): void;
  // 视图
  onToggleTheme(): void;
  /** 应用某个内置预设主题（视图菜单逐项列出全部预设）。 */
  onApplyTheme(themeId: BuiltinThemeId): void;
  /** 当前主题 id（内置 id 或 'custom'），用于菜单标记当前项。 */
  getCurrentThemeId(): string;
  /** 热重载自定义主题文件（R15：接通既有 reloadCustomThemeFile）。 */
  onReloadCustomTheme(): void;
  /** 是否存在可重载的自定义主题文件。 */
  canReloadCustomTheme(): boolean;
  onToggleOutline(): void;
  onToggleSourceMode(): void;
  /** Toggle native window fullscreen (wired in main). */
  onToggleFullscreen(): void;
  /** Whether chrome navigation (menu + tabs) is currently pinned open. */
  isChromePinned(): boolean;
  /** Toggle pin for both menu and tabs chrome (fixed navigation). */
  onToggleChromePinned(): void;
  /** Reading font: larger / smaller / reset to display-tier default. */
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  /** Current font scale label (e.g. `100%`) for the menu. */
  getFontScaleLabel(): string;
  /** Translate UI string (en / zh-CN). */
  t(key: string, vars?: Readonly<Record<string, string>>): string;
  /** Format shortcut for current OS (⌘ on macOS). */
  formatShortcut(combo: string): string;
  /** Current UI locale. */
  getLocale(): 'en' | 'zh-CN';
  /** Switch UI language (rebuilds menus). */
  setLocale(locale: 'en' | 'zh-CN'): void;
}

export interface AppShellOptions {
  /** 快捷键速查表数据源（由快捷键注册表派生）。 */
  shortcutBindings(): readonly CheatBinding[];
  /**
   * Optional storage for chrome pin prefs (default: localStorage when available).
   * Pass null to disable persistence.
   */
  storage?: StorageLike | null;
  /** Initial pin prefs override (tests); otherwise loaded from storage. */
  initialPinPrefs?: ChromePinPrefs;
}

export interface AppShell {
  readonly toolbar: HTMLDivElement;
  readonly tabBar: HTMLDivElement;
  readonly editorArea: HTMLDivElement;
  /** 大纲侧栏槽位（主区左侧），由 outline 视图挂载内容。 */
  readonly outlineSidebar: HTMLDivElement;
  /** Immersive chrome visibility owner (menu + tabs surfaces). */
  readonly chrome: ChromeController;
  /** Reveal menu chrome and open the File menu (hotkey / first-run path). */
  revealMenu(): void;
  /** Toggle menu chrome reveal without forcing a specific panel open. */
  toggleMenuChrome(): void;
  /** Toggle tabs chrome reveal (hotkey path). */
  toggleTabsChrome(): void;
  /** Hold tabs chrome open while a nested UI (e.g. context menu) is active. */
  setTabsHold(hold: boolean): void;
  /** Whether both menu and tabs chrome are pinned open. */
  isChromePinned(): boolean;
  /** Pin/unpin menu + tabs together (fixed navigation bar). */
  setChromePinned(pinned: boolean): void;
  /** Toggle pin; returns the new pinned value. */
  toggleChromePinned(): boolean;
  /** Rebuild menu bar labels/items after language switch. */
  rebuildMenus(): void;
  /** 按当前标签状态重绘标签栏。 */
  renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void;
}

function menuItem(
  id: string,
  label: string | (() => string),
  action: () => void,
  shortcut = '',
  enabled?: () => boolean,
): MenuItem {
  return shortcut === '' ? { id, label, action, enabled } : { id, label, shortcut, action, enabled };
}

/** 菜单分隔符：渲染为 <hr>，不可点击（修复 P2[blocking]：此前分隔项漏设 separator:true）。 */
function separator(id: string): MenuItem {
  return { id, label: '', separator: true, action: () => undefined };
}

// ---------------------------------------------------------------------------
// R12「最近打开」子菜单（VS Code 式：悬停展开列表，替代模态弹窗）
// ---------------------------------------------------------------------------

/** 取路径的文件名（兼容 / 与 \；末尾分隔符已剥除）。 */
export function pathBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** 取路径的目录部分（无目录段返回空串，description 不渲染）。 */
export function pathDirName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : '';
}

/**
 * Abbreviate a directory path for the recents submenu secondary line.
 * Keeps the drive/root and the last 1–2 segments so siblings stay distinguishable
 * without the old RTL ellipsis hack that mangled mixed CJK/ASCII paths.
 *
 * Examples (maxLen=42):
 *   C:\Users\a\project\docs\req  →  C:\…\project\docs\req  (if short enough)
 *   very/long/unix/path/here     →  …/path/here
 */
export function abbreviatePath(path: string, maxLen = 42): string {
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed.length <= maxLen) return trimmed;
  const sep = trimmed.includes('\\') ? '\\' : '/';
  const parts = trimmed.split(/[\\/]/).filter((p) => p.length > 0);
  if (parts.length <= 1) {
    return `…${trimmed.slice(-(maxLen - 1))}`;
  }
  const tailCount = parts.length >= 3 ? 2 : 1;
  const tail = parts.slice(-tailCount).join(sep);
  const head = parts[0]!;
  // Prefer "C:\…\parent\name" when the drive/root is short.
  if (head.length <= 12) {
    const withHead = `${head}${sep}…${sep}${tail}`;
    if (withHead.length <= maxLen) return withHead;
  }
  const tailOnly = `…${sep}${tail}`;
  if (tailOnly.length <= maxLen) return tailOnly;
  return `…${sep}${tail.slice(-(maxLen - 2))}`;
}

export interface RecentsMenuActions {
  open(path: string): void;
  clear(): void;
}

/**
 * 构建「最近打开」子菜单项：
 *   两行布局 = 文件名（主行）+ 缩略目录（次行，muted）
 *   title = 完整路径（悬停可读）
 * 末尾分隔线 + 清空入口；空列表给占位禁用项。
 */
export function buildRecentsMenuItems(
  paths: readonly string[],
  actions: RecentsMenuActions,
  t: (key: string) => string = (k) => k,
): MenuItem[] {
  if (paths.length === 0) {
    return [
      {
        id: 'recents-empty',
        label: () => t('file.recentsEmpty'),
        action: () => undefined,
        enabled: () => false,
      },
    ];
  }
  return [
    ...paths.map((path, index) => {
      const dir = pathDirName(path);
      return {
        id: `recent-${index}`,
        label: pathBaseName(path),
        description: dir === '' ? undefined : abbreviatePath(dir),
        title: path,
        action: () => actions.open(path),
      };
    }),
    separator('recents-sep'),
    { id: 'recents-clear', label: () => t('file.clearRecents'), action: actions.clear },
  ];
}

function sc(actions: AppShellActions, combo: string): string {
  return actions.formatShortcut(combo);
}

export function buildMenus(actions: AppShellActions): Menu[] {
  const t = (key: string) => actions.t(key);
  const insertItems: MenuItem[] = INSERT_ELEMENTS.map((element) =>
    menuItem(
      `insert-${element.id}`,
      () => t(`insert.${element.id}`),
      () => actions.onInsertElement(element.id),
      element.id === 'link'
        ? sc(actions, 'Ctrl+K')
        : element.id === 'image'
          ? sc(actions, 'Ctrl+Alt+I')
          : '',
    ),
  );

  /** View → Theme submenu: toggle + presets + custom reload. */
  const themeSubmenu = (): MenuItem[] => [
    menuItem(
      'view-theme-toggle',
      () => t('view.toggleTheme'),
      actions.onToggleTheme,
      sc(actions, 'Ctrl+J'),
    ),
    separator('view-theme-sep1'),
    // R15：逐项列出全部预设主题，当前主题禁用（不可重复选择）。
    ...BUILTIN_THEMES.map((theme) =>
      menuItem(
        `view-theme-${theme.id}`,
        () => t(`theme.${theme.id}`),
        () => actions.onApplyTheme(theme.id),
        '',
        () => actions.getCurrentThemeId() !== theme.id,
      ),
    ),
    separator('view-theme-sep2'),
    menuItem(
      'view-reload-custom-theme',
      () => t('view.reloadCustomTheme'),
      actions.onReloadCustomTheme,
      '',
      () => actions.canReloadCustomTheme(),
    ),
  ];

  return [
    {
      id: 'file',
      label: () => t('menu.file'),
      items: [
        menuItem('file-new', () => t('file.new'), actions.onNew, sc(actions, 'Ctrl+N')),
        menuItem('file-open', () => t('file.open'), actions.onOpen, sc(actions, 'Ctrl+O')),
        // R12：VS Code 式「最近打开」子菜单——悬停展开列表（打开时现取，
        // 读取失败按空列表处理），不再弹模态层。
        {
          id: 'file-recents',
          label: () => t('file.recents'),
          action: () => undefined,
          submenu: () =>
            actions
              .listRecents()
              .catch(() => [] as string[])
              .then((paths) =>
                buildRecentsMenuItems(
                  paths,
                  {
                    open: (path) => void actions.openRecent(path),
                    clear: () => void actions.clearRecents(),
                  },
                  t,
                ),
              ),
        },
        separator('file-sep1'),
        menuItem('file-save', () => t('file.save'), actions.onSave, sc(actions, 'Ctrl+S')),
        menuItem('file-save-as', () => t('file.saveAs'), actions.onSaveAs, sc(actions, 'Ctrl+Shift+S')),
        separator('file-sep2'),
        menuItem(
          'file-versions',
          () => t('file.versions'),
          actions.onShowVersions,
          '',
          () => actions.hasActiveFile(),
        ),
        menuItem('file-export-html', () => t('file.exportHtml'), actions.onExportHtml),
        menuItem('file-export-pdf', () => t('file.exportPdf'), actions.onExportPdf),
      ],
    },
    {
      id: 'edit',
      label: () => t('menu.edit'),
      items: [
        menuItem('edit-undo', () => t('edit.undo'), actions.onUndo, sc(actions, 'Ctrl+Z')),
        menuItem('edit-redo', () => t('edit.redo'), actions.onRedo, sc(actions, 'Ctrl+Shift+Z')),
        separator('edit-sep1'),
        menuItem('edit-cut', () => t('edit.cut'), actions.onCut, sc(actions, 'Ctrl+X')),
        menuItem('edit-copy', () => t('edit.copy'), actions.onCopy, sc(actions, 'Ctrl+C')),
        menuItem('edit-paste', () => t('edit.paste'), actions.onPaste, sc(actions, 'Ctrl+V')),
      ],
    },
    { id: 'insert', label: () => t('menu.insert'), items: insertItems },
    {
      id: 'view',
      label: () => t('menu.view'),
      items: [
        // Theme controls live under a single submenu (3rd level from the top bar).
        {
          id: 'view-theme',
          label: () => t('view.theme'),
          action: () => undefined,
          submenu: themeSubmenu,
        },
        separator('view-theme-sep'),
        menuItem(
          'view-pin-chrome',
          () => (actions.isChromePinned() ? t('view.unpinChrome') : t('view.pinChrome')),
          actions.onToggleChromePinned,
          sc(actions, 'Alt+P'),
        ),
        menuItem(
          'view-fullscreen',
          () => t('view.fullscreen'),
          actions.onToggleFullscreen,
          sc(actions, 'F11'),
        ),
        separator('view-chrome-sep'),
        menuItem(
          'view-outline',
          () => t('view.outline'),
          actions.onToggleOutline,
          sc(actions, 'Ctrl+Shift+L'),
        ),
        menuItem(
          'view-source-mode',
          () => t('view.sourceMode'),
          actions.onToggleSourceMode,
          sc(actions, 'Ctrl+/'),
          () => true,
        ),
        separator('view-font-sep'),
        menuItem('view-zoom-in', () => t('view.zoomIn'), actions.onZoomIn, sc(actions, 'Ctrl+=')),
        menuItem('view-zoom-out', () => t('view.zoomOut'), actions.onZoomOut, sc(actions, 'Ctrl+-')),
        menuItem(
          'view-zoom-reset',
          () => `${t('view.zoomReset')} (${actions.getFontScaleLabel()})`,
          actions.onZoomReset,
          sc(actions, 'Ctrl+0'),
        ),
      ],
    },
    {
      id: 'help',
      label: () => t('menu.help'),
      items: [
        menuItem('help-cheatsheet', () => t('help.cheatsheet'), () => undefined),
        separator('help-lang-sep'),
        menuItem(
          'help-lang-en',
          () => t('view.language.en'),
          () => actions.setLocale('en'),
          '',
          () => actions.getLocale() !== 'en',
        ),
        menuItem(
          'help-lang-zh',
          () => t('view.language.zh'),
          () => actions.setLocale('zh-CN'),
          '',
          () => actions.getLocale() !== 'zh-CN',
        ),
      ],
    },
  ];
}

function resolveStorage(options: AppShellOptions): StorageLike | null {
  if (options.storage !== undefined) {
    return options.storage;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    /* privacy mode */
  }
  return null;
}

export function createAppShell(
  root: HTMLElement,
  actions: AppShellActions,
  options: AppShellOptions,
): AppShell {
  const chrome = createChromeController();
  const storage = resolveStorage(options);
  const pinPrefs = options.initialPinPrefs ?? loadChromePinPrefs(storage);
  if (pinPrefs.menu) {
    chrome.setPinned('menu', true);
  }
  if (pinPrefs.tabs) {
    chrome.setPinned('tabs', true);
  }

  const chromeHost = document.createElement('div');
  chromeHost.id = 'lightink-chrome-host';
  chromeHost.className = 'lightink-chrome-host';

  const menuTrigger = document.createElement('div');
  menuTrigger.id = 'lightink-menu-trigger';
  menuTrigger.className = 'lightink-chrome-trigger lightink-chrome-trigger--menu';
  menuTrigger.setAttribute('role', 'button');
  menuTrigger.setAttribute('aria-label', actions.t('chrome.showMenu'));
  menuTrigger.tabIndex = 0;

  const toolbar = document.createElement('div');
  toolbar.id = 'lightink-toolbar';

  const tabsHost = document.createElement('div');
  tabsHost.id = 'lightink-tabs-host';
  tabsHost.className = 'lightink-tabs-host';

  const tabsTrigger = document.createElement('div');
  tabsTrigger.id = 'lightink-tabs-trigger';
  tabsTrigger.className = 'lightink-chrome-trigger lightink-chrome-trigger--tabs';
  tabsTrigger.setAttribute('role', 'button');
  tabsTrigger.setAttribute('aria-label', actions.t('chrome.showTabs'));
  tabsTrigger.tabIndex = 0;

  const tabBar = document.createElement('div');
  tabBar.id = 'lightink-tabbar';

  const editorArea = document.createElement('div');
  editorArea.id = 'lightink-editor-area';
  const outlineSidebar = document.createElement('div');
  outlineSidebar.id = 'lightink-outline-sidebar';
  const mainRow = document.createElement('div');
  mainRow.id = 'lightink-main';
  mainRow.replaceChildren(outlineSidebar, editorArea);

  // 下拉菜单栏（语言切换时 rebuildMenus 整栏重建）。
  function wireHelpCheatsheet(menus: Menu[]): void {
    const helpMenu = menus.find((m) => m.id === 'help');
    if (helpMenu === undefined) return;
    const cheatsheetItem = helpMenu.items.find((i) => i.id === 'help-cheatsheet');
    if (cheatsheetItem !== undefined) {
      cheatsheetItem.action = () => showCheatsheet(options.shortcutBindings());
    }
  }

  const initialMenus = buildMenus(actions);
  wireHelpCheatsheet(initialMenus);
  const menuBar = createMenuBar({
    menus: initialMenus,
    loadingLabel: () => actions.t('menu.loading'),
    onOpenChange: (openMenuId) => {
      const hold = openMenuId !== null;
      chrome.setHold('menu', hold);
      syncMenuChrome();
      // setHold(false) schedules leave hysteresis when pointer already left;
      // resync class after the controller timer so is-menu-revealed can clear.
      if (!hold) {
        afterLeaveSync(syncMenuChrome);
      }
    },
  });
  toolbar.appendChild(menuBar.element);

  function rebuildMenus(): void {
    const next = buildMenus(actions);
    wireHelpCheatsheet(next);
    menuBar.rebuild(next, { loadingLabel: () => actions.t('menu.loading') });
  }

  chromeHost.replaceChildren(menuTrigger, toolbar);
  tabsHost.replaceChildren(tabsTrigger, tabBar);
  root.replaceChildren(chromeHost, tabsHost, mainRow);
  root.classList.add('lightink-immersive');

  function syncMenuChrome(): void {
    const revealed = chrome.isRevealed('menu');
    const pinned = chrome.isPinned('menu');
    chromeHost.classList.toggle('is-menu-revealed', revealed);
    chromeHost.classList.toggle('is-chrome-pinned', pinned);
    menuTrigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');
    menuTrigger.hidden = pinned;
  }

  function syncTabsChrome(): void {
    const revealed = chrome.isRevealed('tabs');
    const pinned = chrome.isPinned('tabs');
    tabsHost.classList.toggle('is-tabs-revealed', revealed);
    tabsHost.classList.toggle('is-chrome-pinned', pinned);
    tabsTrigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');
    tabsTrigger.hidden = pinned;
  }

  function persistPinPrefs(): void {
    saveChromePinPrefs(storage, {
      menu: chrome.isPinned('menu'),
      tabs: chrome.isPinned('tabs'),
    });
  }

  function isChromePinned(): boolean {
    return chrome.isPinned('menu') && chrome.isPinned('tabs');
  }

  function setChromePinned(pinned: boolean): void {
    chrome.setPinned('menu', pinned);
    chrome.setPinned('tabs', pinned);
    syncMenuChrome();
    syncTabsChrome();
    persistPinPrefs();
    if (!pinned) {
      afterLeaveSync(syncMenuChrome);
      afterLeaveSync(syncTabsChrome);
    }
  }

  function toggleChromePinned(): boolean {
    const next = !isChromePinned();
    setChromePinned(next);
    return next;
  }

  function revealMenu(): void {
    chrome.reveal('menu');
    syncMenuChrome();
    menuBar.openMenu('file');
  }

  function toggleMenuChrome(): void {
    chrome.toggle('menu');
    syncMenuChrome();
    if (!chrome.isRevealed('menu')) {
      menuBar.closeAll();
    }
  }

  function toggleTabsChrome(): void {
    chrome.toggle('tabs');
    syncTabsChrome();
  }

  function setTabsHold(hold: boolean): void {
    chrome.setHold('tabs', hold);
    syncTabsChrome();
    // Match pointerleave: hold release may schedule leave while revealed is still
    // true; delayed sync clears is-tabs-revealed after hysteresis.
    if (!hold) {
      afterLeaveSync(syncTabsChrome);
    }
  }

  function afterLeaveSync(sync: () => void): void {
    // Match chrome-controller leave hysteresis (180ms) with a small buffer.
    const schedule =
      typeof setTimeout === 'undefined'
        ? (fn: () => void) => {
            fn();
            return 0;
          }
        : (fn: () => void) => setTimeout(fn, 200);
    schedule(sync);
  }

  function bindSurfacePointer(
    surface: 'menu' | 'tabs',
    elements: readonly HTMLElement[],
    sync: () => void,
  ): void {
    for (const el of elements) {
      el.addEventListener('pointerenter', () => {
        chrome.pointerEnter(surface);
        sync();
      });
      el.addEventListener('pointerleave', () => {
        chrome.pointerLeave(surface);
        afterLeaveSync(sync);
      });
    }
  }

  bindSurfacePointer('menu', [menuTrigger, toolbar], syncMenuChrome);
  bindSurfacePointer('tabs', [tabsTrigger, tabBar], syncTabsChrome);

  menuTrigger.addEventListener('click', () => {
    chrome.reveal('menu');
    syncMenuChrome();
  });
  menuTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chrome.reveal('menu');
      syncMenuChrome();
    }
  });

  tabsTrigger.addEventListener('click', () => {
    chrome.reveal('tabs');
    syncTabsChrome();
  });
  tabsTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chrome.reveal('tabs');
      syncTabsChrome();
    }
  });

  // Tab context-menu hold is owned by main via setTabsHold + createContextMenu onClose.

  syncMenuChrome();
  syncTabsChrome();

  function showCheatsheet(bindings: readonly CheatBinding[]): void {
    const overlay = document.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'lightink-modal-dialog';
    const title = document.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = actions.t('help.cheatsheet');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lightink-modal-close';
    close.textContent = actions.t('dialog.close');
    dialog.append(title, renderCheatsheet(bindings), close);
    overlay.appendChild(dialog);
    function dismiss(): void {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        dismiss();
      }
    }
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        dismiss();
      }
    });
    close.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    close.focus();
  }

  function renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void {
    // Always render the full open-tab list; visibility is chrome pin/reveal CSS only.
    tabBar.replaceChildren(
      ...tabs.map((tab) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lightink-tab';
        btn.dataset.tabId = tab.id;
        if (tab.id === activeId) {
          btn.classList.add('active');
        }
        if (tab.dirty) {
          btn.classList.add('dirty');
        }
        const label = document.createElement('span');
        label.className = 'lightink-tab-label';
        label.textContent = tab.dirty ? `● ${tab.title}` : tab.title;
        btn.appendChild(label);
        btn.addEventListener('click', () => callbacks.onSwitch(tab.id));
        const close = document.createElement('span');
        close.className = 'lightink-tab-close';
        close.textContent = '×';
        close.setAttribute('aria-label', `关闭 ${tab.title}`);
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          callbacks.onClose(tab.id);
        });
        btn.appendChild(close);
        return btn;
      }),
    );
  }

  return {
    toolbar,
    tabBar,
    editorArea,
    outlineSidebar,
    chrome,
    revealMenu,
    toggleMenuChrome,
    toggleTabsChrome,
    setTabsHold,
    isChromePinned,
    setChromePinned,
    toggleChromePinned,
    rebuildMenus,
    renderTabBar,
  };
}
