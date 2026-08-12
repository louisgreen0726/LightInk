// @vitest-environment jsdom

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCbzInto } from '../formats/cbz.js';

let observerCallback: IntersectionObserverCallback | null = null;

class ControlledIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
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
const createObjectUrl = vi.fn<(blob: Blob) => string>();
const revokeObjectUrl = vi.fn<(url: string) => void>();

beforeEach(() => {
  let nextUrl = 0;
  createObjectUrl.mockImplementation(() => `blob:cbz-${++nextUrl}`);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrl,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrl,
  });
  globalThis.IntersectionObserver =
    ControlledIntersectionObserver as unknown as typeof IntersectionObserver;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  createObjectUrl.mockReset();
  revokeObjectUrl.mockReset();
  observerCallback = null;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.body.replaceChildren();
});

async function buildCbz(pageCount: number): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (let index = 1; index <= pageCount; index += 1) {
    await writer.add(
      `page${index}.png`,
      new Uint8ArrayReader(new Uint8Array([index, index + 1, index + 2])),
      { level: 0 },
    );
  }
  return writer.close();
}

describe('CBZ page materialization', () => {
  it('keeps only the viewport cache window and revokes every object URL', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderCbzInto(await buildCbz(6), container);

    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(3));
    expect(container.querySelectorAll('.lightink-reader-page-slot')).toHaveLength(6);
    expect(container.querySelectorAll('img')).toHaveLength(3);

    const lastSlot = container.querySelector<HTMLElement>('[data-page-index="5"]')!;
    observerCallback?.(
      [{ target: lastSlot, isIntersecting: true } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(6));
    expect(revokeObjectUrl).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    expect(handle.currentPage).toBe(6);

    await handle.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(6);
    await handle.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(6);
  });

  it('loads around explicit navigation without materializing the whole book', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(10), container);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(3));

    handle.scrollToPage(10);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(6));
    expect(handle.currentPage).toBe(10);
    expect(container.querySelectorAll('img')).toHaveLength(3);

    await handle.destroy();
  });
});
