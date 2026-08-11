// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function frameSource(host: HTMLElement): string {
  return host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')?.srcdoc ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Reader load lifecycle', () => {
  it('publishes immutable phase, chapter, progress, and scale snapshots', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
    });
    const states: Array<typeof view.state> = [];
    const unsubscribe = view.subscribeState((state) => states.push(state));

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ phase: 'empty', current: 0, total: 0 });
    expect(Object.isFrozen(states[0])).toBe(true);

    const loading = view.load('book.epub');
    expect(view.state.phase).toBe('loading');
    await loading;
    expect(view.state).toMatchObject({
      phase: 'ready',
      current: 1,
      total: 2,
      scale: 1,
      locationKind: 'chapter',
    });

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapters = scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter');
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockReturnValue({ top: -400 } as DOMRect);
    vi.spyOn(chapters[1]!, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 250 });
    scroll.scrollTop = 375;
    scroll.dispatchEvent(new Event('scroll'));

    expect(view.state).toMatchObject({ current: 2, total: 2, progress: 0.5 });
    expect(states.some((state) => state.phase === 'loading')).toBe(true);
    unsubscribe();
    const countBeforeDestroy = states.length;
    await view.destroy();
    expect(states).toHaveLength(countBeforeDestroy);
  });

  it('lets the newest load win when byte reads resolve out of order', async () => {
    const pendingA = deferred<Uint8Array>();
    const pendingB = deferred<Uint8Array>();
    const signals = new Map<string, AbortSignal | undefined>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: (path, signal) => {
        signals.set(path, signal);
        return path === 'a.txt' ? pendingA.promise : pendingB.promise;
      },
    });

    const loadA = view.load('a.txt');
    const loadB = view.load('b.txt');
    expect(signals.get('a.txt')?.aborted).toBe(true);
    expect(host.querySelector<HTMLElement>('.lightink-reader-status')?.textContent).toBe(
      'reader.loading',
    );

    pendingB.resolve(bytes('new document'));
    await loadB;
    expect(frameSource(host)).toContain('new document');
    expect(host.querySelector('.lightink-reader')?.getAttribute('aria-busy')).toBe('false');

    pendingA.resolve(bytes('stale document'));
    await loadA;
    expect(frameSource(host)).toContain('new document');
    expect(frameSource(host)).not.toContain('stale document');
  });

  it('does not commit annotation results from a superseded document', async () => {
    const hashA = deferred<string>();
    const hashB = deferred<string>();
    const hashAStarted = deferred<void>();
    const hashBStarted = deferred<void>();
    const readAnnotations = vi.fn(async () => '{"version":1,"annotations":[]}');
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async (path) => bytes(path),
      getContentHash: (path) => {
        if (path === 'a.txt') {
          hashAStarted.resolve();
          return hashA.promise;
        }
        hashBStarted.resolve();
        return hashB.promise;
      },
      readAnnotations,
    });

    const loadA = view.load('a.txt');
    await hashAStarted.promise;
    const loadB = view.load('b.txt');
    await hashBStarted.promise;
    hashB.resolve('bbbbbbbbbbbbbbbb');
    await loadB;
    hashA.resolve('aaaaaaaaaaaaaaaa');
    await loadA;

    expect(readAnnotations).toHaveBeenCalledTimes(1);
    expect(readAnnotations).toHaveBeenCalledWith('bbbbbbbbbbbbbbbb');
    expect(frameSource(host)).toContain('b.txt');
  });

  it('aborts pending work and prevents callbacks after destroy', async () => {
    const pending = deferred<Uint8Array>();
    let loadSignal: AbortSignal | undefined;
    const getContentHash = vi.fn(async () => 'aaaaaaaaaaaaaaaa');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async (_path, signal) => {
        loadSignal = signal;
        return pending.promise;
      },
      getContentHash,
      readAnnotations: async () => '',
    });

    const load = view.load('book.txt');
    await view.destroy();
    expect(loadSignal?.aborted).toBe(true);
    expect(host.children).toHaveLength(0);

    pending.resolve(bytes('late content'));
    await load;
    expect(getContentHash).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
  });

  it('exposes caller cancellation without treating it as a load failure', async () => {
    const pending = deferred<Uint8Array>();
    const host = document.createElement('div');
    const view = createReaderView(host, { readBytes: async () => pending.promise });
    const controller = new AbortController();

    const load = view.load('book.txt', { signal: controller.signal });
    controller.abort();
    pending.resolve(bytes('ignored'));
    await expect(load).resolves.toBeUndefined();

    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    expect(root.dataset.readerState).toBe('cancelled');
    expect(root.getAttribute('aria-busy')).toBe('false');
  });

  it('renders flow content in a same-origin, script-disabled sandbox', async () => {
    const host = document.createElement('div');
    const view = createReaderView(host, { readBytes: async () => bytes('safe text') });
    await view.load('book.txt');

    const frame = host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain('safe text');
  });

  it('exposes a visible failure state for real load errors', async () => {
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => {
        throw new Error('disk read failed');
      },
    });

    await expect(view.load('book.txt')).rejects.toThrow('disk read failed');
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    expect(root.dataset.readerState).toBe('error');
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelector<HTMLElement>('.lightink-reader-status')?.textContent).toBe(
      'reader.failed',
    );
  });

  it('disposes parser-owned resources on replacement and destroy', async () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async (path) => ({
        chapters: [{ title: path, html: `<p>${path}</p>` }],
        dispose: path === 'a.epub' ? disposeA : disposeB,
      }),
    });

    await view.load('a.epub');
    expect(disposeA).not.toHaveBeenCalled();
    await view.load('b.epub');
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();

    await view.destroy();
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  it('closes the annotation drawer from its backdrop, button, and Escape', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host);
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;

    view.toggleSidebar();
    const sidebar = root.querySelector<HTMLElement>('.lightink-reader-sidebar')!;
    const backdrop = root.querySelector<HTMLButtonElement>(
      '.lightink-reader-sidebar-backdrop',
    )!;
    const close = sidebar.querySelector<HTMLButtonElement>(
      '.lightink-reader-sidebar-close',
    )!;
    expect(view.isSidebarVisible()).toBe(true);
    expect(sidebar.getAttribute('aria-hidden')).toBe('false');
    expect(backdrop.hidden).toBe(false);
    expect(backdrop.tabIndex).toBe(-1);
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(close.getAttribute('aria-label')).toBe('annotation.closeSidebar');
    expect(document.activeElement).toBe(close);

    backdrop.click();
    expect(view.isSidebarVisible()).toBe(false);
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop.hidden).toBe(true);
    expect(document.activeElement).toBe(root);

    view.toggleSidebar();
    close.click();
    expect(view.isSidebarVisible()).toBe(false);

    view.toggleSidebar();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.isSidebarVisible()).toBe(false);
  });
});
