/**
 * `cbz` — Comic Book ZIP 解析（ebook-reader T5）。
 *
 * CBZ 是图片 zip：按自然序（page2 < page10）取出图片条目，并仅为视口附近页面
 * 解压图片和创建 object URL。离开缓存窗口的页面会立即释放 URL。
 */

import { ParseError } from './types.js';
import { openSafeArchive, type ArchiveInput } from './safe-archive.js';
import type {
  ArchiveEntryMetadata,
  ArchiveProvider,
  ArchiveReadProgress,
} from '../sources/types.js';
import type { ArchivePasswordProvider } from '../sources/native-archive.js';
import { enforcePageCount } from './page-limits.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { extOfPath } from '../../file/path-ext.js';
import {
  createCoalescedScrollHandler,
  nearestVisibleSlot,
  rafFrameScheduler,
} from '../../ui/reading-layout.js';

const CBZ_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const COMIC_ARCHIVE_EXTS = new Set(['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7']);
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

export type ComicArchiveInput = ArchiveInput | ArchiveProvider;

export interface CbzRenderOptions {
  readonly requestPassword?: ArchivePasswordProvider;
  readonly onArchiveProgress?: (progress: ArchiveReadProgress) => void;
}

function isArchiveProvider(source: ComicArchiveInput): source is ArchiveProvider {
  return typeof (source as ArchiveProvider).readEntry === 'function';
}

interface ComicPageEntry {
  readonly provider: ArchiveProvider;
  readonly entry: ArchiveEntryMetadata & { readonly id: string; readonly filename: string };
  readonly virtualPath: string;
}

async function collectComicPages(
  provider: ArchiveProvider,
  openedProviders: Set<ArchiveProvider>,
  signal?: AbortSignal,
  prefix = '',
): Promise<ComicPageEntry[]> {
  throwIfReaderLoadCancelled(signal);
  const pages: ComicPageEntry[] = [];
  const entries = provider.entries
    .filter(
      (entry): entry is ArchiveEntryMetadata & { readonly id: string; readonly filename: string } =>
        !entry.directory && entry.id !== undefined && entry.filename !== undefined,
    )
    .sort((left, right) => naturalCompare(left.filename, right.filename));
  for (const entry of entries) {
    throwIfReaderLoadCancelled(signal);
    const virtualPath = prefix === '' ? entry.filename : `${prefix}!/${entry.filename}`;
    const extension = extOfPath(entry.filename);
    if (CBZ_IMAGE_EXTS.has(extension)) {
      pages.push({ provider, entry, virtualPath });
      continue;
    }
    if (!COMIC_ARCHIVE_EXTS.has(extension) || provider.openNested === undefined) {
      continue;
    }
    const child = await provider.openNested(entry.id, signal);
    openedProviders.add(child);
    pages.push(...(await collectComicPages(child, openedProviders, signal, virtualPath)));
  }
  return pages;
}

/** Build stable page slots and materialize only a small window of image data. */
export async function renderCbzInto(
  source: ComicArchiveInput,
  container: HTMLElement,
  signal?: AbortSignal,
  options: CbzRenderOptions = {},
): Promise<CbzRenderHandle> {
  const archive = isArchiveProvider(source)
    ? source
    : await openSafeArchive(source, 'CBZ', signal, {
        requestPassword: options.requestPassword,
      });
  const openedProviders = new Set<ArchiveProvider>([archive]);
  const unsubscribeProgress: Array<() => void> = [];
  let initialized = false;
  try {
    const images = (await collectComicPages(archive, openedProviders, signal)).sort(
      (left, right) => naturalCompare(left.virtualPath, right.virtualPath),
    );
    if (images.length === 0) {
      throw new ParseError('CBZ 未找到图片页');
    }
    if (options.onArchiveProgress !== undefined) {
      for (const provider of openedProviders) {
        const unsubscribe = provider.subscribeProgress?.(options.onArchiveProgress);
        if (unsubscribe !== undefined) unsubscribeProgress.push(unsubscribe);
      }
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
    const pending = new Map<number, { promise: Promise<void>; controller: AbortController }>();
    const sequentialQueues = new Map<ArchiveProvider, Promise<void>>();
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
        return existing.promise;
      }
      const controller = new AbortController();
      const operation = (async () => {
        const abortFromParent = (): void => controller.abort();
        if (signal?.aborted === true) controller.abort();
        else signal?.addEventListener('abort', abortFromParent, { once: true });
        try {
          throwIfReaderLoadCancelled(controller.signal);
          const page = images[index]!;
          const name = page.entry.filename;
          const read = (): Promise<Uint8Array> =>
            page.provider.readEntry(page.entry.id, controller.signal);
          let data: Uint8Array;
          if (page.provider.accessMode === 'sequential') {
            const previous = sequentialQueues.get(page.provider) ?? Promise.resolve();
            let resolveQueue = (): void => undefined;
            const queueTail = new Promise<void>((resolve) => {
              resolveQueue = resolve;
            });
            sequentialQueues.set(page.provider, queueTail);
            try {
              await previous.catch(() => undefined);
              throwIfReaderLoadCancelled(controller.signal);
              data = await read();
            } finally {
              resolveQueue();
              if (sequentialQueues.get(page.provider) === queueTail) {
                sequentialQueues.delete(page.provider);
              }
            }
          } else {
            data = await read();
          }
          throwIfReaderLoadCancelled(controller.signal);
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
        } finally {
          signal?.removeEventListener('abort', abortFromParent);
        }
      })().finally(() => {
        pending.delete(index);
      });
      pending.set(index, { promise: operation, controller });
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
      for (const [index, operation] of pending) {
        if (!wanted.has(index)) {
          operation.controller.abort();
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
      for (const operation of pending.values()) operation.controller.abort();
      observer?.disconnect();
      scroller.removeEventListener('scroll', onScrollEvent);
      scrollCoordinator?.cancel();
      for (const index of [...materialized.keys()]) {
        releasePage(index);
      }
      destruction = (async () => {
        await Promise.allSettled([...pending.values()].map((operation) => operation.promise));
        unsubscribeProgress.splice(0).forEach((unsubscribe) => unsubscribe());
        await Promise.allSettled(
          [...openedProviders].reverse().map((provider) => provider.close()),
        );
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
      unsubscribeProgress.splice(0).forEach((unsubscribe) => unsubscribe());
      await Promise.allSettled(
        [...openedProviders].reverse().map((provider) => provider.close()),
      );
    }
  }
}
