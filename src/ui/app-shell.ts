/**
 * `app-shell` — 极简应用外壳（T6, R11）：命令行 + 标签栏 + 编辑区。
 *
 * 布局：顶部一排紧凑命令按钮（新建/打开/保存/另存为/主题，均一次点击，
 * 并有对应快捷键 tooltip），其下标签栏，其余为主区（左侧大纲侧栏槽位 + 编辑区，
 * T7 加入）。无冗余工具栏堆叠、无重型装饰；样式在 theme.css，配色全部取自主题令牌。
 *
 * 承接原 main.ts 的临时工具栏/标签条逻辑，TabManager 接线保持不变
 * （宿主元素仍由入口创建并挂入 editorArea）。
 */

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
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onToggleTheme(): void;
}

export interface AppShell {
  readonly toolbar: HTMLDivElement;
  readonly tabBar: HTMLDivElement;
  readonly editorArea: HTMLDivElement;
  /** T7：大纲侧栏槽位（主区左侧），由 outline 视图挂载内容。 */
  readonly outlineSidebar: HTMLDivElement;
  /** 按当前标签状态重绘标签栏（替代原 main.ts 的内联实现）。 */
  renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void;
}

/** 各命令按钮的标签与快捷键提示。 */
const COMMANDS: ReadonlyArray<{
  action: keyof AppShellActions;
  label: string;
  shortcut: string;
}> = [
  { action: 'onNew', label: '新建', shortcut: 'Ctrl+N' },
  { action: 'onOpen', label: '打开', shortcut: 'Ctrl+O' },
  { action: 'onSave', label: '保存', shortcut: 'Ctrl+S' },
  { action: 'onSaveAs', label: '另存为', shortcut: 'Ctrl+Shift+S' },
  { action: 'onToggleTheme', label: '主题', shortcut: 'Ctrl+J' },
];

export function createAppShell(root: HTMLElement, actions: AppShellActions): AppShell {
  const toolbar = document.createElement('div');
  toolbar.id = 'lightink-toolbar';
  const tabBar = document.createElement('div');
  tabBar.id = 'lightink-tabbar';
  const editorArea = document.createElement('div');
  editorArea.id = 'lightink-editor-area';
  // T7：主区 = 大纲侧栏槽位 + 编辑区（横向排布）。
  const outlineSidebar = document.createElement('div');
  outlineSidebar.id = 'lightink-outline-sidebar';
  const mainRow = document.createElement('div');
  mainRow.id = 'lightink-main';
  mainRow.replaceChildren(outlineSidebar, editorArea);
  root.replaceChildren(toolbar, tabBar, mainRow);

  for (const cmd of COMMANDS) {
    const btn = document.createElement('button');
    btn.className = 'lightink-command';
    btn.dataset.action = cmd.action;
    btn.textContent = cmd.label;
    btn.title = `${cmd.label}（${cmd.shortcut}）`;
    btn.addEventListener('click', () => actions[cmd.action]());
    toolbar.appendChild(btn);
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

  return { toolbar, tabBar, editorArea, outlineSidebar, renderTabBar };
}
