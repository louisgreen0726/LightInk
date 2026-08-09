/**
 * `content-change` — WYSIWYG 文档变更广播（壳层字数栏 / 脏标记 / 查找计数）。
 *
 * 仅靠宿主 `input` 会漏掉：Milkdown `insert()` 粘贴、部分 PM 事务、菜单插入等。
 * 本插件在 EditorView.update 中检测 `doc` 引用变化后通知订阅者，作为可靠事实源。
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

export const CONTENT_CHANGE_PLUGIN_KEY = new PluginKey('lightink-content-change');

export type ContentChangeListener = (view: EditorView) => void;

const listeners = new Set<ContentChangeListener>();

/** 订阅任意标签的 WYSIWYG 文档变更；返回取消订阅函数。 */
export function subscribeContentChange(listener: ContentChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(view: EditorView): void {
  for (const listener of listeners) {
    try {
      listener(view);
    } catch {
      // 壳层监听器异常不影响编辑器。
    }
  }
}

export function createContentChangePlugin(): Plugin {
  return new Plugin({
    key: CONTENT_CHANGE_PLUGIN_KEY,
    view(editorView) {
      let lastDoc = editorView.state.doc;
      return {
        update(view) {
          if (view.state.doc === lastDoc) return;
          lastDoc = view.state.doc;
          emit(view);
        },
      };
    },
  });
}

/** Milkdown 注册入口。 */
export const contentChangePlugin = $prose(() => createContentChangePlugin());
