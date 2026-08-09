/**
 * Window title identity (R1/R3 immersive shell).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { formatDocumentTitle, setAppDisplayName } from '../window-title.js';

describe('formatDocumentTitle', () => {
  afterEach(() => {
    // Default production name for Chinese locale; tests pin explicitly below.
    setAppDisplayName('LightInk');
  });

  it('uses app name only when no active tab', () => {
    setAppDisplayName('LightInk');
    expect(formatDocumentTitle(null)).toBe('LightInk');
  });

  it('shows active title with app suffix', () => {
    setAppDisplayName('LightInk');
    expect(formatDocumentTitle({ title: 'notes.md', dirty: false })).toBe(
      'notes.md — LightInk',
    );
  });

  it('prefixes dirty marker for unsaved tabs', () => {
    setAppDisplayName('轻墨 LightInk');
    expect(formatDocumentTitle({ title: '未命名-1', dirty: true })).toBe(
      '● 未命名-1 — 轻墨 LightInk',
    );
  });

  it('setAppDisplayName updates the suffix', () => {
    setAppDisplayName('轻墨 LightInk');
    expect(formatDocumentTitle(null)).toBe('轻墨 LightInk');
  });
});
