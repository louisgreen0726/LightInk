import { describe, expect, it, vi } from 'vitest';

import {
  NativeArchiveError,
  openNativeArchive,
  type NativeArchiveInvoker,
} from '../native-archive.js';
import type { ReaderTarget } from '../types.js';

const localTarget: ReaderTarget = {
  kind: 'local',
  path: '/books/comic.cbr',
  identity: { id: 'local:/books/comic.cbr' },
  displayName: 'comic.cbr',
  extension: 'cbr',
};

function openResult() {
  return {
    archiveId: 'archive-1',
    format: 'rar5',
    accessMode: 'random' as const,
    solid: false,
    encrypted: false,
    multivolume: false,
    entries: [
      {
        id: 'entry-0',
        filename: 'page1.png',
        directory: false,
        compressedSize: 2,
        uncompressedSize: 3,
        encrypted: false,
        solid: false,
        split: false,
      },
    ],
  };
}

describe('native archive source', () => {
  it('keeps archive bytes behind an opaque session and closes idempotently', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') return openResult();
      if (command === 'archive_read_entry') return new Uint8Array([1, 2, 3]);
      return undefined;
    });
    const archive = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
    });

    await expect(archive.readEntry('entry-0')).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await archive.close();
    await archive.close();

    expect(invoke).toHaveBeenCalledWith('archive_open', {
      path: '/books/comic.cbr',
      resourceId: undefined,
      password: undefined,
    });
    expect(invoke).toHaveBeenCalledWith('archive_read_entry', {
      archiveId: 'archive-1',
      entryId: 'entry-0',
      password: undefined,
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'archive_close')).toHaveLength(1);
  });

  it('requests a session password and retries a failed entry without persisting it', async () => {
    let reads = 0;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'archive_open') return { ...openResult(), encrypted: true };
      if (command === 'archive_read_entry') {
        reads += 1;
        if (reads === 1) {
          throw { code: 'ARCHIVE_PASSWORD_INCORRECT', message: 'bad password' };
        }
        expect(args?.['password']).toBe('correct horse');
        return [7, 8];
      }
      return undefined;
    });
    const requestPassword = vi.fn(async () => 'correct horse');
    const archive = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
      requestPassword,
    });

    await expect(archive.readEntry('entry-0')).resolves.toEqual(new Uint8Array([7, 8]));
    expect(requestPassword).toHaveBeenCalledWith({ displayName: 'comic.cbr', retry: true });
    await archive.close();
  });

  it('owns and closes an existing remote resource handle', async () => {
    const target: ReaderTarget = {
      kind: 'remote',
      itemId: 'item-1',
      resourceId: 'remote-1',
      identity: { id: 'item-1', validator: 'v1' },
      displayName: 'comic.cb7',
      extension: 'cb7',
      mimeType: 'application/x-7z-compressed',
    };
    const invoke = vi.fn(async (command: string) =>
      command === 'archive_open' ? { ...openResult(), format: '7z' } : undefined,
    );
    const archive = await openNativeArchive(target, {
      invoker: { invoke } as NativeArchiveInvoker,
    });

    await archive.close();
    expect(invoke).toHaveBeenCalledWith('remote_close', { resourceId: 'remote-1' });
  });

  it('preserves structured capability errors', async () => {
    const invoker: NativeArchiveInvoker = {
      invoke: vi.fn(async () => {
        throw { code: 'ARCHIVE_MULTIVOLUME_UNSUPPORTED', message: 'single volume only' };
      }),
    };

    await expect(openNativeArchive(localTarget, { invoker })).rejects.toEqual(
      expect.objectContaining<Partial<NativeArchiveError>>({
        name: 'NativeArchiveError',
        code: 'ARCHIVE_MULTIVOLUME_UNSUPPORTED',
      }),
    );
  });
});
