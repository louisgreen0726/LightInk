/**
 * 应用入口（T6 正式极简外壳）。
 *
 * 组装顺序：主题服务（默认护眼浅色/深色切换/自定义主题注入槽）→
 * 极简外壳（src/ui/app-shell：命令行 + 标签栏 + 编辑区）→ TabManager
 * （接线保持 T3 语义不变：宿主元素、崩溃快照、恢复流程）→ 快捷键注册。
 */

import { invoke } from '@tauri-apps/api/core';
import { message as dialogMessage, open as openDialog, save } from '@tauri-apps/plugin-dialog';

import { mountEditor } from './editor/index.js';
import { classifyLink } from './editor/link-navigation.js';
import { imageMarkdownSnippet } from './editor/plugins/image.js';
import { SourceView } from './editor/source-view.js';
import {
  buildEditorContextMenuItems,
  buildTabContextMenuItems,
  createContextMenu,
} from './ui/context-menu.js';
import {
  getInsertElement,
  insertElementMarkdown,
  type InsertElementId,
} from './editor/insert-commands.js';
import { fileNameStem, importImageAsset } from './asset/asset-service.js';
import { planDroppedFiles } from './file/file-drop.js';
import { buildExportCss } from './export/export-css.js';
import {
  exportActiveTabHtml,
  exportActiveTabPdf,
  serializeEditorContent,
  type ExportServiceDeps,
  type ExportTabSnapshot,
} from './export/export-service.js';
import { printViaHiddenIframe } from './export/pdf-export.js';
import { readFile, writeFile } from './file/file-service.js';
import { createOutlineView, type OutlineView } from './outline/outline-view.js';
import { TabManager } from './tabs/tab-manager.js';
import type { CloseChoice } from './tabs/types.js';
import { createStyleTagSlot, ThemeService } from './theme/theme-service.js';
import type { CheatBinding } from './ui/help-cheatsheet.js';
import { createAppShell } from './ui/app-shell.js';
import { showConfirmDialog } from './ui/confirm-dialog.js';
import { ShortcutRegistry, type ShortcutAction } from './ui/shortcuts.js';
import { showVersionsModal, type VersionMeta } from './ui/versions.js';
import './theme/tokens.css';
import './ui/theme.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('LightInk: #app root container not found in index.html');
}

// 主题服务：首次启动默认 warm-light，恢复上次选择；自定义主题走 <style> 注入槽。
const themeService = new ThemeService({
  root: document.documentElement,
  customStyleSlot: createStyleTagSlot(document),
  storage: window.localStorage,
  readFile,
});

// 外壳按钮/快捷键回调仅在用户交互时触发，此时 manager 必然已赋值。
let manager: TabManager;
// T7：大纲视图在 TabManager 之后创建（见下），回调触发时必然已赋值。
let outline: OutlineView;

function saveActiveAs(): void {
  const id = manager.activeTabId;
  if (id !== null) {
    void manager.saveTabAs(id);
  }
}

/**
 * 向活动标签插入元素（R2 插入菜单 / R5 快捷键）：
 *   - 图片：走本地文件选择 → 落盘 assets → 光标处插入（见 insertImageFromFile）；
 *   - 源码模式：片段插入到源码 textarea 光标处（否则写编辑器会被源码态退出时
 *     的 textarea 写回覆盖，用户感知为「插入无法使用」）；
 *   - WYSIWYG：以块间空行分隔追加到文末（MVP 插入路径）。
 */
function insertElement(id: InsertElementId): void {
  const tab = manager.activeTab;
  if (tab === null) {
    return;
  }
  if (id === 'image') {
    void insertImageFromFile();
    return;
  }
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    const element = getInsertElement(id);
    if (element !== undefined) {
      sourceView.insertSnippetAtCursor(element.snippet());
    }
    manager.handleContentChanged(tab.id);
    return;
  }
  tab.editor.setMarkdown(insertElementMarkdown(tab.editor.getMarkdown(), id));
  manager.handleContentChanged(tab.id);
}

/**
 * 插入图片（共享主流程）：Rust 侧落盘（文档旁 assets/ 或未保存文档的
 * 会话暂存目录）→ 在光标处插入引用。WYSIWYG 插入 image 节点；源码模式插入
 * Markdown 图片片段到 textarea 光标处。落盘失败提示且不插入引用（同粘贴路径）。
 * 调用方：插入菜单的文件选择器、OS 文件拖入。
 */
async function importAndInsertImage(sourcePath: string): Promise<void> {
  const tab = manager.activeTab;
  if (tab === null) {
    return;
  }
  let relPath: string;
  try {
    relPath = await importImageAsset(tab.filePath, tab.syntheticId, sourcePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    void dialogMessage(`图片导入失败，未插入引用。\n${detail}`, {
      title: '插入图片',
      kind: 'error',
    });
    return;
  }
  const alt = fileNameStem(sourcePath);
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.insertSnippetAtCursor(imageMarkdownSnippet({ id: '', url: relPath, alt }));
  } else {
    tab.editor.insertImage(relPath, alt);
  }
  manager.handleContentChanged(tab.id);
}

/** 插入菜单「图片」：打开本地文件选择器，选中后走共享落盘/插入流程。 */
async function insertImageFromFile(): Promise<void> {
  const tab = manager.activeTab;
  if (tab === null) {
    return;
  }
  let selected: string | null;
  try {
    const result = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    selected = typeof result === 'string' ? result : null;
  } catch {
    // 非 Tauri 环境（纯前端 dev）：无原生对话框，静默取消。
    return;
  }
  if (selected === null) {
    return;
  }
  await importAndInsertImage(selected);
}

/**
 * OS 文件拖入窗口（tauri://drag-drop）：.md/.markdown 逐个开标签；图片走共享
 * 落盘/插入流程（顺带覆盖 OS 拖图——dragDropEnabled 下 HTML5 handleDrop 收不到
 * OS 文件）；其余类型汇总一条提示。
 */
async function handleOsFileDrop(paths: readonly string[]): Promise<void> {
  const plan = planDroppedFiles(paths);
  for (const path of plan.markdown) {
    const opened = await manager.openFile(path);
    if (opened === null) {
      void dialogMessage(`无法打开「${path}」：文件不存在或无法读取。`, {
        title: '轻墨 LightInk',
        kind: 'warning',
      });
    }
  }
  for (const path of plan.images) {
    await importAndInsertImage(path);
  }
  if (plan.unsupported.length > 0) {
    const names = plan.unsupported.map((p) => p.split(/[\\/]/).pop() ?? p).join('、');
    void dialogMessage(`不支持的文件类型：${names}\n可拖入 Markdown 文件（.md）或图片。`, {
      title: '轻墨 LightInk',
      kind: 'warning',
    });
  }
}

/** 在活动编辑器宿主派发一次 Ctrl+Z / Ctrl+Shift+Z（撤销/重做 MVP）。 */
function dispatchEditorCombo(combo: 'Ctrl+Z' | 'Ctrl+Shift+Z'): void {
  const host = manager.activeTab?.hostElement ?? null;
  if (host === null) {
    return;
  }
  host.focus();
  host.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: combo === 'Ctrl+Shift+Z',
      bubbles: true,
      cancelable: true,
    }),
  );
}

// T10（R5）：导出依赖装配。DOM/IPC 薄接线集中在此，编排与纯逻辑在
// src/export/ 下（可 headless 测试）。
function activeExportSnapshot(): ExportTabSnapshot | null {
  const tab = manager.activeTab;
  if (tab === null) {
    return null;
  }
  return {
    title: tab.title,
    filePath: tab.filePath,
    sessionId: tab.syntheticId,
    contentHtml: serializeEditorContent(tab.hostElement),
  };
}

/** 自定义主题激活时读取注入槽的 CSS，一并内嵌进导出文档。 */
function currentCustomThemeCss(): string {
  return document.getElementById('lightink-custom-theme')?.textContent ?? '';
}

const exportDeps: ExportServiceDeps = {
  getActiveSnapshot: activeExportSnapshot,
  getTheme: () => document.documentElement.getAttribute('data-theme') ?? 'warm-light',
  getCssText: () => buildExportCss(currentCustomThemeCss()),
  readImageBase64: (docPath, sessionId, relPath) =>
    invoke<string>('read_image_base64', { docPath, sessionId, relPath }),
  showHtmlSaveDialog: async (defaultPath) => {
    const selected = await save({
      defaultPath,
      filters: [
        { name: 'HTML', extensions: ['html', 'htm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return typeof selected === 'string' ? selected : null;
  },
  writeFile,
  printHtml: (html) => printViaHiddenIframe(document, html),
  reportError: (message, error) => {
    // eslint-disable-next-line no-console
    console.error(`[lightink/export] ${message}`, error);
    // 导出是用户主动触发的动作：失败必须可见（不静默 console-only）。
    const detail = error instanceof Error ? error.message : String(error ?? '');
    void dialogMessage(`${message}\n${detail}`, { title: '导出失败', kind: 'error' });
  },
};

const shell = createAppShell(
  app,
  {
    onNew: () => void manager.newTab(),
    onOpen: () => void manager.openFile(),
    listRecents: () => invoke<string[]>('list_recents'),
    openRecent: async (path) => {
      const tab = await manager.openFile(path);
      if (tab === null) {
        // 文件缺失/不可读：移除该最近条目并提示。
        void invoke('remove_recent', { path }).catch(() => undefined);
        void dialogMessage(
          `无法打开「${path}」：文件可能已被移动或删除。已从最近打开中移除。`,
          { title: '轻墨 LightInk', kind: 'warning' },
        );
        return false;
      }
      return true;
    },
    clearRecents: () => invoke('clear_recents'),
    onShowVersions: () => showVersionsForActive(),
    // 注意：菜单 enabled 回调在 createAppShell 构造期就被同步调用（见 menus.ts 的
    // refreshItemEnabled），此时 manager 尚未赋值（于下方 new TabManager 处赋值）。
    // 用 ?. 短路避免构造期抛错；构造期返回 false（无活动文件）也正确，菜单打开时
    // 会经 refreshMenu 重算。
    hasActiveFile: () => manager?.activeTab?.filePath != null,
    onSave: () => {
      commitActiveSourceMode();
      void manager.saveActiveTab();
    },
    onSaveAs: () => {
      commitActiveSourceMode();
      void saveActiveAs();
    },
    onExportHtml: () => {
      commitActiveSourceMode();
      void exportActiveTabHtml(exportDeps);
    },
    onExportPdf: () => {
      commitActiveSourceMode();
      void exportActiveTabPdf(exportDeps);
    },
    onUndo: () => dispatchEditorCombo('Ctrl+Z'),
    onRedo: () => dispatchEditorCombo('Ctrl+Shift+Z'),
    onCut: () => document.execCommand('cut'),
    onCopy: () => document.execCommand('copy'),
    onPaste: () => document.execCommand('paste'),
    onInsertElement: insertElement,
    onToggleTheme: () => {
      themeService.toggle();
    },
    onApplyTheme: (themeId) => {
      themeService.apply(themeId);
    },
    getCurrentThemeId: () => themeService.currentThemeId,
    onReloadCustomTheme: () => {
      void themeService.reloadCustomThemeFile();
    },
    canReloadCustomTheme: () => themeService.customThemePath !== null,
    onToggleOutline: () => outline.toggleCollapse(),
    // T7/R10：整窗 WYSIWYG ↔ 源码模式切换。
    onToggleSourceMode: () => toggleActiveSourceMode(),
  },
  { shortcutBindings: getShortcutBindings },
);

/** 关闭未保存标签的三选一确认（应用内主题化弹层，一次给出全部选择）。 */
async function confirmClose(tab: { title: string }): Promise<CloseChoice> {
  const choice = await showConfirmDialog(document, {
    title: '关闭标签',
    message: `「${tab.title}」有未保存的更改。\n保存后再关闭？`,
    buttons: [
      { id: 'save', label: '保存', kind: 'primary' },
      { id: 'discard', label: '不保存', kind: 'danger' },
      { id: 'cancel', label: '取消', kind: 'plain' },
    ],
    cancelId: 'cancel',
  });
  if (choice === 'save') return 'save';
  if (choice === 'discard') return 'discard';
  return 'cancel';
}

function renderTabBar(): void {
  pruneSourceViews();
  shell.renderTabBar(manager.tabList, manager.activeTabId, {
    onSwitch: (id) => manager.switchTab(id),
    onClose: (id) => {
      // 关闭前提交该标签的源码态编辑，避免 closeTab 保存分支写旧值/丢 textarea 编辑。
      commitSourceMode(id);
      void manager.closeTab(id);
    },
  });
}

/** 清理已关闭标签的 SourceView（宿主已由 detachHost 移除；仅删 Map 项，不对已销毁编辑器写回）。 */
function pruneSourceViews(): void {
  const live = new Set(manager.tabList.map((t) => t.id));
  for (const id of [...sourceViews.keys()]) {
    if (!live.has(id)) {
      sourceViews.delete(id);
    }
  }
}

manager = new TabManager({
  mountEditor,
  createHostElement: (tabId) => {
    const el = document.createElement('div');
    el.className = 'lightink-tab-host';
    el.dataset.tabId = tabId;
    return el;
  },
  attachHost: (el) => {
    shell.editorArea.appendChild(el);
    // 编辑内容变化 → 脏标记/快照调度（ProseMirror 的 input 事件冒泡到宿主）。
    el.addEventListener('input', () => {
      const id = el.dataset.tabId;
      if (id !== undefined) {
        manager.handleContentChanged(id);
      }
    });
  },
  detachHost: (el) => {
    el.remove();
  },
  confirmClose,
  promptRestore: async (path) =>
    (await showConfirmDialog(document, {
      title: '崩溃恢复',
      message: `检测到「${path}」的崩溃恢复快照比磁盘文件新。\n是否恢复未保存的内容？`,
      buttons: [
        { id: 'restore', label: '恢复', kind: 'primary' },
        { id: 'skip', label: '不恢复', kind: 'plain' },
      ],
      cancelId: 'skip',
    })) === 'restore',
  onTabsChanged: renderTabBar,
  onActiveContentChanged: () => {
    outline.scheduleRefresh();
  },
  onFileOpened: (filePath) => {
    void invoke('add_recent', { path: filePath }).catch(() => undefined);
  },
  onFileSaved: (filePath, content) => {
    // R13：每次成功保存自动生成一份版本快照。
    void invoke('create_version', { filePath, content }).catch(() => undefined);
  },
  onLinkNavigate: (href) => handleLinkNavigation(href),
});

// T7：大纲侧栏。闭包读取活动标签的宿主/markdown；刷新由 TabManager 的
// onActiveContentChanged 回调防抖驱动（切换标签/活动标签内容变化）。
outline = createOutlineView({
  getActiveHost: () => manager.activeTab?.hostElement ?? null,
  getActiveMarkdown: () => {
    const tab = manager.activeTab;
    if (tab === null) {
      return null;
    }
    try {
      return tab.editor.getMarkdown();
    } catch {
      return null;
    }
  },
});
shell.outlineSidebar.appendChild(outline.root);

/** R13：为活动文件弹出版本历史（列表/预览/恢复/手动存档）。 */
function showVersionsForActive(): void {
  const tab = manager.activeTab;
  const filePath = tab?.filePath ?? null;
  if (filePath === null) {
    return;
  }
  showVersionsModal(document, {
    list: () => invoke<VersionMeta[]>('list_versions', { filePath }),
    read: (id) => invoke<string>('read_version', { filePath, versionId: id }),
    restore: async (id) => {
      const currentContent = tab?.editor.getMarkdown() ?? '';
      const content = await invoke<string>('restore_version', {
        filePath,
        versionId: id,
        currentContent,
      });
      tab?.editor.setMarkdown(content);
      const activeId = manager.activeTabId;
      if (activeId !== null) {
        manager.handleContentChanged(activeId);
      }
    },
    saveCurrent: () =>
      invoke('create_version', { filePath, content: tab?.editor.getMarkdown() ?? '' }),
  });
}

/** 取路径所在目录（兼容 / 与 \）。 */
function dirOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

/** R14：点击文档链接 → 分类跳转（外链浏览器 / 本地 .md 新标签 / 其他本地文件系统默认）。 */
function handleLinkNavigation(href: string): void {
  const docPath = manager.activeTab?.filePath ?? '';
  const currentDocDir = docPath !== '' ? dirOf(docPath) : '';
  const link = classifyLink(href, currentDocDir);
  switch (link.kind) {
    case 'external':
      void invoke('open_in_browser', { url: link.target }).catch(() => undefined);
      return;
    case 'localMd':
      void openLocalMdLink(link.target);
      return;
    case 'localFile':
      void invoke('open_path_default', { path: link.target }).catch(() => undefined);
      return;
    default:
      return;
  }
}

/** 相对/绝对 .md 链接：应用内新标签打开；目标不存在给出提示。 */
async function openLocalMdLink(path: string): Promise<void> {
  const opened = await manager.openFile(path);
  if (opened === null) {
    void dialogMessage(`无法打开「${path}」：文件不存在或无法读取。`, {
      title: '轻墨 LightInk',
      kind: 'warning',
    });
  }
}

// T7/R10：每标签的源码视图（惰性创建）。整窗 WYSIWYG ↔ 源码模式，单窗格无并排。
const sourceViews = new Map<string, SourceView>();
function toggleActiveSourceMode(): void {
  const tab = manager.activeTab;
  if (tab === null) return;
  let view = sourceViews.get(tab.id);
  if (view === undefined) {
    view = new SourceView(tab.hostElement, tab.editor);
    sourceViews.set(tab.id, view);
  }
  view.toggle();
}
/** 源码态下把活动标签的 textarea 源码同步回编辑器（供保存/大纲读取一致）。 */
function commitActiveSourceMode(): void {
  const tab = manager.activeTab;
  if (tab === null) return;
  commitSourceMode(tab.id);
}
/** 按标签 id 提交其源码态编辑（同步到编辑器，不退出源码模式）。 */
function commitSourceMode(tabId: string): void {
  const view = sourceViews.get(tabId);
  if (view !== undefined && view.isSourceMode) {
    view.syncToEditor();
  }
}

// 快捷键：捕获阶段注册，保存等操作在编辑器内同样生效。
const shortcuts = new ShortcutRegistry({
  new: () => void manager.newTab(),
  open: () => void manager.openFile(),
  save: () => {
    commitActiveSourceMode();
    void manager.saveActiveTab();
  },
  'save-as': () => {
    commitActiveSourceMode();
    void saveActiveAs();
  },
  'toggle-theme': () => {
    themeService.toggle();
  },
  // R5：插入链接/图片、大纲显隐（源码模式 Ctrl+/ 由 T7 注册）。
  'insert-link': () => insertElement('link'),
  'insert-image': () => insertElement('image'),
  'toggle-outline': () => outline.toggleCollapse(),
  'toggle-source-mode': () => toggleActiveSourceMode(),
  'toggle-menu-chrome': () => shell.toggleMenuChrome(),
});
shortcuts.attach(document);

// T8/R3：右键上下文菜单（编辑区 + 标签页）。
function showEditorContextMenu(x: number, y: number): void {
  const tab = manager.activeTab;
  if (tab === null) return;
  const sourceView = sourceViews.get(tab.id);
  const inSource = sourceView !== undefined && sourceView.isSourceMode;
  // 源码态下选区/链接以源码 textarea 为准（WYSIWYG 编辑器被覆盖层遮住）。
  const sel = tab.editor.getSelection();
  const hasSelection = inSource
    ? sourceView?.hasTextSelection() === true
    : sel !== null && !sel.empty;
  const link = inSource ? null : tab.editor.getLinkAtPoint(x, y);
  const hasLink = link !== null;
  const items = buildEditorContextMenuItems(
    { hasSelection, hasLink, inSourceMode: inSource },
    {
      cut: () => {
        if (inSource) sourceView?.focusEditor();
        document.execCommand('cut');
      },
      copy: () => {
        if (inSource) sourceView?.focusEditor();
        document.execCommand('copy');
      },
      paste: () => {
        if (inSource) sourceView?.focusEditor();
        void navigator.clipboard?.readText().then((text) => {
          if (typeof text === 'string' && text !== '') {
            document.execCommand('insertText', false, text);
          }
        });
      },
      pastePlain: () => {
        if (inSource) sourceView?.focusEditor();
        void navigator.clipboard?.readText().then((text) => {
          if (typeof text === 'string' && text !== '') {
            document.execCommand('insertText', false, text);
          }
        });
      },
      bold: () => tab.editor.toggleMark('strong'),
      italic: () => tab.editor.toggleMark('emphasis'),
      link: () => {
        const href = typeof prompt === 'function' ? (prompt('链接地址（https://…）') ?? '') : '';
        if (href !== '') tab.editor.setLink(href);
      },
      openLink: () => {
        // 与左键 linkNavigationPlugin 同路径：classifyLink 分类后分派到
        // open_in_browser / openFile / open_path_default，覆盖 external/本地.md/本地文件。
        if (link !== null) handleLinkNavigation(link.href);
      },
      copyLinkAddress: () => {
        if (link !== null) void navigator.clipboard?.writeText(link.href);
      },
    },
  );
  createContextMenu(items, { x, y });
}

function showTabContextMenu(tabId: string, x: number, y: number): void {
  const tab = manager.tabList.find((t) => t.id === tabId) ?? null;
  const hasFile = tab !== null && tab.filePath !== null;
  const items = buildTabContextMenuItems({ hasFile }, {
    close: () => void manager.closeTab(tabId),
    closeOthers: () => {
      for (const other of manager.tabList) {
        if (other.id !== tabId) void manager.closeTab(other.id);
      }
    },
    copyPath: () => {
      if (tab?.filePath !== null && tab?.filePath !== undefined) {
        void navigator.clipboard?.writeText(tab.filePath);
      }
    },
    revealInFiles: () => {
      // 「在文件管理器中显示」走 opener reveal_path_in_files（lib.rs 已注册，与 R14 链接
      // 分类的 opener 能力同源）。能力未注册时忽略，避免阻塞右键菜单。
      const path = tab?.filePath;
      if (path === null || path === undefined) return;
      void invoke('reveal_path_in_files', { path }).catch(() => undefined);
    },
  });
  createContextMenu(items, { x, y });
}

shell.editorArea.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showEditorContextMenu(event.clientX, event.clientY);
});
shell.tabBar.addEventListener('contextmenu', (event) => {
  const target = event.target;
  const btn = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-tab-id]') : null;
  if (btn === null || btn.dataset.tabId === undefined) return;
  event.preventDefault();
  showTabContextMenu(btn.dataset.tabId, event.clientX, event.clientY);
});

const SHORTCUT_LABELS: Readonly<Record<ShortcutAction, string>> = {
  new: '新建',
  open: '打开',
  save: '保存',
  'save-as': '另存为',
  'toggle-theme': '切换主题',
  'insert-link': '插入链接',
  'insert-image': '插入图片',
  'toggle-outline': '大纲显隐',
  'toggle-source-mode': '源码模式',
  'toggle-menu-chrome': '菜单栏显隐',
};

/** 快捷键速查表数据源（R5）：从注册表派生标签→组合键。 */
function getShortcutBindings(): CheatBinding[] {
  return shortcuts.entries().map(({ action, combo }) => ({
    label: SHORTCUT_LABELS[action],
    shortcut: combo,
  }));
}

async function bootstrap(): Promise<void> {
  // 先恢复崩溃遗留的未命名草稿（其副作用：为每个恢复草稿开标签）。
  await manager.recoverUntitledDrafts();
  // R1：先注册单实例 open-file 监听，再取首实例 pending——监听就绪前到达的第二实例
  // 文件由随后的初始 take_pending_file 抽干槽兜底，避免启动竞态内事件被孤立。
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('open-file', () => {
      void invoke<string | null>('take_pending_file')
        .then((path) => {
          if (path !== null) void manager.openFile(path);
        })
        .catch(() => undefined);
    });
    // OS 文件拖入窗口：.md 开标签 / 图片插入 / 其他提示（dragDropEnabled 默认开启，
    // Tauri 把 OS 拖拽拦截为本事件，HTML5 drop 收不到 OS 文件）。
    await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
      void handleOsFileDrop(event.payload.paths);
    });
  } catch {
    // 非 Tauri 环境（纯前端 dev）：无单实例/拖拽事件，忽略。
  }
  // R1：取出启动/关联文件（首实例 argv 经后端 take_pending_file；命令未就绪时静默）。
  const pendingFile = await invoke<string | null>('take_pending_file').catch(() => null);
  if (pendingFile !== null) {
    await manager.openFile(pendingFile);
  }
  // 无标签（无恢复草稿、无启动文件）则新建欢迎标签。
  if (manager.tabList.length === 0) {
    await manager.newTab('# 轻墨 LightInk\n\n开始书写。\n');
  }
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[lightink] bootstrap failed:', err);
});
