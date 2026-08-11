/**
 * R14 可选自动保存测试（T10，node 环境，全依赖注入 fake）：
 *   - localStorage 偏好：默认关、持久化往返、损坏值回退；
 *   - createAutosave 调度：开关驱动定时器启停、到点 tick、dispose 清理；
 *   - TabManager.autosaveDirtyTabs：仅保存「已有路径且脏」的 tab（走与手动
 *     保存相同的 saveTab 流），无路径/干净 tab 跳过；外部变更冲突走 R13
 *     对话框不静默覆盖；写失败保持脏标记，下个 tick 可再试。
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import type { EditorInstance } from '../../editor/types.js';
import type { ExternalConflictChoice } from '../../file/external-change.js';
import type { RoundtripDeps } from '../../file/roundtrip.js';
import type { StorageLike } from '../../ui/chrome-prefs.js';
import {
  AUTOSAVE_STORAGE_KEY,
  createAutosave,
  loadAutosaveEnabled,
  saveAutosaveEnabled,
} from '../autosave.js';
import { TabManager, type TabManagerDeps } from '../tab-manager.js';
import type { CloseChoice, TabState } from '../types.js';

/** 内存 storage fake。 */
function makeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

/** 手动时钟：捕获 interval 回调，测试自行触发到点。 */
function makeManualTimer(): {
  setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  fire: () => void;
  hasTimer: () => boolean;
  intervalMs: () => number;
} {
  let fn: (() => void) | null = null;
  let ms = 0;
  return {
    setIntervalFn: (next, nextMs) => {
      fn = next;
      ms = nextMs;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      fn = null;
    },
    fire: () => fn?.(),
    hasTimer: () => fn !== null,
    intervalMs: () => ms,
  };
}

describe('自动保存偏好（localStorage）', () => {
  it('缺省/空值默认关闭', () => {
    expect(loadAutosaveEnabled(null)).toBe(false);
    expect(loadAutosaveEnabled(undefined)).toBe(false);
    expect(loadAutosaveEnabled(makeStorage())).toBe(false);
  });

  it('持久化往返；损坏值回退默认关闭', () => {
    const storage = makeStorage();
    saveAutosaveEnabled(storage, true);
    expect(storage.data.get(AUTOSAVE_STORAGE_KEY)).toBe('true');
    expect(loadAutosaveEnabled(storage)).toBe(true);
    saveAutosaveEnabled(storage, false);
    expect(loadAutosaveEnabled(storage)).toBe(false);

    const corrupt = makeStorage({ [AUTOSAVE_STORAGE_KEY]: '{oops' });
    expect(loadAutosaveEnabled(corrupt)).toBe(false);
  });
});

describe('createAutosave 调度', () => {
  it('默认关闭时不启动定时器；开启后到点触发 tick 并持久化', () => {
    const storage = makeStorage();
    const timer = makeManualTimer();
    const tick = vi.fn();
    const controller = createAutosave({
      storage,
      tick,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });
    expect(controller.isEnabled()).toBe(false);
    expect(timer.hasTimer()).toBe(false);

    controller.setEnabled(true);
    expect(controller.isEnabled()).toBe(true);
    expect(timer.hasTimer()).toBe(true);
    expect(timer.intervalMs()).toBe(30_000);
    expect(loadAutosaveEnabled(storage)).toBe(true);

    timer.fire();
    timer.fire();
    expect(tick).toHaveBeenCalledTimes(2);

    controller.setEnabled(false);
    expect(timer.hasTimer()).toBe(false);
    timer.fire();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('toggle 返回新状态并持久化；偏好恢复时启动即开定时器', () => {
    const storage = makeStorage({ [AUTOSAVE_STORAGE_KEY]: 'true' });
    const timer = makeManualTimer();
    const controller = createAutosave({
      storage,
      tick: vi.fn(),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });
    expect(controller.isEnabled()).toBe(true);
    expect(timer.hasTimer()).toBe(true);

    expect(controller.toggle()).toBe(false);
    expect(timer.hasTimer()).toBe(false);
    expect(loadAutosaveEnabled(storage)).toBe(false);
    expect(controller.toggle()).toBe(true);
    expect(timer.hasTimer()).toBe(true);
  });

  it('dispose 停止定时器', () => {
    const timer = makeManualTimer();
    const tick = vi.fn();
    const controller = createAutosave({
      storage: makeStorage(),
      tick,
      initiallyEnabled: true,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });
    expect(timer.hasTimer()).toBe(true);
    controller.dispose();
    expect(timer.hasTimer()).toBe(false);
    timer.fire();
    expect(tick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TabManager.autosaveDirtyTabs（harness 克隆 tab-manager.test.ts 风格）
// ---------------------------------------------------------------------------

function makeFakeEditor(initial: string): EditorInstance & { content: string } {
  const state = { content: initial };
  return {
    ready: Promise.resolve(),
    get content() {
      return state.content;
    },
    setMarkdown(md: string) {
      state.content = md;
    },
    getMarkdown() {
      return state.content;
    },
    getSelection: () => null,
    getLinkAtCursor: () => null,
    getLinkAtPoint: () => null,
    toggleMark: () => undefined,
    setLink: () => undefined,
    insertImage: () => undefined,
    insertMarkdown: () => false,
    isInTable: () => false,
    runTableOp: () => false,
    focus: vi.fn(),
    selectAll: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    destroy: vi.fn(async () => undefined),
  };
}

function fakeHost(): HTMLElement {
  return { style: { display: '' } } as unknown as HTMLElement;
}

interface Harness {
  manager: TabManager;
  editors: Array<EditorInstance & { content: string }>;
  roundtrip: RoundtripDeps;
  statFile: Mock<
    (path: string) => Promise<{ mtime_ms: number; size: number; fingerprint: string }>
  >;
  confirmExternalConflict: Mock<
    (tab: Pick<TabState, 'title' | 'filePath'>) => Promise<ExternalConflictChoice>
  >;
}

function makeHarness(overrides: Partial<TabManagerDeps> = {}): Harness {
  const editors: Harness['editors'] = [];
  const roundtrip: RoundtripDeps = {
    readFile: vi.fn(async () => '磁盘内容'),
    writeFile: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => null),
    showSaveDialog: vi.fn(async () => null),
    reportError: vi.fn(),
  };
  const statFile: Harness['statFile'] = vi.fn(async () => ({
    mtime_ms: 1000,
    size: 0,
    fingerprint: '1000:0',
  }));
  const confirmExternalConflict: Harness['confirmExternalConflict'] = vi.fn(
    async () => 'keep' as ExternalConflictChoice,
  );
  const deps: TabManagerDeps = {
    mountEditor: vi.fn(async (_el, opts) => {
      const editor = makeFakeEditor(opts.initialMarkdown ?? '');
      editors.push(editor);
      return editor;
    }),
    createHostElement: () => fakeHost(),
    attachHost: vi.fn(),
    detachHost: vi.fn(),
    confirmClose: vi.fn(async (): Promise<CloseChoice> => 'discard'),
    promptRestore: vi.fn(async () => false),
    confirmExternalConflict,
    roundtrip,
    writeSnapshot: vi.fn(async () => undefined),
    clearSnapshot: vi.fn(async () => undefined),
    readStaleSnapshot: vi.fn(async () => null),
    statFile,
    snapshotDebounceMs: 1000,
    ...overrides,
  };
  return { manager: new TabManager(deps), editors, roundtrip, statFile, confirmExternalConflict };
}

/** 打开文件标签并改脏（模拟用户编辑）。 */
async function openDirtyFileTab(
  harness: Harness,
  path: string,
  edit: string,
): Promise<TabState> {
  const tab = await harness.manager.openFile(path);
  if (tab === null) {
    throw new Error('openFile 应成功');
  }
  harness.editors[harness.editors.length - 1]?.setMarkdown(edit);
  harness.manager.handleContentChanged(tab.id);
  return tab;
}

describe('TabManager.autosaveDirtyTabs', () => {
  it('有路径的脏 tab 走同一保存流写盘并清脏（含保存后基线刷新）', async () => {
    const harness = makeHarness();
    const tab = await openDirtyFileTab(harness, '/docs/a.md', '新内容');
    expect(tab.dirty).toBe(true);

    await harness.manager.autosaveDirtyTabs();

    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('/docs/a.md', '新内容');
    expect(tab.dirty).toBe(false);
    expect(tab.lastSavedMarkdown).toBe('新内容');
    // 保存前闸门 + 打开/保存后基线：stat 至少被调用两次。
    expect(harness.statFile.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('无路径的脏 tab 跳过：不写盘也不弹另存为对话框', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.newTab('初始');
    harness.editors[0]?.setMarkdown('未保存的新内容');
    harness.manager.handleContentChanged(tab.id);
    expect(tab.dirty).toBe(true);

    await harness.manager.autosaveDirtyTabs();

    expect(harness.roundtrip.writeFile).not.toHaveBeenCalled();
    expect(harness.roundtrip.showSaveDialog).not.toHaveBeenCalled();
    expect(tab.dirty).toBe(true);
  });

  it('干净 tab（有路径但无编辑）跳过', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.openFile('/docs/clean.md');
    expect(tab?.dirty).toBe(false);

    await harness.manager.autosaveDirtyTabs();

    expect(harness.roundtrip.writeFile).not.toHaveBeenCalled();
  });

  it('外部变更冲突：浮出 R13 对话框，选择保留内存时不写盘、保持脏', async () => {
    const harness = makeHarness();
    const tab = await openDirtyFileTab(harness, '/docs/conflict.md', '内存编辑');
    // 打开基线 mtime=1000；模拟外部写入使磁盘更新。
    harness.statFile.mockResolvedValue({ mtime_ms: 2000, size: 0, fingerprint: '2000:0' });

    await harness.manager.autosaveDirtyTabs();

    expect(harness.confirmExternalConflict).toHaveBeenCalledTimes(1);
    expect(harness.roundtrip.writeFile).not.toHaveBeenCalled();
    expect(tab.dirty).toBe(true);
  });

  it('写失败保持脏标记且不抛出；下个 tick 可再试成功', async () => {
    const harness = makeHarness();
    const tab = await openDirtyFileTab(harness, '/docs/flaky.md', '内容');
    (harness.roundtrip.writeFile as Mock).mockRejectedValueOnce(new Error('disk full'));

    await harness.manager.autosaveDirtyTabs();
    expect(tab.dirty).toBe(true);
    expect(harness.roundtrip.reportError).toHaveBeenCalled();

    await harness.manager.autosaveDirtyTabs();
    expect(harness.roundtrip.writeFile).toHaveBeenCalledTimes(2);
    expect(tab.dirty).toBe(false);
  });

  it('多个有路径脏 tab 一次 tick 全部保存', async () => {
    const harness = makeHarness();
    const a = await openDirtyFileTab(harness, '/docs/one.md', '一');
    const b = await openDirtyFileTab(harness, '/docs/two.md', '二');

    await harness.manager.autosaveDirtyTabs();

    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('/docs/one.md', '一');
    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('/docs/two.md', '二');
    expect(a.dirty).toBe(false);
    expect(b.dirty).toBe(false);
  });

  it('冲突去重：同一外部变更只弹一次（keep 后下 tick 静默跳过），磁盘再变会再提示', async () => {
    const harness = makeHarness();
    const tab = await openDirtyFileTab(harness, '/docs/dup.md', '内存编辑');
    harness.statFile.mockResolvedValue({ mtime_ms: 2000, size: 0, fingerprint: '2000:0' });

    await harness.manager.autosaveDirtyTabs(); // 首次：弹冲突（keep），不写盘
    expect(harness.confirmExternalConflict).toHaveBeenCalledTimes(1);
    expect(harness.roundtrip.writeFile).not.toHaveBeenCalled();
    expect(tab.dirty).toBe(true);

    await harness.manager.autosaveDirtyTabs(); // 同一磁盘态：静默跳过，不重弹
    expect(harness.confirmExternalConflict).toHaveBeenCalledTimes(1);
    expect(tab.dirty).toBe(true);

    harness.statFile.mockResolvedValue({
      mtime_ms: 3000,
      size: 1,
      fingerprint: '3000:1',
    }); // 磁盘再次外部变更
    await harness.manager.autosaveDirtyTabs(); // 新磁盘态：再次提示
    expect(harness.confirmExternalConflict).toHaveBeenCalledTimes(2);
    expect(harness.roundtrip.writeFile).not.toHaveBeenCalled();
    expect(tab.dirty).toBe(true);
  });
});
