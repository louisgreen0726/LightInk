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
import {
  setFormatToolbarLinkEditor,
  setFormatToolbarTitles,
} from './editor/plugins/format-toolbar.js';
import { setCodeChromeLabels } from './editor/plugins/code-highlight.js';
import { setMathEditTitle } from './editor/plugins/math.js';
import { setMermaidEditTitle } from './editor/plugins/mermaid.js';
import { setSlashImageHandler, setSlashTranslate } from './editor/plugins/slash-menu.js';
import { setAppDisplayName } from './ui/window-title.js';
import { SourceView } from './editor/source-view.js';
import {
  clearFindReplace,
  collectSourceMatches,
  createFindReplacePanel,
  findReplaceViewForHost,
  readFindReplaceState,
  replaceAllMatches,
  replaceCurrentMatch,
  setFindQuery,
  stepFindMatch,
  type FindReplaceLabels,
  type FindReplacePanel,
} from './editor/plugins/find-replace.js';
import {
  buildEditorContextMenuItems,
  buildTabContextMenuItems,
  createContextMenu,
} from './ui/context-menu.js';
import { showLinkDialog, showOpenLinkConfirm } from './ui/link-dialog.js';
import {
  formatLinkMarkdown,
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
import { createAutosave, type AutosaveController } from './tabs/autosave.js';
import type { CloseChoice } from './tabs/types.js';
import { createStyleTagSlot, ThemeService } from './theme/theme-service.js';
import type { CheatBinding } from './ui/help-cheatsheet.js';
import { createAppShell } from './ui/app-shell.js';
import { showConfirmDialog } from './ui/confirm-dialog.js';
import { createStatusBar, type StatusBar } from './ui/status-bar.js';
import { createI18n } from './i18n/i18n.js';
import { installDisplayScale } from './ui/display-scale.js';
import { installFontScale } from './ui/font-scale.js';
import { formatShortcutLabel, isMacPlatform } from './ui/platform.js';
import { ShortcutRegistry } from './ui/shortcuts.js';
import { toggleFullscreen } from './ui/window-chrome.js';
import { formatDocumentTitle } from './ui/window-title.js';
import { showVersionsModal, type VersionMeta } from './ui/versions.js';
import './theme/tokens.css';
import './ui/theme.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('LightInk: #app root container not found in index.html');
}

// 1080p / 2K / 4K layout tier → html[data-display]; theme.css scales tokens.
installDisplayScale(document.documentElement, window);

// Reading font zoom (body/code) over tier baselines; persists lightink.fontScale.
const fontScale = installFontScale(document.documentElement, window.localStorage);

// UI language (en / zh-CN) + macOS shortcut labels.
const i18n = createI18n(window.localStorage);
const isMac = isMacPlatform();

/** Apply locale-dependent chrome labels (window title, format bar, code blocks). */
function applyLocaleChrome(): void {
  setAppDisplayName(i18n.t('app.name'));
  setFormatToolbarTitles({
    bold: i18n.t('format.bold'),
    italic: i18n.t('format.italic'),
    strikethrough: i18n.t('format.strikethrough'),
    code: i18n.t('format.code'),
    link: i18n.t('format.link'),
  });
  setCodeChromeLabels({
    copy: i18n.t('code.copy'),
    copied: i18n.t('code.copied'),
    plain: i18n.t('code.plain'),
    filterPlaceholder: i18n.t('code.filterPlaceholder'),
    emptyFilter: i18n.t('code.emptyFilter'),
    mermaid: i18n.t('code.mermaid'),
    math: i18n.t('code.math'),
  });
  setMathEditTitle(i18n.t('math.editTitle'));
  setMermaidEditTitle(i18n.t('mermaid.editTitle'));
  setSlashTranslate((key) => i18n.t(key));
}
applyLocaleChrome();

// 主题服务：首次启动默认 warm-light，恢复上次选择；自定义主题走 <style> 注入槽。
const themeService = new ThemeService({
  root: document.documentElement,
  customStyleSlot: createStyleTagSlot(document),
  storage: window.localStorage,
  readFile,
});

// 外壳按钮/快捷键回调仅在用户交互时触发，此时 manager 必然已赋值。
let manager: TabManager;
// Shell is assigned after createAppShell returns; menu labels/actions use optional access.
let shell: ReturnType<typeof createAppShell>;
// T7：大纲视图在 TabManager 之后创建（见下），回调触发时必然已赋值。
let outline: OutlineView;
// T5/R3：字数状态栏在 TabManager 之后创建（见下），菜单回调用 ?. 短路。
let statusBar: StatusBar;
// R14：自动保存控制器在 TabManager 之后创建（见下），菜单回调用 ?. 短路。
let autosave: AutosaveController;

function saveActiveAs(): void {
  const id = manager.activeTabId;
  if (id !== null) {
    void manager.saveTabAs(id);
  }
}

/**
 * 向活动标签插入元素（R2 插入菜单 / R5 快捷键）：
 *   - 图片：走本地文件选择 → 落盘 assets → 光标处插入（见 insertImageFromFile）；
 *   - 链接：弹出文本+URL 对话框，确认后插入（不直接塞占位 snippet）；
 *   - 源码模式：片段插入到源码 textarea 光标处（否则写编辑器会被源码态退出时
 *     的 textarea 写回覆盖，用户感知为「插入无法使用」）；
 *   - WYSIWYG：结构化解析后在光标处插入。
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
  if (id === 'link') {
    void insertLinkViaDialog();
    return;
  }
  const element = getInsertElement(id);
  if (element === undefined) {
    return;
  }
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.insertSnippetAtCursor(element.snippet());
    manager.handleContentChanged(tab.id);
    return;
  }
  // Structured insert at caret (table/list/code as real nodes, not plain text).
  if (tab.editor.insertMarkdown(element.snippet())) {
    manager.handleContentChanged(tab.id);
    return;
  }
  // Fallback: append as markdown blocks at end of document.
  tab.editor.setMarkdown(insertElementMarkdown(tab.editor.getMarkdown(), id));
  manager.handleContentChanged(tab.id);
}

/** Insert → Link / shortcut: themed dialog for display text + URL. */
async function insertLinkViaDialog(): Promise<void> {
  const tab = manager.activeTab;
  if (tab === null) return;

  const sourceView = sourceViews.get(tab.id);
  const inSource = sourceView !== undefined && sourceView.isSourceMode;
  const existing = !inSource ? tab.editor.getLinkAtCursor() : null;

  const result = await showLinkDialog(document, {
    title: existing !== null ? i18n.t('dialog.link.edit') : i18n.t('dialog.link.add'),
    initialText: existing?.text ?? '',
    initialHref: existing?.href ?? '',
    confirmLabel: i18n.t('dialog.link.apply'),
    labels: {
      text: i18n.t('dialog.link.textLabel'),
      textPlaceholder: i18n.t('dialog.link.textPlaceholder'),
      href: i18n.t('dialog.link.hrefLabel'),
      hrefPlaceholder: i18n.t('dialog.link.hrefPlaceholder'),
      cancel: i18n.t('dialog.cancel'),
    },
  });
  if (result === null) return;

  const md = formatLinkMarkdown(result.text, result.href);
  if (md === '') return;

  if (inSource && sourceView !== undefined) {
    sourceView.insertSnippetAtCursor(md);
  } else {
    // setLink wraps the current selection or inserts a linked run at the caret.
    tab.editor.setLink(result.href, result.text);
  }
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
    void dialogMessage(i18n.t('error.imageImport', { detail }), {
      title: i18n.t('error.imageImportTitle'),
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
      void dialogMessage(i18n.t('error.openFileMissing', { path }), {
        title: i18n.t('app.name'),
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
      title: i18n.t('app.name'),
      kind: 'warning',
    });
  }
}

/** Focus the active writing surface (source textarea or ProseMirror view). */
function focusActiveEditor(): void {
  const tab = manager?.activeTab ?? null;
  if (tab === null) {
    return;
  }
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.focusEditor();
    return;
  }
  tab.editor.focus();
}

/**
 * Run after the menu click stack unwinds so the editor can take focus away from
 * the just-clicked menu button (menus steal focus on open/click).
 */
function afterMenuFocus(run: () => void): void {
  // Double rAF: first frame closes/hides the menu panel; second frame focuses editor.
  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

/** Menu undo: ProseMirror history in WYSIWYG; native undo in source mode. */
function undoActiveEditor(): void {
  afterMenuFocus(() => {
    const tab = manager?.activeTab ?? null;
    if (tab === null) {
      return;
    }
    const sourceView = sourceViews.get(tab.id);
    if (sourceView !== undefined && sourceView.isSourceMode) {
      sourceView.focusEditor();
      document.execCommand('undo');
      manager.handleContentChanged(tab.id);
      return;
    }
    tab.editor.undo();
    tab.editor.focus();
    manager.handleContentChanged(tab.id);
  });
}

/** Menu redo: ProseMirror history in WYSIWYG; native redo in source mode. */
function redoActiveEditor(): void {
  afterMenuFocus(() => {
    const tab = manager?.activeTab ?? null;
    if (tab === null) {
      return;
    }
    const sourceView = sourceViews.get(tab.id);
    if (sourceView !== undefined && sourceView.isSourceMode) {
      sourceView.focusEditor();
      document.execCommand('redo');
      manager.handleContentChanged(tab.id);
      return;
    }
    tab.editor.redo();
    tab.editor.focus();
    manager.handleContentChanged(tab.id);
  });
}

/**
 * Clipboard menu actions must run against a focused editable target.
 * Menu clicks steal focus, so re-focus before cut/copy/paste.
 */
function runClipboardCommand(command: 'cut' | 'copy' | 'paste'): void {
  afterMenuFocus(() => {
    focusActiveEditor();
    if (command === 'paste') {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (typeof text !== 'string' || text === '') {
            return;
          }
          focusActiveEditor();
          const ok = document.execCommand('insertText', false, text);
          if (!ok) {
            // Fallback for environments that still allow the paste command.
            document.execCommand('paste');
          }
          const tab = manager?.activeTab ?? null;
          if (tab !== null) {
            manager.handleContentChanged(tab.id);
          }
        })
        .catch(() => {
          focusActiveEditor();
          document.execCommand('paste');
        });
      return;
    }
    document.execCommand(command);
    if (command === 'cut') {
      const tab = manager?.activeTab ?? null;
      if (tab !== null) {
        manager.handleContentChanged(tab.id);
      }
    }
  });
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
    void dialogMessage(`${message}\n${detail}`, {
      title: i18n.t('error.exportFailed'),
      kind: 'error',
    });
  },
};

shell = createAppShell(
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
          `${i18n.t('error.openFile', { path })} ${i18n.t('error.recentRemoved')}`,
          { title: i18n.t('app.name'), kind: 'warning' },
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
    // R14：自动保存开关（文件菜单勾选项；autosave 在 TabManager 后创建，
    // 菜单动作经 ?. 短路，菜单打开时 isAutosaveEnabled 重算勾选态）。
    isAutosaveEnabled: () => autosave?.isEnabled() === true,
    onToggleAutosave: () => {
      autosave?.toggle();
    },
    onExportHtml: () => {
      commitActiveSourceMode();
      void exportActiveTabHtml(exportDeps);
    },
    onExportPdf: () => {
      commitActiveSourceMode();
      void exportActiveTabPdf(exportDeps);
    },
    onUndo: () => undoActiveEditor(),
    onRedo: () => redoActiveEditor(),
    onCut: () => runClipboardCommand('cut'),
    onCopy: () => runClipboardCommand('copy'),
    onPaste: () => runClipboardCommand('paste'),
    onFind: () => openFindPanel(),
    // T6/R10：全选（双模式）；含未保存新标签在内的任意活动文档均可用。
    onSelectAll: () => selectAllActive(),
    hasActiveDocument: () => manager.activeTab !== null,
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
    // T5/R3：字数状态栏开关（视图菜单勾选项；statusBar 在 TabManager 后创建，
    // 菜单动作经 ?. 短路，菜单打开时 isStatusBarVisible 重算勾选态）。
    isStatusBarVisible: () => statusBar?.isVisible() === true,
    onToggleStatusBar: () => {
      statusBar?.toggle();
    },
    onToggleFullscreen: () => {
      void enterOrExitFullscreen();
    },
    // Shell is assigned after createAppShell returns; menu opens re-evaluate.
    isChromePinned: () => shell?.isChromePinned() === true,
    onToggleChromePinned: () => {
      toggleChromePinnedWithOutline();
    },
    onZoomIn: () => {
      fontScale.zoomIn();
    },
    onZoomOut: () => {
      fontScale.zoomOut();
    },
    onZoomReset: () => {
      fontScale.reset();
    },
    getFontScaleLabel: () => fontScale.label,
    t: (key, vars) => i18n.t(key, vars),
    formatShortcut: (combo) => formatShortcutLabel(combo, isMac),
    getLocale: () => i18n.locale,
    setLocale: (locale) => {
      i18n.setLocale(locale);
      applyLocaleChrome();
      if (shell !== undefined) {
        shell.rebuildMenus();
        // Keep menu chrome visible so the user sees the new language immediately.
        shell.revealMenu();
      }
      // Outline chrome (title / toggle tooltips / empty states).
      if (outline !== undefined) {
        outline.retranslate();
      }
      // Refresh window title with localized app name.
      const tab = manager?.activeTab ?? null;
      if (tab !== null) {
        document.title = formatDocumentTitle({ title: tab.title, dirty: tab.dirty });
      } else {
        document.title = formatDocumentTitle(null);
      }
    },
  },
  { shortcutBindings: getShortcutBindings },
);

/**
 * Immersive chrome: unpinning hides menu + tabs; also fully hides the outline
 * so the writing surface is unobstructed. Pinning restores outline if we hid it.
 */
let outlineVisibilityBeforeImmersive: import('./outline/outline-view.js').OutlineVisibility | null =
  null;

function toggleChromePinnedWithOutline(): void {
  if (shell === undefined) {
    return;
  }
  const wasPinned = shell.isChromePinned();
  const nowPinned = shell.toggleChromePinned();
  if (!nowPinned && wasPinned) {
    // Enter immersive (unpinned): fully hide outline (not just rail).
    if (outline !== undefined && outline.visibility !== 'hidden') {
      outlineVisibilityBeforeImmersive = outline.visibility;
      outline.setVisibility('hidden');
    }
    return;
  }
  if (nowPinned && outlineVisibilityBeforeImmersive !== null && outline !== undefined) {
    outline.setVisibility(outlineVisibilityBeforeImmersive);
    outlineVisibilityBeforeImmersive = null;
  }
}

/** Fullscreen also forces unpinned chrome + fully hidden outline for a clean canvas. */
async function enterOrExitFullscreen(): Promise<void> {
  const next = await toggleFullscreen();
  if (next) {
    if (shell !== undefined && shell.isChromePinned()) {
      shell.setChromePinned(false);
    }
    if (outline !== undefined && outline.visibility !== 'hidden') {
      outlineVisibilityBeforeImmersive = outline.visibility;
      outline.setVisibility('hidden');
    }
  } else if (outlineVisibilityBeforeImmersive !== null && outline !== undefined) {
    // Leaving fullscreen: restore prior outline mode if we hid it.
    // Keep chrome unpinned so user stays in writing mode unless they re-pin.
    outline.setVisibility(outlineVisibilityBeforeImmersive);
    outlineVisibilityBeforeImmersive = null;
  }
}

/** 关闭未保存标签的三选一确认（应用内主题化弹层，一次给出全部选择）。 */
async function confirmClose(tab: { title: string }): Promise<CloseChoice> {
  const choice = await showConfirmDialog(document, {
    title: i18n.t('dialog.closeTab.title'),
    message: i18n.t('dialog.closeTab.message', { title: tab.title }),
    buttons: [
      { id: 'save', label: i18n.t('dialog.save'), kind: 'primary' },
      { id: 'discard', label: i18n.t('dialog.discard'), kind: 'danger' },
      { id: 'cancel', label: i18n.t('dialog.cancel'), kind: 'plain' },
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
  syncDocumentTitle();
}

/** Window identity for immersive shell: active title + dirty without a permanent tab strip. */
function syncDocumentTitle(): void {
  const tab = manager.activeTab;
  document.title = formatDocumentTitle(
    tab === null ? null : { title: tab.title, dirty: tab.dirty },
  );
}

/** Cycle active tab without requiring the tab bar to be revealed. */
function cycleActiveTab(delta: 1 | -1): void {
  const tabs = manager.tabList;
  if (tabs.length === 0) {
    return;
  }
  const current = manager.activeTabId;
  const index = current === null ? 0 : Math.max(0, tabs.findIndex((t) => t.id === current));
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next !== undefined) {
    manager.switchTab(next.id);
  }
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
  formatUntitledTitle: (n) => i18n.t('app.untitled', { n: String(n) }),
  formatUntitledRestoredTitle: (n) => i18n.t('app.untitledRestored', { n: String(n) }),
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
      title: i18n.t('dialog.crash.title'),
      message: i18n.t('dialog.crash.message', { path }),
      buttons: [
        { id: 'restore', label: i18n.t('dialog.crash.restore'), kind: 'primary' },
        { id: 'skip', label: i18n.t('dialog.crash.skip'), kind: 'plain' },
      ],
      cancelId: 'skip',
    })) === 'restore',
  // R13：未脏文件检测到磁盘更新（提示「可重新加载」）。
  confirmExternalReload: async (tab) =>
    (await showConfirmDialog(document, {
      title: i18n.t('dialog.externalReload.title'),
      message: i18n.t('dialog.externalReload.message', { title: tab.title }),
      buttons: [
        { id: 'reload', label: i18n.t('dialog.externalReload.reload'), kind: 'primary' },
        { id: 'ignore', label: i18n.t('dialog.externalReload.ignore'), kind: 'plain' },
      ],
      cancelId: 'ignore',
    })) === 'reload'
      ? 'reload'
      : 'ignore',
  // R13：已脏文件 / 保存前检测到外部冲突（保留内存 / 重新加载 / 覆盖磁盘）。
  confirmExternalConflict: async (tab) => {
    const choice = await showConfirmDialog(document, {
      title: i18n.t('dialog.externalConflict.title'),
      message: i18n.t('dialog.externalConflict.message', { title: tab.title }),
      buttons: [
        { id: 'keep', label: i18n.t('dialog.externalConflict.keep'), kind: 'primary' },
        { id: 'reload', label: i18n.t('dialog.externalConflict.reload'), kind: 'plain' },
        { id: 'overwrite', label: i18n.t('dialog.externalConflict.overwrite'), kind: 'danger' },
      ],
      cancelId: 'keep',
    });
    if (choice === 'reload') return 'reload';
    if (choice === 'overwrite') return 'overwrite';
    return 'keep';
  },
  onTabsChanged: renderTabBar,
  onActiveContentChanged: () => {
    outline.scheduleRefresh();
    // T5/R3：状态栏防抖刷新（内部在隐藏时短路不渲染）。
    statusBar.scheduleUpdate(getActiveMarkdownForStatus);
  },
  onFileOpened: (filePath) => {
    void invoke('add_recent', { path: filePath }).catch(() => undefined);
  },
  onFileSaved: (filePath, content) => {
    // R13：每次成功保存自动生成一份版本快照。
    void invoke('create_version', { filePath, content }).catch(() => undefined);
  },
  onLinkNavigate: (href) => handleLinkNavigation(href),
  confirmLinkOpen: (href) =>
    showOpenLinkConfirm(document, href, {
      title: i18n.t('dialog.link.openTitle'),
      message: i18n.t('dialog.link.openMessage'),
      openLabel: i18n.t('dialog.open'),
      cancelLabel: i18n.t('dialog.cancel'),
    }),
});

// Format toolbar / context menu: themed link editor (text + href).
setFormatToolbarLinkEditor(async (initial) => {
  const result = await showLinkDialog(document, {
    title: initial.href ? i18n.t('dialog.link.edit') : i18n.t('dialog.link.add'),
    initialText: initial.text,
    initialHref: initial.href,
    confirmLabel: i18n.t('dialog.link.apply'),
    labels: {
      text: i18n.t('dialog.link.textLabel'),
      textPlaceholder: i18n.t('dialog.link.textPlaceholder'),
      href: i18n.t('dialog.link.hrefLabel'),
      hrefPlaceholder: i18n.t('dialog.link.hrefPlaceholder'),
      cancel: i18n.t('dialog.cancel'),
    },
  });
  return result;
});

// Slash `/image` uses the same file-picker path as Insert → Image.
setSlashImageHandler(() => insertImageFromFile());


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
  t: (key) => i18n.t(key),
});
shell.outlineSidebar.appendChild(outline.root);

// T5/R3：字数状态栏。挂载于 shell 根部槽位；显隐偏好 localStorage 跨会话保持
// （默认关闭），刷新由 TabManager 的 onActiveContentChanged 防抖驱动（见上）。
// 标签闭包现读 locale，语言切换后下次刷新即用新文案。
statusBar = createStatusBar(document, shell.statusBarHost, {
  storage: window.localStorage,
  labels: () =>
    i18n.locale === 'en'
      ? { words: 'Words', characters: 'Characters' }
      : { words: '字数', characters: '字符' },
});

/** 活动标签的 markdown（状态栏统计来源；与大纲同一事实源 editor.getMarkdown）。 */
function getActiveMarkdownForStatus(): string | null {
  const tab = manager?.activeTab ?? null;
  if (tab === null) {
    return null;
  }
  try {
    return tab.editor.getMarkdown();
  } catch {
    return null;
  }
}

// 启动即渲染一次（可见偏好恢复时显示当前文档口径，不等首次编辑）。
statusBar.refresh(getActiveMarkdownForStatus);

// R14：可选自动保存（默认关；偏好 localStorage 跨会话保持）。tick 前先提交
// 活动标签的源码态编辑（与手动保存同口径），再扫全部有路径脏 tab 走同一保存流
// （含 R13 保存前 mtime 闸门；冲突由既有对话框分派，不静默覆盖）。
autosave = createAutosave({
  storage: window.localStorage,
  tick: () => {
    commitActiveSourceMode();
    void manager.autosaveDirtyTabs();
  },
});

/** R13：为活动文件弹出版本历史（列表/预览/恢复/手动存档）。 */
function showVersionsForActive(): void {
  const tab = manager.activeTab;
  const filePath = tab?.filePath ?? null;
  if (filePath === null) {
    return;
  }
  showVersionsModal(
    document,
    {
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
    },
    {
      title: i18n.t('dialog.versions.title'),
      loading: i18n.t('dialog.loading'),
      pick: i18n.t('dialog.versions.pick'),
      empty: i18n.t('dialog.versions.empty'),
      restore: i18n.t('dialog.versions.restore'),
      saveNew: i18n.t('dialog.versions.saveNew'),
      close: i18n.t('dialog.close'),
      loadFailed: i18n.t('dialog.versions.loadFailed'),
      justNow: i18n.t('dialog.justNow'),
      minutesAgo: (n) => i18n.t('dialog.minutesAgo', { n: String(n) }),
      hoursAgo: (n) => i18n.t('dialog.hoursAgo', { n: String(n) }),
      daysAgo: (n) => i18n.t('dialog.daysAgo', { n: String(n) }),
    },
  );
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
    void dialogMessage(i18n.t('error.openFileMissing', { path }), {
      title: i18n.t('app.name'),
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

/**
 * T6/R10：全选活动文档（双模式）。WYSIWYG 走编辑器渐进式 selectAll（与 Mod-a 一致），
 * 源码模式选源码 textarea 全文。无活动文档时空操作。
 */
function selectAllActive(): void {
  const tab = manager.activeTab;
  if (tab === null) return;
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.selectAll();
    return;
  }
  tab.editor.selectAll();
}

// ---------------------------------------------------------------------------
// T4/R2：查找与替换壳层。面板本身不感知模式；这里按活动标签的当前模式分派：
//   WYSIWYG → find-replace 插件（decoration 高亮全部/当前命中；替换为单个
//     ProseMirror 事务，可经既有 undo 一次回到替换前）；
//   源码模式 → 直接操作源码 textarea（原生 selection + execCommand('insertText')
//     替换以保留原生 undo，不用 setRangeText；input 事件经 source-view 既有
//     refreshFromTextarea 同步回文档）。
// ---------------------------------------------------------------------------

let findPanel: FindReplacePanel | null = null;
/** 源码模式当前命中下标（WYSIWYG 的当前项由插件状态维护）。 */
let sourceFindActive = -1;

function findPanelLabels(): FindReplaceLabels {
  const zh = i18n.locale !== 'en';
  return {
    findPlaceholder: zh ? '查找' : 'Find',
    replacePlaceholder: zh ? '替换为' : 'Replace with',
    prev: zh ? '上一处' : 'Prev',
    next: zh ? '下一处' : 'Next',
    replace: zh ? '替换' : 'Replace',
    replaceAll: zh ? '全部替换' : 'Replace All',
    close: zh ? '关闭' : 'Close',
    empty: zh ? '无匹配' : 'No matches',
    count: (active, total) => `${String(active + 1)}/${String(total)}`,
  };
}

/** 活动标签处于源码模式时返回其源码 textarea；否则 null（走 WYSIWYG 路径）。 */
function activeSourceTextarea(): HTMLTextAreaElement | null {
  const tab = manager?.activeTab ?? null;
  if (tab === null) return null;
  const view = sourceViews.get(tab.id);
  if (view === undefined || !view.isSourceMode) return null;
  return tab.hostElement.querySelector<HTMLTextAreaElement>('textarea.lightink-source-editor');
}

/** 活动标签的 WYSIWYG EditorView（源码模式/无活动标签/未就绪时 null）。 */
function activeFindView(): ReturnType<typeof findReplaceViewForHost> {
  const tab = manager?.activeTab ?? null;
  if (tab === null || activeSourceTextarea() !== null) return null;
  return findReplaceViewForHost(tab.hostElement);
}

function ensureFindPanel(): FindReplacePanel {
  if (findPanel !== null) return findPanel;
  // 面板绝对定位于编辑区右上角，编辑区需为定位上下文。
  if (shell.editorArea.style.position === '') {
    shell.editorArea.style.position = 'relative';
  }
  findPanel = createFindReplacePanel(document, findPanelLabels(), {
    onQueryChange: (query) => runFindQuery(query),
    onNext: () => stepFind(1),
    onPrev: () => stepFind(-1),
    onReplace: (replacement) => runReplaceCurrent(replacement),
    onReplaceAll: (replacement) => runReplaceAll(replacement),
    onClose: () => clearFindHighlights(),
  });
  shell.editorArea.appendChild(findPanel.element);
  return findPanel;
}

function syncFindPanelStatus(total: number, active: number): void {
  findPanel?.setStatus(total, active);
}

/** 源码模式：选中命中并滚动到可见（按行数 × 行高近似滚动）。 */
function selectSourceMatch(
  ta: HTMLTextAreaElement,
  match: { start: number; end: number },
): void {
  ta.focus();
  ta.setSelectionRange(match.start, match.end);
  const lineHeight = Number.parseFloat(window.getComputedStyle(ta).lineHeight) || 20;
  const line = ta.value.slice(0, match.start).split('\n').length;
  ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

function runFindQuery(query: string): void {
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    sourceFindActive = matches.length > 0 ? 0 : -1;
    const first = matches[0];
    if (first !== undefined) selectSourceMatch(ta, first);
    syncFindPanelStatus(matches.length, sourceFindActive);
    return;
  }
  const view = activeFindView();
  if (view === null) {
    syncFindPanelStatus(0, -1);
    return;
  }
  setFindQuery(view, query);
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

function stepFind(dir: 1 | -1): void {
  const query = findPanel?.getQuery() ?? '';
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    if (matches.length === 0) {
      sourceFindActive = -1;
      syncFindPanelStatus(0, -1);
      return;
    }
    sourceFindActive = (sourceFindActive + dir + matches.length) % matches.length;
    const match = matches[sourceFindActive];
    if (match !== undefined) selectSourceMatch(ta, match);
    syncFindPanelStatus(matches.length, sourceFindActive);
    return;
  }
  const view = activeFindView();
  if (view === null) return;
  stepFindMatch(view, dir);
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

/**
 * 源码模式替换一处：选中命中后 execCommand('insertText')（保留原生 undo）；
 * insertText 触发 input 事件 → source-view 既有同步回文档。execCommand 不可用
 * 的环境回退 setRangeText + 手工 input 事件（功能正确，undo 粒度退化）。
 */
function replaceSourceRange(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function markActiveTabDirty(): void {
  const id = manager?.activeTabId ?? null;
  if (id !== null) manager.handleContentChanged(id);
}

function runReplaceCurrent(replacement: string): void {
  const query = findPanel?.getQuery() ?? '';
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    const match = matches[Math.min(Math.max(sourceFindActive, 0), matches.length - 1)];
    if (match === undefined) {
      syncFindPanelStatus(0, -1);
      return;
    }
    replaceSourceRange(ta, match.start, match.end, replacement);
    // 替换后命中重收：原下标处即下一未替换命中（收敛到范围内）。
    const next = collectSourceMatches(ta.value, query);
    sourceFindActive =
      next.length === 0
        ? -1
        : Math.min(Math.max(sourceFindActive, 0), next.length - 1);
    const current = next[sourceFindActive];
    if (current !== undefined) selectSourceMatch(ta, current);
    syncFindPanelStatus(next.length, sourceFindActive);
    markActiveTabDirty();
    return;
  }
  const view = activeFindView();
  if (view === null) return;
  if (replaceCurrentMatch(view, replacement)) {
    markActiveTabDirty();
  }
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

function runReplaceAll(replacement: string): void {
  const query = findPanel?.getQuery() ?? '';
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    // 自后向前替换，位置不被前序替换带偏；每次 insertText 均为原生可撤销步。
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      if (match !== undefined) replaceSourceRange(ta, match.start, match.end, replacement);
    }
    if (matches.length > 0) markActiveTabDirty();
    sourceFindActive = -1;
    syncFindPanelStatus(collectSourceMatches(ta.value, query).length, -1);
    return;
  }
  const view = activeFindView();
  if (view === null) return;
  const count = replaceAllMatches(view, replacement);
  if (count > 0) markActiveTabDirty();
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

function clearFindHighlights(): void {
  sourceFindActive = -1;
  const view = activeFindView();
  if (view !== null) clearFindReplace(view);
}

/** 编辑菜单「查找…」/ Ctrl+F：打开面板并把当前查询应用到活动标签。 */
function openFindPanel(): void {
  const tab = manager?.activeTab ?? null;
  if (tab === null) return;
  const panel = ensureFindPanel();
  panel.open();
  runFindQuery(panel.getQuery());
}

// Ctrl+F/Cmd+F 打开查找面板：捕获阶段接线，优先于 WebView/编辑器默认行为
//（shortcuts.ts 注册表属后续任务 scope，此处在 main.ts 独立监听）。
document.addEventListener(
  'keydown',
  (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      openFindPanel();
    }
  },
  true,
);


// 快捷键：捕获阶段注册，保存等操作在编辑器内同样生效。
const shortcuts = new ShortcutRegistry({
  new: () => void manager.newTab(),
  open: () => void manager.openFile(),
  // T6/R9：关闭活动标签，复用 closeTab 的未保存确认（与点标签关闭按钮同路径：
  // 先提交源码态编辑，再 closeTab——干净标签直关，脏标签弹三选一确认）。
  // 无活动标签时空操作。注：WebView2 可能由外壳吞掉 Ctrl+W，需真机确认；
  // 若被吞，备选组合键 Ctrl+Shift+W / Alt+W（见 task-run concerns）。
  'close-tab': () => {
    const id = manager.activeTabId;
    if (id !== null) {
      commitSourceMode(id);
      void manager.closeTab(id);
    }
  },
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
  'toggle-tabs-chrome': () => shell.toggleTabsChrome(),
  'toggle-chrome-pin': () => {
    toggleChromePinnedWithOutline();
  },
  'toggle-fullscreen': () => {
    void enterOrExitFullscreen();
  },
  'next-tab': () => cycleActiveTab(1),
  'prev-tab': () => cycleActiveTab(-1),
  'zoom-in': () => {
    fontScale.zoomIn();
  },
  'zoom-out': () => {
    fontScale.zoomOut();
  },
  'zoom-reset': () => {
    fontScale.reset();
  },
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
  const inTable = !inSource && tab.editor.isInTable();
  const items = buildEditorContextMenuItems(
    {
      hasSelection,
      hasLink,
      inSourceMode: inSource,
      inTable,
      t: (key) => i18n.t(key),
      formatShortcut: (combo) => formatShortcutLabel(combo, isMac),
    },
    {
      cut: () => runClipboardCommand('cut'),
      copy: () => runClipboardCommand('copy'),
      paste: () => runClipboardCommand('paste'),
      pastePlain: () => runClipboardCommand('paste'),
      selectAll: () => selectAllActive(),
      bold: () => tab.editor.toggleMark('strong'),
      italic: () => tab.editor.toggleMark('emphasis'),
      link: () => {
        void (async () => {
          const cursorLink = tab.editor.getLinkAtCursor() ?? link;
          const result = await showLinkDialog(document, {
            title:
              cursorLink !== null ? i18n.t('dialog.link.edit') : i18n.t('dialog.link.add'),
            initialText: cursorLink?.text ?? '',
            initialHref: cursorLink?.href ?? '',
            confirmLabel: i18n.t('dialog.link.apply'),
            labels: {
              text: i18n.t('dialog.link.textLabel'),
              textPlaceholder: i18n.t('dialog.link.textPlaceholder'),
              href: i18n.t('dialog.link.hrefLabel'),
              hrefPlaceholder: i18n.t('dialog.link.hrefPlaceholder'),
              cancel: i18n.t('dialog.cancel'),
            },
          });
          if (result !== null) {
            tab.editor.setLink(result.href, result.text);
          }
        })();
      },
      openLink: () => {
        // Right-click open: still confirm, then same classify path as Ctrl+click.
        if (link === null) return;
        void showOpenLinkConfirm(document, link.href, {
          title: i18n.t('dialog.link.openTitle'),
          message: i18n.t('dialog.link.openMessage'),
          openLabel: i18n.t('dialog.open'),
          cancelLabel: i18n.t('dialog.cancel'),
        }).then((ok) => {
          if (ok) handleLinkNavigation(link.href);
        });
      },
      copyLinkAddress: () => {
        if (link !== null) void navigator.clipboard?.writeText(link.href);
      },
      insertColLeft: () => {
        tab.editor.runTableOp('insert-col-left');
      },
      insertColRight: () => {
        tab.editor.runTableOp('insert-col-right');
      },
      insertRowAbove: () => {
        tab.editor.runTableOp('insert-row-above');
      },
      insertRowBelow: () => {
        tab.editor.runTableOp('insert-row-below');
      },
      deleteRow: () => {
        tab.editor.runTableOp('delete-row');
      },
      deleteColumn: () => {
        tab.editor.runTableOp('delete-column');
      },
      selectRow: () => {
        tab.editor.runTableOp('select-row');
      },
      selectColumn: () => {
        tab.editor.runTableOp('select-column');
      },
      deleteTable: () => {
        tab.editor.runTableOp('delete-table');
      },
    },
  );
  createContextMenu(items, { x, y });
}

function showTabContextMenu(tabId: string, x: number, y: number): void {
  const tab = manager.tabList.find((t) => t.id === tabId) ?? null;
  const hasFile = tab !== null && tab.filePath !== null;
  const items = buildTabContextMenuItems(
    { hasFile, t: (key) => i18n.t(key) },
    {
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
  // Keep tabs chrome open while the menu is up; release on every close path.
  shell.setTabsHold(true);
  createContextMenu(items, { x, y }, document, {
    onClose: () => shell.setTabsHold(false),
  });
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

/** 快捷键速查表数据源（R5）：从注册表派生标签→组合键（随语言/平台）。 */
function getShortcutBindings(): CheatBinding[] {
  return shortcuts.entries().map(({ action, combo }) => ({
    label: i18n.t(`shortcut.${action}`),
    shortcut: formatShortcutLabel(combo, isMac),
  }));
}

// R13：外部文件变更检测——窗口聚焦 + 定时（秒级）轮询活动文件 mtime。
// 检测逻辑与冲突/重载分派在 TabManager（可注入测试），这里只做时机触发。
async function pollExternalChange(): Promise<void> {
  try {
    await manager.checkActiveExternalChange();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[lightink/external-change] check failed', error);
  }
}
window.addEventListener('focus', () => {
  void pollExternalChange();
});
// 秒级轮询兜底（聚焦间隙的外部修改）；弹窗进行中由 TabManager 自身守卫跳过。
window.setInterval(() => {
  void pollExternalChange();
}, 3000);
// Tauri 窗口聚焦事件比 DOM focus 更可靠地覆盖「从其它应用切回」的场景。
void (async () => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void pollExternalChange();
    });
  } catch {
    // 非 Tauri（纯前端 dev）：仅依赖 DOM focus + 定时轮询。
  }
})();

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
    await manager.newTab(i18n.t('welcome.body'));
  }
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[lightink] bootstrap failed:', err);
});
