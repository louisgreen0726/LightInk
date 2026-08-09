/**
 * Font scale steps, snap, load/save, and install apply.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEPS,
  formatFontScaleLabel,
  installFontScale,
  loadFontScale,
  saveFontScale,
  snapFontScale,
} from '../font-scale.js';

describe('snapFontScale', () => {
  it('snaps to nearest discrete step', () => {
    expect(snapFontScale(1)).toBe(1);
    expect(snapFontScale(1.1)).toBe(1.125);
    expect(snapFontScale(0.9)).toBe(0.925);
    expect(snapFontScale(99)).toBe(FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1]);
    expect(snapFontScale(Number.NaN)).toBe(DEFAULT_FONT_SCALE);
  });
});

describe('formatFontScaleLabel', () => {
  it('formats percent labels', () => {
    expect(formatFontScaleLabel(1)).toBe('100%');
    expect(formatFontScaleLabel(1.25)).toBe('125%');
  });
});

describe('load/saveFontScale', () => {
  it('loads default when missing; persists snaps', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    expect(loadFontScale(storage)).toBe(1);
    saveFontScale(storage, 1.25);
    expect(loadFontScale(storage)).toBe(1.25);
    expect(loadFontScale(null)).toBe(1);
  });
});

describe('installFontScale', () => {
  it('applies CSS var and steps zoom in/out/reset', () => {
    const props: Record<string, string> = {};
    const root = {
      style: {
        setProperty(name: string, value: string) {
          props[name] = value;
        },
        removeProperty(name: string) {
          delete props[name];
        },
      },
    };
    const store: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    const handle = installFontScale(root, storage, 1);
    expect(props['--lightink-font-scale']).toBe('1');
    expect(handle.zoomIn()).toBe(1.125);
    expect(props['--lightink-font-scale']).toBe('1.125');
    expect(handle.label).toBe('113%');
    expect(handle.zoomOut()).toBe(1);
    expect(handle.reset()).toBe(1);
    handle.dispose();
    expect(props['--lightink-font-scale']).toBeUndefined();
  });
});
