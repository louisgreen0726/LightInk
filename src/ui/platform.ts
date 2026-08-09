/**
 * Platform helpers — macOS vs Windows/Linux for shortcut labels and modifiers.
 *
 * Matching already treats Ctrl and Meta as equivalent (`shortcuts.ts`).
 * This module only affects **display** (menus, cheatsheet): Mac shows ⌘/⌥/⇧.
 */

export type HostPlatform = 'mac' | 'windows' | 'linux' | 'unknown';

/** Detect host OS. Prefer navigator.userAgentData / platform; injectable for tests. */
export function detectPlatform(
  nav: {
    platform?: string;
    userAgent?: string;
    userAgentData?: { platform?: string };
  } | null = typeof navigator !== 'undefined' ? navigator : null,
): HostPlatform {
  const uaPlatform = nav?.userAgentData?.platform ?? '';
  const platform = (nav?.platform ?? '').toLowerCase();
  const ua = `${uaPlatform} ${platform} ${nav?.userAgent ?? ''}`.toLowerCase();
  if (ua.includes('mac') || platform.startsWith('mac')) return 'mac';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

export function isMacPlatform(
  nav?: {
    platform?: string;
    userAgent?: string;
    userAgentData?: { platform?: string };
  } | null,
): boolean {
  return detectPlatform(nav) === 'mac';
}

/**
 * Format a canonical combo (`Ctrl+Shift+S`, `Alt+M`, `F11`) for the current OS.
 * - Mac: Ctrl→⌘, Alt→⌥, Shift→⇧, Meta/Cmd→⌘
 * - Others: keep Ctrl/Alt/Shift text
 */
export function formatShortcutLabel(
  combo: string,
  mac: boolean = isMacPlatform(),
): string {
  if (!combo || combo.trim() === '') return '';
  const parts = combo.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return combo;

  if (!mac) {
    // Normalize Cmd/Meta display to Ctrl on non-Mac.
    return parts
      .map((p) => {
        const lower = p.toLowerCase();
        if (lower === 'cmd' || lower === 'meta') return 'Ctrl';
        if (lower === 'ctrl') return 'Ctrl';
        if (lower === 'alt' || lower === 'option') return 'Alt';
        if (lower === 'shift') return 'Shift';
        if (lower === 'tab') return 'Tab';
        return p.length === 1 ? p.toUpperCase() : p;
      })
      .join('+');
  }

  // macOS symbols (Apple HIG style).
  const out: string[] = [];
  let key = '';
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'cmd' || lower === 'meta') {
      out.push('⌘');
    } else if (lower === 'alt' || lower === 'option') {
      out.push('⌥');
    } else if (lower === 'shift') {
      out.push('⇧');
    } else if (lower === 'tab') {
      key = '⇥';
    } else if (lower === 'enter' || lower === 'return') {
      key = '↩';
    } else if (lower === 'backspace') {
      key = '⌫';
    } else if (lower === 'delete') {
      key = '⌦';
    } else if (lower === 'arrowleft' || lower === 'left') {
      key = '←';
    } else if (lower === 'arrowright' || lower === 'right') {
      key = '→';
    } else if (lower === 'arrowup' || lower === 'up') {
      key = '↑';
    } else if (lower === 'arrowdown' || lower === 'down') {
      key = '↓';
    } else {
      key = p.length === 1 ? p.toUpperCase() : p;
    }
  }
  // Modifiers first (already ordered from combo), then key.
  if (key !== '') out.push(key);
  return out.join('');
}
