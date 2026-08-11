// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfRuntime = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: {} as { workerSrc?: string },
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: pdfRuntime.workerOptions,
  getDocument: pdfRuntime.getDocument,
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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  pdfRuntime.getDocument.mockReset();
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.body.replaceChildren();
});

function mockPdf(): {
  readonly tasks: ControlledRenderTask[];
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const tasks: ControlledRenderTask[] = [];
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    }),
    render: vi.fn(() => {
      const task = renderTask();
      tasks.push(task);
      return task;
    }),
  };
  const destroy = vi.fn(async () => undefined);
  pdfRuntime.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 1, getPage: vi.fn(async () => page) }),
    destroy,
  });
  return { tasks, destroy };
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
