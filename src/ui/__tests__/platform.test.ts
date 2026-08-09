import { describe, expect, it } from 'vitest';

import { detectPlatform, formatShortcutLabel, isMacPlatform } from '../platform.js';

describe('detectPlatform', () => {
  it('detects mac / windows', () => {
    expect(detectPlatform({ platform: 'MacIntel', userAgent: '' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32', userAgent: '' })).toBe('windows');
  });
});

describe('formatShortcutLabel', () => {
  it('keeps Ctrl form on Windows', () => {
    expect(formatShortcutLabel('Ctrl+Shift+S', false)).toBe('Ctrl+Shift+S');
    expect(formatShortcutLabel('Alt+M', false)).toBe('Alt+M');
  });

  it('uses Apple symbols on Mac', () => {
    expect(formatShortcutLabel('Ctrl+S', true)).toBe('⌘S');
    expect(formatShortcutLabel('Ctrl+Shift+S', true)).toBe('⌘⇧S');
    expect(formatShortcutLabel('Alt+M', true)).toBe('⌥M');
    expect(formatShortcutLabel('Ctrl+Alt+I', true)).toBe('⌘⌥I');
  });
});

describe('isMacPlatform', () => {
  it('true for MacIntel', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false);
  });
});
