/**
 * Reading font scale — user-adjustable body/code size over display-tier baselines.
 *
 * Display tiers (display-scale.ts) set absolute `--lightink-font-size*` for the
 * screen class; this multiplies them via `--lightink-font-scale` so zoom works
 * the same on 1080p and 4K without fighting media queries.
 *
 * Persistence: localStorage `lightink.fontScale` (numeric factor string).
 */

export const FONT_SCALE_STORAGE_KEY = 'lightink.fontScale';

/** Discrete steps (≈ −15% … +400% around the tier baseline). */
export const FONT_SCALE_STEPS = [
  0.85, 0.925, 1, 1.125, 1.25, 1.375, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

export type FontScaleStep = (typeof FONT_SCALE_STEPS)[number];

export const DEFAULT_FONT_SCALE: FontScaleStep = 1;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FontScaleRootLike {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

export interface FontScaleHandle {
  /** Current scale factor (1 = tier default). */
  readonly scale: number;
  /** Percent label for menus, e.g. `100%`. */
  readonly label: string;
  zoomIn(): number;
  zoomOut(): number;
  reset(): number;
  /** Apply an arbitrary factor (clamped to nearest step). */
  setScale(scale: number): number;
  dispose(): void;
}

/** Snap any number to the nearest discrete step (clamped to range). */
export function snapFontScale(value: number): FontScaleStep {
  if (!Number.isFinite(value)) {
    return DEFAULT_FONT_SCALE;
  }
  let best: FontScaleStep = DEFAULT_FONT_SCALE;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const step of FONT_SCALE_STEPS) {
    const dist = Math.abs(step - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = step;
    }
  }
  return best;
}

export function formatFontScaleLabel(scale: number): string {
  const pct = Math.round(snapFontScale(scale) * 100);
  return `${pct}%`;
}

export function loadFontScale(storage: StorageLike | null | undefined): FontScaleStep {
  if (storage == null) {
    return DEFAULT_FONT_SCALE;
  }
  try {
    const raw = storage.getItem(FONT_SCALE_STORAGE_KEY);
    if (raw === null || raw === '') {
      return DEFAULT_FONT_SCALE;
    }
    return snapFontScale(Number(raw));
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

export function saveFontScale(
  storage: StorageLike | null | undefined,
  scale: number,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(FONT_SCALE_STORAGE_KEY, String(snapFontScale(scale)));
  } catch {
    // Privacy mode / quota — ignore.
  }
}

function stepIndex(scale: number): number {
  const snapped = snapFontScale(scale);
  const idx = FONT_SCALE_STEPS.indexOf(snapped);
  return idx < 0 ? FONT_SCALE_STEPS.indexOf(DEFAULT_FONT_SCALE) : idx;
}

/**
 * Install font scale on a root element (usually `document.documentElement`).
 * Sets CSS `--lightink-font-scale` and persists changes.
 */
export function installFontScale(
  root: FontScaleRootLike = document.documentElement,
  storage: StorageLike | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
  initial?: number,
): FontScaleHandle {
  let scale = snapFontScale(initial ?? loadFontScale(storage));

  const apply = (next: FontScaleStep): number => {
    const changed = next !== scale;
    scale = next;
    root.style.setProperty('--lightink-font-scale', String(next));
    if (!changed) {
      return next;
    }
    // 同步持久化：localStorage 写入极小；防抖会让“改完 250ms 内关窗”丢最后一步，
    // 进程退出时 dispose 也无法可靠 flush。
    saveFontScale(storage, next);
    // PDF 页宿主不走 CSS zoom，需按新字号重栅格化（reader-view 监听此事件）。
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: next }));
    }
    return next;
  };

  apply(scale);

  return {
    get scale() {
      return scale;
    },
    get label() {
      return formatFontScaleLabel(scale);
    },
    zoomIn(): number {
      const i = stepIndex(scale);
      const next = FONT_SCALE_STEPS[Math.min(FONT_SCALE_STEPS.length - 1, i + 1)]!;
      return apply(next);
    },
    zoomOut(): number {
      const i = stepIndex(scale);
      const next = FONT_SCALE_STEPS[Math.max(0, i - 1)]!;
      return apply(next);
    },
    reset(): number {
      return apply(DEFAULT_FONT_SCALE);
    },
    setScale(value: number): number {
      return apply(snapFontScale(value));
    },
    dispose(): void {
      root.style.removeProperty('--lightink-font-scale');
    },
  };
}
