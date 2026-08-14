/**
 * `pdf` — PDF 页格式渲染（ebook-reader T5 + 文本层）。
 *
 * `createPdfPageController` 是纯页码/缩放状态机（next/prev/setPage/zoom），headless 可测；
 * `renderPdfInto` 懒加载 pdfjs-dist（worker 经 `?url` 独立 chunk），把当前页渲染到 canvas，
 * 并在其上叠加 pdfjs `TextLayer` 文本层（DOM span 承载文字选择，版式仍由 canvas 保真）。
 * 文本层与 canvas 同生命周期：懒渲染、缩放全量重建、离屏回收；渲染失败降级纯 canvas。
 * 返回 handle 供导航/缩放重绘。canvas/文本层真实渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */

import { ParseError } from './types.js';
import { enforcePageCount } from './page-limits.js';
import { findPdfMatches } from '../search-panel.js';
import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';

/** 缩放档位（与字号缩放独立，PDF 像素级）。 */
export const PDF_SCALE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const DEFAULT_SCALE_IDX = 2; // 1.0

export interface PdfPageController {
  readonly totalPages: number;
  readonly page: number;
  readonly scale: number;
  readonly canPrev: boolean;
  readonly canNext: boolean;
  next(): boolean;
  prev(): boolean;
  setPage(page: number): boolean;
  zoomIn(): boolean;
  zoomOut(): boolean;
  resetScale(): boolean;
}

/**
 * 创建页码/缩放状态机。所有变更返回是否真正改变（供调用方决定是否重绘）。
 * 纯逻辑、无 DOM，headless 可测。
 */
export function createPdfPageController(totalPages: number): PdfPageController {
  const total = Math.max(1, Math.floor(totalPages));
  let page = 1;
  let scaleIdx = DEFAULT_SCALE_IDX;
  const clampPage = (p: number): number => Math.min(total, Math.max(1, Math.floor(p)));
  return {
    get totalPages() {
      return total;
    },
    get page() {
      return page;
    },
    get scale() {
      return PDF_SCALE_STEPS[scaleIdx]!;
    },
    get canPrev() {
      return page > 1;
    },
    get canNext() {
      return page < total;
    },
    next() {
      if (page < total) {
        page += 1;
        return true;
      }
      return false;
    },
    prev() {
      if (page > 1) {
        page -= 1;
        return true;
      }
      return false;
    },
    setPage(p) {
      const n = clampPage(p);
      if (n === page) {
        return false;
      }
      page = n;
      return true;
    },
    zoomIn() {
      if (scaleIdx < PDF_SCALE_STEPS.length - 1) {
        scaleIdx += 1;
        return true;
      }
      return false;
    },
    zoomOut() {
      if (scaleIdx > 0) {
        scaleIdx -= 1;
        return true;
      }
      return false;
    },
    resetScale() {
      if (scaleIdx === DEFAULT_SCALE_IDX) {
        return false;
      }
      scaleIdx = DEFAULT_SCALE_IDX;
      return true;
    },
  };
}

export interface PdfRenderHandle {
  readonly controller: PdfPageController;
  /** 重算 slot 尺寸并重渲染可见页（缩放后调用）。 */
  rerender(): Promise<void>;
  /** 滚动到指定页（1-based），并同步 controller.page。供翻页/侧栏跳转。 */
  scrollToPage(page: number): void;
  /** 全文搜索（大小写不敏感）：按页序返回命中（页码 + 该页拼接文本偏移）。 */
  search(query: string): Promise<PdfSearchMatch[]>;
  /** 释放 pdfjs 文档资源 + 断开 observer（关闭/重开 PDF 时调用）。 */
  destroy(): Promise<void>;
}

/** PDF 搜索命中：偏移与文本层 anchor 同一坐标系（该页拼接文本）。 */
export interface PdfSearchMatch {
  page: number;
  start: number;
  end: number;
}

/** 当前设备像素比（WebView2 下读 window.devicePixelRatio）。 */
function devicePixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/**
 * 用 pdfjs-dist 把 PDF 以**连续垂直滚动**渲染进容器。worker 经 `?url` 独立 chunk
 * 懒加载。每页一个 `.lightink-reader-page-slot` 占位（预取 viewport 定高，避免滚动
 * 跳变），IntersectionObserver 懒栅格化：仅渲染视口附近（rootMargin 缓冲）的页到
 * canvas，离屏过远的清画布省内存。缩放重算所有 slot 高度并重渲染可见页。
 *
 * 真实 canvas/滚动渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */
export async function renderPdfInto(
  bytes: Uint8Array,
  container: HTMLElement,
  signal?: AbortSignal,
): Promise<PdfRenderHandle> {
  throwIfReaderLoadCancelled(signal);
  const pdfjs = await import('pdfjs-dist');
  const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  throwIfReaderLoadCancelled(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;

  const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
  let doc: Awaited<typeof loadingTask.promise>;
  const cancelInitialLoad = (): void => {
    void loadingTask.destroy();
  };
  try {
    signal?.addEventListener('abort', cancelInitialLoad, { once: true });
    doc = await loadingTask.promise;
    throwIfReaderLoadCancelled(signal);
  } catch (error) {
    if (isReaderLoadCancelled(error, signal)) {
      throw new ReaderLoadCancelledError();
    }
    throw new ParseError('PDF 文件损坏或无法解析');
  } finally {
    signal?.removeEventListener('abort', cancelInitialLoad);
  }
  try {
    enforcePageCount('pdf', doc.numPages);
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
  const controller = createPdfPageController(doc.numPages);
  const total = controller.totalPages;
  let destroyed = false;
  let renderGeneration = 0;
  const renderTasks = new Map<
    number,
    { cancel(): void; readonly promise: Promise<unknown> }
  >();
  /** 每页活动文本层任务（与 canvas 同生命周期，clearSlot/destroy 时 cancel）。 */
  const textLayers = new Map<number, { cancel(): void }>();
  /** 每页拼接文本缓存（文本层/搜索共用同一坐标系，懒填充）。 */
  const pageTexts: string[] = [];
  let observer: IntersectionObserver | null = null;
  const isAborted = (): boolean => signal?.aborted === true;

  const cancelRenderTasks = (): void => {
    for (const task of renderTasks.values()) {
      try {
        task.cancel();
      } catch {
        // A completed pdf.js task may reject a late cancellation.
      }
    }
    renderTasks.clear();
  };

  const cancelTextLayers = (): void => {
    for (const layer of textLayers.values()) {
      try {
        layer.cancel();
      } catch {
        // A finished pdf.js TextLayer may reject a late cancellation.
      }
    }
    textLayers.clear();
  };

  const onAbort = (): void => {
    renderGeneration += 1;
    cancelRenderTasks();
    cancelTextLayers();
    observer?.disconnect();
    void loadingTask.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  throwIfReaderLoadCancelled(signal);

  // 每页一个占位 slot；预取 viewport 定高（getPage 不栅格化，开销远小于 render）。
  const slots: HTMLDivElement[] = [];
  const sizes: { width: number; height: number }[] = [];
  const sizeSlot = (slot: HTMLDivElement, w: number, h: number): void => {
    slot.style.width = `${Math.floor(w)}px`;
    slot.style.height = `${Math.floor(h)}px`;
  };

  container.replaceChildren();
  for (let i = 1; i <= total; i += 1) {
    const page = await doc.getPage(i);
    throwIfReaderLoadCancelled(signal);
    const vp = page.getViewport({ scale: controller.scale });
    sizes.push({ width: vp.width, height: vp.height });
    const slot = document.createElement('div');
    slot.className = 'lightink-reader-page-slot';
    slot.dataset.pageIndex = String(i - 1);
    sizeSlot(slot, vp.width, vp.height);
    container.appendChild(slot);
    slots.push(slot);
  }

  /**
   * 在已渲染 canvas 的 slot 上叠加 pdfjs `TextLayer`（CSS 尺寸 viewport，span 百分比
   * 定位 + `--total-scale-factor` 约定见 reader.css）。失败/取消降级移除容器，不阻断
   * canvas 阅读；扫描件 getTextContent 为空时容器内无 span，自然无可选文字。
   */
  const appendTextLayer = async (
    index: number,
    page: Awaited<ReturnType<typeof doc.getPage>>,
    generation: number,
  ): Promise<void> => {
    const slot = slots[index];
    if (slot === undefined || destroyed || isAborted() || generation !== renderGeneration) {
      return;
    }
    if (slot.querySelector('.lightink-reader-text-layer') !== null) {
      return; // 已存在
    }
    if (slot.querySelector('canvas') === null) {
      return; // canvas 已被回收，不孤立文本层
    }
    const textContent = await page.getTextContent();
    if (
      destroyed ||
      isAborted() ||
      generation !== renderGeneration ||
      slot.querySelector('canvas') === null ||
      slot.querySelector('.lightink-reader-text-layer') !== null // 并发 appendTextLayer 复检去重
    ) {
      return;
    }
    // 页拼接文本缓存（搜索与文本层 anchor 同一坐标系）。
    pageTexts[index] = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
    const container = document.createElement('div');
    container.className = 'lightink-reader-text-layer';
    // pdfjs TextLayer 约定：容器按 CSS 变量计算宽高，缩放因子为 CSS 尺寸 scale（非 dpr）。
    container.style.setProperty('--total-scale-factor', String(controller.scale));
    container.style.setProperty('--scale-round-x', '1px');
    container.style.setProperty('--scale-round-y', '1px');
    slot.appendChild(container);
    const layer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container,
      viewport: page.getViewport({ scale: controller.scale }),
    });
    textLayers.set(index, layer);
    try {
      await layer.render();
    } catch (error) {
      container.remove();
      if (
        !destroyed &&
        !isAborted() &&
        generation === renderGeneration &&
        (error as { name?: unknown }).name !== 'AbortException'
      ) {
        // 真实失败才记录；cancel/换代/离屏回收引起的 AbortException 静默降级为纯 canvas。
        console.warn('[lightink/reader] PDF text layer failed', error);
      }
    } finally {
      if (textLayers.get(index) === layer) {
        textLayers.delete(index);
      }
    }
  };

  /** 渲染单页到其 slot（幂等：已有 canvas 则跳过）。 */
  const renderSlot = async (
    index: number,
    generation = renderGeneration,
  ): Promise<void> => {
    const slot = slots[index];
    if (
      slot === undefined ||
      destroyed ||
      isAborted() ||
      generation !== renderGeneration
    ) {
      return;
    }
    if (slot.querySelector('canvas') !== null) {
      return; // 已渲染
    }
    const page = await doc.getPage(index + 1);
    if (destroyed || isAborted() || generation !== renderGeneration) {
      return;
    }
    const dpr = devicePixelRatio();
    const viewport = page.getViewport({ scale: controller.scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'lightink-reader-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    slot.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      canvas.remove();
      return;
    }
    const task = page.render({ canvas, canvasContext: ctx, viewport });
    renderTasks.set(index, task);
    try {
      await task.promise;
    } catch (error) {
      if (
        destroyed ||
        isAborted() ||
        generation !== renderGeneration ||
        (error as { name?: unknown }).name === 'RenderingCancelledException'
      ) {
        canvas.remove();
        return;
      }
      canvas.remove();
      throw error;
    } finally {
      if (renderTasks.get(index) === task) {
        renderTasks.delete(index);
      }
    }
    void appendTextLayer(index, page, generation).catch(() => undefined);
  };

  const queueRender = (index: number): void => {
    void renderSlot(index).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[lightink/reader] PDF page render failed', error);
    });
  };

  /** 清掉离屏过远的 slot 画布与文本层，释放内存（再次进入视口会重渲染）。 */
  const clearSlot = (index: number): void => {
    renderTasks.get(index)?.cancel();
    textLayers.get(index)?.cancel();
    slots[index]?.replaceChildren();
  };

  // 懒渲染：视口附近（上下各 ~2 屏缓冲）的页栅格化，离屏过远的清画布。
  observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
              if (entry.isIntersecting) {
                queueRender(idx);
              } else {
                clearSlot(idx);
              }
            }
          },
          { root: container, rootMargin: '200% 0px 200% 0px' },
        )
      : null;
  if (observer !== null) {
    for (const slot of slots) {
      observer.observe(slot);
    }
  } else {
    // 无 IntersectionObserver（理论上 WebView2 不会有）兜底：渲染全部。
    for (let i = 0; i < total; i += 1) {
      queueRender(i);
    }
  }

  // 滚动时把视口顶部最近的页回写 controller.page（供书签/笔记定位与侧栏跳转）。
  const onScroll = (): void => {
    const scrollTop = container.scrollTop;
    let acc = 0;
    let top = 1;
    for (let i = 0; i < total; i += 1) {
      const h = sizes[i]?.height ?? 0;
      if (acc + h > scrollTop) {
        top = i + 1;
        break;
      }
      acc += h;
      top = i + 1;
    }
    controller.setPage(top);
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  const rerender = async (): Promise<void> => {
    renderGeneration += 1;
    const generation = renderGeneration;
    cancelRenderTasks();
    // 缩放后重算所有 slot 尺寸（CSS px）。
    for (let i = 0; i < total; i += 1) {
      const page = await doc.getPage(i + 1);
      if (destroyed || isAborted() || generation !== renderGeneration) {
        return;
      }
      const vp = page.getViewport({ scale: controller.scale });
      sizes[i] = { width: vp.width, height: vp.height };
      sizeSlot(slots[i]!, vp.width, vp.height);
      // 旧画布按旧 scale 栅格化，清掉重渲染。
      clearSlot(i);
    }
    // 显式重渲染当前可见页（observer 对已在缓冲区的元素不会重复派发）。
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    let pageTop = 0;
    for (let i = 0; i < total; i += 1) {
      const pageHeight = sizes[i]!.height;
      const bottom = pageTop + pageHeight;
      if (bottom >= scrollTop && pageTop <= scrollTop + viewH) {
        await renderSlot(i, generation);
      }
      pageTop = bottom;
    }
    onScroll();
  };

  const scrollToPage = (page: number): void => {
    const target = Math.min(total, Math.max(1, Math.floor(page)));
    controller.setPage(target);
    slots[target - 1]?.scrollIntoView({ block: 'start' });
  };

  /** 懒取某页拼接文本（缓存优先；未渲染过的页经 getPage/getTextContent 补齐）。 */
  const ensurePageText = async (index: number): Promise<string> => {
    const cached = pageTexts[index];
    if (cached !== undefined) {
      return cached;
    }
    const page = await doc.getPage(index + 1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
    pageTexts[index] = text;
    return text;
  };

  const search = async (query: string): Promise<PdfSearchMatch[]> => {
    if (query.trim().length === 0 || destroyed || isAborted()) {
      return [];
    }
    // 逐页懒取文本后复用 findPdfMatches（单一匹配实现，测试锁定行为）。
    const texts: string[] = [];
    for (let index = 0; index < total && !destroyed && !isAborted(); index += 1) {
      texts.push(await ensurePageText(index));
    }
    return findPdfMatches(texts, query);
  };

  return {
    controller,
    rerender,
    scrollToPage,
    search,
    destroy: async () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      renderGeneration += 1;
      signal?.removeEventListener('abort', onAbort);
      cancelRenderTasks();
      cancelTextLayers();
      container.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      await loadingTask.destroy();
    },
  };
}
