/**
 * Immersive shell window title identity (R1/R3): active document without a
 * permanent tab strip. Pure formatter — main applies to document.title.
 */

export interface WindowTitleTab {
  title: string;
  dirty: boolean;
}

let appName = 'LightInk';

/** Set localized application name used in the window title. */
export function setAppDisplayName(name: string): void {
  if (name.trim() !== '') {
    appName = name.trim();
  }
}

/** Build the browser/webview title for the active tab (or app-only when none). */
export function formatDocumentTitle(tab: WindowTitleTab | null): string {
  if (tab === null) {
    return appName;
  }
  const dirty = tab.dirty ? '● ' : '';
  return `${dirty}${tab.title} — ${appName}`;
}
