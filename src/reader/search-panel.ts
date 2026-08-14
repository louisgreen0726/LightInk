/**
 * `search-panel` — PDF 内搜索面板（R2）。
 *
 * 参照编辑器 find-replace 的分层模式：`findPdfMatches`/`nextMatchIndex` 为纯函数
 * （node 可测），面板为纯 DOM 装配 + handlers 回调（Enter 下一处 / Shift+Enter
 * 上一处 / Escape 关闭，aria-live 状态 + 无结果空态）。命中数据源与跳转由
 * reader-view 经 pdf handle 提供；命中高亮 overlay 由 reader-view 渲染。
 */

import type { MessageKey } from '../i18n/messages.js';

export interface PdfSearchMatch {
  /** 1-based 页码。 */
  page: number;
  /** 命中在该页拼接文本中的 [start, end) 偏移（与文本层 anchor 同一坐标系）。 */
  start: number;
  end: number;
}

/**
 * 在页文本数组（1:1 对应页码）中查找全部命中（大小写不敏感），按页序返回。空查询返回空。
 * 大小写变形长度保护：小写化改变 UTF-16 长度的文本/查询（如 İ）会使偏移与 DOM 文本
 * 坐标系错位，此时该页退化为大小写敏感匹配，保持坐标系一致。
 */
export function findPdfMatches(
  pageTexts: readonly string[],
  query: string,
): PdfSearchMatch[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const loweredNeedle = trimmed.toLowerCase();
  const matches: PdfSearchMatch[] = [];
  for (let index = 0; index < pageTexts.length; index += 1) {
    const text = pageTexts[index]!;
    const loweredText = text.toLowerCase();
    let hay: string;
    let needle: string;
    if (loweredText.length === text.length && loweredNeedle.length === trimmed.length) {
      hay = loweredText;
      needle = loweredNeedle;
    } else {
      // 小写化改变 UTF-16 长度（如 İ）：退化大小写敏感，偏移保持与 DOM 文本对齐。
      hay = text;
      needle = trimmed;
    }
    let at = hay.indexOf(needle);
    while (at >= 0) {
      matches.push({ page: index + 1, start: at, end: at + needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return matches;
}

/** 环形步进命中索引（direction 1 下一个 / -1 上一个）；空集返回 -1。 */
export function nextMatchIndex(total: number, active: number, direction: 1 | -1): number {
  if (total <= 0) {
    return -1;
  }
  if (active < 0) {
    return 0;
  }
  return (active + direction + total) % total;
}

export interface SearchPanelDeps {
  t: (key: MessageKey) => string;
  /** 输入变化（去抖由调用方决定）。 */
  onQuery: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export interface SearchPanel {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  focus(): void;
  getQuery(): string;
  destroy(): void;
  /** 更新命中计数（aria-live）；无结果显示空态文案。 */
  setStatus(total: number, active: number): void;
}

/** 创建搜索面板。element 挂到 reader 视图；open/close 控制显隐。 */
export function createSearchPanel(deps: SearchPanelDeps): SearchPanel {
  const root = document.createElement('div');
  root.className = 'lightink-reader-search-panel';
  root.setAttribute('role', 'search');
  root.hidden = true;

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'lightink-reader-search-input';
  input.setAttribute('aria-label', deps.t('reader.search.title'));
  input.placeholder = deps.t('reader.search.placeholder');
  input.addEventListener('input', () => deps.onQuery(input.value));

  const status = document.createElement('span');
  status.className = 'lightink-reader-search-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = '';

  const makeButton = (className: string, labelKey: MessageKey, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = deps.t(labelKey);
    button.setAttribute('aria-label', deps.t(labelKey));
    button.addEventListener('click', onClick);
    return button;
  };
  const prev = makeButton('lightink-reader-search-prev', 'reader.search.prev', deps.onPrev);
  const next = makeButton('lightink-reader-search-next', 'reader.search.next', deps.onNext);
  const close = makeButton('lightink-reader-search-close', 'reader.search.close', deps.onClose);

  // 键位挂面板容器：焦点落在按钮上时 Enter 走原生 click、Escape 仍可关闭。
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLButtonElement) {
        return; // 按钮原生 click 已派发对应动作
      }
      event.preventDefault();
      if (event.shiftKey) {
        deps.onPrev();
      } else {
        deps.onNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // 不冒泡：避免一次 Escape 同时关闭搜索面板与其外层（如标注侧栏）。
      event.stopPropagation();
      deps.onClose();
    }
  });

  root.append(input, status, prev, next, close);

  return {
    element: root,
    open() {
      root.hidden = false;
      input.focus();
      input.select();
    },
    close() {
      root.hidden = true;
    },
    isOpen() {
      return !root.hidden;
    },
    focus() {
      input.focus();
    },
    getQuery() {
      return input.value;
    },
    destroy() {
      root.remove();
    },
    setStatus(total, active) {
      status.dataset.searchTotal = String(total);
      status.dataset.searchEmpty = total === 0 ? 'true' : 'false';
      status.textContent =
        total === 0
          ? deps.t('reader.search.empty')
          : `${active + 1}/${total}`;
    },
  };
}

/** 把 range 覆盖的文本片段包进带类名的 span（搜索命中 overlay，非持久标注）。可选 key 戳记用于幂等复检。 */
export function wrapTextRangeWithSpan(
  root: Node,
  range: Range,
  className: string,
  key?: string,
): number {
  const walkerOwner = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
  const walker = walkerOwner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const selected = nodes.flatMap((node) => {
    if (!range.intersectsNode(node)) {
      return [];
    }
    const length = node.nodeValue?.length ?? 0;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : length;
    return start < end ? [{ node, start, end }] : [];
  });
  for (const { node, start, end } of selected.reverse()) {
    const selectedNode = start === 0 ? node : node.splitText(start);
    const selectedLength = end - start;
    if (selectedLength < selectedNode.length) {
      selectedNode.splitText(selectedLength);
    }
    const span = walkerOwner.createElement('span');
    span.className = className;
    if (key !== undefined) {
      span.dataset.searchKey = key;
    }
    selectedNode.replaceWith(span);
    span.appendChild(selectedNode);
  }
  return selected.length;
}

/** 解包并移除指定类名的 overlay span（与 wrapTextRangeWithSpan 成对）。 */
export function unwrapSpans(root: ParentNode, className: string): void {
  for (const span of Array.from(
    root.querySelectorAll<HTMLElement>(`.${className}`),
  )) {
    const parent = span.parentNode;
    span.replaceWith(...Array.from(span.childNodes));
    parent?.normalize();
  }
}

/** root 拼接文本总长（判断 pdfjs 文本层是否已填充到命中末尾，避免部分包裹）。 */
export function textLengthOf(root: Node): number {
  const owner = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let length = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    length += node.nodeValue?.length ?? 0;
  }
  return length;
}

/**
 * overlay 包裹判定：已有该 key 的 overlay（幂等，防 observer 自激循环）或
 * 层文本尚未填充到命中末尾（防部分包裹被 key 戳记定格）时不可包裹。
 */
export function canWrapSearchMark(layer: HTMLElement, key: string, end: number): boolean {
  if (layer.querySelector(`[data-search-key="${key.replace(/["\\]/g, '\\$&')}"]`) !== null) {
    return false;
  }
  return textLengthOf(layer) >= end;
}

/** root 拼接文本的 [start, end) 偏移 → Range（与文本层 anchor 同一坐标系）。 */
export function offsetRangeFrom(root: Node, start: number, end: number): Range | null {
  const owner = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const locate = (target: number, preferNext: boolean): { node: Text; offset: number } | null => {
    let offset = 0;
    for (const node of nodes) {
      const length = node.nodeValue?.length ?? 0;
      if (target < offset + length || (!preferNext && target === offset + length)) {
        return { node, offset: Math.max(0, target - offset) };
      }
      offset += length;
    }
    const last = nodes[nodes.length - 1];
    return last === undefined
      ? null
      : { node: last, offset: last.nodeValue?.length ?? 0 };
  };
  const from = locate(start, true);
  if (from === null) {
    return null;
  }
  const range = owner.createRange();
  range.setStart(from.node, from.offset);
  if (start === end) {
    range.collapse(true);
    return range;
  }
  const to = locate(end, false);
  if (to === null) {
    return null;
  }
  range.setEnd(to.node, to.offset);
  return range;
}
