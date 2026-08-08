/**
 * TabManager 行为测试（node 环境，全依赖注入 fake）：
 *   - 新建/打开/保存/另存为/关闭/切换的状态变迁；
 *   - 多标签并行编辑互不影响、各自独立脏标记；
 *   - 未保存关闭的三选一确认；
 *   - 崩溃快照的防抖写入、过期检测与恢复提示；
 *   - 保存-重开内容往返无损（中文 + 特殊字符）。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { EditorInstance } from '../../editor/types.js';
import type { RoundtripDeps } from '../../file/roundtrip.js';
import { fileNameOf, snapshotKeyOf, TabManager, type TabManagerDeps } from '../tab-manager.js';
import type { CloseChoice, TabState } from '../types.js';

type ConfirmCloseMock = Mock<
  (tab: Pick<TabState, 'title' | 'filePath'>) => Promise<CloseChoice>
>;
type PromptRestoreMock = Mock<(path: string) => Promise<boolean>>;

/** 假编辑器：内存字符串模拟内容。 */
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
    destroy: vi.fn(async () => undefined),
  };
}

function fakeHost(): HTMLElement {
  return { style: { display: '' } } as unknown as HTMLElement;
}

interface Harness {
  manager: TabManager;
  deps: TabManagerDeps;
  editors: Array<EditorInstance & { content: string }>;
  roundtrip: RoundtripDeps;
  snapshots: Map<string, string>;
  confirmClose: ConfirmCloseMock;
  promptRestore: PromptRestoreMock;
}

function makeHarness(overrides: Partial<TabManagerDeps> = {}): Harness {
  const editors: Harness['editors'] = [];
  const snapshots = new Map<string, string>();
  const roundtrip: RoundtripDeps = {
    readFile: vi.fn(async () => '磁盘内容'),
    writeFile: vi.fn(async () => undefined),
    clearSnapshot: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => null),
    showSaveDialog: vi.fn(async () => null),
    reportError: vi.fn(),
  };
  const confirmClose: ConfirmCloseMock = vi.fn(
    async (_tab: Pick<TabState, 'title' | 'filePath'>) => 'discard' as CloseChoice,
  );
  const promptRestore: PromptRestoreMock = vi.fn(async (_path: string) => false);
  const deps: TabManagerDeps = {
    mountEditor: vi.fn(async (_el, opts) => {
      const editor = makeFakeEditor(opts.initialMarkdown ?? '');
      editors.push(editor);
      return editor;
    }),
    createHostElement: () => fakeHost(),
    attachHost: vi.fn(),
    detachHost: vi.fn(),
    confirmClose,
    promptRestore,
    roundtrip,
    writeSnapshot: vi.fn(async (key: string, content: string) => {
      snapshots.set(key, content);
    }),
    clearSnapshot: vi.fn(async (key: string) => {
      snapshots.delete(key);
    }),
    readStaleSnapshot: vi.fn(async () => null),
    snapshotDebounceMs: 1000,
    ...overrides,
  };
  return { manager: new TabManager(deps), deps, editors, roundtrip, snapshots, confirmClose, promptRestore };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('新建与切换', () => {
  it('newTab 创建未命名标签并置为活动', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab();
    expect(manager.tabList).toHaveLength(1);
    expect(manager.activeTabId).toBe(tab.id);
    expect(tab.title).toBe('未命名-1');
    expect(tab.filePath).toBeNull();
    expect(tab.dirty).toBe(false);
    expect(snapshotKeyOf(tab)).toMatch(/^untitled-/);
  });

  it('两个未命名标签的快照键互不相同（跨会话唯一 token）', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    expect(snapshotKeyOf(a)).not.toBe(snapshotKeyOf(b));
  });

  it('switchTab 只显示活动标签的宿主元素', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    manager.switchTab(a.id);
    expect((a.hostElement as { style: { display: string } }).style.display).toBe('');
    expect((b.hostElement as { style: { display: string } }).style.display).toBe('none');
    manager.switchTab(b.id);
    expect(manager.activeTabId).toBe(b.id);
  });
});

describe('多标签并行编辑互不影响', () => {
  it('各标签内容与脏标记独立', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab('甲');
    const b = await manager.newTab('乙');
    a.editor.setMarkdown('甲-改');
    manager.handleContentChanged(a.id);
    expect(a.dirty).toBe(true);
    expect(b.dirty).toBe(false);
    expect(a.editor.getMarkdown()).toBe('甲-改');
    expect(b.editor.getMarkdown()).toBe('乙');
  });

  it('undo 回到已保存内容时脏标记自动清除', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab('原文');
    tab.editor.setMarkdown('改过');
    manager.handleContentChanged(tab.id);
    expect(tab.dirty).toBe(true);
    tab.editor.setMarkdown('原文'); // 模拟 undo 回保存点
    manager.handleContentChanged(tab.id);
    expect(tab.dirty).toBe(false);
  });
});

describe('打开与内容往返', () => {
  it('openFile 读取内容创建标签，标题取文件名', async () => {
    const customRoundtrip: RoundtripDeps = {
      readFile: vi.fn(async () => '# 你好 🚀\n\n特殊字符 <>&"\'\\'),
      writeFile: vi.fn(async () => undefined),
      clearSnapshot: vi.fn(async () => undefined),
      showOpenDialog: vi.fn(async () => null),
      showSaveDialog: vi.fn(async () => null),
      reportError: vi.fn(),
    };
    const { manager } = makeHarness({ roundtrip: customRoundtrip });
    const tab = await manager.openFile('C:\\docs\\笔记.md');
    expect(tab).not.toBeNull();
    expect(tab!.filePath).toBe('C:\\docs\\笔记.md');
    expect(tab!.title).toBe('笔记.md');
    expect(tab!.dirty).toBe(false);
    expect(tab!.editor.getMarkdown()).toBe('# 你好 🚀\n\n特殊字符 <>&"\'\\');
    expect(customRoundtrip.readFile).toHaveBeenCalledWith('C:\\docs\\笔记.md');
  });

  it('保存-重开往返无损（中文与特殊字符）', async () => {
    const harness = makeHarness();
    let disk = '';
    (harness.roundtrip.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (_p: string, c: string) => {
        disk = c;
      },
    );
    (harness.roundtrip.readFile as ReturnType<typeof vi.fn>).mockImplementation(
      async () => disk,
    );
    const tab = await harness.manager.newTab();
    const content = '# 标题 🎉\n\n中文、emoji 🚀、<html>、"引号"、\\反斜杠\n';
    tab.editor.setMarkdown(content);
    await expect(harness.manager.saveTabAs(tab.id)).resolves.toBe(false); // 对话框取消
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\往返.md',
    );
    await expect(harness.manager.saveTabAs(tab.id)).resolves.toBe(true);
    expect(disk).toBe(content);

    // 重新打开同一文件 → 内容一致
    await harness.manager.closeTab(tab.id);
    const reopened = await harness.manager.openFile('D:\\往返.md');
    expect(reopened!.editor.getMarkdown()).toBe(content);
    expect(reopened!.dirty).toBe(false);
  });

  it('重复打开同一路径切换而非新建', async () => {
    const { manager } = makeHarness();
    const first = await manager.openFile('C:\\a.md');
    const again = await manager.openFile('C:\\a.md');
    expect(again!.id).toBe(first!.id);
    expect(manager.tabList).toHaveLength(1);
  });
});

describe('保存与脏标记', () => {
  it('保存成功清脏标记并清除崩溃快照', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改动');
    harness.manager.handleContentChanged(tab!.id);
    expect(tab!.dirty).toBe(true);
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(true);
    expect(tab!.dirty).toBe(false);
    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('C:\\a.md', '改动');
    expect(harness.roundtrip.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });

  it('保存失败保持脏标记且不清快照', async () => {
    const harness = makeHarness();
    (harness.roundtrip.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      '磁盘错误',
    );
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改动');
    harness.manager.handleContentChanged(tab!.id);
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(false);
    expect(tab!.dirty).toBe(true);
    expect(harness.roundtrip.clearSnapshot).not.toHaveBeenCalled();
  });

  it('未命名标签保存转另存为，成功后迁移路径与标题', async () => {
    const harness = makeHarness();
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\命名.md',
    );
    const tab = await harness.manager.newTab('草稿');
    tab!.editor.setMarkdown('草稿-改');
    await expect(harness.manager.saveTab(tab.id)).resolves.toBe(true);
    expect(tab.filePath).toBe('D:\\命名.md');
    expect(tab.title).toBe('命名.md');
    expect(tab.dirty).toBe(false);
    expect(snapshotKeyOf(tab)).toBe('D:\\命名.md');
  });
});

describe('关闭未保存标签', () => {
  it('confirmClose=cancel 不关闭', async () => {
    const harness = makeHarness();
    harness.confirmClose.mockResolvedValue('cancel');
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab.id);
    await expect(harness.manager.closeTab(tab.id)).resolves.toBe(false);
    expect(harness.manager.tabList).toHaveLength(1);
  });

  it('confirmClose=discard 关闭并清除快照、销毁编辑器', async () => {
    const harness = makeHarness();
    harness.confirmClose.mockResolvedValue('discard');
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab.id);
    await expect(harness.manager.closeTab(tab.id)).resolves.toBe(true);
    expect(harness.manager.tabList).toHaveLength(0);
    expect(harness.manager.activeTabId).toBeNull();
    expect(tab.editor.destroy).toHaveBeenCalled();
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith(tab.syntheticId);
  });

  it('confirmClose=save 先保存再关闭；保存失败则不关闭', async () => {
    const harness = makeHarness();
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\s.md',
    );
    harness.confirmClose.mockResolvedValue('save');
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab.id);
    await expect(harness.manager.closeTab(tab.id)).resolves.toBe(true);
    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('D:\\s.md', '改');

    // 保存失败场景
    const harness2 = makeHarness();
    harness2.confirmClose.mockResolvedValue('save');
    (harness2.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    ); // 另存为取消
    const tab2 = await harness2.manager.newTab();
    tab2.editor.setMarkdown('改');
    harness2.manager.handleContentChanged(tab2.id);
    await expect(harness2.manager.closeTab(tab2.id)).resolves.toBe(false);
    expect(harness2.manager.tabList).toHaveLength(1);
  });

  it('关闭活动标签后切换到相邻标签', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    await manager.closeTab(b.id);
    expect(manager.activeTabId).toBe(a.id);
  });
});

describe('崩溃快照', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('编辑防抖后写入快照（键为文件路径或 untitled 合成 id）', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('未保存的草稿');
    harness.manager.handleContentChanged(tab.id);
    expect(harness.deps.writeSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(
      tab.syntheticId,
      '未保存的草稿',
    );
  });

  it('连续编辑只触发一次防抖快照', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('v1');
    harness.manager.handleContentChanged(tab.id);
    vi.advanceTimersByTime(500);
    tab.editor.setMarkdown('v2');
    harness.manager.handleContentChanged(tab.id);
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(tab.syntheticId, 'v2');
  });

  it('已保存文件编辑后的快照键是文件路径', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab!.id);
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith('C:\\a.md', '改');
  });

  it('打开文件时检测到过期快照：选择恢复则载入且保持脏标记', async () => {
    const harness = makeHarness();
    (harness.deps.readStaleSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      '崩溃前的未保存内容',
    );
    (harness.roundtrip.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      '磁盘旧内容',
    );
    harness.promptRestore.mockResolvedValue(true);
    const tab = await harness.manager.openFile('C:\\a.md');
    expect(tab!.editor.getMarkdown()).toBe('崩溃前的未保存内容');
    expect(tab!.dirty).toBe(true);
  });

  it('放弃恢复则使用磁盘内容且清掉旧快照', async () => {
    const harness = makeHarness();
    (harness.deps.readStaleSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      '崩溃前的内容',
    );
    harness.promptRestore.mockResolvedValue(false);
    const tab = await harness.manager.openFile('C:\\a.md');
    expect(tab!.editor.getMarkdown()).toBe('磁盘内容');
    expect(tab!.dirty).toBe(false);
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });
});

describe('辅助函数', () => {
  it('fileNameOf 同时兼容两种分隔符', () => {
    expect(fileNameOf('C:\\docs\\笔记.md')).toBe('笔记.md');
    expect(fileNameOf('/home/user/a.md')).toBe('a.md');
  });
});

describe('未命名崩溃草稿恢复', () => {
  it('recoverUntitledDrafts：恢复则以其原键开标签且保持脏标记', async () => {
    const harness = makeHarness({
      listUntitledDrafts: vi.fn(async () => [
        { key: 'untitled-aa11bb22', content: '崩溃前的草稿内容' },
      ]),
    });
    harness.promptRestore.mockResolvedValue(true);
    const restored = await harness.manager.recoverUntitledDrafts();
    expect(restored).toHaveLength(1);
    expect(restored[0].syntheticId).toBe('untitled-aa11bb22');
    expect(restored[0].editor.getMarkdown()).toBe('崩溃前的草稿内容');
    expect(restored[0].dirty).toBe(true);
    // 后续防抖快照覆盖同一键（不清除也不另起新键）
    vi.useFakeTimers();
    restored[0].editor.setMarkdown('继续编辑');
    harness.manager.handleContentChanged(restored[0].id);
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(
      'untitled-aa11bb22',
      '继续编辑',
    );
  });

  it('recoverUntitledDrafts：放弃则删除该快照', async () => {
    const harness = makeHarness({
      listUntitledDrafts: vi.fn(async () => [
        { key: 'untitled-cc33dd44', content: '旧草稿' },
      ]),
    });
    harness.promptRestore.mockResolvedValue(false);
    const restored = await harness.manager.recoverUntitledDrafts();
    expect(restored).toHaveLength(0);
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('untitled-cc33dd44');
  });

  it('listUntitledDrafts 失败时静默返回空（不阻塞启动）', async () => {
    const harness = makeHarness({
      listUntitledDrafts: vi.fn(async () => {
        throw new Error('ipc down');
      }),
    });
    const restored = await harness.manager.recoverUntitledDrafts();
    expect(restored).toEqual([]);
  });
});

describe('保存与快照写入竞态', () => {
  it('保存前取消待写快照并等待进行中的写入完成', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab!.id);
    // 防抖窗口内立即保存：不应再触发快照写入
    await harness.manager.saveTab(tab!.id);
    vi.advanceTimersByTime(2000);
    expect(harness.deps.writeSnapshot).not.toHaveBeenCalled();
    // 文件路径快照由 saveToPathFlow 经 roundtrip.clearSnapshot 清除
    expect(harness.roundtrip.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });

  it('进行中的快照写入完成后才清快照（无孤儿快照）', async () => {
    vi.useFakeTimers();
    let resolveWrite: (() => void) | null = null;
    const harness = makeHarness({
      writeSnapshot: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      ),
    });
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab!.id);
    vi.advanceTimersByTime(1000); // 触发 writeSnapshot（挂起中）
    expect(harness.deps.writeSnapshot).toHaveBeenCalledTimes(1);

    const savePromise = harness.manager.saveTab(tab!.id);
    // 快照写入未完成 → 保存流程挂起在 await 上
    await Promise.resolve();
    expect(harness.roundtrip.clearSnapshot).not.toHaveBeenCalled();
    resolveWrite!();
    await savePromise;
    expect(harness.roundtrip.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });
});
