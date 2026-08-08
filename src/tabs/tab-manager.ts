/**
 * `TabManager` — 多标签页状态管理器（T3）。
 *
 * 职责（多标签状态唯一 owner）：
 *   - 标签列表 / 活动标签 / 新建 / 打开 / 保存 / 另存为 / 关闭 / 切换；
 *   - 每个标签独占一个编辑器实例与宿主 DOM，切换时 show/hide；
 *   - 脏标记由「当前内容与最近保存内容比较」得出，undo 回到已保存
 *     状态会自动清除脏标记；
 *   - 编辑防抖后写崩溃快照（有效快照键 = 文件路径 ?? 未命名合成 id），
 *     正常保存/关闭后清除快照；
 *   - 打开文件时检测「快照比磁盘新」并提示恢复（崩溃恢复）。
 *
 * 撤销栈说明：独立 undo 栈依赖 @milkdown/plugin-history 接入编辑器
 * （属 T2 编辑器内部，本任务未改动 src/editor/**）。每个标签已是独立
 * 的 ProseMirror EditorView，接入 history 插件后各标签撤销栈天然独立。
 *
 * 测试性设计：DOM 创建/挂载、编辑器挂载、文件流程、快照、确认对话框
 * 全部通过 `TabManagerDeps` 注入，vitest 可在 node 环境下以 fake 替换。
 */

import type { EditorInstance, MountOptions } from '../editor/types.js';
import {
  defaultRoundtripDeps,
  openFileFlow,
  openPathFlow,
  saveAsFlow,
  saveToPathFlow,
  type RoundtripDeps,
} from '../file/roundtrip.js';
import * as fileService from '../file/file-service.js';
import type { CloseChoice, TabState } from './types.js';

export interface TabManagerDeps {
  /** 挂载编辑器（生产为 src/editor 的 mountEditor）。 */
  mountEditor: (container: HTMLElement, options: MountOptions) => Promise<EditorInstance>;
  /** 为标签创建宿主元素（生产为 document.createElement('div')）。 */
  createHostElement: (tabId: string) => HTMLElement;
  /** 把宿主元素挂到界面上。 */
  attachHost: (el: HTMLElement) => void;
  /** 把宿主元素从界面移除。 */
  detachHost: (el: HTMLElement) => void;
  /** 关闭未保存标签时的三选一确认。 */
  confirmClose: (tab: Pick<TabState, 'title' | 'filePath'>) => Promise<CloseChoice>;
  /** 检测到崩溃快照时询问是否恢复。 */
  promptRestore: (path: string) => Promise<boolean>;
  /** 文件/对话框流程依赖（生产为真实 Tauri 调用）。 */
  roundtrip?: RoundtripDeps;
  writeSnapshot?: (key: string, content: string) => Promise<void>;
  clearSnapshot?: (key: string) => Promise<void>;
  readStaleSnapshot?: (path: string) => Promise<string | null>;
  /** 标签列表/脏标记变化后的 UI 刷新回调。 */
  onTabsChanged?: () => void;
  /** 快照防抖间隔（毫秒），默认 1000。 */
  snapshotDebounceMs?: number;
  reportError?: (message: string, error: unknown) => void;
}

/** 有效快照键：有文件路径用路径（与 Rust 侧哈希命名一致），否则用合成 id。 */
export function snapshotKeyOf(tab: Pick<TabState, 'filePath' | 'syntheticId'>): string {
  return tab.filePath ?? tab.syntheticId;
}

const DEFAULT_DEBOUNCE_MS = 1000;

export class TabManager {
  private readonly deps: Required<Omit<TabManagerDeps, 'onTabsChanged'>> & Pick<TabManagerDeps, 'onTabsChanged'>;
  private tabs: TabState[] = [];
  private activeId: string | null = null;
  private counter = 0;
  private untitledCounter = 0;
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: TabManagerDeps) {
    this.deps = {
      roundtrip: defaultRoundtripDeps,
      writeSnapshot: fileService.writeSnapshot,
      clearSnapshot: fileService.clearSnapshot,
      readStaleSnapshot: fileService.readStaleSnapshot,
      snapshotDebounceMs: DEFAULT_DEBOUNCE_MS,
      reportError: (message, error) => {
        // eslint-disable-next-line no-console
        console.error(`[lightink/tabs] ${message}`, error);
      },
      ...deps,
      onTabsChanged: deps.onTabsChanged,
    };
  }

  get tabList(): readonly TabState[] {
    return this.tabs;
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  get activeTab(): TabState | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  /** 新建未命名标签。 */
  async newTab(initialMarkdown = ''): Promise<TabState> {
    this.untitledCounter += 1;
    return this.createTab({
      filePath: null,
      title: `未命名-${this.untitledCounter}`,
      syntheticId: `untitled-${this.untitledCounter}`,
      initialMarkdown,
      lastSavedMarkdown: initialMarkdown,
    });
  }

  /**
   * 打开文件：path 缺省时弹系统对话框。已打开的同路径文件直接切换。
   * 打开前检测崩溃快照：比磁盘新则询问是否恢复（恢复内容载入编辑器
   * 且保持脏标记，直到用户保存）。
   */
  async openFile(path?: string): Promise<TabState | null> {
    const opened =
      path !== undefined
        ? await openPathFlow(this.deps.roundtrip, path)
        : await openFileFlow(this.deps.roundtrip);
    if (opened === null) {
      return null;
    }
    const existing = this.tabs.find((t) => t.filePath === opened.path);
    if (existing !== undefined) {
      this.switchTab(existing.id);
      return existing;
    }

    let content = opened.content;
    try {
      const stale = await this.deps.readStaleSnapshot(opened.path);
      if (stale !== null && stale !== opened.content) {
        const restore = await this.deps.promptRestore(opened.path);
        if (restore) {
          content = stale;
        } else {
          // 用户放弃恢复：删掉旧快照，避免下次重复提示。
          await this.deps.clearSnapshot(opened.path).catch(() => undefined);
        }
      }
    } catch (error) {
      this.deps.reportError(`崩溃快照检测失败: ${opened.path}`, error);
    }

    return this.createTab({
      filePath: opened.path,
      title: fileNameOf(opened.path),
      syntheticId: `untitled-${(this.untitledCounter += 1)}`,
      initialMarkdown: content,
      // 恢复的内容与磁盘不同 → 通过比较自然得到 dirty = true。
      lastSavedMarkdown: opened.content,
    });
  }

  /** 保存活动标签（无路径时转另存为）。 */
  async saveActiveTab(): Promise<boolean> {
    const tab = this.activeTab;
    return tab === null ? false : this.saveTab(tab.id);
  }

  /** 保存：原子写成功 → 清脏标记 + 清对应崩溃快照。失败保持脏标记。 */
  async saveTab(id: string): Promise<boolean> {
    const tab = this.requireTab(id);
    if (tab.filePath === null) {
      return this.saveTabAs(id);
    }
    const content = tab.editor.getMarkdown();
    const ok = await saveToPathFlow(this.deps.roundtrip, tab.filePath, content);
    if (!ok) {
      return false;
    }
    tab.lastSavedMarkdown = content;
    tab.dirty = false;
    // 未命名时期的旧快照（若有）也一并清掉。
    if (tab.syntheticId !== tab.filePath) {
      await this.deps.clearSnapshot(tab.syntheticId).catch(() => undefined);
    }
    this.notifyChanged();
    return true;
  }

  /** 另存为：弹对话框 → 写入新路径 → 更新标签路径/标题/脏标记。 */
  async saveTabAs(id: string): Promise<boolean> {
    const tab = this.requireTab(id);
    const content = tab.editor.getMarkdown();
    const newPath = await saveAsFlow(
      this.deps.roundtrip,
      content,
      tab.filePath ?? undefined,
    );
    if (newPath === null) {
      return false;
    }
    // 从未命名（或旧路径）迁移：清掉旧键对应的快照。
    const oldKey = snapshotKeyOf(tab);
    if (oldKey !== newPath) {
      await this.deps.clearSnapshot(oldKey).catch(() => undefined);
    }
    tab.filePath = newPath;
    tab.title = fileNameOf(newPath);
    tab.lastSavedMarkdown = content;
    tab.dirty = false;
    this.notifyChanged();
    return true;
  }

  /**
   * 关闭标签：未保存时先三选一确认（保存/放弃/取消）。
   * 正常关闭后清除对应崩溃快照并销毁编辑器与宿主 DOM。
   * 返回 true 表示标签已关闭。
   */
  async closeTab(id: string): Promise<boolean> {
    const tab = this.requireTab(id);
    if (tab.dirty) {
      const choice = await this.deps.confirmClose(tab);
      if (choice === 'cancel') {
        return false;
      }
      if (choice === 'save') {
        const saved = await this.saveTab(id);
        if (!saved) {
          return false; // 保存失败/另存为取消 → 不关闭
        }
      }
    }
    this.cancelPendingSnapshot(id);
    await this.deps.clearSnapshot(snapshotKeyOf(tab)).catch((error: unknown) => {
      this.deps.reportError('清除快照失败', error);
    });
    await tab.editor.destroy().catch((error: unknown) => {
      this.deps.reportError('销毁编辑器失败', error);
    });
    this.deps.detachHost(tab.hostElement);

    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    if (this.activeId === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)] ?? null;
      this.activeId = null;
      if (next !== null) {
        this.switchTab(next.id);
      }
    }
    this.notifyChanged();
    return true;
  }

  /** 切换活动标签（show/hide 宿主元素）。 */
  switchTab(id: string): void {
    const tab = this.requireTab(id);
    for (const t of this.tabs) {
      t.hostElement.style.display = t.id === id ? '' : 'none';
    }
    this.activeId = tab.id;
    this.notifyChanged();
  }

  /**
   * 内容变更通知：由宿主 DOM 的 input 事件触发（见 main.ts 的接线）。
   * 重新比较得出脏标记；脏时调度防抖快照。
   */
  handleContentChanged(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab === undefined) {
      return;
    }
    let current: string;
    try {
      current = tab.editor.getMarkdown();
    } catch {
      return; // 编辑器已销毁等异常时静默跳过
    }
    tab.dirty = current !== tab.lastSavedMarkdown;
    if (tab.dirty) {
      this.scheduleSnapshot(tab, current);
    }
    this.notifyChanged();
  }

  /** 立即写入该标签的待处理快照（测试与关闭前兜底用）。 */
  flushSnapshot(id: string): void {
    const timer = this.snapshotTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.snapshotTimers.delete(id);
      const tab = this.tabs.find((t) => t.id === id);
      if (tab !== undefined && tab.dirty) {
        this.writeSnapshotNow(tab);
      }
    }
  }

  private async createTab(args: {
    filePath: string | null;
    title: string;
    syntheticId: string;
    initialMarkdown: string;
    lastSavedMarkdown: string;
  }): Promise<TabState> {
    this.counter += 1;
    const id = `tab-${this.counter}`;
    const host = this.deps.createHostElement(id);
    this.deps.attachHost(host);
    const editor = await this.deps.mountEditor(host, {
      initialMarkdown: args.initialMarkdown,
    });
    const tab: TabState = {
      id,
      filePath: args.filePath,
      syntheticId: args.syntheticId,
      title: args.title,
      dirty: args.initialMarkdown !== args.lastSavedMarkdown,
      editor,
      hostElement: host,
      lastSavedMarkdown: args.lastSavedMarkdown,
    };
    this.tabs.push(tab);
    this.switchTab(id);
    return tab;
  }

  private scheduleSnapshot(tab: TabState, _content: string): void {
    this.cancelPendingSnapshot(tab.id);
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(tab.id);
      if (tab.dirty) {
        this.writeSnapshotNow(tab);
      }
    }, this.deps.snapshotDebounceMs);
    this.snapshotTimers.set(tab.id, timer);
  }

  private writeSnapshotNow(tab: TabState): void {
    let content: string;
    try {
      content = tab.editor.getMarkdown();
    } catch {
      return;
    }
    this.deps.writeSnapshot(snapshotKeyOf(tab), content).catch((error: unknown) => {
      this.deps.reportError('写入快照失败', error);
    });
  }

  private cancelPendingSnapshot(id: string): void {
    const timer = this.snapshotTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.snapshotTimers.delete(id);
    }
  }

  private requireTab(id: string): TabState {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab === undefined) {
      throw new Error(`TabManager: unknown tab id "${id}"`);
    }
    return tab;
  }

  private notifyChanged(): void {
    this.deps.onTabsChanged?.();
  }
}

/** 从路径提取文件名（同时兼容 / 与 \\）。 */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}
