/**
 * Ctrl/Cmd + 滚轮 → 字号缩放（R5）。
 *
 * 与 Ctrl+= / Ctrl+- / Ctrl+0 共用同一 font-scale 档位与 localStorage 持久化：
 * 向上滚（deltaY<0）放大一档，向下滚缩小一档；放开修饰键则不介入，普通滚轮
 * 行为不变。监听注册在 capture 阶段，确保代码块 / 源码态 / 阅读器内各内容的
 * wheel 监听不会吞掉 Ctrl+滚轮；源码态（source-view.ts）额外在自身 onWheel
 * 顶部短路修饰键作为双保险。
 */
import type { FontScaleHandle } from './font-scale.js';

export type WheelListener = (event: WheelEvent) => void;

export interface WheelZoomTarget {
  addEventListener(type: 'wheel', listener: WheelListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: 'wheel', listener: WheelListener, options?: EventListenerOptions): void;
}

export interface WheelZoomHandle {
  dispose(): void;
}

export interface WheelZoomOptions {
  /** Override the zoom-modifier test（default: ctrlKey || metaKey）。 */
  isZoomModifier?: (event: WheelEvent) => boolean;
}

/**
 * Install Ctrl/Cmd + wheel font zoom on `target`（usually `document`）。
 * Captures at the target so the event reaches this handler before any
 * content-level wheel listeners.
 */
export function installWheelZoom(
  target: WheelZoomTarget,
  handle: FontScaleHandle,
  options: WheelZoomOptions = {},
): WheelZoomHandle {
  const isZoom =
    options.isZoomModifier ?? ((event: WheelEvent) => event.ctrlKey || event.metaKey);
  const onWheel: WheelListener = (event) => {
    if (!isZoom(event)) return;
    if (event.deltaY === 0) return;
    event.preventDefault();
    if (event.deltaY < 0) {
      handle.zoomIn();
    } else {
      handle.zoomOut();
    }
  };
  target.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return {
    dispose(): void {
      target.removeEventListener('wheel', onWheel, { capture: true });
    },
  };
}
