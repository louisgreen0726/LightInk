import { describe, expect, it, vi } from 'vitest';
import { LibraryClient, type LibraryClientInvoker } from '../library-client.js';

describe('LibraryClient managed content', () => {
  it('imports a local file through the managed-content command', async () => {
    const item = {
      id: 'managed:abc',
      sourceKind: 'managed' as const,
      title: 'Book.epub',
      authors: [],
      blobHash: 'abc',
      availability: 'local' as const,
      updatedAt: 1,
    };
    const invoke = vi.fn(async () => item);
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);

    await expect(client.importManagedBook('/books/Book.epub')).resolves.toEqual(item);
    expect(invoke).toHaveBeenCalledWith('library_import_managed_book', {
      path: '/books/Book.epub',
    });
  });

  it('copies readonly migration ids into the invoke payload', async () => {
    const invoke = vi.fn(async () => ({ migrated: 0, duplicates: 0, failed: [], aliases: [] }));
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);
    const ids = ['local:a'] as const;

    await client.applyManagedMigration(ids);

    expect(invoke).toHaveBeenCalledWith('library_apply_managed_migration', {
      itemIds: ['local:a'],
    });
  });
});
