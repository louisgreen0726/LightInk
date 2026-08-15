/**
 * pdf.js TextLayerBuilder 的选区护栏。
 *
 * 文本层 span 绝对定位，行间空隙会被浏览器当成「选到别的 span」。
 * 官方做法：层末插入 `.endOfContent`，拖选时加 `.selecting` 把它铺满底层
 * （span 仍在 z-index:1）。Chromium ≥148 / Firefox 不再把填充层插入选区边界
 * ——拖选中改 DOM 会打断选区。WebView2 走这条现代路径。
 */

const END_CLASS = 'endOfContent';
const SELECTING_CLASS = 'selecting';
const MODERN_CHROMIUM = 148;

const layers = new Map<HTMLElement, HTMLElement>();
let selectionAbort: AbortController | null = null;
let prevRange: Range | null = null;

function ensureEndOfContent(layer: HTMLElement): HTMLElement {
  const existing = layer.querySelector<HTMLElement>(`:scope > .${END_CLASS}`);
  if (existing !== null) {
    return existing;
  }
  const end = layer.ownerDocument.createElement('div');
  end.className = END_CLASS;
  layer.appendChild(end);
  return end;
}

function resetLayer(layer: HTMLElement, end: HTMLElement): void {
  if (end.parentElement !== layer) {
    layer.appendChild(end);
  }
  end.style.width = '';
  end.style.height = '';
  end.style.userSelect = '';
  layer.classList.remove(SELECTING_CLASS);
}

/** Chromium ≥148 / 无法识别时走现代路径（拖选中不搬 DOM）。 */
export function usesLegacyEndOfContentPlacement(
  nav: { userAgent?: string; userAgentData?: { brands?: readonly { brand: string; version: string }[] } } | null = typeof navigator === 'undefined'
    ? null
    : navigator,
): boolean {
  if (nav === null) {
    return false;
  }
  const fromBrands = nav.userAgentData?.brands?.find((item) => item.brand === 'Chromium')?.version;
  const fromUa = /\bChrome\/(\d+)\b/.exec(nav.userAgent ?? '')?.[1];
  const raw = fromBrands ?? fromUa;
  if (raw === undefined) {
    return false;
  }
  const version = Number(raw);
  return Number.isFinite(version) && version > 0 && version < MODERN_CHROMIUM;
}

/** 终点未变、起点在动 → 从右往左（或反向收缩）。 */
export function isModifyingSelectionStart(prev: Range | null, next: Range): boolean {
  if (prev === null) {
    return false;
  }
  try {
    return (
      next.compareBoundaryPoints(Range.END_TO_END, prev) === 0 ||
      next.compareBoundaryPoints(Range.START_TO_END, prev) === 0
    );
  } catch {
    return false;
  }
}

function unwrapAnchor(node: Node | null): Element | null {
  let anchor: Node | null = node;
  if (anchor !== null && anchor.nodeType === Node.TEXT_NODE) {
    anchor = anchor.parentNode;
  }
  if (anchor instanceof Element) {
    const marked = anchor.closest(
      '[data-annotation-id], .lightink-reader-highlight, .lightink-reader-search-mark',
    );
    if (marked !== null) {
      anchor = marked;
    }
  }
  return anchor instanceof Element ? anchor : null;
}

/** 旧 Chromium：把 endOfContent 插到当前拖选边界之外。现代内核不要调用。 */
export function placeEndOfContent(
  layer: HTMLElement,
  end: HTMLElement,
  range: Range,
  prev: Range | null,
): void {
  const modifyStart = isModifyingSelectionStart(prev, range);
  let anchor = unwrapAnchor(modifyStart ? range.startContainer : range.endContainer);
  if (anchor === null) {
    return;
  }
  if (!modifyStart && range.endOffset === 0) {
    let cursor: Node | null = anchor;
    do {
      while (cursor !== null && cursor.previousSibling === null) {
        cursor = cursor.parentNode;
      }
      cursor = cursor?.previousSibling ?? null;
    } while (cursor !== null && cursor.childNodes.length === 0);
    if (cursor instanceof Element) {
      anchor = cursor;
    }
  }
  const parent = anchor.parentElement;
  if (parent === null || !layer.contains(parent)) {
    return;
  }
  end.style.width = layer.style.width;
  end.style.height = layer.style.height;
  end.style.userSelect = 'text';
  parent.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
}

function enableSelectionListener(): void {
  if (selectionAbort !== null) {
    return;
  }
  selectionAbort = new AbortController();
  const { signal } = selectionAbort;
  const legacy = usesLegacyEndOfContentPlacement();
  const resetAll = (): void => {
    prevRange = null;
    for (const [layer, end] of layers) {
      resetLayer(layer, end);
    }
  };
  document.addEventListener('pointerup', resetAll, { signal });
  window.addEventListener('blur', resetAll, { signal });
  document.addEventListener(
    'selectionchange',
    () => {
      const selection = document.getSelection();
      if (selection === null || selection.rangeCount === 0) {
        resetAll();
        return;
      }
      const range = selection.getRangeAt(0);
      for (const [layer, end] of layers) {
        if (!range.intersectsNode(layer)) {
          resetLayer(layer, end);
          continue;
        }
        layer.classList.add(SELECTING_CLASS);
        if (legacy) {
          placeEndOfContent(layer, end, range, prevRange);
        }
      }
      if (legacy) {
        try {
          prevRange = range.cloneRange();
        } catch {
          prevRange = null;
        }
      }
    },
    { signal },
  );
}

function disableSelectionListenerIfIdle(): void {
  if (layers.size > 0 || selectionAbort === null) {
    return;
  }
  selectionAbort.abort();
  selectionAbort = null;
  prevRange = null;
}

/** 文本层渲染完成后安装护栏；返回卸载函数（清 slot / destroy 时调用）。 */
export function bindTextLayerSelection(layer: HTMLElement): () => void {
  const end = ensureEndOfContent(layer);
  layers.set(layer, end);
  const onMouseDown = (): void => {
    layer.classList.add(SELECTING_CLASS);
  };
  layer.addEventListener('mousedown', onMouseDown);
  enableSelectionListener();
  return () => {
    layer.removeEventListener('mousedown', onMouseDown);
    layers.delete(layer);
    end.remove();
    layer.classList.remove(SELECTING_CLASS);
    disableSelectionListenerIfIdle();
  };
}

export function isEndOfContentNode(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).classList.contains(END_CLASS);
}
