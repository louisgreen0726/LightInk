/**
 * 应用入口（T6 正式极简外壳）。
 *
 * 组装顺序：主题服务（默认护眼浅色/深色切换/自定义主题注入槽）→
 * 极简外壳（src/ui/app-shell：命令行 + 标签栏 + 编辑区）→ TabManager
 * （接线保持 T3 语义不变：宿主元素、崩溃快照、恢复流程）→ 快捷键注册。
 */

import { invoke } from '@tauri-apps/api/core';
import { ask, confirm, save } from '@tauri-apps/plugin-dialog';

import { mountEditor } from './editor/index.js';
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
import { createAppShell } from './ui/app-shell.js';
import { ShortcutRegistry } from './ui/shortcuts.js';
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
  },
};

const shell = createAppShell(app, {
  onNew: () => void manager.newTab(),
  onOpen: () => void manager.openFile(),
  onSave: () => void manager.saveActiveTab(),
  onSaveAs: saveActiveAs,
  onToggleTheme: () => {
    themeService.toggle();
  },
  onExportHtml: () => void exportActiveTabHtml(exportDeps),
  onExportPdf: () => void exportActiveTabPdf(exportDeps),
});

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
  shell.renderTabBar(manager.tabList, manager.activeTabId, {
    onSwitch: (id) => manager.switchTab(id),
    onClose: (id) => void manager.closeTab(id),
  });
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
  onActiveContentChanged: () => outline.scheduleRefresh(),
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

// 快捷键：捕获阶段注册，保存等操作在编辑器内同样生效。
const shortcuts = new ShortcutRegistry({
  new: () => void manager.newTab(),
  open: () => void manager.openFile(),
  save: () => void manager.saveActiveTab(),
  'save-as': saveActiveAs,
  'toggle-theme': () => {
    themeService.toggle();
  },
});
shortcuts.attach(document);

async function bootstrap(): Promise<void> {
  // 先恢复崩溃遗留的未命名草稿，再决定是否新建初始标签。
  const restored = await manager.recoverUntitledDrafts();
  if (restored.length === 0 && manager.tabList.length === 0) {
    await manager.newTab('# 轻墨 LightInk\n\n开始书写。\n');
  }
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[lightink] bootstrap failed:', err);
});
