import { describe, expect, it, vi } from 'vitest';
import { createSyncableStorage, isSyncableStorageKey } from '../syncable-storage.js';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    values,
  };
}

describe('SyncableStorage', () => {
  it('allows whitelisted preferences and progress prefixes only', () => {
    expect(isSyncableStorageKey('lightink.theme')).toBe(true);
    expect(isSyncableStorageKey('lightink.reader.progress.book')).toBe(true);
    expect(isSyncableStorageKey('lightink.theme.customPath')).toBe(false);
    expect(isSyncableStorageKey('lightink.remote.password')).toBe(false);
    expect(isSyncableStorageKey('lightink.crash.snapshot')).toBe(false);
  });

  it('exports and applies only syncable keys and reports mutations', () => {
    const base = storage({
      'lightink.theme': 'dark',
      'lightink.theme.customPath': '/home/user/theme.css',
      'lightink.reader.progress.book': '{"version":1}',
    });
    const changes: Array<[string, string | null]> = [];
    const sync = createSyncableStorage(base, {
      onChange: (key, value) => changes.push([key, value]),
    });

    expect(sync.snapshot()).toEqual({
      'lightink.theme': 'dark',
      'lightink.reader.progress.book': '{"version":1}',
    });
    sync.applySnapshot({ 'lightink.locale': 'zh-CN', 'lightink.remote.password': 'secret' });
    sync.removeItem('lightink.theme');
    expect(base.values.get('lightink.locale')).toBe('zh-CN');
    expect(base.values.has('lightink.remote.password')).toBe(false);
    expect(sync.snapshot()).not.toHaveProperty('lightink.remote.password');
    expect(changes).toEqual([
      ['lightink.locale', 'zh-CN'],
      ['lightink.theme', null],
    ]);
  });

  it('does not turn a storage failure into an application crash on reads', () => {
    const broken = storage();
    broken.getItem = vi.fn(() => {
      throw new Error('quota');
    });
    const sync = createSyncableStorage(broken);
    expect(sync.getItem('lightink.theme')).toBeNull();
  });
});
