/**
 * `pdf` — PDF 页格式渲染（ebook-reader T5）。
 *
 * `createPdfPageController` 是纯页码/缩放状态机（next/prev/setPage/zoom），headless 可测；
 * `renderPdfInto` 懒加载 pdfjs-dist（worker 经 `?url` 独立 chunk），把当前页渲染到 canvas，
 * 返回 handle 供导航/缩放重绘。canvas 真实渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */

import { ParseError } from './types.js';
import { enforcePageCount } from './page-limits.js';

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
  /** 释放 pdfjs 文档资源 + 断开 observer（关闭/重开 PDF 时调用）。 */
  destroy(): Promise<void>;
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
): Promise<PdfRenderHandle> {
  const pdfjs = await import('pdfjs-dist');
  const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;

  let loadingTask;
  let doc;
  try {
    loadingTask = pdfjs.getDocument({ data: bytes.slice() });
    doc = await loadingTask.promise;
  } catch {
    throw new ParseError('PDF 文件损坏或无法解析');
  }
  try {
    enforcePageCount('pdf', doc.numPages);
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
  const controller = createPdfPageController(doc.numPages);
  const total = controller.totalPages;

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
    const vp = page.getViewport({ scale: controller.scale });
    sizes.push({ width: vp.width, height: vp.height });
    const slot = document.createElement('div');
    slot.className = 'lightink-reader-page-slot';
    slot.dataset.pageIndex = String(i - 1);
    sizeSlot(slot, vp.width, vp.height);
    container.appendChild(slot);
    slots.push(slot);
  }

  /** 渲染单页到其 slot（幂等：已有 canvas 则跳过）。 */
  const renderSlot = async (index: number): Promise<void> => {
    const slot = slots[index];
    if (slot === undefined) {
      return;
    }
    if (slot.querySelector('canvas') !== null) {
      return; // 已渲染
    }
    const page = await doc.getPage(index + 1);
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
      return;
    }
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  };

  /** 清掉离屏过远的 slot 画布，释放内存（再次进入视口会重渲染）。 */
  const clearSlot = (index: number): void => {
    slots[index]?.replaceChildren();
  };

  // 懒渲染：视口附近（上下各 ~2 屏缓冲）的页栅格化，离屏过远的清画布。
  const observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
              if (entry.isIntersecting) {
                void renderSlot(idx);
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
      void renderSlot(i);
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
    // 缩放后重算所有 slot 尺寸（CSS px）。
    for (let i = 0; i < total; i += 1) {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: controller.scale });
      sizes[i] = { width: vp.width, height: vp.height };
      sizeSlot(slots[i]!, vp.width, vp.height);
      // 旧画布按旧 scale 栅格化，清掉重渲染。
      clearSlot(i);
    }
    // 显式重渲染当前可见页（observer 对已在缓冲区的元素不会重复派发）。
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    for (let i = 0; i < total; i += 1) {
      const top = sizes[i]!.height * i;
      const bottom = top + sizes[i]!.height;
      if (bottom >= scrollTop && top <= scrollTop + viewH) {
        await renderSlot(i);
      }
    }
    onScroll();
  };

  const scrollToPage = (page: number): void => {
    const target = Math.min(total, Math.max(1, Math.floor(page)));
    controller.setPage(target);
    slots[target - 1]?.scrollIntoView({ block: 'start' });
  };

  return {
    controller,
    rerender,
    scrollToPage,
    destroy: async () => {
      container.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      await loadingTask.destroy();
    },
  };
}
