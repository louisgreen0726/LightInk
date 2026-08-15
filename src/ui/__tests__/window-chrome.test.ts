/**
 * Fullscreen helper unit tests (injected fake window).
 */

import { describe, expect, it, vi } from 'vitest';

import { setNativeTitleBar, toggleFullscreen, type AppWindowLike } from '../window-chrome.js';

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

describe('setNativeTitleBar', () => {
  it('hides and restores native decorations', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      setDecorations: vi.fn(async () => undefined),
    };
    await setNativeTitleBar(false, async () => win);
    expect(win.setDecorations).toHaveBeenCalledWith(false);
    await setNativeTitleBar(true, async () => win);
    expect(win.setDecorations).toHaveBeenCalledWith(true);
  });

  it('no-ops when no window or no setDecorations support', async () => {
    await expect(setNativeTitleBar(false, async () => null)).resolves.toBeUndefined();
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(setNativeTitleBar(true, async () => win)).resolves.toBeUndefined();
  });
});
