/**
 * `content-change` — WYSIWYG 文档变更广播（壳层字数栏 / 脏标记 / 查找计数）。
 *
 * 仅靠宿主 `input` 会漏掉：Milkdown `insert()` 粘贴、部分 PM 事务、菜单插入等。
 * 本插件在 EditorView.update 中检测 `doc` 引用变化后通知订阅者，作为可靠事实源。
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
export const CONTENT_CHANGE_PLUGIN_KEY = new PluginKey('lightink-content-change');

export type ContentChangeListener = () => void;

export function createContentChangePlugin(listener?: ContentChangeListener): Plugin {
  return new Plugin({
    key: CONTENT_CHANGE_PLUGIN_KEY,
    view(editorView) {
      let lastDoc = editorView.state.doc;
      return {
        update(view) {
          if (view.state.doc === lastDoc) return;
          lastDoc = view.state.doc;
          try {
            listener?.();
          } catch {
            // A shell callback must not break the editor update cycle.
          }
        },
      };
    },
  });
}

/** Milkdown 注册入口。 */
export function contentChangePlugin(listener?: ContentChangeListener) {
  return $prose(() => createContentChangePlugin(listener));
}
