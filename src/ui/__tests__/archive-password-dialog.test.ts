// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { translate } from '../../i18n/messages.js';
import { showArchivePasswordDialog } from '../archive-password-dialog.js';

afterEach(() => {
  document.body.replaceChildren();
});

/** Node 实验性 localStorage 在未设 --localstorage-file 时是 undefined，jsdom 盖不掉。 */
function ensureTestStorage(): Storage {
  const current = globalThis.localStorage;
  if (typeof current === 'object' && current !== null) {
    return current;
  }
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
}

describe('archive password dialog', () => {
  it('returns the password without writing browser storage', async () => {
    const storage = ensureTestStorage();
    storage.clear();
    const result = showArchivePasswordDialog(document, {
      displayName: 'secret.cb7',
      retry: false,
      t: (key, vars) => translate('zh-CN', key, vars),
    });
    const input = document.querySelector<HTMLInputElement>('#lightink-archive-password')!;
    input.value = 'session-only';
    document.querySelector<HTMLFormElement>('form')!.requestSubmit();

    await expect(result).resolves.toBe('session-only');
    expect(storage).toHaveLength(0);
    expect(document.querySelector('.lightink-modal-overlay')).toBeNull();
  });

  it('shows retry copy and cancels with Escape', async () => {
    const result = showArchivePasswordDialog(document, {
      displayName: 'secret.cbr',
      retry: true,
      t: (key, vars) => translate('en', key, vars),
    });
    expect(document.querySelector('.lightink-modal-message')?.textContent).toContain('incorrect');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(result).resolves.toBeNull();
  });
});
