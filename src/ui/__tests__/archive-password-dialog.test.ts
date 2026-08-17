// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { translate } from '../../i18n/messages.js';
import { showArchivePasswordDialog } from '../archive-password-dialog.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('archive password dialog', () => {
  it('returns the password without writing browser storage', async () => {
    localStorage.clear();
    const result = showArchivePasswordDialog(document, {
      displayName: 'secret.cb7',
      retry: false,
      t: (key, vars) => translate('zh-CN', key, vars),
    });
    const input = document.querySelector<HTMLInputElement>('#lightink-archive-password')!;
    input.value = 'session-only';
    document.querySelector<HTMLFormElement>('form')!.requestSubmit();

    await expect(result).resolves.toBe('session-only');
    expect(localStorage).toHaveLength(0);
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
