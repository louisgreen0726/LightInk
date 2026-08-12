// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { labelModal, mountModalFocus } from '../modal-focus.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('modal focus management', () => {
  it('traps focus, restores the background, and returns focus on Escape', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const overlay = document.createElement('div');
    const dialog = document.createElement('div');
    const title = document.createElement('h2');
    const first = document.createElement('button');
    const last = document.createElement('button');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.append(title, first, last);
    overlay.appendChild(dialog);
    labelModal(dialog, title);

    let release = (): void => undefined;
    const onEscape = vi.fn(() => release());
    release = mountModalFocus(document, overlay, dialog, { initialFocus: first, onEscape });

    expect(opener.inert).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(opener.inert).not.toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(overlay.isConnected).toBe(false);
  });
});
