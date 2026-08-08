/**
 * 大纲侧栏视图（T7, R7）：实时大纲列表 + 点击跳转 + 可折叠。
 *
 * 职责：
 *   - 按活动标签的 markdown 内容重建大纲（`buildOutline`，见 outline-model）；
 *   - `scheduleRefresh()` 防抖重算（默认 250ms），由 TabManager 的
 *     `onActiveContentChanged` 回调驱动（切换标签/活动标签内容变化）；
 *   - 点击条目 → 在活动标签宿主 DOM 中按序号锚点定位第 n 个 h1-h6
 *     并 `scrollIntoView({ block: 'start' })`（锚点策略见 outline-model
 *     头部注释：MDAST 文档顺序与渲染 DOM 顺序一致）；
 *   - 折叠开关：折叠后隐藏标题与列表，侧栏收缩为窄条（仅留展开按钮）；
 *     折叠状态仅会话内有效，不持久化（极简外壳不做状态膨胀）。
 *
 * 可测试性：DOM 创建经 `doc` 注入、宿主/内容经 `getActiveHost` /
 * `getActiveMarkdown` 注入，node 环境下以 fake 元素驱动全部行为。
 * 样式类见 src/ui/theme.css，配色全部取主题令牌。
 */

import { buildOutline, type OutlineItem } from './outline-model.js';

/** 渲染侧标题选择器：与 buildOutline 收集的 heading 一一对应（文档顺序）。 */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

const DEFAULT_DEBOUNCE_MS = 250;

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
  /** 当前是否处于折叠态。 */
  readonly collapsed: boolean;
  /** 切换折叠/展开。 */
  toggleCollapse(): void;
  /** 防抖调度一次大纲重算（内容变化/切换标签时调用）。 */
  scheduleRefresh(): void;
  /** 立即重算并渲染（绕过防抖）。 */
  refreshNow(): void;
  /** 清理待执行的防抖计时器。 */
  destroy(): void;
}

export function createOutlineView(deps: OutlineViewDeps): OutlineView {
  const doc = deps.doc ?? document;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const root = doc.createElement('div');
  root.classList.add('lightink-outline');

  const header = doc.createElement('div');
  header.classList.add('lightink-outline-header');
  const title = doc.createElement('span');
  title.classList.add('lightink-outline-title');
  title.textContent = '大纲';
  const toggle = doc.createElement('button');
  toggle.classList.add('lightink-outline-toggle');
  toggle.setAttribute('title', '折叠/展开大纲');
  toggle.textContent = '«';
  header.appendChild(title);
  header.appendChild(toggle);

  const body = doc.createElement('div');
  body.classList.add('lightink-outline-body');

  root.appendChild(header);
  root.appendChild(body);

  let collapsed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 点击跳转：按序号锚点取活动宿主中第 n 个 h1-h6 并滚动到视口顶部。 */
  function scrollToItem(item: OutlineItem): void {
    const host = deps.getActiveHost();
    if (host === null || typeof host.querySelectorAll !== 'function') {
      return;
    }
    const headings = host.querySelectorAll(HEADING_SELECTOR);
    const el = headings[item.anchor] as HTMLElement | undefined;
    if (el !== undefined && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'start' });
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

  toggle.addEventListener('click', () => {
    view.toggleCollapse();
  });

  const view: OutlineView = {
    root,
    get collapsed() {
      return collapsed;
    },
    toggleCollapse(): void {
      collapsed = !collapsed;
      if (collapsed) {
        root.classList.add('collapsed');
        toggle.textContent = '»';
      } else {
        root.classList.remove('collapsed');
        toggle.textContent = '«';
      }
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
