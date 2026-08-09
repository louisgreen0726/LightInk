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
}

export interface AppShellOptions {
  /** 快捷键速查表数据源（由快捷键注册表派生）。 */
  shortcutBindings(): readonly CheatBinding[];
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
  /** 按当前标签状态重绘标签栏。 */
  renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void;
}

function menuItem(
  id: string,
  label: string,
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

/** 取路径的目录部分（无目录段返回空串，hint 不渲染）。 */
export function pathDirName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : '';
}

export interface RecentsMenuActions {
  open(path: string): void;
  clear(): void;
}

/**
 * 构建「最近打开」子菜单项：每行 = 文件名（label）+ 目录（右侧弱化 hint，
 * 头部省略），末尾分隔线 + 清空入口；空列表给占位禁用项。
 */
export function buildRecentsMenuItems(
  paths: readonly string[],
  actions: RecentsMenuActions,
): MenuItem[] {
  if (paths.length === 0) {
    return [
      { id: 'recents-empty', label: '（无最近打开的文件）', action: () => undefined, enabled: () => false },
    ];
  }
  return [
    ...paths.map((path, index) => ({
      id: `recent-${index}`,
      label: pathBaseName(path),
      hint: pathDirName(path),
      action: () => actions.open(path),
    })),
    separator('recents-sep'),
    { id: 'recents-clear', label: '清空最近打开', action: actions.clear },
  ];
}

export function buildMenus(actions: AppShellActions): Menu[] {
  const insertItems: MenuItem[] = INSERT_ELEMENTS.map((element) =>
    menuItem(
      `insert-${element.id}`,
      element.label,
      () => actions.onInsertElement(element.id),
      element.id === 'link' ? 'Ctrl+K' : element.id === 'image' ? 'Ctrl+Alt+I' : '',
    ),
  );

  return [
    {
      id: 'file',
      label: '文件',
      items: [
        menuItem('file-new', '新建', actions.onNew, 'Ctrl+N'),
        menuItem('file-open', '打开', actions.onOpen, 'Ctrl+O'),
        // R12：VS Code 式「最近打开」子菜单——悬停展开列表（打开时现取，
        // 读取失败按空列表处理），不再弹模态层。
        {
          id: 'file-recents',
          label: '最近打开',
          action: () => undefined,
          submenu: () =>
            actions
              .listRecents()
              .catch(() => [] as string[])
              .then((paths) =>
                buildRecentsMenuItems(paths, {
                  open: (path) => void actions.openRecent(path),
                  clear: () => void actions.clearRecents(),
                }),
              ),
        },
        separator('file-sep1'),
        menuItem('file-save', '保存', actions.onSave, 'Ctrl+S'),
        menuItem('file-save-as', '另存为', actions.onSaveAs, 'Ctrl+Shift+S'),
        separator('file-sep2'),
        menuItem('file-versions', '版本历史…', actions.onShowVersions, '', () => actions.hasActiveFile()),
        menuItem('file-export-html', '导出 HTML', actions.onExportHtml),
        menuItem('file-export-pdf', '导出 PDF', actions.onExportPdf),
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        menuItem('edit-undo', '撤销', actions.onUndo),
        menuItem('edit-redo', '重做', actions.onRedo),
        separator('edit-sep1'),
        menuItem('edit-cut', '剪切', actions.onCut),
        menuItem('edit-copy', '复制', actions.onCopy),
        menuItem('edit-paste', '粘贴', actions.onPaste),
      ],
    },
    { id: 'insert', label: '插入', items: insertItems },
    {
      id: 'view',
      label: '视图',
      items: [
        menuItem('view-theme-toggle', '切换主题（浅/深）', actions.onToggleTheme, 'Ctrl+J'),
        separator('view-theme-sep1'),
        // R15：逐项列出全部预设主题，当前主题禁用（不可重复选择）。
        ...BUILTIN_THEMES.map((theme) =>
          menuItem(
            `view-theme-${theme.id}`,
            theme.label,
            () => actions.onApplyTheme(theme.id),
            '',
            () => actions.getCurrentThemeId() !== theme.id,
          ),
        ),
        separator('view-theme-sep2'),
        // R15：热重载自定义主题文件（无自定义文件时禁用）。
        menuItem(
          'view-reload-custom-theme',
          '重新加载自定义主题',
          actions.onReloadCustomTheme,
          '',
          () => actions.canReloadCustomTheme(),
        ),
        separator('view-theme-sep3'),
        menuItem('view-outline', '大纲显隐', actions.onToggleOutline, 'Ctrl+Shift+L'),
        // T7/R10 已接通：整窗源码模式。
        menuItem('view-source-mode', '源码模式', actions.onToggleSourceMode, 'Ctrl+/', () => true),
      ],
    },
    { id: 'help', label: '帮助', items: [menuItem('help-cheatsheet', '快捷键速查', () => undefined)] },
  ];
}

export function createAppShell(
  root: HTMLElement,
  actions: AppShellActions,
  options: AppShellOptions,
): AppShell {
  const chrome = createChromeController();
  const chromeHost = document.createElement('div');
  chromeHost.id = 'lightink-chrome-host';
  chromeHost.className = 'lightink-chrome-host';

  const menuTrigger = document.createElement('div');
  menuTrigger.id = 'lightink-menu-trigger';
  menuTrigger.className = 'lightink-chrome-trigger lightink-chrome-trigger--menu';
  menuTrigger.setAttribute('role', 'button');
  menuTrigger.setAttribute('aria-label', '显示菜单栏');
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
  tabsTrigger.setAttribute('aria-label', '显示标签栏');
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

  // 下拉菜单栏。
  const menus = buildMenus(actions);
  // 帮助菜单的快捷键速查弹出层。
  const helpMenu = menus.find((m) => m.id === 'help');
  if (helpMenu !== undefined) {
    const cheatsheetItem = helpMenu.items.find((i) => i.id === 'help-cheatsheet');
    if (cheatsheetItem !== undefined) {
      cheatsheetItem.action = () => showCheatsheet(options.shortcutBindings());
    }
  }
  const menuBar = createMenuBar({
    menus,
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

  chromeHost.replaceChildren(menuTrigger, toolbar);
  tabsHost.replaceChildren(tabsTrigger, tabBar);
  root.replaceChildren(chromeHost, tabsHost, mainRow);
  root.classList.add('lightink-immersive');

  function syncMenuChrome(): void {
    const revealed = chrome.isRevealed('menu');
    chromeHost.classList.toggle('is-menu-revealed', revealed);
    menuTrigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');
  }

  function syncTabsChrome(): void {
    const revealed = chrome.isRevealed('tabs');
    tabsHost.classList.toggle('is-tabs-revealed', revealed);
    tabsTrigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');
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
    title.textContent = '快捷键速查';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lightink-modal-close';
    close.textContent = '关闭';
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
    tabBar.replaceChildren(
      ...tabs.map((tab) => {
        const btn = document.createElement('button');
        btn.className = 'lightink-tab';
        btn.dataset.tabId = tab.id;
        if (tab.id === activeId) {
          btn.classList.add('active');
        }
        btn.textContent = tab.dirty ? `● ${tab.title}` : tab.title;
        btn.addEventListener('click', () => callbacks.onSwitch(tab.id));
        const close = document.createElement('span');
        close.className = 'lightink-tab-close';
        close.textContent = ' ×';
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
    renderTabBar,
  };
}
