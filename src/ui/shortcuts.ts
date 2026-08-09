/**
 * `shortcuts` — 极简 UI 的键盘快捷键注册表（T6, R11）。
 *
 * 核心操作单快捷键直达：
 *   Ctrl+N 新建 / Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+Shift+S 另存为 /
 *   Ctrl+J 切换主题。
 *
 * 键位说明：
 *   - Ctrl+T 在多数浏览器/WebView 中是保留键（新建标签页），避开；
 *   - Alt+T 切换标签栏 chrome（与 Alt+M 菜单对称）；
 *   - Alt+P 固定/取消固定导航栏（菜单+标签常驻）；
 *   - F11 切换原生全屏；
 *   - Ctrl+Tab / Ctrl+Shift+Tab 在标签栏折叠时仍可切换活动文档；
 *   - Ctrl+J 在无浏览器外壳的 Tauri WebView2 中无默认行为，用作主题切换；
 *   - 监听挂在 document 的捕获阶段，优先于编辑器/页面默认行为（如 WebView
 *     的 Ctrl+S 保存网页弹窗），命中后 preventDefault。
 *   - Milkdown 默认 keymap 不含上述组合（Mod-B/Mod-I 等不冲突），因此
 *     全部快捷键在编辑器内同样生效（保存尤其必须在任意焦点下可用）。
 *   - 无修饰键的组合（未来扩展）在可编辑目标（input/textarea/
 *     contentEditable）中被忽略，避免抢占文本输入。
 *
 * 可测试性：`handleKeyDown` 接受结构化事件对象，node 环境下直接以
 * fake 事件驱动，无需真实 DOM。
 */

export type ShortcutAction =
  | 'new'
  | 'open'
  | 'save'
  | 'save-as'
  | 'toggle-theme'
  | 'insert-link'
  | 'insert-image'
  | 'toggle-outline'
  | 'toggle-source-mode'
  | 'toggle-menu-chrome'
  | 'toggle-tabs-chrome'
  | 'toggle-chrome-pin'
  | 'toggle-fullscreen'
  | 'next-tab'
  | 'prev-tab'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutAction, string>> = {
  new: 'Ctrl+N',
  open: 'Ctrl+O',
  save: 'Ctrl+S',
  'save-as': 'Ctrl+Shift+S',
  'toggle-theme': 'Ctrl+J',
  // R5：补齐插入链接/图片、大纲显隐、源码模式切换（源码模式由 T7/R10 接通）。
  'insert-link': 'Ctrl+K',
  'insert-image': 'Ctrl+Alt+I',
  'toggle-outline': 'Ctrl+Shift+L',
  'toggle-source-mode': 'Ctrl+/',
  // Immersive shell: Alt alone is awkward; Alt+M toggles menu chrome.
  'toggle-menu-chrome': 'Alt+M',
  // Immersive tabs chrome + cycling without a permanently visible tab bar (R3).
  'toggle-tabs-chrome': 'Alt+T',
  'toggle-chrome-pin': 'Alt+P',
  'toggle-fullscreen': 'F11',
  'next-tab': 'Ctrl+Tab',
  'prev-tab': 'Ctrl+Shift+Tab',
  // Reading font size (multiplies tier baseline; persists across sessions).
  'zoom-in': 'Ctrl+=',
  'zoom-out': 'Ctrl+-',
  'zoom-reset': 'Ctrl+0',
};

/** 结构化键盘事件（兼容 DOM KeyboardEvent 的结构子集）。 */
export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: unknown;
  preventDefault(): void;
}

interface ParsedCombo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** 解析 "Ctrl+Shift+S" 风格的组合键描述。 */
export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const parsed: ParsedCombo = { key: '', ctrl: false, shift: false, alt: false };
  for (const part of parts) {
    if (part === 'ctrl' || part === 'cmd' || part === 'meta') {
      parsed.ctrl = true;
    } else if (part === 'shift') {
      parsed.shift = true;
    } else if (part === 'alt') {
      parsed.alt = true;
    } else {
      parsed.key = part;
    }
  }
  return parsed;
}

/**
 * Key equality with zoom-friendly aliases:
 *   Ctrl+= also matches Ctrl++ (Shift+=)
 *   Ctrl+- also matches Ctrl+_ (Shift+-)
 */
function keysMatch(eventKey: string, comboKey: string): boolean {
  const ek = eventKey.toLowerCase();
  const ck = comboKey.toLowerCase();
  if (ek === ck) return true;
  if (ck === '=' && (ek === '=' || ek === '+')) return true;
  if (ck === '-' && (ek === '-' || ek === '_')) return true;
  return false;
}

/** 事件是否命中组合键（Ctrl 与 macOS Cmd/meta 等价对待）。 */
export function matchEvent(event: KeyboardEventLike, combo: string): boolean {
  const c = parseCombo(combo);
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl !== c.ctrl || event.altKey !== c.alt) {
    return false;
  }
  if (!keysMatch(event.key, c.key)) {
    return false;
  }
  // Shift must match, except zoom aliases where Shift is only used to type + / _.
  const zoomAlias =
    (c.key === '=' && (event.key === '+' || event.key === '=')) ||
    (c.key === '-' && (event.key === '_' || event.key === '-'));
  if (zoomAlias) {
    return true;
  }
  return event.shiftKey === c.shift;
}

/** 目标是否为可编辑元素（结构化判定，兼容 fake）。 */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') {
    return false;
  }
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) {
    return true;
  }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Function keys and other non-text global chords that must work inside the editor. */
export function isGlobalFunctionKey(key: string): boolean {
  return /^f([1-9]|1[0-2])$/.test(key.toLowerCase());
}

export type ShortcutHandlers = Partial<Record<ShortcutAction, () => void>>;

interface ListenerTarget {
  addEventListener(type: string, listener: (e: unknown) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (e: unknown) => void, capture?: boolean): void;
}

export class ShortcutRegistry {
  private readonly handlers: ShortcutHandlers;
  private readonly combos: Readonly<Record<ShortcutAction, string>>;
  private readonly listener: (e: unknown) => void;

  constructor(
    handlers: ShortcutHandlers,
    combos: Readonly<Record<ShortcutAction, string>> = DEFAULT_SHORTCUTS,
  ) {
    this.handlers = handlers;
    this.combos = combos;
    this.listener = (e) => {
      this.handleKeyDown(e as KeyboardEventLike);
    };
  }

  /** 返回动作当前绑定的组合键描述（用于按钮 tooltip 等）。 */
  comboOf(action: ShortcutAction): string {
    return this.combos[action];
  }

  /** 列出已注册处理器对应的动作与组合键（供快捷键速查表 R5 使用）。 */
  entries(): ReadonlyArray<{ action: ShortcutAction; combo: string }> {
    return (Object.keys(this.handlers) as ShortcutAction[]).map((action) => ({
      action,
      combo: this.combos[action],
    }));
  }

  /**
   * 处理一次 keydown：命中已注册组合则 preventDefault 并派发处理器。
   * 返回 true 表示已处理。无修饰键的“可打印键”在可编辑目标内被忽略；
   * 功能键（F1–F12 等）即使焦点在编辑器内仍生效（如 F11 全屏）。
   */
  handleKeyDown(event: KeyboardEventLike): boolean {
    for (const action of Object.keys(this.handlers) as ShortcutAction[]) {
      const handler = this.handlers[action];
      if (handler === undefined) {
        continue;
      }
      const combo = this.combos[action];
      if (!matchEvent(event, combo)) {
        continue;
      }
      const parsed = parseCombo(combo);
      if (
        !parsed.ctrl &&
        !parsed.alt &&
        isEditableTarget(event.target) &&
        !isGlobalFunctionKey(parsed.key)
      ) {
        continue;
      }
      event.preventDefault();
      handler();
      return true;
    }
    return false;
  }

  /** 捕获阶段监听，优先于 WebView/编辑器默认行为。 */
  attach(target: ListenerTarget): void {
    target.addEventListener('keydown', this.listener, true);
  }

  detach(target: ListenerTarget): void {
    target.removeEventListener('keydown', this.listener, true);
  }
}
