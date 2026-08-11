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
 *   - 打开文件时检测「快照比磁盘新」并提示恢复（崩溃恢复）；
 *   - R14 自动保存入口 `autosaveDirtyTabs`：仅扫已有路径的脏 tab，逐个走
 *     与手动保存完全相同的 saveTab 流（含 R13 保存前 mtime 闸门），冲突
 *     由既有对话框分派，绝不静默覆盖、不触发另存为；偏好与定时调度在
 *     src/tabs/autosave.ts。
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
import type { ReaderInstance } from '../reader/types.js';
import {
  defaultRoundtripDeps,
  openFileFlow,
  openPathFlow,
  saveAsFlow,
  saveToPathFlow,
  type RoundtripDeps,
} from '../file/roundtrip.js';
import * as fileService from '../file/file-service.js';
import type { FileStat } from '../file/file-service.js';
import {
  isDiskNewer,
  type ExternalConflictChoice,
  type ExternalReloadChoice,
} from '../file/external-change.js';
import type {
  CloseAllAction,
  CloseChoice,
  MarkdownTabState,
  ReaderTabState,
  TabState,
} from './types.js';

/** reader 标签判别：reader 标签豁免全部可写编辑器路径。 */
export function isMarkdownTab(tab: TabState): tab is MarkdownTabState {
  return tab.kind === 'markdown';
}

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
  /**
   * 挂载只读阅读视图（reader 标签；生产为 src/reader 的 reader-view，T3 接入）。
   * 仅 openReader 使用；纯 markdown 用法可不提供。返回的 ReaderInstance 由
   * TabManager 在 closeTab 时 destroy。
   */
  mountReader?: (container: HTMLElement) => Promise<ReaderInstance>;
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
  /**
   * R13：未脏文件检测到磁盘更新时询问是否重新加载。缺省视为「忽略」
   * （不重载、更新基线避免重复弹窗）。
   */
  confirmExternalReload?: (tab: Pick<TabState, 'title' | 'filePath'>) => Promise<ExternalReloadChoice>;
  /**
   * R13：已脏文件（或保存前）检测到外部冲突时的明确选择。缺省视为「保留内存」
   * （中止覆盖、保留脏态）。禁止无提示覆盖（R13 核心禁令）。
   */
  confirmExternalConflict?: (
    tab: Pick<TabState, 'title' | 'filePath'>,
  ) => Promise<ExternalConflictChoice>;
  /**
   * R13：轮询发现活动文件不可读/已被删除时的一次性可见提示（每段不可读期
   * 只触发一次，恢复可读后重置）。缺省保持 console-only（reportError）。
   */
  notifyExternalUnreadable?: (tab: Pick<TabState, 'title' | 'filePath'>) => void;
  /** 文件/对话框流程依赖（生产为真实 Tauri 调用）。 */
  roundtrip?: RoundtripDeps;
  writeSnapshot?: (key: string, content: string) => Promise<void>;
  clearSnapshot?: (key: string) => Promise<void>;
  readStaleSnapshot?: (path: string) => Promise<string | null>;
  /** R13：取文件 mtime+size（默认为真实 Tauri stat_file 调用）。 */
  statFile?: (path: string) => Promise<FileStat>;
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
  /**
   * Localized untitled tab title. Defaults to Chinese `未命名-{n}` when omitted
   * (tests / headless). Production injects i18n `app.untitled`.
   */
  formatUntitledTitle?: (n: number) => string;
  /**
   * Localized restored untitled title. Defaults to `未命名-{n}（已恢复）`.
   */
  formatUntitledRestoredTitle?: (n: number) => string;
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

type TabManagerOptionalUi =
  | 'onTabsChanged'
  | 'onActiveContentChanged'
  | 'onFileOpened'
  | 'onFileSaved'
  | 'onLinkNavigate'
  | 'confirmLinkOpen'
  | 'confirmExternalReload'
  | 'confirmExternalConflict'
  | 'notifyExternalUnreadable'
  | 'formatUntitledTitle'
  | 'formatUntitledRestoredTitle'
  | 'mountReader';

export class TabManager {
  private readonly deps: Required<Omit<TabManagerDeps, TabManagerOptionalUi>> &
    Pick<TabManagerDeps, TabManagerOptionalUi>;
  private tabs: TabState[] = [];
  private activeId: string | null = null;
  private counter = 0;
  private untitledCounter = 0;
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 进行中的快照写入 Promise（按标签 id），保存前需先等待以避免写/清竞态。 */
  private snapshotWrites = new Map<string, Promise<void>>();
  /** 同一标签的保存操作串行执行；失败会被队列尾吸收，不阻塞后续保存。 */
  private saveQueues = new Map<string, Promise<void>>();
  /** 同一标签的重复关闭请求共享一个操作，避免重复确认、销毁或数组删除。 */
  private closingTabs = new Map<string, Promise<boolean>>();
  /** 应用退出期间共享同一个批量关闭操作，避免与单标签关闭交错。 */
  private closingAll: Promise<boolean> | null = null;
  /** 编辑器内容每次成功变更后递增；用于约束异步保存完成时的快照清理。 */
  private contentRevisions = new Map<string, number>();
  /** R13：外部变更弹窗进行中标志，避免轮询/保存前重复堆叠弹窗。 */
  private externalDialogOpen = false;
  /**
   * R13：外部变更检测进行中标志——必须在首个 await 之前同步置位。窗口聚焦时
   * DOM focus 与 Tauri onFocusChanged 双通道成对触发，若只在弹窗前置
   * externalDialogOpen，两个并发调用都会通过入口检查、各自 await stat 后
   * 堆叠重复弹窗（Delivery Review P2[blocking]）。
   */
  private externalCheckRunning = false;
  /** R14：autosave 已提示过冲突的磁盘态（按 tab），同一外部变更只弹一次。 */
  private autosaveConflictPrompted = new Map<string, string>();
  /** R13：stat 失败（文件被删/不可读）已做可见提示的 tab，恢复可读后重置。 */
  private externalUnreadableNotified = new Set<string>();

  constructor(deps: TabManagerDeps) {
    this.deps = {
      roundtrip: defaultRoundtripDeps,
      writeSnapshot: fileService.writeSnapshot,
      clearSnapshot: fileService.clearSnapshot,
      readStaleSnapshot: fileService.readStaleSnapshot,
      statFile: fileService.statFile,
      listUntitledDrafts: fileService.listUntitledDrafts,
      saveAsset: assetService.saveAsset,
      migrateStagingAssets: assetService.migrateStagingAssets,
      readImageBase64: assetService.readImageBase64,
      snapshotDebounceMs: DEFAULT_DEBOUNCE_MS,
      reportError: (message, error) => {
        // eslint-disable-next-line no-console
        console.error(`[lightink/tabs] ${message}`, error);
      },
      formatUntitledTitle: (n) => `未命名-${n}`,
      formatUntitledRestoredTitle: (n) => `未命名-${n}（已恢复）`,
      ...deps,
      onTabsChanged: deps.onTabsChanged,
      onActiveContentChanged: deps.onActiveContentChanged,
      onFileOpened: deps.onFileOpened,
      onFileSaved: deps.onFileSaved,
      onLinkNavigate: deps.onLinkNavigate,
      confirmLinkOpen: deps.confirmLinkOpen,
      confirmExternalReload: deps.confirmExternalReload,
      confirmExternalConflict: deps.confirmExternalConflict,
      notifyExternalUnreadable: deps.notifyExternalUnreadable,
      mountReader: deps.mountReader,
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
  async newTab(initialMarkdown = ''): Promise<MarkdownTabState> {
    this.untitledCounter += 1;
    const format =
      this.deps.formatUntitledTitle ?? ((n: number) => `未命名-${n}`);
    return this.createTab({
      filePath: null,
      title: format(this.untitledCounter),
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
  async recoverUntitledDrafts(): Promise<MarkdownTabState[]> {
    let drafts: fileService.UntitledDraft[];
    try {
      drafts = await this.deps.listUntitledDrafts();
    } catch (error) {
      this.deps.reportError('枚举未命名崩溃草稿失败', error);
      return [];
    }
    const restored: MarkdownTabState[] = [];
    for (const draft of drafts) {
      const restore = await this.deps.promptRestore(draft.key);
      if (restore) {
        this.untitledCounter += 1;
        const format =
          this.deps.formatUntitledRestoredTitle ??
          ((n: number) => `未命名-${n}（已恢复）`);
        const tab = await this.createTab({
          filePath: null,
          title: format(this.untitledCounter),
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
  async openFile(path?: string): Promise<MarkdownTabState | null> {
    const opened =
      path !== undefined
        ? await openPathFlow(this.deps.roundtrip, path)
        : await openFileFlow(this.deps.roundtrip);
    if (opened === null) {
      return null;
    }
    // markdown 标签按路径去重：reader 标签（即便同路径）是独立只读标签，不在此复用。
    const existing = this.tabs.find(
      (t): t is MarkdownTabState => t.kind === 'markdown' && t.filePath === opened.path,
    );
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

    const tab = await this.createTab({
      filePath: opened.path,
      title: fileNameOf(opened.path),
      syntheticId: `untitled-${newUntitledToken()}`,
      initialMarkdown: content,
      // 恢复的内容与磁盘不同 → 通过比较自然得到 dirty = true。
      lastSavedMarkdown: opened.content,
    });
    // R13：记录磁盘 stat 作为外部变更检测基线（失败则放弃检测，不阻塞打开）。
    await this.recordBaseline(tab);
    this.deps.onFileOpened?.(opened.path);
    return tab;
  }

  /**
   * 打开只读阅读标签（PDF/EPUB/...）。不挂编辑器、不记录 dirty / 快照 / 外部
   * 变更基线；同路径已打开的 reader 标签直接切换。文件字节读取与格式渲染由
   * 后续任务经 mountReader 注入；本方法只负责 reader 标签的生命周期与可写
   * 路径豁免。
   */
  async openReader(path: string): Promise<ReaderTabState> {
    const existing = this.tabs.find(
      (t): t is ReaderTabState => t.kind === 'reader' && t.filePath === path,
    );
    if (existing !== undefined) {
      this.switchTab(existing.id);
      this.deps.onFileOpened?.(path);
      return existing;
    }
    const mountReader = this.deps.mountReader;
    if (mountReader === undefined) {
      throw new Error('TabManager.openReader requires the mountReader dependency');
    }
    this.counter += 1;
    const id = `tab-${this.counter}`;
    const host = this.deps.createHostElement(id);
    this.deps.attachHost(host);
    const reader = await mountReader(host);
    const tab: ReaderTabState = {
      kind: 'reader',
      id,
      filePath: path,
      syntheticId: `reader-${newUntitledToken()}`,
      title: fileNameOf(path),
      dirty: false,
      reader,
      hostElement: host,
      lastSavedMarkdown: '',
      lastSavedMtime: null,
    };
    this.tabs.push(tab);
    this.switchTab(id);
    this.deps.onFileOpened?.(path);
    return tab;
  }

  /** 保存活动标签（无路径时转另存为）。 */
  async saveActiveTab(): Promise<boolean> {
    const tab = this.activeTab;
    return tab === null ? false : this.saveTab(tab.id);
  }

  /** 保存：原子写成功 → 清脏标记 + 清对应崩溃快照。失败保持脏标记。 */
  async saveTab(id: string): Promise<boolean> {
    if (this.closingTabs.has(id)) {
      return false;
    }
    return this.enqueueSave(id, () => this.performSaveTab(id));
  }

  private async performSaveTab(id: string): Promise<boolean> {
    const tab = this.requireTab(id);
    if (tab.kind !== 'markdown') {
      return false; // reader 标签只读，永不保存
    }
    if (tab.filePath === null) {
      return this.performSaveTabAs(id);
    }
    // 先停掉待写快照并等待进行中的快照写入完成，避免「写快照 IPC 晚于
    // 清快照 IPC 落盘」留下比文件新的孤儿快照。
    this.cancelPendingSnapshot(id);
    await this.snapshotWrites.get(id)?.catch(() => undefined);
    const content = tab.editor.getMarkdown();
    // R13：写入前先比 mtime，发现外部变更即弹冲突、中止写入——即使轮询间隙
    // 也不静默覆盖（R13 核心禁令）。reload/keep 中止本次保存；overwrite 继续。
    const disposition = await this.checkBeforeSave(tab);
    if (disposition !== 'proceed') {
      return false;
    }
    const ok = await saveToPathFlow(this.deps.roundtrip, tab.filePath, content);
    if (!ok) {
      return false;
    }
    return this.finalizeSuccessfulSave(tab, tab.filePath, content, [
      tab.filePath,
      tab.syntheticId,
    ]);
  }

  /** 另存为：弹对话框 → 写入新路径 → 更新标签路径/标题/脏标记。 */
  async saveTabAs(id: string): Promise<boolean> {
    if (this.closingTabs.has(id)) {
      return false;
    }
    return this.enqueueSave(id, () => this.performSaveTabAs(id));
  }

  private async performSaveTabAs(id: string): Promise<boolean> {
    const tab = this.requireTab(id);
    if (tab.kind !== 'markdown') {
      return false; // reader 标签只读，永不另存为
    }
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
    const oldKey = snapshotKeyOf(tab);
    tab.filePath = newPath;
    tab.title = fileNameOf(newPath);
    // T4：未命名时期粘贴的图片落在会话暂存目录；引用均为相对路径
    // assets/...，按原名迁入新文档旁 assets/ 后引用保持有效，无需改写
    // 文档内容。无暂存时 Rust 侧为 no-op。
    try {
      await this.deps.migrateStagingAssets(tab.syntheticId, newPath);
    } catch (error) {
      this.deps.reportError('迁移暂存图片失败', error);
    }
    return this.finalizeSuccessfulSave(tab, newPath, content, [newPath, oldKey]);
  }

  private async finalizeSuccessfulSave(
    tab: MarkdownTabState,
    savedPath: string,
    content: string,
    snapshotKeys: readonly string[],
  ): Promise<boolean> {
    tab.lastSavedMarkdown = content;
    // R13：自写（原子 persist）后必须更新基线，避免下次轮询误报自身保存为外部变更。
    await this.recordBaseline(tab);
    this.deps.onFileSaved?.(savedPath, content);

    const current = this.readMarkdown(tab);
    tab.dirty = current === null || current !== content;
    if (!tab.dirty) {
      const revision = this.contentRevisions.get(tab.id) ?? 0;
      this.cancelPendingSnapshot(tab.id);
      await this.snapshotWrites.get(tab.id)?.catch(() => undefined);
      const stillCurrent = this.readMarkdown(tab);
      if (
        stillCurrent === content &&
        (this.contentRevisions.get(tab.id) ?? 0) === revision
      ) {
        for (const key of new Set(snapshotKeys)) {
          await this.deps.clearSnapshot(key).catch((error: unknown) => {
            this.deps.reportError(`清除快照失败: ${key}`, error);
          });
        }
      }
      // 清理快照本身也是异步的；返回前再次确认没有更晚编辑。
      const afterCleanup = this.readMarkdown(tab);
      tab.dirty = afterCleanup === null || afterCleanup !== content;
    }
    this.notifyChanged();
    return !tab.dirty;
  }

  private readMarkdown(tab: MarkdownTabState): string | null {
    try {
      return tab.editor.getMarkdown();
    } catch {
      return null;
    }
  }

  private enqueueSave(id: string, operation: () => Promise<boolean>): Promise<boolean> {
    const previous = this.saveQueues.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.saveQueues.set(id, tail);
    void tail.then(() => {
      if (this.saveQueues.get(id) === tail) {
        this.saveQueues.delete(id);
      }
    });
    return result;
  }

  /**
   * 关闭标签：未保存时先三选一确认（保存/放弃/取消）。
   * 正常关闭后清除对应崩溃快照并销毁编辑器与宿主 DOM。
   * 返回 true 表示标签已关闭。
   */
  closeTab(id: string): Promise<boolean> {
    if (this.closingAll !== null) {
      return Promise.resolve(false);
    }
    const existing = this.closingTabs.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.performCloseTab(id);
    this.closingTabs.set(id, pending);
    void pending.then(
      () => this.clearClosingOperation(id, pending),
      () => this.clearClosingOperation(id, pending),
    );
    return pending;
  }

  private clearClosingOperation(id: string, pending: Promise<boolean>): void {
    if (this.closingTabs.get(id) === pending) {
      this.closingTabs.delete(id);
    }
  }

  /**
   * Close every tab after the exit UI has selected Save All or Discard All.
   * Save All persists every dirty document before any editor is destroyed, so
   * a cancelled Save As, failed write, or newer edit leaves the full workspace
   * available. The confirmation UI intentionally remains outside TabManager.
   */
  closeAllTabs(action: CloseAllAction): Promise<boolean> {
    if (this.closingAll !== null) {
      return this.closingAll;
    }
    if (this.closingTabs.size > 0) {
      return Promise.resolve(false);
    }
    const pending = this.performCloseAllTabs(action);
    this.closingAll = pending;
    void pending.then(
      () => this.clearCloseAllOperation(pending),
      () => this.clearCloseAllOperation(pending),
    );
    return pending;
  }

  private clearCloseAllOperation(pending: Promise<boolean>): void {
    if (this.closingAll === pending) {
      this.closingAll = null;
    }
  }

  private async performCloseAllTabs(action: CloseAllAction): Promise<boolean> {
    const targets = [...this.tabs];
    if (action === 'save') {
      for (const tab of targets) {
        if (tab.kind !== 'markdown' || !tab.dirty) continue;
        const saved = await this.enqueueSave(tab.id, () => this.performSaveTab(tab.id));
        if (!saved) {
          return false;
        }
      }
    }

    // A tab created or individually removed while native dialogs were open
    // invalidates the preflight. Keep the current workspace instead of
    // applying an exit decision to a different set of documents.
    if (
      this.tabs.length !== targets.length ||
      targets.some((tab, index) => this.tabs[index] !== tab)
    ) {
      return false;
    }

    const inertStates = targets.map((tab) => tab.hostElement.inert);
    for (const tab of targets) {
      tab.hostElement.inert = true;
    }
    if (action === 'save') {
      const hasNewerEdits = targets.some((tab) => {
        if (tab.kind !== 'markdown') return false;
        const current = this.readMarkdown(tab);
        tab.dirty = current === null || current !== tab.lastSavedMarkdown;
        return tab.dirty;
      });
      if (hasNewerEdits) {
        targets.forEach((tab, index) => {
          tab.hostElement.inert = inertStates[index] ?? false;
        });
        this.notifyChanged();
        return false;
      }
    }

    for (const tab of targets) {
      this.cancelPendingSnapshot(tab.id);
      await this.snapshotWrites.get(tab.id)?.catch(() => undefined);
      await this.deps.clearSnapshot(snapshotKeyOf(tab)).catch((error: unknown) => {
        this.deps.reportError('清除快照失败', error);
      });
    }
    for (const tab of targets) {
      const destroy = tab.kind === 'markdown' ? tab.editor.destroy() : tab.reader.destroy();
      await destroy.catch((error: unknown) => {
        this.deps.reportError('销毁标签内容失败', error);
      });
    }

    for (const tab of targets) {
      this.deps.detachHost(tab.hostElement);
    }
    this.tabs = [];
    this.activeId = null;
    this.snapshotTimers.clear();
    this.snapshotWrites.clear();
    this.saveQueues.clear();
    this.contentRevisions.clear();
    this.autosaveConflictPrompted.clear();
    this.externalUnreadableNotified.clear();
    this.notifyChanged();
    this.notifyActiveContentChanged();
    return true;
  }

  private async performCloseTab(id: string): Promise<boolean> {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) {
      return true;
    }
    let discardConfirmed = false;
    if (tab.dirty) {
      const choice = await this.deps.confirmClose(tab);
      if (choice === 'cancel') {
        return false;
      }
      if (choice === 'save') {
        const saved = await this.enqueueSave(id, () => this.performSaveTab(id));
        if (!saved) {
          return false; // 保存失败/另存为取消 → 不关闭
        }
      } else {
        discardConfirmed = true;
      }
    }
    await this.saveQueues.get(id)?.catch(() => undefined);
    if (!discardConfirmed && tab.dirty) {
      return false;
    }

    const wasInert = tab.hostElement.inert;
    tab.hostElement.inert = true;
    this.cancelPendingSnapshot(id);
    this.autosaveConflictPrompted.delete(id);
    this.externalUnreadableNotified.delete(id);
    await this.deps.clearSnapshot(snapshotKeyOf(tab)).catch((error: unknown) => {
      this.deps.reportError('清除快照失败', error);
    });
    if (!discardConfirmed && tab.dirty) {
      tab.hostElement.inert = wasInert;
      return false;
    }
    // reader 标签销毁阅读视图；markdown 标签销毁编辑器。reader 永不写快照，
    // 上面的 clearSnapshot 对其为 no-op。
    if (tab.kind === 'markdown') {
      await tab.editor.destroy().catch((error: unknown) => {
        this.deps.reportError('销毁编辑器失败', error);
      });
    } else {
      await tab.reader.destroy().catch((error: unknown) => {
        this.deps.reportError('销毁阅读视图失败', error);
      });
    }
    const index = this.tabs.indexOf(tab);
    if (index < 0) {
      return true;
    }
    this.deps.detachHost(tab.hostElement);
    this.tabs.splice(index, 1);
    this.contentRevisions.delete(id);
    this.saveQueues.delete(id);
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
    if (tab === undefined || tab.kind !== 'markdown') {
      return; // reader 标签无编辑器输入，永不进入脏标记/快照路径
    }
    let current: string;
    try {
      current = tab.editor.getMarkdown();
    } catch {
      return; // 编辑器已销毁等异常时静默跳过
    }
    this.contentRevisions.set(id, (this.contentRevisions.get(id) ?? 0) + 1);
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

  /** Flush every dirty document's pending recovery snapshot after exit cancellation. */
  flushDirtySnapshots(): void {
    for (const tab of this.tabs) {
      if (tab.kind === 'markdown' && tab.dirty) {
        this.flushSnapshot(tab.id);
      }
    }
  }

  private async createTab(args: {
    filePath: string | null;
    title: string;
    syntheticId: string;
    initialMarkdown: string;
    lastSavedMarkdown: string;
  }): Promise<MarkdownTabState> {
    this.counter += 1;
    const id = `tab-${this.counter}`;
    const host = this.deps.createHostElement(id);
    this.deps.attachHost(host);
    const editor = await this.deps.mountEditor(host, {
      initialMarkdown: args.initialMarkdown,
      onContentChanged: () => this.handleContentChanged(id),
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
    const tab: MarkdownTabState = {
      kind: 'markdown',
      id,
      filePath: args.filePath,
      syntheticId: args.syntheticId,
      title: args.title,
      dirty: args.initialMarkdown !== args.lastSavedMarkdown,
      editor,
      hostElement: host,
      lastSavedMarkdown: args.lastSavedMarkdown,
      lastSavedMtime: null,
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
    if (tab.kind !== 'markdown') {
      return; // reader 标签永不写崩溃快照
    }
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

  /**
   * R13：记录活动文件的磁盘 stat 作为外部变更检测基线。stat 失败（文件被删/
   * 权限）时置 null（放弃检测），不阻塞加载/保存主流程。无路径标签同样置 null。
   */
  private async recordBaseline(tab: TabState): Promise<void> {
    if (tab.filePath === null) {
      tab.lastSavedMtime = null;
      return;
    }
    try {
      tab.lastSavedMtime = await this.deps.statFile(tab.filePath);
    } catch {
      tab.lastSavedMtime = null;
    }
  }

  /**
   * R13：从磁盘重新加载内容到编辑器（用户选「重新加载」时）。读失败上报且
   * 不改动当前内容；成功则更新 lastSavedMarkdown、清脏、刷新基线。
   */
  private async reloadFromDisk(tab: TabState): Promise<void> {
    if (tab.filePath === null || tab.kind !== 'markdown') return;
    let content: string;
    try {
      content = await this.deps.roundtrip.readFile(tab.filePath);
    } catch (error) {
      this.deps.reportError(`重新加载失败: ${tab.filePath}`, error);
      return;
    }
    tab.editor.setMarkdown(content);
    tab.lastSavedMarkdown = content;
    tab.dirty = false;
    await this.recordBaseline(tab);
    this.notifyChanged();
    this.notifyActiveContentChanged();
  }

  /**
   * R13 保存前闸门：写入前比 mtime，发现外部变更弹冲突对话框。
   *   - stat 失败 → 视为无可覆盖的外部内容，交 write_file 自然成败（proceed）；
   *   - 未变更 → proceed；
   *   - 变更 + overwrite → proceed（用户明确选择覆盖，非静默）；
   *   - 变更 + reload → 从磁盘重载并 aborted（本次不保存）；
   *   - 变更 + keep → aborted（保留内存脏态，不保存）。
   */
  private async checkBeforeSave(tab: TabState): Promise<'proceed' | 'aborted'> {
    if (tab.filePath === null || tab.lastSavedMtime === null) {
      return 'proceed';
    }
    let disk: FileStat;
    try {
      disk = await this.deps.statFile(tab.filePath);
    } catch {
      return 'proceed';
    }
    if (!isDiskNewer(tab.lastSavedMtime, disk)) {
      return 'proceed';
    }
    // 即使未脏，覆盖也会丢磁盘新内容 → 必须让用户明确选择（R13）。
    this.externalDialogOpen = true;
    let choice: ExternalConflictChoice;
    try {
      choice = (await this.deps.confirmExternalConflict?.(tab)) ?? 'keep';
    } finally {
      this.externalDialogOpen = false;
    }
    if (choice === 'overwrite') {
      return 'proceed';
    }
    if (choice === 'reload') {
      await this.reloadFromDisk(tab);
    }
    return 'aborted';
  }

  /**
   * R13 检测入口：由窗口聚焦 + 定时轮询（main.ts）调用，检查活动文件是否被
   * 外部修改并按脏态分派提示。弹窗进行中（externalDialogOpen）或上一次检测
   * 仍在进行（externalCheckRunning，聚焦双通道并发）时跳过避免堆叠。
   *   - 无路径 / 无基线 → 跳过（未保存过不检测）；
   *   - stat 失败 → 上报错误 + 一次性可见提示（每段不可读期只提示一次，
   *     恢复可读后重置），不自动动作（R13 失败行为）；
   *   - 未脏 + 磁盘更新 → 提示「可重新加载」(reload/ignore)；
   *   - 已脏 + 磁盘更新 → 冲突对话框 (reload/keep/overwrite)。
   */
  async checkActiveExternalChange(): Promise<void> {
    // 同步置位必须在首个 await 之前：DOM focus 与 Tauri onFocusChanged 成对
    // 触发时，后到的调用在入口即被拦下，不会各自 await stat 后堆叠弹窗。
    if (this.externalDialogOpen || this.externalCheckRunning) return;
    this.externalCheckRunning = true;
    try {
      const tab = this.activeTab;
      if (tab === null || tab.filePath === null || tab.lastSavedMtime === null) {
        return;
      }
      let disk: FileStat;
      try {
        disk = await this.deps.statFile(tab.filePath);
        // 恢复可读：重置一次性提示标志（下段不可读期可再提示）。
        this.externalUnreadableNotified.delete(tab.id);
      } catch (error) {
        this.deps.reportError(`文件不可读或已被删除: ${tab.filePath}`, error);
        // stat 失败的可观察提示（Delivery Review P2[advisory]）：每段不可读期
        // 只浮出一次，避免 3s 轮询重复打扰；未注入时保持 console-only。
        if (!this.externalUnreadableNotified.has(tab.id)) {
          this.externalUnreadableNotified.add(tab.id);
          this.deps.notifyExternalUnreadable?.(tab);
        }
        return;
      }
      if (!isDiskNewer(tab.lastSavedMtime, disk)) {
        return;
      }
      this.externalDialogOpen = true;
      try {
        if (!tab.dirty) {
          const choice = (await this.deps.confirmExternalReload?.(tab)) ?? 'ignore';
          if (choice === 'reload') {
            await this.reloadFromDisk(tab);
          } else {
            // 忽略：以当前磁盘态为基线，避免每次轮询重复弹窗（接受内容分歧）。
            tab.lastSavedMtime = disk;
          }
          return;
        }
        const choice = (await this.deps.confirmExternalConflict?.(tab)) ?? 'keep';
        if (choice === 'reload') {
          await this.reloadFromDisk(tab);
        } else if (choice === 'overwrite') {
          // 用户明确选择覆盖：先把基线对齐到当前磁盘态，避免 saveTab 内的
          // 保存前闸门重复弹窗；saveTab 写入后会再以写后 stat 刷新基线。
          tab.lastSavedMtime = disk;
          await this.saveTab(tab.id);
        } else {
          // 保留内存脏态，但更新基线避免重复弹窗；用户后续主动保存会再经保存前闸门。
          tab.lastSavedMtime = disk;
        }
      } finally {
        this.externalDialogOpen = false;
      }
    } finally {
      this.externalCheckRunning = false;
    }
  }

  /**
   * R14 自动保存 tick（由 autosave.ts 定时调度）：顺序扫描全部标签，仅对
   * 「已有路径且脏」的 tab 走与手动保存完全相同的 saveTab 流——保存前
   * mtime 闸门发现外部变更即弹 R13 冲突对话框并中止写入，绝不静默覆盖；
   * 无路径 tab 跳过（不触发另存为对话框，继续靠崩溃快照）；写失败保持
   * 脏标记，下个 tick 自然再试。外部变更弹窗/检测进行中跳过本次 tick，
   * 避免弹窗堆叠；顺序 await 保证多个脏 tab 的冲突提示不并发。
   *
   * 冲突去重（T10 review P2[advisory]）：autosave 每 30s 重试同一保存流，
   * 若用户在某次冲突弹窗选了「保留内存」，不加去重则每 tick 重弹同一对话框。
   * 这里按 tab 记录已提示过的磁盘态（mtime:size），同一外部变更只弹一次；
   * 磁盘再变（新 mtime/size）时会再次提示。不能用更新基线的方式去重——
   * 否则后续手动保存的保存前闸门会被绕过（R13 核心禁令）。
   */
  async autosaveDirtyTabs(): Promise<void> {
    if (this.externalDialogOpen || this.externalCheckRunning) {
      return;
    }
    for (const tab of [...this.tabs]) {
      if (tab.filePath === null || !tab.dirty) {
        continue;
      }
      if (tab.lastSavedMtime !== null) {
        try {
          const disk = await this.deps.statFile(tab.filePath);
          if (isDiskNewer(tab.lastSavedMtime, disk)) {
            const key = `${disk.mtime_ms}:${disk.size}`;
            if (this.autosaveConflictPrompted.get(tab.id) === key) {
              continue; // 同一外部变更已提示过且用户选择保留内存：本次静默跳过。
            }
            this.autosaveConflictPrompted.set(tab.id, key);
          } else {
            this.autosaveConflictPrompted.delete(tab.id);
          }
        } catch {
          // stat 失败：交 saveTab 的保存前闸门按既有语义处理（不吞错误路径）。
        }
      }
      await this.saveTab(tab.id);
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
