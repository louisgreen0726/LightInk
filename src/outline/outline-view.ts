/**
 * 大纲侧栏视图（T7, R7）：实时大纲列表 + 点击跳转 + 三态显示。
 *
 * 职责：
 *   - 按活动标签的 markdown 内容重建大纲（`buildOutline`，见 outline-model）；
 *   - `scheduleRefresh()` 防抖重算（默认 250ms），由 TabManager 的
 *     `onActiveContentChanged` 回调驱动（切换标签/活动标签内容变化）；
 *   - 点击条目 → 在活动标签宿主 DOM 中按序号锚点定位第 n 个 h1-h6
 *     并 `scrollIntoView({ block: 'start' })`；
 *   - 显示三态循环（菜单 / Ctrl+Shift+L / 侧栏按钮）：
 *       expanded → rail（窄条 »）→ hidden（完全隐藏）→ expanded
 *     状态仅会话内有效，不持久化。
 *
 * 可测试性：DOM 创建经 `doc` 注入、宿主/内容经 `getActiveHost` /
 * `getActiveMarkdown` 注入，node 环境下以 fake 元素驱动全部行为。
 * 样式类见 src/ui/theme.css，配色全部取主题令牌。
 */

import { buildOutline, type OutlineItem } from './outline-model.js';

/** 渲染侧标题选择器：与 buildOutline 收集的 heading 一一对应（文档顺序）。 */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

const DEFAULT_DEBOUNCE_MS = 250;

/** expanded: full panel; rail: narrow reopen strip; hidden: no sidebar chrome. */
export type OutlineVisibility = 'expanded' | 'rail' | 'hidden';

const VISIBILITY_CYCLE: readonly OutlineVisibility[] = ['expanded', 'rail', 'hidden'];

export interface OutlineViewDeps {
  /** 当前活动标签的宿主元素（无活动标签时返回 null）。 */
  getActiveHost(): HTMLElement | null;
  /** 当前活动标签的 markdown（无活动标签或读取失败时返回 null）。 */
  getActiveMarkdown(): string | null;
  /** DOM 创建入口（生产为全局 document，测试注入 fake）。 */
  doc?: Document;
  /** 重算防抖间隔（毫秒），默认 250。 */
  debounceMs?: number;
}

export interface OutlineView {
  /** 侧栏根元素（由调用方挂入外壳的侧栏槽位）。 */
  readonly root: HTMLElement;
  /** Current visibility mode. */
  readonly visibility: OutlineVisibility;
  /**
   * Backward-compatible: true when not fully expanded (rail or hidden).
   * Prefer `visibility` for new code.
   */
  readonly collapsed: boolean;
  /** Cycle expanded → rail → hidden → expanded. */
  toggleCollapse(): void;
  /** Set exact visibility (immersive / fullscreen / tests). */
  setVisibility(next: OutlineVisibility): void;
  /**
   * Backward-compatible boolean API:
   *   true  → rail (narrow strip, one click to expand)
   *   false → expanded
   * For full hide use setVisibility('hidden').
   */
  setCollapsed(next: boolean): void;
  /** 防抖调度一次大纲重算（内容变化/切换标签时调用）。 */
  scheduleRefresh(): void;
  /** 立即重算并渲染（绕过防抖）。 */
  refreshNow(): void;
  /** 清理待执行的防抖计时器。 */
  destroy(): void;
}

function nextVisibility(current: OutlineVisibility): OutlineVisibility {
  const idx = VISIBILITY_CYCLE.indexOf(current);
  return VISIBILITY_CYCLE[(idx + 1) % VISIBILITY_CYCLE.length] ?? 'expanded';
}

export function createOutlineView(deps: OutlineViewDeps): OutlineView {
  const doc = deps.doc ?? document;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const root = doc.createElement('div');
  root.classList.add('lightink-outline');
  root.dataset.visibility = 'expanded';

  const header = doc.createElement('div');
  header.classList.add('lightink-outline-header');
  const title = doc.createElement('span');
  title.classList.add('lightink-outline-title');
  title.textContent = '大纲';
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.classList.add('lightink-outline-toggle');
  toggle.setAttribute('title', '折叠大纲');
  toggle.setAttribute('aria-label', '折叠大纲');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = '«';
  header.appendChild(title);
  header.appendChild(toggle);

  const body = doc.createElement('div');
  body.classList.add('lightink-outline-body');

  root.appendChild(header);
  root.appendChild(body);

  let visibility: OutlineVisibility = 'expanded';
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 点击跳转：按序号锚点取活动宿主中第 n 个 h1-h6 并滚动到视口顶部。 */
  function scrollToItem(item: OutlineItem): void {
    try {
      const host = deps.getActiveHost();
      if (host === null || typeof host.querySelectorAll !== 'function') {
        return;
      }
      const headings = host.querySelectorAll(HEADING_SELECTOR);
      const el = headings[item.anchor] as HTMLElement | undefined;
      // Source-mode overlay may hide WYSIWYG headings; never throw on missing target.
      if (el !== undefined && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start' });
      }
    } catch {
      // Defensive: outline jump must not break immersive shell (R4).
    }
  }

  function renderEmpty(text: string): void {
    const empty = doc.createElement('div');
    empty.classList.add('lightink-outline-empty');
    empty.textContent = text;
    body.replaceChildren(empty);
  }

  function render(): void {
    const markdown = deps.getActiveMarkdown();
    if (markdown === null) {
      renderEmpty('无活动标签');
      return;
    }
    const items = buildOutline(markdown);
    if (items.length === 0) {
      renderEmpty('暂无标题');
      return;
    }
    body.replaceChildren(
      ...items.map((item) => {
        const el = doc.createElement('button');
        el.classList.add('lightink-outline-item');
        el.classList.add(`level-${Math.min(Math.max(item.level, 1), 6)}`);
        el.textContent = item.text;
        el.setAttribute('title', item.text);
        el.addEventListener('click', () => scrollToItem(item));
        return el;
      }),
    );
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function syncHostClass(): void {
    try {
      const host = (root as { parentElement?: HTMLElement | null }).parentElement ?? null;
      if (host?.classList === undefined) {
        return;
      }
      host.classList.toggle('is-outline-rail', visibility === 'rail');
      host.classList.toggle('is-outline-hidden', visibility === 'hidden');
      host.classList.toggle('is-outline-collapsed', visibility !== 'expanded');
    } catch {
      /* ignore missing parent / fake DOM */
    }
  }

  function applyVisibility(next: OutlineVisibility): void {
    visibility = next;
    root.dataset.visibility = next;
    root.classList.toggle('is-rail', next === 'rail');
    root.classList.toggle('is-hidden', next === 'hidden');
    // Legacy class kept for older CSS/tests: any non-expanded mode.
    root.classList.toggle('collapsed', next !== 'expanded');

    if (next === 'hidden') {
      root.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', '显示大纲');
      toggle.setAttribute('aria-label', '显示大纲');
      toggle.textContent = '»';
    } else if (next === 'rail') {
      root.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', '展开大纲');
      toggle.setAttribute('aria-label', '展开大纲');
      toggle.textContent = '»';
    } else {
      root.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('title', '折叠大纲');
      toggle.setAttribute('aria-label', '折叠大纲');
      toggle.textContent = '«';
    }
    syncHostClass();
  }

  toggle.addEventListener('click', () => {
    // Rail strip is a reopen control: click expands. Menu / Ctrl+Shift+L still
    // cycle expanded → rail → hidden → expanded for full three-state control.
    if (visibility === 'rail') {
      applyVisibility('expanded');
      return;
    }
    view.toggleCollapse();
  });

  const view: OutlineView = {
    root,
    get visibility() {
      return visibility;
    },
    get collapsed() {
      return visibility !== 'expanded';
    },
    toggleCollapse(): void {
      applyVisibility(nextVisibility(visibility));
    },
    setVisibility(next: OutlineVisibility): void {
      if (visibility === next) {
        return;
      }
      applyVisibility(next);
    },
    setCollapsed(next: boolean): void {
      // true → rail (recoverable strip); false → expanded. Full hide is setVisibility.
      applyVisibility(next ? 'rail' : 'expanded');
    },
    scheduleRefresh(): void {
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        render();
      }, debounceMs);
    },
    refreshNow(): void {
      cancelTimer();
      render();
    },
    destroy(): void {
      cancelTimer();
    },
  };

  // 初始渲染一次（通常在首个标签创建前，为空态）。
  render();
  return view;
}
