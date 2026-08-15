/**
 * Native window chrome helpers (fullscreen). Thin wrapper around Tauri window
 * API so unit tests can inject a fake; browser-only fallbacks are no-ops.
 */

export interface AppWindowLike {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  setDecorations?(decorations: boolean): Promise<void>;
}

/** Resolve the current Tauri webview/window, or null outside Tauri. */
export async function getAppWindow(): Promise<AppWindowLike | null> {
  // Prefer WebviewWindow (Tauri v2 primary surface), then Window.
  try {
    const webviewMod = await import('@tauri-apps/api/webviewWindow');
    if (typeof webviewMod.getCurrentWebviewWindow === 'function') {
      return webviewMod.getCurrentWebviewWindow() as unknown as AppWindowLike;
    }
  } catch {
    /* try window module next */
  }
  try {
    const winMod = await import('@tauri-apps/api/window');
    if (typeof winMod.getCurrentWindow === 'function') {
      return winMod.getCurrentWindow() as unknown as AppWindowLike;
    }
  } catch {
    return null;
  }
  return null;
}

/** Toggle native fullscreen; returns the new fullscreen state (false if unavailable). */
export async function toggleFullscreen(
  getWindow: () => Promise<AppWindowLike | null> = getAppWindow,
): Promise<boolean> {
  const win = await getWindow();
  if (win === null) {
    return false;
  }
  try {
    const current = await win.isFullscreen();
    const next = !current;
    await win.setFullscreen(next);
    return next;
  } catch (error) {
    // Permission / platform failure — do not throw into UI hotkey path.
    // eslint-disable-next-line no-console
    console.error('[lightink] setFullscreen failed', error);
    return false;
  }
}

/** Show/hide the native title bar (window decorations); no-op outside Tauri. */
export async function setNativeTitleBar(
  visible: boolean,
  getWindow: () => Promise<AppWindowLike | null> = getAppWindow,
): Promise<void> {
  const win = await getWindow();
  if (win === null || typeof win.setDecorations !== 'function') {
    return;
  }
  try {
    await win.setDecorations(visible);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[lightink] setDecorations failed', error);
  }
}
