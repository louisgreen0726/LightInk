/**
 * Persistent preferences for immersive chrome (pin navigation, etc.).
 * Pure storage helpers — shell applies values to ChromeController.
 */

export const CHROME_PINNED_STORAGE_KEY = 'lightink.chrome.pinned';

export interface ChromePinPrefs {
  menu: boolean;
  tabs: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** First-run default: navigation chrome pinned open (user can unpin). */
const DEFAULT_PREFS: ChromePinPrefs = { menu: true, tabs: true };

/** Load pin prefs; missing key uses default pinned; corrupt values fall back to default. */
export function loadChromePinPrefs(storage: StorageLike | null | undefined): ChromePinPrefs {
  if (storage == null) {
    return { ...DEFAULT_PREFS };
  }
  try {
    const raw = storage.getItem(CHROME_PINNED_STORAGE_KEY);
    if (raw === null || raw === '') {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<ChromePinPrefs>;
    // Explicit booleans only — partial objects still fill missing sides with defaults.
    return {
      menu: typeof parsed.menu === 'boolean' ? parsed.menu : DEFAULT_PREFS.menu,
      tabs: typeof parsed.tabs === 'boolean' ? parsed.tabs : DEFAULT_PREFS.tabs,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist pin prefs (best-effort). */
export function saveChromePinPrefs(
  storage: StorageLike | null | undefined,
  prefs: ChromePinPrefs,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(CHROME_PINNED_STORAGE_KEY, JSON.stringify({
      menu: prefs.menu === true,
      tabs: prefs.tabs === true,
    }));
  } catch {
    // Privacy mode / quota — ignore.
  }
}
