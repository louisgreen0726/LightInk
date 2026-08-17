// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLibraryView, type LibraryViewDependencies } from '../library-view.js';
import type { LibraryItem } from '../library-client.js';
import type { OpdsEntry, OpdsFeed, OpdsSource } from '../opds-client.js';

const source: OpdsSource = {
  id: 'source-1',
  title: '测试书库',
  url: 'https://books.example/opds',
  allowHttp: false,
  createdAt: 1,
  updatedAt: 1,
};

const entry: OpdsEntry = {
  id: 'entry-1',
  itemId: 'item-1',
  title: '远程漫画',
  authors: ['作者'],
  links: [
    {
      href: 'https://books.example/book.cbz',
      rel: 'http://opds-spec.org/acquisition',
      mediaType: 'application/vnd.comicbook+zip',
      extension: 'cbz',
      acquisition: true,
    },
  ],
};

function feed(overrides: Partial<OpdsFeed> = {}): OpdsFeed {
  return {
    title: '目录',
    entries: [entry],
    links: [],
    sourceUrl: 'https://books.example/opds',
    ...overrides,
  };
}

function localItem(): LibraryItem {
  return {
    id: 'local:/books/a.epub',
    sourceKind: 'local',
    title: '本地小说',
    authors: [],
    localPath: '/books/a.epub',
    extension: 'epub',
    updatedAt: 1,
  };
}

function dependencies(overrides: Partial<LibraryViewDependencies> = {}): LibraryViewDependencies {
  return {
    opds: {
      addSource: vi.fn(async () => source),
      listSources: vi.fn(async () => [source]),
      removeSource: vi.fn(async () => undefined),
      browse: vi.fn(async () => feed({ nextUrl: 'https://books.example/opds?page=2' })),
      search: vi.fn(async () => feed({ title: '搜索结果' })),
    },
    library: {
      listItems: vi.fn(async () => [localItem()]),
      listAcquisitionLinks: vi.fn(async () => []),
      removeItem: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      setCacheLimit: vi.fn(async () => undefined),
      cacheStats: vi.fn(async () => ({ bytesCached: 0, limitBytes: 2 * 1024 ** 3 })),
    },
    getLocale: () => 'zh-CN',
    onOpen: vi.fn(async () => undefined),
    onCache: vi.fn(async () => undefined),
    onImportLocal: vi.fn(async () => null),
    notify: vi.fn(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const candidate = Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  );
  if (!(candidate instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return candidate;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('LibraryView', () => {
  it('switches source, pages, searches, opens an item, and supports keyboard navigation', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(host.textContent).toContain('本地小说');
    buttonWithText(host, '测试书库').click();
    await settle();
    expect(deps.opds.browse).toHaveBeenCalledWith('source-1', undefined);
    expect(host.textContent).toContain('远程漫画');

    buttonWithText(host, '下一页').click();
    await settle();
    expect(deps.opds.browse).toHaveBeenCalledWith(
      'source-1',
      'https://books.example/opds?page=2',
    );

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '漫画';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(deps.opds.search).toHaveBeenCalledWith('source-1', '漫画');

    const list = host.querySelector<HTMLElement>('.lightink-library-items')!;
    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: 'item-1' }),
        acquisition: expect.objectContaining({ href: 'https://books.example/book.cbz' }),
        source,
      }),
      expect.anything(),
    );
    expect(view.visible).toBe(false);
  });

  it('exposes a retry action after an offline browse failure', async () => {
    const browse = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(feed());
    const deps = dependencies({ opds: { ...dependencies().opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    buttonWithText(host, '测试书库').click();
    await settle();
    expect(host.textContent).toContain('offline');
    buttonWithText(host, '重试').click();
    await settle();
    expect(browse).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('远程漫画');
  });
  it('preserves an existing OPDS credential unless the user changes authentication', async () => {
    const authenticated = { ...source, credentialRef: 'credential-1' };
    const addSource = vi.fn(async () => authenticated);
    const listSources = vi.fn(async () => [authenticated]);
    const base = dependencies();
    const deps = dependencies({
      opds: { ...base.opds, addSource, listSources },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    host.querySelector<HTMLButtonElement>('[aria-label^="编辑 OPDS 源"]')!.click();
    const form = host.querySelector<HTMLFormElement>('.lightink-library-source-form')!;
    expect((form.elements.namedItem('auth') as HTMLSelectElement).value).toBe('keep');
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-1',
        credentialRef: 'credential-1',
        clearCredential: undefined,
        credential: undefined,
      }),
    );
    view.destroy();
  });

  it('edits an OPDS source and explicitly clears its stored credential', async () => {
    const authenticated = { ...source, credentialRef: 'credential-1' };
    const addSource = vi.fn(async (input) => ({
      ...authenticated,
      title: input.title,
      url: input.url,
      credentialRef: undefined,
    }));
    const listSources = vi
      .fn()
      .mockResolvedValueOnce([authenticated])
      .mockResolvedValueOnce([{ ...authenticated, title: '更新后的书库', credentialRef: undefined }]);
    const base = dependencies();
    const deps = dependencies({
      opds: { ...base.opds, addSource, listSources },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    host.querySelector<HTMLButtonElement>('[aria-label^="编辑 OPDS 源"]')!.click();
    const form = host.querySelector<HTMLFormElement>('.lightink-library-source-form')!;
    (form.elements.namedItem('title') as HTMLInputElement).value = '更新后的书库';
    (form.elements.namedItem('auth') as HTMLSelectElement).value = 'none';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-1',
        title: '更新后的书库',
        credentialRef: undefined,
        clearCredential: true,
      }),
    );
    expect(form.hidden).toBe(true);
    view.destroy();
  });

  it('lets the user change the bounded cache limit', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    host.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!.click();
    const form = host.querySelector<HTMLFormElement>('.lightink-library-cache-limit-form')!;
    const input = form.elements.namedItem('cacheLimitGiB') as HTMLInputElement;
    input.value = '3.5';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(deps.library.setCacheLimit).toHaveBeenCalledWith(3.5 * 1024 ** 3);
    expect(form.hidden).toBe(true);
    view.destroy();
  });

  it('cancels an active open when the library is closed', async () => {
    let operationSignal: AbortSignal | undefined;
    const onOpen = vi.fn(
      async (_request: unknown, signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve) => {
          operationSignal = signal;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const deps = dependencies({ onOpen });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    host.querySelector<HTMLButtonElement>('.lightink-library-item')!.click();
    await settle();
    buttonWithText(host, '打开阅读').click();
    await settle();
    host.querySelector<HTMLButtonElement>('[aria-label="关闭书库"]')!.click();
    await settle();

    expect(operationSignal?.aborted).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
    view.destroy();
  });

  it('shows persisted comic series, volume, page count, direction, and cover page', async () => {
    const comic: LibraryItem = {
      ...localItem(),
      title: '本地漫画',
      series: '墨色档案',
      number: '12',
      volume: '3',
      pageCount: 128,
      readingDirection: 'rtl',
      coverPage: 0,
    };
    const base = dependencies();
    const deps = dependencies({
      library: {
        ...base.library,
        listItems: vi.fn(async () => [comic]),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    host.querySelector<HTMLButtonElement>('.lightink-library-item')!.click();
    await settle();
    const metadata = host.querySelector<HTMLElement>('.lightink-library-comic-metadata')!;
    expect(metadata.textContent).toContain('系列墨色档案');
    expect(metadata.textContent).toContain('卷3');
    expect(metadata.textContent).toContain('页数128');
    expect(metadata.textContent).toContain('阅读方向从右到左');
    expect(metadata.textContent).toContain('封面页1');
    view.destroy();
  });

  it('distinguishes not-started and in-progress imported books without rendering 0%', async () => {
    const unread = localItem();
    const comic: LibraryItem = {
      ...localItem(),
      id: 'local:/books/b.cbz',
      title: '本地漫画',
      extension: 'cbz',
      localPath: '/books/b.cbz',
    };
    const novel: LibraryItem = {
      ...localItem(),
      id: 'local:/books/c.epub',
      title: '续读小说',
      localPath: '/books/c.epub',
    };
    const getProgress = vi.fn((item: LibraryItem) => {
      if (item.id === comic.id) {
        return { status: 'in-progress' as const, unit: 'page' as const, index: 12, ratio: 0, percent: 37 };
      }
      if (item.id === novel.id) {
        return { status: 'in-progress' as const, unit: 'chapter' as const, index: 2, ratio: 0.4, percent: 21 };
      }
      return { status: 'not-started' as const };
    });
    const base = dependencies();
    const deps = dependencies({
      getProgress,
      library: {
        ...base.library,
        listItems: vi.fn(async () => [unread, comic, novel]),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const unreadRow = host.querySelector<HTMLButtonElement>(`[data-item-id="${unread.id}"]`)!;
    const comicRow = host.querySelector<HTMLButtonElement>(`[data-item-id="${comic.id}"]`)!;
    const novelRow = host.querySelector<HTMLButtonElement>(`[data-item-id="${novel.id}"]`)!;
    expect(unreadRow.dataset.progressStatus).toBe('not-started');
    expect(unreadRow.textContent).toContain('未开始');
    expect(unreadRow.textContent).not.toContain('0%');
    expect(comicRow.dataset.progressStatus).toBe('in-progress');
    expect(comicRow.textContent).toContain('第 12 页');
    expect(comicRow.textContent).toContain('已读 37%');
    expect(novelRow.dataset.progressStatus).toBe('in-progress');
    expect(novelRow.textContent).toContain('第 3 章');
    expect(novelRow.textContent).toContain('已读 21%');
    expect(getProgress).toHaveBeenCalledWith(expect.objectContaining({ id: unread.id }));
    expect(getProgress).toHaveBeenCalledWith(expect.objectContaining({ id: comic.id }));
    expect(getProgress).toHaveBeenCalledWith(expect.objectContaining({ id: novel.id }));
    view.destroy();
  });

  it('offers continue reading for in-progress books and hides a zero percent', async () => {
    const getProgress = vi.fn(() => ({
      status: 'in-progress' as const,
      unit: 'chapter' as const,
      index: 3,
      ratio: 0,
      percent: 0,
    }));
    const deps = dependencies({ getProgress });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    host.querySelector<HTMLButtonElement>('.lightink-library-item')!.click();
    await settle();
    expect(host.textContent).toContain('第 4 章');
    expect(host.textContent).not.toContain('0%');
    buttonWithText(host, '继续阅读').click();
    await settle();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ id: localItem().id }) }),
      expect.anything(),
    );
    view.destroy();
  });

  it('labels a first comic page without rendering 0%', async () => {
    const comic: LibraryItem = {
      ...localItem(),
      id: 'local:/comics/a.cbz',
      title: '首页漫画',
      extension: 'cbz',
      localPath: '/comics/a.cbz',
    };
    const getProgress = vi.fn(() => ({
      status: 'in-progress' as const,
      unit: 'page' as const,
      index: 0,
      ratio: 0,
    }));
    const base = dependencies();
    const deps = dependencies({
      getProgress,
      library: {
        ...base.library,
        listItems: vi.fn(async () => [comic]),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const row = host.querySelector<HTMLButtonElement>('.lightink-library-item')!;
    expect(row.dataset.progressStatus).toBe('in-progress');
    expect(row.textContent).toContain('第 1 页');
    expect(row.textContent).not.toContain('0%');
    view.destroy();
  });

  it('treats missing or unreadable progress as not started without 0%', async () => {
    const getProgress = vi.fn(() => null);
    const deps = dependencies({ getProgress });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const row = host.querySelector<HTMLButtonElement>('.lightink-library-item')!;
    expect(row.dataset.progressStatus).toBe('not-started');
    expect(row.textContent).toContain('未开始');
    expect(row.textContent).not.toContain('0%');
    expect(row.textContent).not.toContain('已读');
    view.destroy();
  });

  it('does not project progress onto unopened OPDS catalog entries', async () => {
    const getProgress = vi.fn((_item, options) =>
      options?.catalogEntry === true
        ? null
        : { status: 'in-progress' as const, unit: 'page' as const, index: 9, ratio: 0, percent: 88 },
    );
    const deps = dependencies({ getProgress });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    getProgress.mockClear();
    buttonWithText(host, '测试书库').click();
    await settle();

    expect(getProgress).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-1' }),
      { catalogEntry: true },
    );
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).not.toContain('已读');
    expect(host.textContent).not.toContain('%');
    expect(host.querySelector('[data-progress-status]')).toBeNull();
    expect(host.querySelector('.lightink-library-item-progress')).toBeNull();
    view.destroy();
  });

  it('shows real catalog progress only when the projection returns in-progress', async () => {
    const getProgress = vi.fn(() => ({
      status: 'in-progress' as const,
      unit: 'page' as const,
      index: 12,
      ratio: 0,
      percent: 30,
    }));
    const deps = dependencies({ getProgress });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    buttonWithText(host, '测试书库').click();
    await settle();

    const row = host.querySelector<HTMLButtonElement>('[data-item-id="item-1"]')!;
    expect(row.dataset.progressStatus).toBe('in-progress');
    expect(row.textContent).toContain('第 12 页');
    expect(row.textContent).toContain('已读 30%');
    view.destroy();
  });
});
