/**
 * 应用入口（T6 正式极简外壳）。
 *
 * 组装顺序：主题服务（默认护眼浅色/深色切换/自定义主题注入槽）→
 * 极简外壳（src/ui/app-shell：命令行 + 标签栏 + 编辑区）→ TabManager
 * （接线保持 T3 语义不变：宿主元素、崩溃快照、恢复流程）→ 快捷键注册。
 */

import { invoke } from '@tauri-apps/api/core';
import { ask, confirm, message as dialogMessage, save } from '@tauri-apps/plugin-dialog';

import { mountEditor } from './editor/index.js';
import { SourceView } from './editor/source-view.js';
import {
  buildEditorContextMenuItems,
  buildTabContextMenuItems,
  createContextMenu,
} from './ui/context-menu.js';
import { insertElementMarkdown, type InsertElementId } from './editor/insert-commands.js';
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
import { ShortcutRegistry, type ShortcutAction } from './ui/shortcuts.js';
import { countDocumentStats, createStatusBarView, type StatusBarView } from './ui/status-bar.js';
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
// T9：状态栏视图同上（回调触发时必然已赋值）。
let statusBar: StatusBarView;

function saveActiveAs(): void {
  const id = manager.activeTabId;
  if (id !== null) {
    void manager.saveTabAs(id);
  }
}

/** 向活动标签追加插入元素（R2 插入菜单 MVP；光标级精度由 T6/R11 叠加）。 */
function insertElement(id: InsertElementId): void {
  const tab = manager.activeTab;
  if (tab === null) {
    return;
  }
  tab.editor.setMarkdown(insertElementMarkdown(tab.editor.getMarkdown(), id));
  const activeId = manager.activeTabId;
  if (activeId !== null) {
    manager.handleContentChanged(activeId);
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

/** 关闭未保存标签的三选一确认（dialog 插件两步询问，临时方案）。 */
async function confirmClose(tab: { title: string }): Promise<CloseChoice> {
  const wantSave = await ask(`「${tab.title}」有未保存的更改，是否保存？`, {
    title: '轻墨 LightInk',
    kind: 'warning',
  });
  if (wantSave) {
    return 'save';
  }
  const discard = await confirm('不保存直接关闭？更改将丢失。', {
    title: '轻墨 LightInk',
    kind: 'warning',
  });
  return discard ? 'discard' : 'cancel';
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
  promptRestore: (path) =>
    ask(`检测到「${path}」的崩溃恢复快照比磁盘文件新，是否恢复未保存的内容？`, {
      title: '轻墨 LightInk - 崩溃恢复',
      kind: 'warning',
    }),
  onTabsChanged: renderTabBar,
  onActiveContentChanged: () => {
    outline.scheduleRefresh();
    refreshStatusBar();
  },
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

// T9/R6：底部状态栏（字数/字符数）。随活动标签切换/内容变化经既有
// onActiveContentChanged 回调实时刷新（每键击重算，常规文档可接受）。
statusBar = createStatusBarView(document);
shell.statusBar.appendChild(statusBar.root);
/** 刷新底部状态栏字数/字符数（无活动标签或读取异常时清空）。 */
function refreshStatusBar(): void {
  const tab = manager.activeTab;
  if (tab === null) {
    statusBar.setStats(null);
    return;
  }
  let md: string;
  try {
    md = tab.editor.getMarkdown();
  } catch {
    statusBar.setStats(null);
    return;
  }
  statusBar.setStats(countDocumentStats(md));
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
});
shortcuts.attach(document);

// T8/R3：右键上下文菜单（编辑区 + 标签页）。
function showEditorContextMenu(x: number, y: number): void {
  const tab = manager.activeTab;
  if (tab === null) return;
  const sel = tab.editor.getSelection();
  const hasSelection = sel !== null && !sel.empty;
  const link = tab.editor.getLinkAtCursor();
  const hasLink = link !== null;
  const items = buildEditorContextMenuItems(
    { hasSelection, hasLink },
    {
      cut: () => document.execCommand('cut'),
      copy: () => document.execCommand('copy'),
      paste: () => {
        void navigator.clipboard?.readText().then((text) => {
          if (typeof text === 'string' && text !== '') {
            document.execCommand('insertText', false, text);
          }
        });
      },
      pastePlain: () => {
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
        if (link !== null) window.open(link.href, '_blank', 'noopener');
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
      // 「在文件管理器中显示」依赖 opener/shell 能力（与 R14 共用）；命令未就绪时静默。
      const path = tab?.filePath;
      if (path === null || path === undefined) return;
      void (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('reveal_path_in_files', { path });
        } catch {
          // 能力未注册（R14 接通前）：忽略。
        }
      })();
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
  } catch {
    // 非 Tauri 环境（纯前端 dev）：无单实例事件，忽略。
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
