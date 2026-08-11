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
  /**
   * Secondary line under the label (e.g. recent-file directory).
   * Prefer this over `hint` for long paths so the filename stays readable.
   */
  description?: string;
  /** Tooltip for the whole item (e.g. full path). */
  title?: string;
  /** 右侧弱化提示（快捷键旁的短文案）。与 shortcut 二选一。 */
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
  /** Static label, or factory refreshed when menus rebuild / open. */
  label: string | (() => string);
  items: MenuItem[];
}

export interface MenuBarSpec {
  menus: Menu[];
  /** Fires when open menu id changes (null = all closed). Used by immersive chrome hold. */
  onOpenChange?: (openMenuId: string | null) => void;
  /** Localized “Loading…” placeholder for async submenus (defaults to Chinese). */
  loadingLabel?: string | (() => string);
}

export interface MenuBar {
  /** 挂入工具栏的根元素。 */
  readonly element: HTMLDivElement;
  /** 打开指定菜单（测试与键盘导航用）。 */
  openMenu(menuId: string): void;
  /** 关闭所有下拉面板。 */
  closeAll(): void;
  /**
   * Replace menu definitions (e.g. after language switch) and re-render triggers
   * + panels in place. Keeps the same root element.
   */
  /**
   * Replace menu definitions (e.g. after language switch) and re-render triggers
   * + panels in place. Keeps the same root element.
   * Optional loadingLabel updates the async-submenu placeholder.
   */
  rebuild(menus: Menu[], options?: { loadingLabel?: string | (() => string) }): void;
}

let nextMenuBarId = 0;

export function createMenuBar(spec: MenuBarSpec, doc: Document = document): MenuBar {
  const element = doc.createElement('div');
  element.className = 'lightink-menu-bar';
  element.setAttribute('role', 'menubar');
  let menus = [...spec.menus];
  let loadingLabel: string | (() => string) = spec.loadingLabel ?? '加载中…';
  let openMenuId: string | null = null;
  const panels = new Map<string, HTMLDivElement>();
  const itemButtons = new Map<string, HTMLButtonElement>();
  const triggers = new Map<string, HTMLButtonElement>();
  /** 当前打开的子菜单浮层（同时最多一个）。 */
  let openFlyout: {
    itemId: string;
    el: HTMLDivElement;
    trigger: HTMLButtonElement;
  } | null = null;
  const idPrefix = `lightink-menu-${nextMenuBarId++}`;

  const focusButton = (button: HTMLButtonElement): void => {
    if (button.classList.contains('lightink-menu-trigger')) {
      for (const trigger of triggers.values()) {
        trigger.tabIndex = trigger === button ? 0 : -1;
      }
      button.focus();
      return;
    }
    const owner = button.parentElement;
    if (owner !== null) {
      for (const sibling of directMenuButtons(owner)) {
        sibling.tabIndex = sibling === button ? 0 : -1;
      }
    }
    button.focus();
  };

  const directMenuButtons = (container: HTMLElement): HTMLButtonElement[] =>
    Array.from(container.children).filter(
      (child): child is HTMLButtonElement =>
        child.classList.contains('lightink-menu-item') &&
        !(child as HTMLButtonElement).disabled,
    );

  const focusMenuEdge = (container: HTMLElement, edge: 'first' | 'last'): void => {
    const buttons = directMenuButtons(container);
    const button = edge === 'first' ? buttons[0] : buttons[buttons.length - 1];
    if (button !== undefined) focusButton(button);
  };

  const moveMenuFocus = (
    container: HTMLElement,
    current: HTMLButtonElement,
    delta: number,
  ): void => {
    const buttons = directMenuButtons(container);
    if (buttons.length === 0) return;
    const currentIndex = Math.max(0, buttons.indexOf(current));
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length;
    focusButton(buttons[nextIndex]!);
  };

  function closeFlyout(): void {
    openFlyout?.trigger.setAttribute('aria-expanded', 'false');
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
    for (const [menuId, panel] of panels) {
      panel.hidden = true;
      triggers.get(menuId)?.setAttribute('aria-expanded', 'false');
    }
    notifyOpenChange(null);
  }

  function openMenu(menuId: string, focus?: 'first' | 'last'): void {
    closeFlyout();
    for (const [id, panel] of panels) {
      panel.hidden = true;
      triggers.get(id)?.setAttribute('aria-expanded', 'false');
    }
    const panel = panels.get(menuId);
    if (panel !== undefined) {
      refreshMenu(menuId);
      panel.hidden = false;
      triggers.get(menuId)?.setAttribute('aria-expanded', 'true');
      notifyOpenChange(menuId);
      if (focus !== undefined) focusMenuEdge(panel, focus);
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
    btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
    // Prefer class walk over querySelector so node fakes without full CSSOM still work.
    const children = Array.from(btn.children) as HTMLElement[];
    const labelEl =
      children.find((child) => child.classList?.contains('lightink-menu-item-label')) ?? null;
    if (labelEl !== null) {
      labelEl.textContent = resolveMenuLabel(item.label);
    }
  }

  /** 打开菜单前刷新触发器文案、启用态与快捷键（i18n / 上下文）。 */
  function refreshMenu(menuId: string): void {
    const menu = menus.find((m) => m.id === menuId);
    if (menu === undefined) {
      return;
    }
    const trigger = triggers.get(menuId);
    if (trigger !== undefined) {
      trigger.textContent = resolveMenuLabel(menu.label);
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
    btn.setAttribute('role', 'menuitem');
    btn.tabIndex = -1;
    if (item.title !== undefined && item.title !== '') {
      btn.setAttribute('title', item.title);
    }

    const hasDescription =
      item.description !== undefined && item.description !== '';
    if (hasDescription) {
      btn.classList.add('lightink-menu-item--stacked');
      const textCol = doc.createElement('span');
      textCol.className = 'lightink-menu-item-text';
      const label = doc.createElement('span');
      label.className = 'lightink-menu-item-label';
      label.textContent = resolveMenuLabel(item.label);
      const desc = doc.createElement('span');
      desc.className = 'lightink-menu-item-description';
      desc.textContent = item.description ?? '';
      textCol.append(label, desc);
      btn.appendChild(textCol);
    } else {
      const label = doc.createElement('span');
      label.className = 'lightink-menu-item-label';
      label.textContent = resolveMenuLabel(item.label);
      btn.appendChild(label);
    }

    const hintText = item.hint ?? item.shortcut;
    if (hintText !== undefined && hintText !== '') {
      const hint = doc.createElement('span');
      hint.className = 'lightink-menu-item-hint';
      hint.textContent = hintText;
      btn.appendChild(hint);
    }
    if (item.submenu !== undefined) {
      btn.classList.add('lightink-menu-item--sub');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      const arrow = doc.createElement('span');
      arrow.className = 'lightink-menu-item-sub-arrow';
      arrow.textContent = '▸';
      btn.appendChild(arrow);
    }
    if (item.enabled !== undefined) {
      btn.disabled = !item.enabled();
    }
    btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
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
  function openSubmenu(
    item: MenuItem,
    btn: HTMLButtonElement,
    panel: HTMLDivElement,
    focusFirst = false,
  ): void {
    if (item.submenu === undefined) return;
    closeFlyout();
    const flyout = doc.createElement('div');
    flyout.className = 'lightink-menu-flyout';
    flyout.id = `${idPrefix}-flyout-${item.id}`;
    flyout.setAttribute('role', 'menu');
    btn.setAttribute('aria-controls', flyout.id);
    btn.setAttribute('aria-expanded', 'true');
    flyout.style.top = `${btn.offsetTop}px`;
    flyout.style.left = '100%';
    const loading = createItemButton(
      {
        id: `${item.id}-loading`,
        label: resolveMenuLabel(loadingLabel),
        enabled: () => false,
        action: () => undefined,
      },
      () => undefined,
    );
    flyout.appendChild(loading);
    openFlyout = { itemId: item.id, el: flyout, trigger: btn };
    panel.appendChild(flyout);

    void Promise.resolve(item.submenu()).then((items) => {
      // 加载期间浮层已被关闭/切换 → 丢弃。
      if (openFlyout === null || openFlyout.el !== flyout) return;
      flyout.replaceChildren(
        ...items.map((sub) => {
          if (sub.separator === true) {
            const sep = doc.createElement('hr');
            sep.className = 'lightink-menu-separator';
            sep.setAttribute('role', 'separator');
            return sep;
          }
          const subButton = createItemButton(sub, () => closeAll());
          subButton.addEventListener('keydown', (event) => {
            handleFlyoutKeyDown(event, subButton, flyout, btn);
          });
          return subButton;
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
      if (focusFirst) focusMenuEdge(flyout, 'first');
    });
  }

  function adjacentMenu(menuId: string, delta: number): Menu | undefined {
    const current = menus.findIndex((menu) => menu.id === menuId);
    if (current < 0 || menus.length === 0) return undefined;
    return menus[(current + delta + menus.length) % menus.length];
  }

  function handleTriggerKeyDown(
    event: KeyboardEvent,
    menu: Menu,
    trigger: HTMLButtonElement,
  ): void {
    const move = (delta: number): void => {
      const next = adjacentMenu(menu.id, delta);
      if (next === undefined) return;
      if (openMenuId !== null) openMenu(next.id);
      const nextTrigger = triggers.get(next.id);
      if (nextTrigger !== undefined) focusButton(nextTrigger);
    };
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const targetMenu = event.key === 'Home' ? menus[0] : menus[menus.length - 1];
      const target = targetMenu === undefined ? undefined : triggers.get(targetMenu.id);
      if (targetMenu !== undefined && openMenuId !== null) openMenu(targetMenu.id);
      if (target !== undefined) focusButton(target);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(menu.id, event.key === 'ArrowDown' ? 'first' : 'last');
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (openMenuId === menu.id) {
        closeAll();
      } else {
        openMenu(menu.id, 'first');
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAll();
      focusButton(trigger);
    }
  }

  function handlePanelKeyDown(
    event: KeyboardEvent,
    menu: Menu,
    item: MenuItem,
    button: HTMLButtonElement,
    panel: HTMLDivElement,
  ): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveMenuFocus(panel, button, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusMenuEdge(panel, event.key === 'Home' ? 'first' : 'last');
    } else if (event.key === 'ArrowRight' && item.submenu !== undefined) {
      event.preventDefault();
      openSubmenu(item, button, panel, true);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = adjacentMenu(menu.id, event.key === 'ArrowRight' ? 1 : -1);
      if (next !== undefined) openMenu(next.id, 'first');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAll();
      const trigger = triggers.get(menu.id);
      if (trigger !== undefined) focusButton(trigger);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (item.submenu !== undefined) {
        openSubmenu(item, button, panel, true);
      } else {
        button.click();
      }
    } else if (event.key === 'Tab') {
      closeAll();
    }
  }

  function handleFlyoutKeyDown(
    event: KeyboardEvent,
    button: HTMLButtonElement,
    flyout: HTMLDivElement,
    parentButton: HTMLButtonElement,
  ): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveMenuFocus(flyout, button, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusMenuEdge(flyout, event.key === 'Home' ? 'first' : 'last');
    } else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      closeFlyout();
      focusButton(parentButton);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      button.click();
    } else if (event.key === 'Tab') {
      closeAll();
    }
  }

  function renderMenus(nextMenus: Menu[]): void {
    closeAll();
    panels.clear();
    itemButtons.clear();
    triggers.clear();
    element.replaceChildren();
    menus = [...nextMenus];

    for (const menu of menus) {
      const trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'lightink-menu-trigger';
      trigger.dataset.menuId = menu.id;
      trigger.id = `${idPrefix}-trigger-${menu.id}`;
      trigger.setAttribute('role', 'menuitem');
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.tabIndex = element.children.length === 0 ? 0 : -1;
      trigger.textContent = resolveMenuLabel(menu.label);
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
      trigger.addEventListener('keydown', (event) => {
        handleTriggerKeyDown(event, menu, trigger);
      });

      const panel = doc.createElement('div');
      panel.className = 'lightink-menu-panel';
      panel.dataset.menuId = menu.id;
      panel.id = `${idPrefix}-panel-${menu.id}`;
      panel.setAttribute('role', 'menu');
      panel.setAttribute('aria-labelledby', trigger.id);
      trigger.setAttribute('aria-controls', panel.id);
      panel.hidden = true;
      for (const item of menu.items) {
        if (item.separator === true) {
          const sep = doc.createElement('hr');
          sep.className = 'lightink-menu-separator';
          sep.setAttribute('role', 'separator');
          panel.appendChild(sep);
          continue;
        }
        const btn = createItemButton(item, () => closeAll());
        btn.addEventListener('keydown', (event) => {
          handlePanelKeyDown(event, menu, item, btn, panel);
        });
        if (item.submenu !== undefined) {
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
          btn.addEventListener('mouseenter', () => closeFlyout());
        }
        panel.appendChild(btn);
        itemButtons.set(item.id, btn);
        refreshItemEnabled(item);
      }
      panels.set(menu.id, panel);
      triggers.set(menu.id, trigger);

      const wrap = doc.createElement('div');
      wrap.className = 'lightink-menu';
      wrap.setAttribute('role', 'none');
      wrap.append(trigger, panel);
      element.appendChild(wrap);
    }
  }

  renderMenus(menus);

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

  return {
    element,
    openMenu,
    closeAll,
    rebuild(nextMenus: Menu[], options?: { loadingLabel?: string | (() => string) }): void {
      if (options?.loadingLabel !== undefined) {
        loadingLabel = options.loadingLabel;
      }
      renderMenus(nextMenus);
    },
  };
}
