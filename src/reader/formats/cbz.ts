/**
 * `cbz` — Comic Book ZIP 解析（ebook-reader T5）。
 *
 * CBZ 是图片 zip：按自然序（page2 < page10）取出图片条目，并仅为视口附近页面
 * 解压图片和创建 object URL。离开缓存窗口的页面会立即释放 URL。
 */

import { ParseError } from './types.js';
import { openSafeArchive } from './safe-archive.js';
import { enforcePageCount } from './page-limits.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { extOfPath } from '../../file/path-ext.js';
import {
  createCoalescedScrollHandler,
  nearestVisibleSlot,
  rafFrameScheduler,
} from '../../ui/reading-layout.js';

const CBZ_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const CBZ_CACHE_RADIUS = 2;

/** 把字符串拆为「非数字段 / 数字段」序列，供自然序比较。 */
function splitNatural(s: string): Array<string | number> {
  const out: Array<string | number> = [];
  s.replace(/(\d+)|(\D+)/g, (_m, d, nd) => {
    out.push(d ? Number.parseInt(d, 10) : nd);
    return '';
  });
  return out;
}

/** 自然序比较：page2 < page10。 */
export function naturalCompare(a: string, b: string): number {
  const ax = splitNatural(a);
  const bx = splitNatural(b);
  const n = Math.max(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const an = ax[i];
    const bn = bx[i];
    if (an === undefined) {
      return -1;
    }
    if (bn === undefined) {
      return 1;
    }
    if (typeof an === 'number' && typeof bn === 'number') {
      if (an !== bn) {
        return an < bn ? -1 : 1;
      }
    } else {
      const c = String(an).localeCompare(String(bn));
      if (c !== 0) {
        return c < 0 ? -1 : 1;
      }
    }
  }
  return 0;
}

/**
 * 从 zip 条目名中筛出图片并按自然序排序。过滤目录项（以 `/` 结尾）与非图片。
 * 纯逻辑，headless 可测。
 */
export function listImageEntries(names: readonly string[]): string[] {
  const images = names.filter((n) => !n.endsWith('/') && CBZ_IMAGE_EXTS.has(extOfPath(n)));
  return images.sort(naturalCompare);
}

export interface CbzRenderHandle {
  readonly totalPages: number;
  readonly currentPage: number;
  scrollToPage(page: number): void;
  destroy(): Promise<void>;
}

/** Build stable page slots and materialize only a small window of image data. */
export async function renderCbzInto(
  bytes: Uint8Array,
  container: HTMLElement,
  signal?: AbortSignal,
): Promise<CbzRenderHandle> {
  const archive = await openSafeArchive(bytes, 'CBZ', signal);
  let initialized = false;
  try {
    const images = listImageEntries(archive.entries.map((entry) => entry.filename));
    if (images.length === 0) {
      throw new ParseError('CBZ 未找到图片页');
    }
    enforcePageCount('cbz', images.length);
    container.replaceChildren();
    const slots = images.map((_name, index) => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot lightink-reader-cbz-slot';
      slot.dataset.pageIndex = String(index);
      slot.setAttribute('aria-label', `${index + 1} / ${images.length}`);
      container.appendChild(slot);
      return slot;
    });

    const materialized = new Map<number, { image: HTMLImageElement; url: string }>();
    const pending = new Map<number, Promise<void>>();
    const visible = new Set<number>();
    let wantedPages = new Set<number>([0]);
    let currentPage = 1;
    let destroyed = false;
    let destruction: Promise<void> | null = null;
    let observer: IntersectionObserver | null = null;

    const releasePage = (index: number): void => {
      const page = materialized.get(index);
      if (page === undefined) {
        return;
      }
      materialized.delete(index);
      page.image.remove();
      URL.revokeObjectURL(page.url);
    };

    const loadPage = (index: number): Promise<void> => {
      if (
        index < 0 ||
        index >= images.length ||
        destroyed ||
        materialized.has(index)
      ) {
        return Promise.resolve();
      }
      const existing = pending.get(index);
      if (existing !== undefined) {
        return existing;
      }
      const operation = (async () => {
        throwIfReaderLoadCancelled(signal);
        const name = images[index]!;
        const file = archive.file(name);
        if (file === null) {
          return;
        }
        const data = await file.readBytes(signal);
        throwIfReaderLoadCancelled(signal);
        if (destroyed || !wantedPages.has(index)) {
          return;
        }
        const ext = extOfPath(name);
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const imageBytes = Uint8Array.from(data);
        const url = URL.createObjectURL(
          new Blob([imageBytes.buffer], { type: `image/${mime}` }),
        );
        if (destroyed || signal?.aborted === true) {
          URL.revokeObjectURL(url);
          return;
        }
        const image = document.createElement('img');
        image.className = 'lightink-reader-page';
        image.alt = name;
        image.src = url;
        image.addEventListener(
          'load',
          () => {
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              slots[index]!.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
            }
          },
          { once: true },
        );
        materialized.set(index, { image, url });
        slots[index]!.appendChild(image);
      })().finally(() => {
        pending.delete(index);
      });
      pending.set(index, operation);
      return operation;
    };

    const loadWindow = (center: number): void => {
      const wanted = new Set<number>();
      const centers = visible.size === 0 ? [center] : [...visible];
      for (const visibleIndex of centers) {
        for (
          let index = Math.max(0, visibleIndex - CBZ_CACHE_RADIUS);
          index <= Math.min(images.length - 1, visibleIndex + CBZ_CACHE_RADIUS);
          index += 1
        ) {
          wanted.add(index);
        }
      }
      for (const index of materialized.keys()) {
        if (!wanted.has(index)) {
          releasePage(index);
        }
      }
      wantedPages = wanted;
      for (const index of wanted) {
        void loadPage(index).catch((error: unknown) => {
          if (signal?.aborted !== true && !destroyed) {
            // eslint-disable-next-line no-console
            console.error('[lightink/reader] CBZ page decode failed', error);
          }
        });
      }
    };

    const scroller =
      typeof document !== 'undefined'
        ? (document.getElementById('lightink-editor-area') ?? container)
        : container;

    // 槽位判定走共享 nearestVisibleSlot；scroll 事件经 rAF 合并，帧内连发只同步一次。
    const syncCurrentPage = (): void => {
      const top = scroller.getBoundingClientRect().top;
      const slotTops = slots.map((slot) => slot.getBoundingClientRect().top);
      const nearest = nearestVisibleSlot(slotTops, top);
      const closest = nearest >= 0 ? nearest : 0;
      currentPage = closest + 1;
      if (observer === null) {
        loadWindow(closest);
      }
    };
    const scrollFrames = rafFrameScheduler();
    const scrollCoordinator =
      scrollFrames === null ? null : createCoalescedScrollHandler(syncCurrentPage, scrollFrames);
    const onScrollEvent = (): void => {
      if (scrollCoordinator === null) {
        syncCurrentPage();
        return;
      }
      scrollCoordinator.schedule();
    };
    scroller.addEventListener('scroll', onScrollEvent, { passive: true });

    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.pageIndex);
            if (entry.isIntersecting) {
              visible.add(index);
              currentPage = index + 1;
            } else {
              visible.delete(index);
            }
          }
          loadWindow(currentPage - 1);
        },
        { root: scroller, rootMargin: '200% 0px 200% 0px' },
      );
      slots.forEach((slot) => observer?.observe(slot));
    }

    // Ensure the first page is visible even before the observer's initial callback.
    await loadPage(0);
    loadWindow(0);

    const destroy = (): Promise<void> => {
      if (destruction !== null) {
        return destruction;
      }
      destroyed = true;
      observer?.disconnect();
      scroller.removeEventListener('scroll', onScrollEvent);
      scrollCoordinator?.cancel();
      for (const index of [...materialized.keys()]) {
        releasePage(index);
      }
      destruction = (async () => {
        await Promise.allSettled(pending.values());
        await archive.close().catch(() => undefined);
      })();
      return destruction;
    };
    const onAbort = (): void => {
      void destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    initialized = true;
    return {
      totalPages: images.length,
      get currentPage() {
        return currentPage;
      },
      scrollToPage(page) {
        const index = Math.min(images.length - 1, Math.max(0, Math.floor(page) - 1));
        currentPage = index + 1;
        visible.clear();
        loadWindow(index);
        slots[index]?.scrollIntoView({ block: 'start' });
      },
      destroy: async () => {
        signal?.removeEventListener('abort', onAbort);
        await destroy();
      },
    };
  } finally {
    if (!initialized) {
      await archive.close().catch(() => undefined);
    }
  }
}
