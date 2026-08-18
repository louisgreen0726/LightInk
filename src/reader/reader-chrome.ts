/**
 * `reader-chrome` — 读书页沉浸控件（R4 / R5）。
 *
 * 拥有揭示/收起与四项带文字入口。默认无常驻顶栏：控件以绝对定位浮层叠在
 * 正文上，显隐不占文档流、不改变阅读区域高度。写作 `chrome-controller`
 * 不扩展到阅读表面。
 *
 * 唤出：单击阅读表面（中部或上部），或指针靠近顶/底边缘。约 2.5s 无操作
 * 自动收起；`isOverlayOpen()` 为真时不自动收。Escape 一次只退一步且永不
 * 调用 `returnToShelf`：选区工具条 → 标注侧栏 → 其它浮层 → 控件条。
 * 「返回书架」是顶栏起始侧唯一合书入口。
 */

export type ReaderChromeLocale = 'en' | 'zh-CN';

export type ReaderChromeAction = 'backToShelf' | 'toc' | 'typography' | 'annotations';

export interface ReaderChromeLabels {
  readonly backToShelf: string;
  readonly toc: string;
  readonly typography: string;
  readonly annotations: string;
}

export const READER_CHROME_ACTIONS: readonly ReaderChromeAction[] = [
  'backToShelf',
  'toc',
  'typography',
  'annotations',
];

export const READER_CHROME_HIDE_DELAY_MS = 2500;
export const READER_CHROME_EDGE_PX = 32;

export const READER_CHROME_LABELS: Record<ReaderChromeLocale, ReaderChromeLabels> = {
  en: {
    backToShelf: 'Back to Shelf',
    toc: 'Contents',
    typography: 'Typography',
    annotations: 'Book notes',
  },
  'zh-CN': {
    backToShelf: '返回书架',
    toc: '目录',
    typography: '排版',
    annotations: '本书标注',
  },
};

export interface ReaderChromeBounds {
  readonly top: number;
  readonly height: number;
}

export interface ReaderChromeDeps {
  host?: HTMLElement;
  locale?: ReaderChromeLocale;
  labels?: Partial<ReaderChromeLabels>;
  hideDelayMs?: number;
  edgePx?: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
  returnToShelf: () => void;
  openOutline?: () => void;
  openTypography?: () => void;
  toggleSidebar?: () => void;
  isOverlayOpen?: () => boolean;
  dismissOverlay?: () => boolean;
  isSidebarVisible?: () => boolean;
  isSelectionToolbarVisible?: () => boolean;
  hideSelectionToolbar?: () => void;
}

export interface ReaderChrome {
  readonly element: HTMLElement;
  readonly bar: HTMLElement;
  isRevealed(): boolean;
  reveal(): void;
  dismiss(): void;
  toggle(): void;
  /**
   * One-step back. Never calls `returnToShelf`. True when a layer closed;
   * false when nothing is open (window leftover Escape may 合书).
   */
  handleEscape(): boolean;
  handleSurfaceClick(event: MouseEvent | PointerEvent): void;
  handlePointerMove(event: { clientY: number }, bounds?: ReaderChromeBounds): void;
  handlePointerLeave(): void;
  attach(host: HTMLElement): void;
  detach(): void;
  destroy(): void;
}

export function readerChromeLabels(
  locale: ReaderChromeLocale = 'zh-CN',
  overrides?: Partial<ReaderChromeLabels>,
): ReaderChromeLabels {
  return { ...READER_CHROME_LABELS[locale], ...overrides };
}

/** Pointer is in the top or bottom edge band used to reveal controls. */
export function isReaderChromeEdge(
  clientY: number,
  bounds: ReaderChromeBounds,
  edgePx: number = READER_CHROME_EDGE_PX,
): boolean {
  if (!Number.isFinite(clientY) || !Number.isFinite(bounds.height) || bounds.height <= 0) {
    return false;
  }
  const y = clientY - bounds.top;
  const band = Math.max(0, edgePx);
  return y <= band || y >= bounds.height - band;
}

function isElementHost(value: HTMLElement | ReaderChromeDeps): value is HTMLElement {
  return typeof (value as HTMLElement).appendChild === 'function';
}

function defaultSchedule(fn: () => void, ms: number): number {
  if (typeof setTimeout === 'undefined') {
    fn();
    return 0;
  }
  return setTimeout(fn, ms) as unknown as number;
}

function defaultCancel(id: number): void {
  if (typeof clearTimeout !== 'undefined') {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
}

function applyOverlayLayout(element: HTMLElement): void {
  // Out of flow so reveal/dismiss cannot change the reading surface height.
  element.style.position = 'absolute';
  element.style.left = '0';
  element.style.right = '0';
  element.style.top = '0';
  element.style.bottom = '0';
  element.style.width = 'auto';
  element.style.height = 'auto';
  element.style.margin = '0';
  element.style.padding = '0';
  element.style.border = '0';
  element.style.pointerEvents = 'none';
  element.style.zIndex = '12';
  element.style.boxSizing = 'border-box';
}

function applyBarLayout(bar: HTMLElement): void {
  bar.style.position = 'absolute';
  bar.style.top = '0';
  bar.style.left = '0';
  bar.style.right = '0';
  bar.style.display = 'flex';
  bar.style.flexWrap = 'wrap';
  bar.style.alignItems = 'center';
  bar.style.gap = '0.5rem';
  bar.style.padding = '0.45rem 0.75rem';
  bar.style.pointerEvents = 'auto';
  bar.style.boxSizing = 'border-box';
  bar.style.background = 'color-mix(in srgb, var(--lightink-bg-elevated, #fff) 92%, transparent)';
  bar.style.color = 'var(--lightink-fg, inherit)';
  bar.style.borderBottom = '1px solid var(--lightink-border, rgba(0,0,0,0.12))';
  bar.style.boxShadow = 'var(--lightink-shadow, 0 8px 24px rgba(0,0,0,0.12))';
  bar.style.font = 'inherit';
  bar.style.fontSize = 'var(--lightink-font-size-ui, 0.8rem)';
}

function applyButtonLayout(button: HTMLButtonElement): void {
  button.style.pointerEvents = 'auto';
  button.style.padding = '0.25rem 0.65rem';
  button.style.border = '1px solid transparent';
  button.style.borderRadius = '4px';
  button.style.background = 'transparent';
  button.style.color = 'inherit';
  button.style.font = 'inherit';
  button.style.cursor = 'pointer';
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Node).nodeType !== 'number') {
    return false;
  }
  const node = target as Node;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (element === null || typeof element.closest !== 'function') {
    return false;
  }
  return element.closest('a, button, input, textarea, select, [contenteditable="true"]') !== null;
}

function hasNonCollapsedSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  const selection = window.getSelection();
  return selection !== null && selection.toString().trim() !== '';
}

function resolveBounds(host: HTMLElement | null, fallback?: ReaderChromeBounds): ReaderChromeBounds {
  if (fallback !== undefined) {
    return fallback;
  }
  if (host !== null && typeof host.getBoundingClientRect === 'function') {
    const rect = host.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  }
  return { top: 0, height: 0 };
}

export function createReaderChrome(
  hostOrDeps: HTMLElement | ReaderChromeDeps,
  maybeDeps?: ReaderChromeDeps,
): ReaderChrome {
  const initialHost = isElementHost(hostOrDeps) ? hostOrDeps : hostOrDeps.host;
  const deps: ReaderChromeDeps = isElementHost(hostOrDeps)
    ? (maybeDeps ?? { returnToShelf: () => undefined })
    : hostOrDeps;

  const labels = readerChromeLabels(deps.locale ?? 'zh-CN', deps.labels);
  const hideDelayMs = deps.hideDelayMs ?? READER_CHROME_HIDE_DELAY_MS;
  const edgePx = deps.edgePx ?? READER_CHROME_EDGE_PX;
  const schedule = deps.schedule ?? defaultSchedule;
  const cancel = deps.cancel ?? defaultCancel;

  const element = document.createElement('div');
  element.className = 'lightink-reader-chrome';
  element.setAttribute('data-reader-chrome', 'overlay');
  applyOverlayLayout(element);

  const bar = document.createElement('div');
  bar.className = 'lightink-reader-chrome-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', labels.backToShelf);
  applyBarLayout(bar);

  const makeButton = (action: ReaderChromeAction, label: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `lightink-reader-chrome-action lightink-reader-chrome-action--${action}`;
    button.dataset.readerChromeAction = action;
    button.textContent = label;
    applyButtonLayout(button);
    return button;
  };

  const backButton = makeButton('backToShelf', labels.backToShelf);
  const tocButton = makeButton('toc', labels.toc);
  const typographyButton = makeButton('typography', labels.typography);
  const annotationsButton = makeButton('annotations', labels.annotations);
  bar.append(backButton, tocButton, typographyButton, annotationsButton);
  element.appendChild(bar);

  let revealed = false;
  let pointerInsideBar = false;
  let hideTimer: number | null = null;
  let attachedHost: HTMLElement | null = null;
  let destroyed = false;

  const overlayOpen = (): boolean => deps.isOverlayOpen?.() === true;

  const clearHideTimer = (): void => {
    if (hideTimer !== null) {
      cancel(hideTimer);
      hideTimer = null;
    }
  };

  const syncDom = (): void => {
    element.hidden = !revealed;
    element.setAttribute('aria-hidden', revealed ? 'false' : 'true');
    element.setAttribute('data-revealed', revealed ? 'true' : 'false');
    element.classList.toggle('is-revealed', revealed);
    bar.hidden = !revealed;
    bar.setAttribute('aria-hidden', revealed ? 'false' : 'true');
    bar.style.display = revealed ? 'flex' : 'none';
    for (const button of [backButton, tocButton, typographyButton, annotationsButton]) {
      button.hidden = !revealed;
    }
  };

  const scheduleHide = (): void => {
    if (destroyed || overlayOpen() || pointerInsideBar || !revealed) {
      return;
    }
    clearHideTimer();
    hideTimer = schedule(() => {
      hideTimer = null;
      if (destroyed || overlayOpen() || pointerInsideBar) {
        return;
      }
      revealed = false;
      syncDom();
    }, hideDelayMs);
  };

  const reveal = (): void => {
    if (destroyed) {
      return;
    }
    revealed = true;
    syncDom();
    if (overlayOpen() || pointerInsideBar) {
      clearHideTimer();
      return;
    }
    scheduleHide();
  };

  const dismiss = (): void => {
    if (overlayOpen()) {
      return;
    }
    clearHideTimer();
    revealed = false;
    syncDom();
  };

  const handleEscape = (): boolean => {
    if (destroyed) {
      return false;
    }
    if (deps.isSelectionToolbarVisible?.() === true) {
      deps.hideSelectionToolbar?.();
      return true;
    }
    if (deps.isSidebarVisible?.() === true) {
      deps.toggleSidebar?.();
      return true;
    }
    if (overlayOpen()) {
      deps.dismissOverlay?.();
      return true;
    }
    if (revealed) {
      clearHideTimer();
      revealed = false;
      syncDom();
      return true;
    }
    return false;
  };

  const handleSurfaceClick = (event: MouseEvent | PointerEvent): void => {
    if (destroyed || event.defaultPrevented) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && element.contains(target)) {
      return;
    }
    if (isInteractiveTarget(target) || hasNonCollapsedSelection()) {
      return;
    }
    if (revealed) {
      dismiss();
      return;
    }
    reveal();
  };

  const handlePointerMove = (event: { clientY: number }, bounds?: ReaderChromeBounds): void => {
    if (destroyed) {
      return;
    }
    const box = resolveBounds(attachedHost, bounds);
    if (isReaderChromeEdge(event.clientY, box, edgePx)) {
      reveal();
    }
  };

  const handlePointerLeave = (): void => {
    pointerInsideBar = false;
    scheduleHide();
  };

  const onHostClick = (event: Event): void => {
    handleSurfaceClick(event as MouseEvent);
  };

  const onHostPointerMove = (event: Event): void => {
    handlePointerMove(event as PointerEvent);
  };

  const onHostPointerLeave = (): void => {
    handlePointerLeave();
  };

  const onHostKeyDown = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key !== 'Escape') {
      return;
    }
    if (handleEscape()) {
      keyEvent.preventDefault();
      if (typeof keyEvent.stopPropagation === 'function') {
        keyEvent.stopPropagation();
      }
    }
  };

  const detach = (): void => {
    if (attachedHost === null) {
      return;
    }
    attachedHost.removeEventListener('click', onHostClick);
    attachedHost.removeEventListener('pointermove', onHostPointerMove);
    attachedHost.removeEventListener('pointerleave', onHostPointerLeave);
    attachedHost.removeEventListener('keydown', onHostKeyDown, true);
    attachedHost = null;
  };

  const attach = (host: HTMLElement): void => {
    detach();
    attachedHost = host;
    if (element.parentNode !== host) {
      host.appendChild(element);
    }
    host.addEventListener('click', onHostClick);
    host.addEventListener('pointermove', onHostPointerMove);
    host.addEventListener('pointerleave', onHostPointerLeave);
    host.addEventListener('keydown', onHostKeyDown, true);
  };

  backButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.returnToShelf();
  });
  tocButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openOutline?.();
  });
  typographyButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openTypography?.();
  });
  annotationsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.toggleSidebar?.();
  });

  bar.addEventListener('pointerenter', () => {
    pointerInsideBar = true;
    clearHideTimer();
    reveal();
  });
  bar.addEventListener('pointerleave', () => {
    pointerInsideBar = false;
    scheduleHide();
  });

  syncDom();

  if (initialHost !== undefined) {
    attach(initialHost);
  }

  return {
    element,
    bar,
    isRevealed: () => revealed,
    reveal,
    dismiss,
    toggle() {
      if (revealed) {
        dismiss();
        return;
      }
      reveal();
    },
    handleEscape,
    handleSurfaceClick,
    handlePointerMove,
    handlePointerLeave,
    attach,
    detach,
    destroy() {
      destroyed = true;
      clearHideTimer();
      detach();
      element.remove();
      revealed = false;
      syncDom();
    },
  };
}
