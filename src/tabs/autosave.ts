/**
 * `autosave` — R14 可选自动保存（T10）。
 *
 * 偏好存 localStorage（键 `lightink.autosave.enabled`，默认关，克隆
 * status-bar 的 storage 模式）；开启后按固定间隔（默认 30s，时间制）
 * 触发注入的 `tick`。tick 的保存语义在 TabManager.autosaveDirtyTabs
 * （仅已有路径的脏 tab，走与手动保存完全相同的 saveTab 流，含 R13
 * 保存前 mtime 闸门）；本模块只管偏好持久化与定时调度。
 *
 * 无路径文档不自动写盘（继续依赖既有崩溃快照/草稿）；写失败保持 dirty
 * 并经既有 reportError 通道上报，下个 tick 自然再试，无重试风暴。
 *
 * 测试性设计：storage / tick / 定时器全部注入，vitest 可 headless 替换。
 */

import type { StorageLike } from '../ui/chrome-prefs.js';

export const AUTOSAVE_STORAGE_KEY = 'lightink.autosave.enabled';

/** 首启默认：自动保存默认关闭（R14 安全默认），用户经文件菜单打开。 */
const DEFAULT_ENABLED = false;

export const DEFAULT_AUTOSAVE_INTERVAL_MS = 30_000;

/** Load autosave pref; missing key / corrupt value falls back to default. */
export function loadAutosaveEnabled(storage: StorageLike | null | undefined): boolean {
  if (storage == null) {
    return DEFAULT_ENABLED;
  }
  try {
    const raw = storage.getItem(AUTOSAVE_STORAGE_KEY);
    if (raw === null || raw === '') {
      return DEFAULT_ENABLED;
    }
    return JSON.parse(raw) === true;
  } catch {
    return DEFAULT_ENABLED;
  }
}

/** Persist autosave pref (best-effort). */
export function saveAutosaveEnabled(
  storage: StorageLike | null | undefined,
  enabled: boolean,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(enabled === true));
  } catch {
    // Privacy mode / quota — ignore.
  }
}

export interface AutosaveDeps {
  /** Optional storage (default: localStorage when available). Pass null to disable persistence. */
  storage?: StorageLike | null;
  /** 每次到点触发的保存动作（生产为 commit 源码态 + manager.autosaveDirtyTabs）。 */
  tick: () => void | Promise<void>;
  /** 间隔毫秒，默认 30000（R14 固定时间制）。 */
  intervalMs?: number;
  /** 定时器注入（测试用 fake / 手动时钟）。 */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  /** 初始开关覆盖（测试）；缺省从 storage 读取。 */
  initiallyEnabled?: boolean;
  /** Optional error sink for rejected or synchronously throwing ticks. */
  onError?: (error: unknown) => void;
}

export interface AutosaveController {
  isEnabled(): boolean;
  /** 设置开关并持久化；开启即启动定时器，关闭即停止。 */
  setEnabled(enabled: boolean): void;
  /** 切换开关；返回切换后的状态。 */
  toggle(): boolean;
  /** 停止定时器，并等待当前 tick 收口（应用退出/测试清理）。 */
  dispose(): Promise<void>;
}

function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    /* privacy mode */
  }
  return null;
}

export function createAutosave(deps: AutosaveDeps): AutosaveController {
  const storage = resolveStorage(deps.storage);
  const intervalMs = deps.intervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
  let enabled = deps.initiallyEnabled ?? loadAutosaveEnabled(storage);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  function reportError(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // Error reporting must not create a rejected timer task.
    }
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function syncTimer(): void {
    stopTimer();
    if (enabled) {
      timer = setIntervalFn(runTick, intervalMs);
    }
  }

  function runTick(): void {
    if (running !== null) {
      return;
    }
    let result: void | Promise<void>;
    try {
      result = deps.tick();
    } catch (error) {
      reportError(error);
      return;
    }
    const pending = Promise.resolve(result).catch((error: unknown) => {
      reportError(error);
    });
    running = pending;
    void pending.then(() => {
      if (running === pending) {
        running = null;
      }
    });
  }

  syncTimer();

  return {
    isEnabled: () => enabled,
    setEnabled(next: boolean) {
      enabled = next;
      saveAutosaveEnabled(storage, enabled);
      syncTimer();
    },
    toggle() {
      const next = !enabled;
      enabled = next;
      saveAutosaveEnabled(storage, enabled);
      syncTimer();
      return next;
    },
    async dispose() {
      stopTimer();
      await running;
    },
  };
}
