// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfRuntime = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: {} as { workerSrc?: string },
  textLayerInstances: [] as MockTextLayer[],
}));

interface MockTextLayerOptions {
  readonly container: HTMLElement;
  readonly viewport: { width: number; height: number };
  readonly textContentSource: unknown;
}

class MockTextLayer {
  readonly container: HTMLElement;
  readonly cancel = vi.fn(() => undefined);
  readonly render: ReturnType<typeof vi.fn>;
  readonly #renderPromise: Promise<void>;
  #resolveRender!: () => void;
  #rejectRender!: (error: unknown) => void;

  constructor(readonly options: MockTextLayerOptions) {
    this.container = options.container;
    this.#renderPromise = new Promise<void>((resolve, reject) => {
      this.#resolveRender = resolve;
      this.#rejectRender = reject;
    });
    this.render = vi.fn(() => this.#renderPromise);
    pdfRuntime.textLayerInstances.push(this);
  }

  resolveRender(): void {
    this.#resolveRender();
  }

  rejectRender(error: unknown): void {
    this.#rejectRender(error);
  }
}

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: pdfRuntime.workerOptions,
  getDocument: pdfRuntime.getDocument,
  TextLayer: MockTextLayer,
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));

import { renderPdfInto } from '../formats/pdf.js';

interface ControlledRenderTask {
  readonly promise: Promise<void>;
  readonly cancel: ReturnType<typeof vi.fn>;
  resolve(): void;
}

function renderTask(): ControlledRenderTask {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const cancel = vi.fn(() => {
    reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
  });
  return { promise, cancel, resolve };
}

class IdleIntersectionObserver {
  constructor(_callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  globalThis.IntersectionObserver =
    IdleIntersectionObserver as unknown as typeof IntersectionObserver;
  document.documentElement.style.setProperty('--lightink-font-scale', '1');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  pdfRuntime.getDocument.mockReset();
  pdfRuntime.textLayerInstances.length = 0;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.body.replaceChildren();
});

function mockPdf(): {
  readonly tasks: ControlledRenderTask[];
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getTextContent: ReturnType<typeof vi.fn>;
} {
  const tasks: ControlledRenderTask[] = [];
  const getTextContent = vi.fn(async () => ({ items: [], styles: {} }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    }),
    getTextContent,
    render: vi.fn(() => {
      const task = renderTask();
      tasks.push(task);
      return task;
    }),
  };
  const destroy = vi.fn(async () => undefined);
  pdfRuntime.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => page),
      getOutline: vi.fn(async () => []),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 0),
    }),
    destroy,
  });
  return { tasks, destroy, getTextContent };
}

async function waitForTask(tasks: readonly ControlledRenderTask[], count: number): Promise<void> {
  await vi.waitFor(() => expect(tasks).toHaveLength(count));
}

describe('PDF render lifecycle', () => {
  it('cancels the previous render when zoom requests overlap', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn();
    const first = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    handle.controller.zoomIn();
    const second = handle.rerender();
    await waitForTask(runtime.tasks, 2);

    expect(runtime.tasks[0]!.cancel).toHaveBeenCalledTimes(1);
    runtime.tasks[1]!.resolve();
    await Promise.all([first, second]);
    await handle.destroy();
  });

  it('cancels active page work and destroys pdf.js resources on teardown', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    handle.controller.zoomIn();
    const rerender = handle.rerender();
    await waitForTask(runtime.tasks, 1);

    await handle.destroy();
    await rerender;
    expect(runtime.tasks[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('PDF text layer', () => {
  it('builds a text layer with a css-scale viewport and cancels it on teardown', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn(); // 1.25
    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    expect(layer.container.classList.contains('lightink-reader-text-layer')).toBe(true);
    expect(layer.container.parentElement?.className).toBe('lightink-reader-page-slot');
    // 文本层用 CSS 尺寸 viewport（controller.scale × 字号，不含 dpr）。
    expect(layer.options.viewport.width).toBe(100 * 1.25);
    expect(layer.container.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    layer.resolveRender();
    await handle.destroy();
  });

  it('cancels an in-flight text layer on teardown', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn();
    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    await handle.destroy(); // render 仍 pending
    expect(layer.cancel).toHaveBeenCalledTimes(1);
    layer.resolveRender();
  });

  it('degrades to canvas-only when the text layer render fails', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn();
    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    layer.rejectRender(new Error('text layer boom'));

    await vi.waitFor(() => {
      const slot = container.querySelector('.lightink-reader-page-slot');
      expect(slot?.querySelector('.lightink-reader-text-layer')).toBeNull();
      expect(slot?.querySelector('canvas')).not.toBeNull();
    });
    await handle.destroy();
  });

  it('multiplies the text-layer viewport by the reading font scale', async () => {
    document.documentElement.style.setProperty('--lightink-font-scale', '1.25');
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    expect(layer.options.viewport.width).toBe(100 * 1.25);
    expect(layer.container.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    layer.resolveRender();
    await handle.destroy();
  });
});
