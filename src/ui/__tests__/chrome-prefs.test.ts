/**
 * Chrome pin preference persistence.
 */

import { describe, expect, it } from 'vitest';

import {
  CHROME_PINNED_STORAGE_KEY,
  loadChromePinPrefs,
  saveChromePinPrefs,
} from '../chrome-prefs.js';

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return store[key] ?? null;
    },
    setItem(key, value) {
      store[key] = value;
    },
  };
}

describe('chrome pin prefs', () => {
  it('defaults both surfaces pinned (first-run fixed navigation)', () => {
    expect(loadChromePinPrefs(null)).toEqual({ menu: true, tabs: true });
    expect(loadChromePinPrefs(memoryStorage())).toEqual({ menu: true, tabs: true });
  });

  it('round-trips pin prefs including unpinned', () => {
    const storage = memoryStorage();
    saveChromePinPrefs(storage, { menu: false, tabs: false });
    expect(loadChromePinPrefs(storage)).toEqual({ menu: false, tabs: false });
    saveChromePinPrefs(storage, { menu: true, tabs: true });
    expect(loadChromePinPrefs(storage)).toEqual({ menu: true, tabs: true });
  });

  it('ignores corrupt storage and falls back to default pinned', () => {
    const storage = memoryStorage({ [CHROME_PINNED_STORAGE_KEY]: '{not-json' });
    expect(loadChromePinPrefs(storage)).toEqual({ menu: true, tabs: true });
  });
});
