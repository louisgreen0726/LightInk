/**
 * `mountEditor` — the public entry point used by `src/main.ts`.
 *
 * Implementation notes (T2):
 *   - The underlying WYSIWYG engine is Milkdown v7 wired with the
 *     `commonmark` + `gfm` presets. Together they cover every R1 node kind
 *     (headings, lists, task lists, blockquote, code, tables, links, images,
 *     emphasis, strong, strikethrough, hr) without bespoke schemas.
 *   - `mountEditor` binds the caller-supplied `container` via `rootCtx` and
 *     seeds the document via `defaultValueCtx` so the editor DOM lives inside
 *     the host element and starts with `initialMarkdown` rendered.
 *   - Reading/writing markdown content goes through the live ProseMirror
 *     document via `@milkdown/utils` `getMarkdown` / `replaceAll`. A cached
 *     fallback is kept for the pre-`Created` window (e.g. headless callers
 *     that `setMarkdown` before `ready` resolves).
 *   - The returned `EditorInstance` exposes a Promise-friendly interface so
 *     the rest of the app (file IO, tabs, autosave) can plug in during
 *     later tasks.
 */

import {
  defaultValueCtx,
  Editor as MilkdownEditor,
  EditorStatus,
  rootCtx,
} from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import {
  getMarkdown as milkdownGetMarkdown,
  replaceAll,
} from '@milkdown/utils';

import { attachCursorListeners, type CursorEventBinding } from './dom-events.js';
import { codeHighlightPlugin } from './plugins/code-highlight.js';
import { clipboardMdPlugin } from './plugins/clipboard-md.js';
import { inputAssistPlugin } from './plugins/input-assist.js';
import { imageAssetPlugin, type ImageAssetMountOptions } from './plugins/image.js';
import { mathPlugin } from './plugins/math.js';
import { mermaidPlugin } from './plugins/mermaid.js';
import type { EditorInstance, MountOptions } from './types.js';

interface MountState {
  editor: MilkdownEditor | null;
  cursorBinding: CursorEventBinding | null;
  mounted: boolean;
  /** Last markdown supplied via `setMarkdown`, used as the fallback
   *  serializer source when the editor hasn't reached `Created` yet. */
  cachedMarkdown: string;
}

/** True when running under Vite's dev server (`import.meta.env.DEV`). */
function isDevEnvironment(): boolean {
  try {
    // `import.meta.env` is populated by Vite; in non-Vite runs it is
    // undefined and accessing it throws — which we swallow to mean "prod".
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

/** True when the Milkdown editor has finished creating and has a live view. */
function isCreated(state: MountState): boolean {
  return state.editor !== null && state.editor.status === EditorStatus.Created;
}

/**
 * Mount a Milkdown-backed WYSIWYG editor inside `container`.
 *
 * Returns an `EditorInstance` once the editor reaches the `Created` status.
 * If the environment cannot supply a real DOM (e.g. SSR or a Node-only
 * vitest run), `ready` rejects with a clear error so callers can fall back
 * gracefully — the pure-logic layers (`parser.ts`, `paste.ts`, `cursor.ts`)
 * do not need this entry point at all.
 */
export async function mountEditor(
  container: HTMLElement,
  options: MountOptions & ImageAssetMountOptions = {},
): Promise<EditorInstance> {
  if (
    typeof container === 'undefined' ||
    container === null ||
    typeof container.appendChild !== 'function'
  ) {
    throw new TypeError(
      'mountEditor: a DOM HTMLElement container is required',
    );
  }

  const state: MountState = {
    editor: null,
    cursorBinding: null,
    mounted: false,
    cachedMarkdown: options.initialMarkdown ?? '',
  };

  const ready = new Promise<void>((resolve, reject) => {
    try {
      const editor = MilkdownEditor.make()
        .config((ctx) => {
          // Bind the editor DOM into the caller's container (defaults to
          // document.body otherwise) and seed the document with the
          // initial markdown so the editor isn't empty on mount.
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, state.cachedMarkdown);
        })
        // R4：Typora 式配对输入 + 空列表项回车退出 + 表格 Tab。注册早于 preset，
        // 使 Enter(空列表项 lift 退出)/Tab(表格 goToNextCell) 优先于 preset keymap。
        .use(inputAssistPlugin)
        .use(commonmark)
        .use(gfm)
        .use(history)
        // T5：代码块语法高亮（highlight.js decoration 插件，见 R4）。
        .use(codeHighlightPlugin)
        // T4：Markdown 源复制 / 粘贴解析（R9）。注册于图片插件之前：clipboard-md 对
        // 非空 files（图片粘贴）直接返回 false，交 imageAssetPlugin 优先拦截。
        .use(clipboardMdPlugin)
        // T8：LaTeX 公式即时渲染（KaTeX 按需加载 + 错误隔离，见 R8）。
        .use(mathPlugin)
        // T9：mermaid 代码块即时渲染（按需加载 + 语法错误隔离，见 R9）。
        .use(mermaidPlugin);
      // T4：注入图片落盘回调时拦截粘贴/拖拽图片 → 落盘 → 插入相对引用。
      if (options.assetSaver !== undefined) {
        editor.use(
          imageAssetPlugin({
            saver: options.assetSaver,
            onError: options.onAssetError,
          }),
        );
      }
      state.editor = editor;

      editor.onStatusChange((status) => {
        if (status === EditorStatus.Created) {
          state.mounted = true;
          try {
            state.cursorBinding = attachCursorListeners(container);
          } catch (e) {
            if (isDevEnvironment()) {
              // eslint-disable-next-line no-console
              console.warn('[lightink/editor] cursor binding skipped:', e);
            }
          }
          resolve();
        }
        if (status === EditorStatus.Destroyed) {
          state.mounted = false;
        }
      });

      editor.create().catch((err: unknown) => reject(err));
    } catch (err) {
      reject(err);
    }
  });

  return {
    ready,
    setMarkdown(markdown: string): void {
      const value = typeof markdown === 'string' ? markdown : String(markdown ?? '');
      if (isCreated(state)) {
        // Replace the live ProseMirror document.
        state.editor!.action(replaceAll(value, false));
        state.cachedMarkdown = value;
      } else {
        // Editor not created yet — keep the fallback so getMarkdown still
        // returns something sensible for headless callers.
        state.cachedMarkdown = value;
      }
    },
    getMarkdown(): string {
      if (isCreated(state)) {
        const live = state.editor!.action(milkdownGetMarkdown());
        state.cachedMarkdown = live;
        return live;
      }
      return state.cachedMarkdown;
    },
    async destroy(): Promise<void> {
      try {
        if (state.cursorBinding !== null) {
          state.cursorBinding.dispose();
          state.cursorBinding = null;
        }
        const editor = state.editor;
        if (editor !== null) {
          await editor.destroy(true);
        }
      } finally {
        state.editor = null;
        state.mounted = false;
      }
    },
  };
}
