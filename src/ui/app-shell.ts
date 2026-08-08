/**
 * `app-shell` — 极简应用外壳（R2 重构）：紧凑高频按钮 + 下拉菜单栏 + 标签栏 + 编辑区。
 *
 * 顶部由原单排按钮重构为「紧凑按钮（新建/打开/保存）+ 下拉菜单（文件/编辑/插入/视图/帮助）」，
 * 菜单项标注快捷键；菜单不挤占编辑区纵向空间（与原工具栏同高）。插入菜单与斜杠命令（R11）
 * 共用 `insert-commands` 元素目录。帮助菜单的快捷键速查（R5）动态读取快捷键注册表。
 *
 * 标签栏/主区（大纲侧栏槽位 + 编辑区）与 TabManager 接线保持不变。
 */

import type { InsertElementId } from '../editor/insert-commands.js';
import { INSERT_ELEMENTS } from '../editor/insert-commands.js';
import { BUILTIN_THEMES, type BuiltinThemeId } from '../theme/theme-service.js';
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
  /** 底部状态栏槽位（R6），由 status-bar 视图挂载字数/字符数。 */
  readonly statusBar: HTMLDivElement;
  /** 按当前标签状态重绘标签栏。 */
  renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void;
}

/** 紧凑高频按钮：新建/打开/保存（菜单旁保留，一次点击直达）。 */
const COMPACT_COMMANDS: ReadonlyArray<{
  action: 'onNew' | 'onOpen' | 'onSave';
  label: string;
  shortcut: string;
}> = [
  { action: 'onNew', label: '新建', shortcut: 'Ctrl+N' },
  { action: 'onOpen', label: '打开', shortcut: 'Ctrl+O' },
  { action: 'onSave', label: '保存', shortcut: 'Ctrl+S' },
];

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
        menuItem('file-recents', '最近打开…', () => undefined),
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
  const toolbar = document.createElement('div');
  toolbar.id = 'lightink-toolbar';
  const tabBar = document.createElement('div');
  tabBar.id = 'lightink-tabbar';
  const editorArea = document.createElement('div');
  editorArea.id = 'lightink-editor-area';
  const outlineSidebar = document.createElement('div');
  outlineSidebar.id = 'lightink-outline-sidebar';
  const mainRow = document.createElement('div');
  mainRow.id = 'lightink-main';
  mainRow.replaceChildren(outlineSidebar, editorArea);
  const statusBar = document.createElement('div');
  statusBar.id = 'lightink-statusbar';

  // 紧凑高频按钮。
  for (const cmd of COMPACT_COMMANDS) {
    const btn = document.createElement('button');
    btn.className = 'lightink-command';
    btn.dataset.action = cmd.action;
    btn.textContent = cmd.label;
    btn.title = `${cmd.label}（${cmd.shortcut}）`;
    btn.addEventListener('click', () => actions[cmd.action]());
    toolbar.appendChild(btn);
  }

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
  // R12：文件菜单「最近打开…」弹出最近文件列表。
  const fileMenu = menus.find((m) => m.id === 'file');
  if (fileMenu !== undefined) {
    const recentsItem = fileMenu.items.find((i) => i.id === 'file-recents');
    if (recentsItem !== undefined) {
      recentsItem.action = () => showRecents();
    }
  }
  const menuBar = createMenuBar({ menus });
  toolbar.appendChild(menuBar.element);

  root.replaceChildren(toolbar, tabBar, mainRow, statusBar);

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

  // R12：最近打开文件列表弹层。动态读取 actions.listRecents，逐行点击调用
  // actions.openRecent；「清空」调用 actions.clearRecents 并刷新为空态。
  function showRecents(): void {
    void actions
      .listRecents()
      .then((paths) => renderRecents(paths))
      .catch(() => undefined);
  }

  function renderRecents(paths: string[]): void {
    const overlay = document.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'lightink-modal-dialog';
    const title = document.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = '最近打开';
    const list = document.createElement('div');
    list.className = 'lightink-recents-list';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lightink-modal-close';
    close.textContent = '关闭';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'lightink-recents-clear';
    clearBtn.textContent = '清空';

    const renderRows = (items: readonly string[]): void => {
      list.replaceChildren();
      clearBtn.disabled = items.length === 0;
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'lightink-recents-empty';
        empty.textContent = '暂无最近打开的文件';
        list.appendChild(empty);
        return;
      }
      for (const path of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'lightink-recents-item';
        row.textContent = path;
        row.addEventListener('click', () => {
          dismiss();
          void actions.openRecent(path);
        });
        list.appendChild(row);
      }
    };
    clearBtn.addEventListener('click', () => {
      void actions.clearRecents().then(() => renderRows([]));
    });

    const footer = document.createElement('div');
    footer.className = 'lightink-recents-footer';
    footer.append(clearBtn, close);
    dialog.append(title, list, footer);
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
    renderRows(paths);
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

  return { toolbar, tabBar, editorArea, outlineSidebar, statusBar, renderTabBar };
}
