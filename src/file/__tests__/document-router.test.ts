import { describe, expect, it, vi } from 'vitest';

import type { MarkdownTabState, ReaderTabState } from '../../tabs/types.js';
import { openDocumentPath, type DocumentRouterDeps } from '../document-router.js';

function manager(overrides: Partial<DocumentRouterDeps['manager']> = {}) {
  return {
    tabList: [],
    openFile: vi.fn(async () => null),
    openReader: vi.fn(async () => {
      throw new Error('not configured');
    }),
    closeTab: vi.fn(async () => true),
    ...overrides,
  } as unknown as DocumentRouterDeps['manager'];
}

describe('openDocumentPath', () => {
  it('routes Markdown directly to the editable file manager path', async () => {
    const opened = { kind: 'markdown', id: 'md-1' } as unknown as MarkdownTabState;
    const deps = {
      manager: manager({ openFile: vi.fn(async () => opened) }),
      onReaderOpenError: vi.fn(),
      onReaderLoadError: vi.fn(),
    };

    await expect(openDocumentPath('/docs/note.md', deps)).resolves.toBe(opened);
    expect(deps.manager.openFile).toHaveBeenCalledWith('/docs/note.md');
    expect(deps.manager.openReader).not.toHaveBeenCalled();
  });

  it('reuses an open Reader without loading it again', async () => {
    const load = vi.fn();
    const existing = {
      kind: 'reader',
      id: 'reader-1',
      filePath: '/books/book.epub',
      reader: { load },
    } as unknown as ReaderTabState;
    const deps = {
      manager: manager({
        tabList: [existing],
        openReader: vi.fn(async () => existing),
      }),
      onReaderOpenError: vi.fn(),
      onReaderLoadError: vi.fn(),
    };

    await expect(openDocumentPath('/books/book.epub', deps)).resolves.toBe(existing);
    expect(load).not.toHaveBeenCalled();
  });

  it('closes a newly-created Reader tab before reporting a load failure', async () => {
    const order: string[] = [];
    const failure = new Error('invalid book');
    const created = {
      kind: 'reader',
      id: 'reader-2',
      filePath: '/books/broken.epub',
      reader: {
        load: vi.fn(async () => {
          throw failure;
        }),
      },
    } as unknown as ReaderTabState;
    const closeTab = vi.fn(async () => {
      order.push('close');
      return true;
    });
    const onReaderLoadError = vi.fn(() => order.push('report'));
    const deps = {
      manager: manager({ openReader: vi.fn(async () => created), closeTab }),
      onReaderOpenError: vi.fn(),
      onReaderLoadError,
    };

    await expect(openDocumentPath('/books/broken.epub', deps)).resolves.toBeNull();
    expect(closeTab).toHaveBeenCalledWith('reader-2');
    expect(onReaderLoadError).toHaveBeenCalledWith(failure);
    expect(order).toEqual(['close', 'report']);
  });
});
