/**
 * Ctrl + 滚轮字号缩放（R5 / T2）。
 *
 * 用 fake target + 真实 installFontScale handle，直接观察 wheel 事件对
 * font-scale 档位的成功（放大/缩小）与失败（无修饰键 / deltaY=0 / 已到边界）。
 */
import { describe, expect, it } from 'vitest';

import { installFontScale } from '../font-scale.js';
import {
  captureWheelZoomAnchor,
  installWheelZoom,
  restoreWheelZoomAnchor,
  type WheelListener,
  type WheelZoomAnchorElement,
  type WheelZoomTarget,
} from '../wheel-zoom.js';

interface WheelLike {
  ctrlKey?: boolean;
  metaKey?: boolean;
  deltaY: number;
  clientX?: number;
  clientY?: number;
}

interface DispatchResult {
  preventedDefault: boolean;
  propagationStopped: boolean;
}

function makeTarget(): WheelZoomTarget & {
  dispatch(event: WheelLike): DispatchResult;
} {
  let listener: WheelListener | null = null;
  let prevented = false;
  let stopped = false;
  return {
    addEventListener(_type, fn) {
      listener = fn;
    },
    removeEventListener() {
      listener = null;
    },
    dispatch(event) {
      prevented = false;
      stopped = false;
      const fake = {
        ctrlKey: event.ctrlKey ?? false,
        metaKey: event.metaKey ?? false,
        deltaY: event.deltaY,
        ...(event.clientX !== undefined ? { clientX: event.clientX } : {}),
        ...(event.clientY !== undefined ? { clientY: event.clientY } : {}),
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
      } as unknown as WheelEvent;
      listener?.(fake);
      return { preventedDefault: prevented, propagationStopped: stopped };
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

  it('clamps at the max step', () => {
    const handle = installFontScale(fakeRoot(), null, 5);
    const target = makeTarget();
    installWheelZoom(target, handle);
    target.dispatch({ ctrlKey: true, deltaY: -100 });
    expect(handle.scale).toBe(5);
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

  it('coalesces a burst of trackpad events into one step', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle, { minIntervalMs: 80 });
    target.dispatch({ ctrlKey: true, deltaY: -20 });
    target.dispatch({ ctrlKey: true, deltaY: -20 });
    target.dispatch({ ctrlKey: true, deltaY: -20 });
    expect(handle.scale).toBe(1.125);
  });

  it('stops propagation so content-level wheel listeners never see the zoom event', () => {
    const handle = installFontScale(fakeRoot(), null, 1);
    const target = makeTarget();
    installWheelZoom(target, handle, { anchorSource: null });
    const res = target.dispatch({ ctrlKey: true, deltaY: -100 });
    expect(res.propagationStopped).toBe(true);
    expect(res.preventedDefault).toBe(true);
  });
});

/** fake 锚点元素：closest 按 map 返回，rect 可变（模拟缩放后几何）。 */
function fakeAnchorElement(opts: {
  rect: { top: number; height: number };
  scroller?: { scrollTop: number };
  block?: WheelZoomAnchorElement;
}): WheelZoomAnchorElement {
  return {
    closest(selector: string) {
      if (selector.includes('lightink-editor-area')) {
        return (opts.scroller ?? null) as unknown as WheelZoomAnchorElement | null;
      }
      return opts.block ?? null;
    },
    getBoundingClientRect() {
      return opts.rect;
    },
  };
}

describe('wheel zoom 鼠标锚点（R5 修复）', () => {
  it('capture：指针不在已知滚动容器内 → null（不补偿）', () => {
    const anchor = captureWheelZoomAnchor(
      { elementFromPoint: () => fakeAnchorElement({ rect: { top: 0, height: 10 } }) },
      100,
      200,
    );
    expect(anchor).toBeNull();
  });

  it('capture + restore：缩放后补偿 scrollTop 使块内同比例点回到指针 Y', () => {
    const scroller = { scrollTop: 1000 };
    const rect = { top: 180, height: 40 };
    const block = fakeAnchorElement({ rect });
    const hit = fakeAnchorElement({ rect, scroller, block });
    // 指针 y=200：块内比例 (200-180)/40 = 0.5。
    const anchor = captureWheelZoomAnchor({ elementFromPoint: () => hit }, 100, 200);
    expect(anchor).not.toBeNull();
    expect(anchor!.frac).toBe(0.5);
    expect(anchor!.scroller).toBe(scroller);
    // 模拟缩放后：块变大（height 40→60）且上移（top 180→150）。
    rect.top = 150;
    rect.height = 60;
    restoreWheelZoomAnchor(anchor!);
    // 块内 0.5 处 = 150+30=180，指针 y=200 → scrollTop 减 20。
    expect(scroller.scrollTop).toBe(980);
  });

  it('缩放流程：Ctrl+滚轮带坐标 → 缩放档位并补偿滚动容器', () => {
    const root = fakeRoot();
    const handle = installFontScale(root, null, 1);
    const target = makeTarget();
    const scroller = { scrollTop: 500 };
    // 几何随档位变化（模拟缩放引起的重排）：height ∝ scale，top 随上方内容增高而上移。
    const hit = fakeAnchorElement({
      rect: { top: 0, height: 0 },
      scroller,
    });
    const block = fakeAnchorElement({ rect: { top: 0, height: 0 } });
    block.getBoundingClientRect = () => ({
      top: 100 - 160 * (handle.scale - 1),
      height: 40 * handle.scale,
    });
    hit.closest = (selector: string) =>
      (selector.includes('lightink-editor-area')
        ? scroller
        : block) as unknown as WheelZoomAnchorElement | null;
    installWheelZoom(target, handle, {
      anchorSource: { elementFromPoint: () => hit },
    });
    target.dispatch({ ctrlKey: true, deltaY: -100, clientX: 10, clientY: 110 });
    expect(handle.scale).toBe(1.125);
    // 捕获时（scale 1）：frac = (110-100)/40 = 0.25；
    // 缩放后：top 80、height 45 → 同比例点 = 80+11.25 = 91.25 → scrollTop 减 18.75。
    expect(scroller.scrollTop).toBeCloseTo(481.25, 5);
  });
});
