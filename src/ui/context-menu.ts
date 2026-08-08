/**
 * `context-menu` — 右键上下文菜单组件（R3）。纯 DOM 渲染 + 结构化事件，可 headless 测试。
 *
 * 两类菜单（共享同一渲染器）：
 *   - 编辑区：剪切/复制/粘贴/粘贴为纯文本 + 加粗/斜体/链接 + 链接的打开/复制地址；
 *     项的启用由上下文（是否有选区、是否在链接上）决定。
 *   - 标签页：关闭/关闭其他/复制文件路径/在文件管理器中显示；
 *     复制路径/显示位置由是否有文件路径决定。
 *
 * 纯逻辑 `buildEditorContextMenuItems` / `buildTabContextMenuItems`（按上下文决定 enabled）
 * headless 可测；`createContextMenu`（在 (x,y) 浮层渲染、外部 pointerdown/Esc 关闭）属
 * 挂载态 DOM（同 menus.ts）。
 */

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  action(): void;
  /** 返回 false 时禁用。 */
  enabled?: () => boolean;
  /** 为 true 时渲染为分隔线，忽略其余字段。 */
  separator?: boolean;
}

export interface ContextMenuHandle {
  readonly element: HTMLDivElement;
  close(): void;
}

/** 在 (x,y) 处渲染一个浮动上下文菜单；外部 pointerdown / Esc / 滚动关闭。 */
export function createContextMenu(
  items: MenuItem[],
  position: { x: number; y: number },
  doc: Document = document,
): ContextMenuHandle {
  const element = doc.createElement('div');
  element.className = 'lightink-context-menu';
  element.setAttribute('role', 'menu');
  element.style.position = 'fixed';
  element.style.left = `${position.x}px`;
  element.style.top = `${position.y}px`;
  element.style.zIndex = '2000';

  for (const item of items) {
    if (item.separator === true) {
      const sep = doc.createElement('hr');
      sep.className = 'lightink-context-menu__separator';
      element.appendChild(sep);
      continue;
    }
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'lightink-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.shortcut !== undefined && item.shortcut !== '') {
      const hint = doc.createElement('span');
      hint.className = 'lightink-context-menu__shortcut';
      hint.textContent = item.shortcut;
      btn.appendChild(hint);
    }
    const isEnabled = item.enabled ? item.enabled() : true;
    btn.disabled = !isEnabled;
    if (isEnabled) {
      btn.addEventListener('click', () => {
        item.action();
        close();
      });
    }
    element.appendChild(btn);
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && element.contains(event.target)) return;
    close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const close = (): void => {
    element.remove();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.body.appendChild(element);
  // 右键点在视口边缘时把菜单拉回视口内。
  const rect = element.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    element.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    element.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  }

  return { element, close };
}

// ---------------------------------------------------------------------------
// 编辑区上下文菜单（纯逻辑：按上下文决定 enabled）
// ---------------------------------------------------------------------------

export interface EditorMenuContext {
  /** 是否有非空文本选区。 */
  hasSelection: boolean;
  /** 光标是否在链接上。 */
  hasLink: boolean;
}

export interface EditorMenuActions {
  cut(): void;
  copy(): void;
  paste(): void;
  pastePlain(): void;
  bold(): void;
  italic(): void;
  link(): void;
  openLink(): void;
  copyLinkAddress(): void;
}

/** 构建编辑区右键菜单项：剪贴板/格式/链接，按上下文启用。 */
export function buildEditorContextMenuItems(
  ctx: EditorMenuContext,
  actions: EditorMenuActions,
): MenuItem[] {
  return [
    { id: 'cut', label: '剪切', action: actions.cut, enabled: () => ctx.hasSelection },
    { id: 'copy', label: '复制', action: actions.copy, enabled: () => ctx.hasSelection },
    { id: 'paste', label: '粘贴', action: actions.paste },
    { id: 'paste-plain', label: '粘贴为纯文本', action: actions.pastePlain },
    { separator: true, id: 'sep-format', label: '', action: () => undefined },
    { id: 'bold', label: '加粗', shortcut: 'Ctrl+B', action: actions.bold, enabled: () => ctx.hasSelection },
    { id: 'italic', label: '斜体', shortcut: 'Ctrl+I', action: actions.italic, enabled: () => ctx.hasSelection },
    { id: 'link', label: '链接', shortcut: 'Ctrl+K', action: actions.link, enabled: () => ctx.hasSelection },
    { separator: true, id: 'sep-link', label: '', action: () => undefined },
    { id: 'open-link', label: '打开链接', action: actions.openLink, enabled: () => ctx.hasLink },
    { id: 'copy-link', label: '复制链接地址', action: actions.copyLinkAddress, enabled: () => ctx.hasLink },
  ];
}

// ---------------------------------------------------------------------------
// 标签页上下文菜单（纯逻辑：按上下文决定 enabled）
// ---------------------------------------------------------------------------

export interface TabMenuContext {
  /** 是否有磁盘文件路径（未保存的新标签无路径）。 */
  hasFile: boolean;
}

export interface TabMenuActions {
  close(): void;
  closeOthers(): void;
  copyPath(): void;
  revealInFiles(): void;
}

/** 构建标签页右键菜单项：关闭/关闭其他/复制路径/在文件管理器中显示。 */
export function buildTabContextMenuItems(ctx: TabMenuContext, actions: TabMenuActions): MenuItem[] {
  return [
    { id: 'close', label: '关闭', action: actions.close },
    { id: 'close-others', label: '关闭其他', action: actions.closeOthers },
    { separator: true, id: 'sep-path', label: '', action: () => undefined },
    { id: 'copy-path', label: '复制文件路径', action: actions.copyPath, enabled: () => ctx.hasFile },
    { id: 'reveal', label: '在文件管理器中显示', action: actions.revealInFiles, enabled: () => ctx.hasFile },
  ];
}
