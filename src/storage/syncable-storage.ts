/**
 * Single browser-storage boundary for state that may be synchronized.
 * Secrets, absolute paths, caches, live tabs and crash snapshots deliberately
 * stay outside this allow-list.
 */

export interface SyncStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface SyncableStorageOptions {
  readonly onChange?: (key: string, value: string | null) => void;
}

export type SyncStorageSnapshot = Readonly<Record<string, string>>;

const EXACT_SYNC_KEYS = new Set([
  'lightink.locale',
  'lightink.theme',
  'lightink.fontScale',
  'lightink.reading.layout',
  'lightink.reader.flow.layout',
  'lightink.reader.typography',
  'lightink.reader.theme',
  'lightink.reader.comic.preferences',
  'lightink.autosave.enabled',
  'lightink.chrome.pinned',
  'lightink.statusBar.visible',
  'lightink.outlineWidth',
]);

const SYNC_PREFIXES = [
  'lightink.reader.progress.',
  'lightink.library.progressAlias.',
  'lightink.annotation.',
  'lightink.recent.',
];

export function isSyncableStorageKey(key: string): boolean {
  return EXACT_SYNC_KEYS.has(key) || SYNC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function syncableStorageKeys(): readonly string[] {
  return [...EXACT_SYNC_KEYS].sort();
}

export class SyncableStorage implements SyncStorageLike {
  private readonly base: SyncStorageLike;
  private readonly onChange?: (key: string, value: string | null) => void;

  constructor(base: SyncStorageLike, options: SyncableStorageOptions = {}) {
    this.base = base;
    this.onChange = options.onChange;
  }

  get length(): number {
    return this.base.length;
  }

  key(index: number): string | null {
    return this.base.key(index);
  }

  getItem(key: string): string | null {
    try {
      return this.base.getItem(key);
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    this.base.setItem(key, value);
    if (isSyncableStorageKey(key)) this.onChange?.(key, value);
  }

  removeItem(key: string): void {
    this.base.removeItem(key);
    if (isSyncableStorageKey(key)) this.onChange?.(key, null);
  }

  snapshot(): SyncStorageSnapshot {
    const snapshot: Record<string, string> = {};
    for (const key of this.keys().filter(isSyncableStorageKey)) {
      const value = this.base.getItem(key);
      if (value !== null) snapshot[key] = value;
    }
    return snapshot;
  }

  applySnapshot(snapshot: SyncStorageSnapshot): void {
    for (const [key, value] of Object.entries(snapshot)) {
      if (isSyncableStorageKey(key)) this.setItem(key, value);
    }
  }

  private keys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < this.base.length; index += 1) {
      const key = this.base.key(index);
      if (key !== null && isSyncableStorageKey(key)) keys.push(key);
    }
    return keys;
  }
}

export function createSyncableStorage(
  base: SyncStorageLike,
  options?: SyncableStorageOptions,
): SyncableStorage {
  return new SyncableStorage(base, options);
}
