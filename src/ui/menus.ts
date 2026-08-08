/**
 * `menus` — 下拉菜单栏（R2）。纯 DOM 渲染 + 结构化事件，可 headless 测试。
 *
 * 顶部菜单栏由若干下拉菜单组成（文件/编辑/插入/视图/帮助）。点击触发器展开面板，
 * 再次点击或外部 pointerdown / Esc 关闭。菜单项标注快捷键；`enabled` 返回 false 时禁用。
 * 不挤占编辑区纵向空间（菜单栏与原工具栏同高，样式见 theme.css）。
 */

export interface MenuItem {
  id: string;
  label: string;
  /** 显示在标签右侧的快捷键提示。 */
  shortcut?: string;
  /** 触发该菜单项的动作。 */
  action(): void;
  /** 返回 false 时该项禁用（不可点击）。 */
  enabled?: () => boolean;
  /** 为 true 时渲染为分隔线，忽略其余字段。 */
  separator?: boolean;
}

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

export interface MenuBarSpec {
  menus: Menu[];
}

export interface MenuBar {
  /** 挂入工具栏的根元素。 */
  readonly element: HTMLDivElement;
  /** 打开指定菜单（测试与键盘导航用）。 */
  openMenu(menuId: string): void;
  /** 关闭所有下拉面板。 */
  closeAll(): void;
}

export function createMenuBar(spec: MenuBarSpec, doc: Document = document): MenuBar {
  const element = doc.createElement('div');
  element.className = 'lightink-menu-bar';
  let openMenuId: string | null = null;
  const panels = new Map<string, HTMLDivElement>();
  const itemButtons = new Map<string, HTMLButtonElement>();

  function closeAll(): void {
    for (const panel of panels.values()) {
      panel.hidden = true;
    }
    openMenuId = null;
  }

  function openMenu(menuId: string): void {
    closeAll();
    const panel = panels.get(menuId);
    if (panel !== undefined) {
      panel.hidden = false;
      openMenuId = menuId;
    }
  }

  function refreshItemEnabled(item: MenuItem): void {
    const btn = itemButtons.get(item.id);
    if (btn !== undefined && item.enabled !== undefined) {
      btn.disabled = !item.enabled();
    }
  }

  /** 打开菜单前刷新其所有项的启用态（上下文相关项据此更新）。 */
  function refreshMenu(menuId: string): void {
    const menu = spec.menus.find((m) => m.id === menuId);
    if (menu === undefined) {
      return;
    }
    for (const item of menu.items) {
      if (item.separator !== true) {
        refreshItemEnabled(item);
      }
    }
  }

  for (const menu of spec.menus) {
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'lightink-menu-trigger';
    trigger.dataset.menuId = menu.id;
    trigger.textContent = menu.label;
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openMenuId === menu.id) {
        closeAll();
      } else {
        refreshMenu(menu.id);
        openMenu(menu.id);
      }
    });

    const panel = doc.createElement('div');
    panel.className = 'lightink-menu-panel';
    panel.dataset.menuId = menu.id;
    panel.hidden = true;
    for (const item of menu.items) {
      if (item.separator === true) {
        const sep = doc.createElement('hr');
        sep.className = 'lightink-menu-separator';
        panel.appendChild(sep);
        continue;
      }
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'lightink-menu-item';
      btn.dataset.itemId = item.id;
      btn.textContent = item.shortcut ? `${item.label} ${item.shortcut}` : item.label;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        refreshItemEnabled(item);
        if (btn.disabled) {
          return;
        }
        item.action();
        closeAll();
      });
      panel.appendChild(btn);
      itemButtons.set(item.id, btn);
      refreshItemEnabled(item);
    }
    panels.set(menu.id, panel);

    const wrap = doc.createElement('div');
    wrap.className = 'lightink-menu';
    wrap.append(trigger, panel);
    element.appendChild(wrap);
  }

  // 外部 pointerdown 与 Esc 关闭菜单。
  const onPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (target !== null && element.contains(target)) {
      return;
    }
    closeAll();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      closeAll();
    }
  };
  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('keydown', onKeyDown);

  return { element, openMenu, closeAll };
}
