/**
 * `pdf` — PDF 页格式渲染（ebook-reader T5）。
 *
 * `createPdfPageController` 是纯页码/缩放状态机（next/prev/setPage/zoom），headless 可测；
 * `renderPdfInto` 懒加载 pdfjs-dist（worker 经 `?url` 独立 chunk），把当前页渲染到 canvas，
 * 返回 handle 供导航/缩放重绘。canvas 真实渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */

import { ParseError } from './types.js';

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
  rerender(): Promise<void>;
}

/**
 * 用 pdfjs-dist 把 PDF 渲染进容器。worker 经 `?url` 作为独立 chunk 懒加载；
 * 当前页渲染为 canvas。返回 handle.controller 供导航/缩放，rerender() 据其重绘。
 */
export async function renderPdfInto(
  bytes: Uint8Array,
  container: HTMLElement,
): Promise<PdfRenderHandle> {
  const pdfjs = await import('pdfjs-dist');
  const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;

  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch {
    throw new ParseError('PDF 文件损坏或无法解析');
  }
  const controller = createPdfPageController(doc.numPages);

  const render = async (): Promise<void> => {
    const pdfPage = await doc.getPage(controller.page);
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const viewport = pdfPage.getViewport({ scale: controller.scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'lightink-reader-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    const ctx = canvas.getContext('2d');
    container.replaceChildren(canvas);
    if (ctx === null) {
      return;
    }
    await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
  };

  await render();
  return { controller, rerender: render };
}
