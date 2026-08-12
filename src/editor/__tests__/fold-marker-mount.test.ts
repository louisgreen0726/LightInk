// @vitest-environment jsdom

/**
 * 回归：新打开的文件（mountEditor + initialMarkdown）必须渲染折叠三角。
 *
 * 背景：Milkdown commonmark 的 heading id 插件在挂载时为缺 id 的标题
 * setNodeMarkup（replaceAround structure 事务），DecorationSet.map 会把
 * heading-fold 插件 init 挂在标题内部的三角 widget decoration 全部丢弃；
 * 该事务不经本插件 view 的 update，防抖重建不会触发，三角永久缺失（只能在
 * 大纲点一次折叠强制重建后才出现）。修复：view 挂载即排一次兜底防抖刷新。
 */
import { describe, expect, it } from 'vitest';

import { FOLD_REBUILD_DEBOUNCE_MS } from '../plugins/heading-fold.js';
import { mountEditor } from '../index.js';

/** 等待超过防抖窗口，让挂载兜底刷新完成。 */
function waitForMountRefresh(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FOLD_REBUILD_DEBOUNCE_MS * 2));
}

describe('折叠三角挂载渲染（回归）', () => {
  it('新挂载的编辑器为每个标题渲染折叠三角（无需先折叠一次）', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = await mountEditor(host, {
      initialMarkdown: '# A\n\npara one\n\n## B\n\npara two\n',
    });
    await editor.ready;
    await waitForMountRefresh();
    expect(host.querySelectorAll('.lightink-fold-marker').length).toBe(2);
    await editor.destroy();
    host.remove();
  });
});
