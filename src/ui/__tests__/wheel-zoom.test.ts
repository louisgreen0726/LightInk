/**
 * Ctrl + 滚轮字号缩放（R5 / T2）。
 *
 * 用 fake target + 真实 installFontScale handle，直接观察 wheel 事件对
 * font-scale 档位的成功（放大/缩小）与失败（无修饰键 / deltaY=0 / 已到边界）。
 */
import { describe, expect, it } from 'vitest';

import { installFontScale } from '../font-scale.js';
import { installWheelZoom, type WheelListener, type WheelZoomTarget } from '../wheel-zoom.js';

interface WheelLike {
  ctrlKey?: boolean;
  metaKey?: boolean;
  deltaY: number;
}

interface DispatchResult {
  preventedDefault: boolean;
}

function makeTarget(): WheelZoomTarget & {
  dispatch(event: WheelLike): DispatchResult;
} {
  let listener: WheelListener | null = null;
  let prevented = false;
  return {
    addEventListener(_type, fn) {
      listener = fn;
    },
    removeEventListener() {
      listener = null;
    },
    dispatch(event) {
      prevented = false;
      const fake = {
        ctrlKey: event.ctrlKey ?? false,
        metaKey: event.metaKey ?? false,
        deltaY: event.deltaY,
        preventDefault() {
          prevented = true;
        },
      } as unknown as WheelEvent;
      listener?.(fake);
      return { preventedDefault: prevented };
    },
  };
}

function fakeRoot(): {
  style: { setProperty(n: string, v: string): void; removeProperty(n: string): void };
} {
  const props: Record<string, string> = {};
  return {
    style: {
      setProperty(name: string, value: string) {
        props[name] = value;
      },
      removeProperty(name: string) {
        delete props[name];
      },
    },
  };
}

describe('installWheelZoom (R5/T2)', () => {
  it('zooms in on Ctrl+scroll up and prevents the browser default', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle);
    const res = target.dispatch({ ctrlKey: true, deltaY: -100 });
    expect(res.preventedDefault).toBe(true);
    expect(handle.scale).toBe(1.125);
  });

  it('zooms out on Ctrl+scroll down', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle);
    target.dispatch({ ctrlKey: true, deltaY: 100 });
    expect(handle.scale).toBe(0.925);
  });

  it('treats Cmd (metaKey) like Ctrl for macOS parity', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle);
    target.dispatch({ metaKey: true, deltaY: -100 });
    expect(handle.scale).toBe(1.125);
  });

  it('does nothing without the zoom modifier (plain scroll passes through)', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle);
    const res = target.dispatch({ deltaY: -100 });
    expect(res.preventedDefault).toBe(false);
    expect(handle.scale).toBe(1);
  });

  it('ignores Ctrl+wheel when deltaY is 0', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle);
    const res = target.dispatch({ ctrlKey: true, deltaY: 0 });
    expect(res.preventedDefault).toBe(false);
    expect(handle.scale).toBe(1);
  });

  it('clamps at the max step (no overflow past 1.5)', () => {
    const handle = installFontScale(fakeRoot(), null, 1.5);
    const target = makeTarget();
    installWheelZoom(target, handle);
    target.dispatch({ ctrlKey: true, deltaY: -100 });
    expect(handle.scale).toBe(1.5);
  });

  it('clamps at the min step (no underflow below 0.85)', () => {
    const handle = installFontScale(fakeRoot(), null, 0.85);
    const target = makeTarget();
    installWheelZoom(target, handle);
    target.dispatch({ ctrlKey: true, deltaY: 100 });
    expect(handle.scale).toBe(0.85);
  });

  it('dispose stops further zoom', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    const zoom = installWheelZoom(target, handle);
    zoom.dispose();
    target.dispatch({ ctrlKey: true, deltaY: -100 });
    expect(handle.scale).toBe(1);
  });
});
