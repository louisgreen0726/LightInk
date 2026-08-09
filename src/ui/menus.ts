/**
 * `menus` — 下拉菜单栏（R2）。纯 DOM 渲染 + 结构化事件，可 headless 测试。
 *
 * 顶部菜单栏由若干下拉菜单组成（文件/编辑/插入/视图/帮助）。点击触发器展开面板，
 * 再次点击或外部 pointerdown / Esc 关闭。菜单项标注快捷键（右侧弱化对齐）；
 * `enabled` 返回 false 时禁用。不挤占编辑区纵向空间（菜单栏与原工具栏同高，
 * 样式见 theme.css）。
 *
 * 子菜单（VS Code 式「最近打开」）：项携带 `submenu` 加载器（同步或异步，打开时
 * 现取数据）时渲染为 ▸ 触发器，悬停/点击在其右侧展开浮层；悬停其他项、外部
 * pointerdown、Esc 或 closeAll 时关闭。异步加载期间显示「加载中…」占位，
 * 加载完成前浮层被关闭则丢弃结果。
 */

export interface MenuItem {
  id: string;
  /** Static label, or factory refreshed when the parent menu opens. */
  label: string | (() => string);
  /** 显示在标签右侧的快捷键提示（弱化右对齐）。 */
  shortcut?: string;
  /** 右侧弱化提示（如最近文件的目录路径，省略号截断头部）。与 shortcut 二选一。 */
  hint?: string;
  /** 触发该菜单项的动作。 */
  action(): void;
  /** 返回 false 时该项禁用（不可点击）。 */
  enabled?: () => boolean;
  /** 为 true 时渲染为分隔线，忽略其余字段。 */
  separator?: boolean;
  /** 子菜单加载器：存在时该项为 ▸ 触发器（action 不触发），打开时现取子项。 */
  submenu?: () => MenuItem[] | Promise<MenuItem[]>;
}

function resolveMenuLabel(label: string | (() => string)): string {
  return typeof label === 'function' ? label() : label;
}

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

export interface MenuBarSpec {
  menus: Menu[];
  /** Fires when open menu id changes (null = all closed). Used by immersive chrome hold. */
  onOpenChange?: (openMenuId: string | null) => void;
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
  /** 当前打开的子菜单浮层（同时最多一个）。 */
  let openFlyout: { itemId: string; el: HTMLDivElement } | null = null;

  function closeFlyout(): void {
    openFlyout?.el.remove();
    openFlyout = null;
  }

  function notifyOpenChange(next: string | null): void {
    if (openMenuId === next) {
      return;
    }
    openMenuId = next;
    spec.onOpenChange?.(next);
  }

  function closeAll(): void {
    closeFlyout();
    for (const panel of panels.values()) {
      panel.hidden = true;
    }
    notifyOpenChange(null);
  }

  function openMenu(menuId: string): void {
    closeFlyout();
    for (const panel of panels.values()) {
      panel.hidden = true;
    }
    const panel = panels.get(menuId);
    if (panel !== undefined) {
      panel.hidden = false;
      notifyOpenChange(menuId);
    } else {
      notifyOpenChange(null);
    }
  }

  function refreshItemEnabled(item: MenuItem): void {
    const btn = itemButtons.get(item.id);
    if (btn === undefined) {
      return;
    }
    if (item.enabled !== undefined) {
      btn.disabled = !item.enabled();
    }
    // Prefer class walk over querySelector so node fakes without full CSSOM still work.
    const children = Array.from(btn.children) as HTMLElement[];
    const labelEl =
      children.find((child) => child.classList?.contains('lightink-menu-item-label')) ?? null;
    if (labelEl !== null) {
      labelEl.textContent = resolveMenuLabel(item.label);
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

  /** 渲染一个菜单项按钮（主面板与子菜单浮层共用）。 */
  function createItemButton(item: MenuItem, onAction: () => void): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'lightink-menu-item';
    btn.dataset.itemId = item.id;
    const label = doc.createElement('span');
    label.className = 'lightink-menu-item-label';
    label.textContent = resolveMenuLabel(item.label);
    btn.appendChild(label);
    const hintText = item.hint ?? item.shortcut;
    if (hintText !== undefined && hintText !== '') {
      const hint = doc.createElement('span');
      hint.className =
        item.hint !== undefined
          ? 'lightink-menu-item-hint lightink-menu-item-hint--path'
          : 'lightink-menu-item-hint';
      hint.textContent = hintText;
      btn.appendChild(hint);
    }
    if (item.submenu !== undefined) {
      btn.classList.add('lightink-menu-item--sub');
      const arrow = doc.createElement('span');
      arrow.className = 'lightink-menu-item-sub-arrow';
      arrow.textContent = '▸';
      btn.appendChild(arrow);
    }
    if (item.enabled !== undefined) {
      btn.disabled = !item.enabled();
    }
    // 子菜单触发器的点击行为由调用方挂载（展开浮层而非触发 action）。
    if (item.submenu === undefined) {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (btn.disabled) {
          return;
        }
        item.action();
        onAction();
      });
    }
    return btn;
  }

  /** 打开（或切换）某触发器项的子菜单浮层；异步加载期间显示占位。 */
  function openSubmenu(item: MenuItem, btn: HTMLButtonElement, panel: HTMLDivElement): void {
    if (item.submenu === undefined) return;
    closeFlyout();
    const flyout = doc.createElement('div');
    flyout.className = 'lightink-menu-flyout';
    flyout.style.top = `${btn.offsetTop}px`;
    flyout.style.left = '100%';
    const loading = createItemButton(
      { id: `${item.id}-loading`, label: '加载中…', enabled: () => false, action: () => undefined },
      () => undefined,
    );
    flyout.appendChild(loading);
    openFlyout = { itemId: item.id, el: flyout };
    panel.appendChild(flyout);

    void Promise.resolve(item.submenu()).then((items) => {
      // 加载期间浮层已被关闭/切换 → 丢弃。
      if (openFlyout === null || openFlyout.el !== flyout) return;
      flyout.replaceChildren(
        ...items.map((sub) => {
          if (sub.separator === true) {
            const sep = doc.createElement('hr');
            sep.className = 'lightink-menu-separator';
            return sep;
          }
          return createItemButton(sub, () => closeAll());
        }),
      );
      // 视口右缘放不下时翻到面板左侧。
      const rect = flyout.getBoundingClientRect();
      const viewportWidth =
        typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth;
      if (rect.right > viewportWidth) {
        flyout.style.left = 'auto';
        flyout.style.right = '100%';
      }
    });
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
    // VS Code 式菜单栏跟踪：已有菜单展开时，悬停其他触发器直接切换过去
    //（无菜单展开时不响应悬停，避免指针滑过误开）。
    trigger.addEventListener('mouseenter', () => {
      if (openMenuId !== null && openMenuId !== menu.id) {
        refreshMenu(menu.id);
        openMenu(menu.id);
      }
    });
    // Immersive shell: opening any menu panel keeps chrome held via onOpenChange.

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
      const btn = createItemButton(item, () => closeAll());
      if (item.submenu !== undefined) {
        // 子菜单触发器：action 不直达，悬停/点击展开浮层；点击重复触发即重载数据。
        btn.addEventListener('mouseenter', () => {
          refreshItemEnabled(item);
          if (!btn.disabled) openSubmenu(item, btn, panel);
        });
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          refreshItemEnabled(item);
          if (!btn.disabled) openSubmenu(item, btn, panel);
        });
      } else {
        // 悬停普通项时关掉已展开的子菜单浮层。
        btn.addEventListener('mouseenter', () => closeFlyout());
      }
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
