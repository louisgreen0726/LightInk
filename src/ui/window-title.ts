/**
 * Immersive shell window title identity (R1/R3): active document without a
 * permanent tab strip. Pure formatter — main applies to document.title.
 */

export interface WindowTitleTab {
  title: string;
  dirty: boolean;
}

const APP_NAME = '轻墨 LightInk';

/** Build the browser/webview title for the active tab (or app-only when none). */
export function formatDocumentTitle(tab: WindowTitleTab | null): string {
  if (tab === null) {
    return APP_NAME;
  }
  const dirty = tab.dirty ? '● ' : '';
  return `${dirty}${tab.title} — ${APP_NAME}`;
}
