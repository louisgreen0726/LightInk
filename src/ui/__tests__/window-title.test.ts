/**
 * Window title identity (R1/R3 immersive shell).
 */

import { describe, expect, it } from 'vitest';

import { formatDocumentTitle } from '../window-title.js';

describe('formatDocumentTitle', () => {
  it('uses app name only when no active tab', () => {
    expect(formatDocumentTitle(null)).toBe('轻墨 LightInk');
  });

  it('shows active title with app suffix', () => {
    expect(formatDocumentTitle({ title: 'notes.md', dirty: false })).toBe(
      'notes.md — 轻墨 LightInk',
    );
  });

  it('prefixes dirty marker for unsaved tabs', () => {
    expect(formatDocumentTitle({ title: '未命名-1', dirty: true })).toBe(
      '● 未命名-1 — 轻墨 LightInk',
    );
  });
});
