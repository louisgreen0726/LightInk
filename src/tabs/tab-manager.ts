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
 * 撤销栈说明：@milkdown/plugin-history 已接入编辑器（src/editor/index.ts，
 * 随本次返工补齐）。每个标签是独立的 ProseMirror EditorView，各标签撤销
 * 栈天然独立。
 *
 * 崩溃快照键：文件标签用文件路径；未命名标签用含跨会话唯一 token 的
 * `untitled-<token>` 合成 id（不复用旧键覆盖草稿）。Rust 侧维护
 * untitled-index.json 以便启动时枚举崩溃遗留草稿（见 recoverUntitledDrafts）。
 * 保存前会先取消并等待进行中的快照写入，避免写/清快照的 IPC 竞态。
 *
 * 测试性设计：DOM 创建/挂载、编辑器挂载、文件流程、快照、确认对话框
 * 全部通过 `TabManagerDeps` 注入，vitest 可在 node 环境下以 fake 替换。
 */

import { createAssetSaver, createImageSrcResolver } from '../asset/asset-service.js';
import * as assetService from '../asset/asset-service.js';
import type { EditorInstance, MountOptions } from '../editor/types.js';
import type { ImageAssetMountOptions } from '../editor/plugins/image.js';
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

/** 跨会话唯一的未命名快照键片段：crypto.randomUUID 优先，缺失时退化。 */
function newUntitledToken(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID().slice(0, 8);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface TabManagerDeps {
  /** 挂载编辑器（生产为 src/editor 的 mountEditor）。 */
  mountEditor: (
    container: HTMLElement,
    options: MountOptions & ImageAssetMountOptions,
  ) => Promise<EditorInstance>;
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
  /** 启动时枚举崩溃遗留的未命名草稿。 */
  listUntitledDrafts?: () => Promise<fileService.UntitledDraft[]>;
  /** 标签列表/脏标记变化后的 UI 刷新回调。 */
  onTabsChanged?: () => void;
  /**
   * T7：活动标签内容或活动标签本身变化后的回调（大纲等视图据此刷新）。
   * 触发点：切换标签、新建标签（内含切换）、活动标签内容变化、
   * 关闭活动标签且无后继（活动变为 null）。
   */
  onActiveContentChanged?: () => void;
  /**
   * R12：成功打开某个文件路径后回调（按路径记录到最近打开）。仅在确已打开
   * （新建标签或切换到已存在标签）时触发，对话框取消/读取失败不触发。
   */
  onFileOpened?: (filePath: string) => void;
  /**
   * R13：成功保存某文件后回调（按 (filePath, content) 生成版本快照）。
   * 仅在写入磁盘成功时触发。
   */
  onFileSaved?: (filePath: string, content: string) => void;
  /**
   * R14：Ctrl/Cmd+点击文档内链接时回调（main.ts 分类后跳转）。经 mountEditor 选项注入。
   */
  onLinkNavigate?: (href: string) => void;
  /**
   * Optional confirm gate before opening a link (themed modal in main).
   */
  confirmLinkOpen?: (href: string) => boolean | Promise<boolean>;
  /** 快照防抖间隔（毫秒），默认 1000。 */
  snapshotDebounceMs?: number;
  reportError?: (message: string, error: unknown) => void;
  /** T4：图片落盘（生产为 asset-service 的 saveAsset）。 */
  saveAsset?: (
    docPath: string | null,
    sessionId: string,
    bytesBase64: string,
    ext: string,
  ) => Promise<string>;
  /** T4：另存为后迁移该会话暂存图片到文档旁 assets/。 */
  migrateStagingAssets?: (sessionId: string, docPath: string) => Promise<string[]>;
  /** 读取文档相对引用图片（base64），供编辑器把 assets/… 解析为 data URL 显示。 */
  readImageBase64?: (
    docPath: string | null,
    sessionId: string,
    relPath: string,
  ) => Promise<string>;
}

/** 有效快照键：有文件路径用路径（与 Rust 侧哈希命名一致），否则用合成 id。 */
export function snapshotKeyOf(tab: Pick<TabState, 'filePath' | 'syntheticId'>): string {
  return tab.filePath ?? tab.syntheticId;
}

const DEFAULT_DEBOUNCE_MS = 1000;

export class TabManager {
  private readonly deps: Required<Omit<TabManagerDeps, 'onTabsChanged' | 'onActiveContentChanged' | 'onFileOpened' | 'onFileSaved' | 'onLinkNavigate' | 'confirmLinkOpen'>> & Pick<TabManagerDeps, 'onTabsChanged' | 'onActiveContentChanged' | 'onFileOpened' | 'onFileSaved' | 'onLinkNavigate' | 'confirmLinkOpen'>;
  private tabs: TabState[] = [];
  private activeId: string | null = null;
  private counter = 0;
  private untitledCounter = 0;
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 进行中的快照写入 Promise（按标签 id），保存前需先等待以避免写/清竞态。 */
  private snapshotWrites = new Map<string, Promise<void>>();

  constructor(deps: TabManagerDeps) {
    this.deps = {
      roundtrip: defaultRoundtripDeps,
      writeSnapshot: fileService.writeSnapshot,
      clearSnapshot: fileService.clearSnapshot,
      readStaleSnapshot: fileService.readStaleSnapshot,
      listUntitledDrafts: fileService.listUntitledDrafts,
      saveAsset: assetService.saveAsset,
      migrateStagingAssets: assetService.migrateStagingAssets,
      readImageBase64: assetService.readImageBase64,
      snapshotDebounceMs: DEFAULT_DEBOUNCE_MS,
      reportError: (message, error) => {
        // eslint-disable-next-line no-console
        console.error(`[lightink/tabs] ${message}`, error);
      },
      ...deps,
      onTabsChanged: deps.onTabsChanged,
      onActiveContentChanged: deps.onActiveContentChanged,
      onFileOpened: deps.onFileOpened,
      onFileSaved: deps.onFileSaved,
      onLinkNavigate: deps.onLinkNavigate,
      confirmLinkOpen: deps.confirmLinkOpen,
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

  /** 新建未命名标签。快照键含跨会话唯一 token，避免复用覆盖崩溃草稿。 */
  async newTab(initialMarkdown = ''): Promise<TabState> {
    this.untitledCounter += 1;
    return this.createTab({
      filePath: null,
      title: `未命名-${this.untitledCounter}`,
      syntheticId: `untitled-${newUntitledToken()}`,
      initialMarkdown,
      lastSavedMarkdown: initialMarkdown,
    });
  }

  /**
   * 启动时恢复未命名崩溃草稿：枚举 Rust 侧索引的遗留快照，逐个询问恢复；
   * 恢复则以其原 syntheticId 开标签（后续防抖覆盖同一键，保存/关闭即清除），
   * 放弃则删除该快照。正常保存/关闭的快照不会出现在索引中，故现存条目
   * 即崩溃遗留。
   */
  async recoverUntitledDrafts(): Promise<TabState[]> {
    let drafts: fileService.UntitledDraft[];
    try {
      drafts = await this.deps.listUntitledDrafts();
    } catch (error) {
      this.deps.reportError('枚举未命名崩溃草稿失败', error);
      return [];
    }
    const restored: TabState[] = [];
    for (const draft of drafts) {
      const restore = await this.deps.promptRestore(draft.key);
      if (restore) {
        this.untitledCounter += 1;
        const tab = await this.createTab({
          filePath: null,
          title: `未命名-${this.untitledCounter}（已恢复）`,
          syntheticId: draft.key,
          initialMarkdown: draft.content,
          lastSavedMarkdown: '',
        });
        restored.push(tab);
      } else {
        await this.deps.clearSnapshot(draft.key).catch(() => undefined);
      }
    }
    return restored;
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
      this.deps.onFileOpened?.(opened.path);
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
      syntheticId: `untitled-${newUntitledToken()}`,
      initialMarkdown: content,
      // 恢复的内容与磁盘不同 → 通过比较自然得到 dirty = true。
      lastSavedMarkdown: opened.content,
    }).then((tab) => {
      this.deps.onFileOpened?.(opened.path);
      return tab;
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
    // 先停掉待写快照并等待进行中的快照写入完成，避免「写快照 IPC 晚于
    // 清快照 IPC 落盘」留下比文件新的孤儿快照。
    this.cancelPendingSnapshot(id);
    await this.snapshotWrites.get(id)?.catch(() => undefined);
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
    this.deps.onFileSaved?.(tab.filePath, content);
    this.notifyChanged();
    return true;
  }

  /** 另存为：弹对话框 → 写入新路径 → 更新标签路径/标题/脏标记。 */
  async saveTabAs(id: string): Promise<boolean> {
    const tab = this.requireTab(id);
    this.cancelPendingSnapshot(id);
    await this.snapshotWrites.get(id)?.catch(() => undefined);
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
    // T4：未命名时期粘贴的图片落在会话暂存目录；引用均为相对路径
    // assets/...，按原名迁入新文档旁 assets/ 后引用保持有效，无需改写
    // 文档内容。无暂存时 Rust 侧为 no-op。
    try {
      await this.deps.migrateStagingAssets(tab.syntheticId, newPath);
    } catch (error) {
      this.deps.reportError('迁移暂存图片失败', error);
    }
    this.deps.onFileSaved?.(newPath, content);
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
      } else {
        // 活动标签关闭且无后继：活动变为 null，通知大纲等视图清空。
        this.notifyActiveContentChanged();
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
    this.notifyActiveContentChanged();
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
    if (id === this.activeId) {
      this.notifyActiveContentChanged();
    }
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
      // T4：图片粘贴/拖拽落盘。saver 每次调用现读该标签当前路径 ——
      // 另存为之后新图片直接落新文档旁 assets/；未保存时走会话暂存
      // （sessionId = syntheticId），保存时由 saveTabAs 迁移。
      assetSaver: createAssetSaver({
        saveAsset: this.deps.saveAsset,
        sessionId: args.syntheticId,
        getDocPath: () => this.tabs.find((t) => t.id === id)?.filePath ?? null,
      }),
      // 图片显示：文档内 assets/… 相对引用经 Rust 解析为 data URL（按标签缓存，
      // 另存为后文档路径变化自动换键重解析）。
      imageSrcResolver: createImageSrcResolver({
        readImageBase64: this.deps.readImageBase64,
        sessionId: args.syntheticId,
        getDocPath: () => this.tabs.find((t) => t.id === id)?.filePath ?? null,
      }),
      onAssetError: (message, error) => this.deps.reportError(message, error),
      onLinkNavigate: this.deps.onLinkNavigate,
      confirmLinkOpen: this.deps.confirmLinkOpen,
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
    // Immersive shell R4: after mount, place caret so typing can start without a click.
    // ready is already resolved by mountEditor before return; still await for fakes/async mounts.
    void tab.editor.ready.then(() => {
      if (this.activeId === id) {
        tab.editor.focus();
      }
    });
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
    const pending = this.deps
      .writeSnapshot(snapshotKeyOf(tab), content)
      .catch((error: unknown) => {
        this.deps.reportError('写入快照失败', error);
      })
      .finally(() => {
        if (this.snapshotWrites.get(tab.id) === pending) {
          this.snapshotWrites.delete(tab.id);
        }
      });
    this.snapshotWrites.set(tab.id, pending);
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

  private notifyActiveContentChanged(): void {
    this.deps.onActiveContentChanged?.();
  }
}

/** 从路径提取文件名（同时兼容 / 与 \\）。 */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}
