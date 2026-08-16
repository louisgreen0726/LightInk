import { invoke } from '@tauri-apps/api/core';

export interface LibraryItem {
  readonly id: string;
  readonly sourceId?: string;
  readonly sourceKind: 'local' | 'opds' | 'remote';
  readonly title: string;
  readonly authors: readonly string[];
  readonly coverUrl?: string;
  readonly localPath?: string;
  readonly acquisitionUrl?: string;
  readonly mediaType?: string;
  readonly extension?: string;
  readonly size?: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly updatedAt: number;
}

export interface AcquisitionLink {
  readonly itemId: string;
  readonly href: string;
  readonly rel: string;
  readonly title?: string;
  readonly mediaType?: string;
  readonly extension?: string;
  readonly size?: number;
}

export interface LibraryCacheStats {
  readonly bytesCached: number;
  readonly limitBytes: number;
}

export interface LibraryClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: LibraryClientInvoker = { invoke };

export class LibraryClient {
  private readonly invoker: LibraryClientInvoker;

  constructor(invoker: LibraryClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  listItems(sourceId?: string): Promise<LibraryItem[]> {
    return this.invoker.invoke<LibraryItem[]>('library_list_items', { sourceId });
  }

  listAcquisitionLinks(itemId: string): Promise<AcquisitionLink[]> {
    return this.invoker.invoke<AcquisitionLink[]>('library_list_acquisition_links', { itemId });
  }

  upsertItem(item: LibraryItem): Promise<void> {
    return this.invoker.invoke<void>('library_upsert_item', { item });
  }

  removeItem(itemId: string): Promise<void> {
    return this.invoker.invoke<void>('library_remove_item', { itemId });
  }

  clearCache(): Promise<void> {
    return this.invoker.invoke<void>('library_clear_cache');
  }

  setCacheLimit(limitBytes: number): Promise<void> {
    return this.invoker.invoke<void>('library_set_cache_limit', { limitBytes });
  }

  cacheStats(): Promise<LibraryCacheStats> {
    return this.invoker.invoke<LibraryCacheStats>('library_cache_stats');
  }
}

export const libraryClient = new LibraryClient();
