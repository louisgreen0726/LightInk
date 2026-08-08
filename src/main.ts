/**
 * 应用入口（T3 临时接线）。
 *
 * 创建 TabManager，启动时新建一个标签，并提供最简的 新建/打开/保存/
 * 另存为 按钮与标签条。正式 UI 在 T6/T11 交付，这里只保证 T3 的
 * 文件管理与多标签能力真实可用。
 */

import { ask, confirm } from '@tauri-apps/plugin-dialog';

import { mountEditor } from './editor/index.js';
import { TabManager } from './tabs/tab-manager.js';
import type { CloseChoice } from './tabs/types.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('LightInk: #app root container not found in index.html');
}

const toolbar = document.createElement('div');
toolbar.id = 'lightink-toolbar';
const tabBar = document.createElement('div');
tabBar.id = 'lightink-tabbar';
const editorArea = document.createElement('div');
editorArea.id = 'lightink-editor-area';
app.replaceChildren(toolbar, tabBar, editorArea);

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

const manager = new TabManager({
  mountEditor,
  createHostElement: (tabId) => {
    const el = document.createElement('div');
    el.className = 'lightink-tab-host';
    el.dataset.tabId = tabId;
    return el;
  },
  attachHost: (el) => {
    editorArea.appendChild(el);
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
});

function renderTabBar(): void {
  tabBar.replaceChildren(
    ...manager.tabList.map((tab) => {
      const btn = document.createElement('button');
      btn.className = 'lightink-tab';
      if (tab.id === manager.activeTabId) {
        btn.classList.add('active');
      }
      btn.textContent = tab.dirty ? `● ${tab.title}` : tab.title;
      btn.addEventListener('click', () => manager.switchTab(tab.id));
      const close = document.createElement('span');
      close.textContent = ' ×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        void manager.closeTab(tab.id);
      });
      btn.appendChild(close);
      return btn;
    }),
  );
}

function addToolbarButton(label: string, onClick: () => void): void {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  toolbar.appendChild(btn);
}

addToolbarButton('新建', () => void manager.newTab());
addToolbarButton('打开', () => void manager.openFile());
addToolbarButton('保存', () => void manager.saveActiveTab());
addToolbarButton('另存为', () => {
  const id = manager.activeTabId;
  if (id !== null) {
    void manager.saveTabAs(id);
  }
});

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
