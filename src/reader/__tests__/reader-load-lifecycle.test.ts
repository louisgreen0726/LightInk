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
  document.body.replaceChildren();
});

describe('Reader load lifecycle', () => {
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
});
