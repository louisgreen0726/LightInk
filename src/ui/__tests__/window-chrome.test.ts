/**
 * Fullscreen helper unit tests (injected fake window).
 */

import { describe, expect, it, vi } from 'vitest';

import { toggleFullscreen, type AppWindowLike } from '../window-chrome.js';

describe('toggleFullscreen', () => {
  it('returns false when no window is available', async () => {
    await expect(toggleFullscreen(async () => null)).resolves.toBe(false);
  });

  it('enters fullscreen when currently windowed', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(toggleFullscreen(async () => win)).resolves.toBe(true);
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });

  it('exits fullscreen when currently fullscreen', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => true),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(toggleFullscreen(async () => win)).resolves.toBe(false);
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
  });
});
