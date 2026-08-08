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
  editorViewCtx,
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
import { toggleMark } from '@milkdown/prose/commands';

import { attachCursorListeners, type CursorEventBinding } from './dom-events.js';
import { codeHighlightPlugin } from './plugins/code-highlight.js';
import { clipboardMdPlugin } from './plugins/clipboard-md.js';
import { formatToolbarPlugin } from './plugins/format-toolbar.js';
import { linkNavigationPlugin } from './link-navigation.js';
import { inputAssistPlugin } from './plugins/input-assist.js';
import { imageAssetPlugin, type ImageAssetMountOptions } from './plugins/image.js';
import { mathPlugin } from './plugins/math.js';
import { mermaidPlugin } from './plugins/mermaid.js';
import { slashMenuPlugin } from './plugins/slash-menu.js';
import type { EditorView } from '@milkdown/prose/view';
import type { Mark } from '@milkdown/prose/model';
import type { CursorLink, EditorInstance, MountOptions, SelectionSummary } from './types.js';

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

/** 取得底层 ProseMirror EditorView（编辑器未就绪或异常时返回 null）。 */
function getView(state: MountState): EditorView | null {
  if (!isCreated(state)) return null;
  try {
    return state.editor!.action((ctx) => ctx.get(editorViewCtx));
  } catch {
    return null;
  }
}

/**
 * 解析指定文档位置处的链接（R3/R7/R14）。取该位置的 link mark，并向前/向后
 * 展开到该 mark 覆盖的完整文本范围，返回 href 与链接文本；无链接返回 null。
 * 供「光标处链接」(resolveCursorLink) 与「右键坐标处链接」(getLinkAtPoint) 共用。
 */
function resolveLinkAt(view: EditorView, pos: number): CursorLink | null {
  const $pos = view.state.doc.resolve(pos);
  const link = $pos.marks().find((mark: Mark) => mark.type.name === 'link');
  if (link === undefined) return null;
  const href = typeof link.attrs['href'] === 'string' ? (link.attrs['href'] as string) : '';
  const doc = view.state.doc;
  const same = (mark: Mark): boolean =>
    mark.type === link.type && mark.attrs['href'] === link.attrs['href'];
  let from = pos;
  while (from > 0 && doc.resolve(from - 1).marks().some(same)) {
    from -= 1;
  }
  let to = pos;
  while (to < doc.content.size && doc.resolve(to).marks().some(same)) {
    to += 1;
  }
  const text = doc.textBetween(from, to, '');
  return { href, text };
}

/** 解析文本光标处的链接（R7/R3）。 */
function resolveCursorLink(view: EditorView): CursorLink | null {
  return resolveLinkAt(view, view.state.selection.from);
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
        // T5：选中文字浮出格式工具条（R7）。
        .use(formatToolbarPlugin)
        // T6：行首斜杠快速插入菜单（R11），元素集合与 R2 插入菜单同源。
        .use(slashMenuPlugin)
        // T4：Markdown 源复制 / 粘贴解析（R9）。注册于图片插件之前：clipboard-md 对
        // 非空 files（图片粘贴）直接返回 false，交 imageAssetPlugin 优先拦截。
        .use(clipboardMdPlugin)
        // T8：LaTeX 公式即时渲染（KaTeX 按需加载 + 错误隔离，见 R8）。
        .use(mathPlugin)
        // T9：mermaid 代码块即时渲染（按需加载 + 语法错误隔离，见 R9）。
        .use(mermaidPlugin);
      // T14：文档链接点击跳转（R14）。注入回调时拦截单击 link mark。
      if (options.onLinkNavigate !== undefined) {
        editor.use(linkNavigationPlugin({ onLinkNavigate: options.onLinkNavigate }));
      }
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
    getSelection(): SelectionSummary | null {
      const view = getView(state);
      if (view === null) return null;
      const { from, to, empty } = view.state.selection;
      return { from, to, empty };
    },
    getLinkAtCursor(): CursorLink | null {
      const view = getView(state);
      if (view === null) return null;
      return resolveCursorLink(view);
    },
    getLinkAtPoint(x: number, y: number): CursorLink | null {
      // R3 右键链接：按右键坐标（clientX/clientY）解析文档位置再查 link mark，
      // 而非文本光标位置（左键链接已触发 R14 跳转，光标几乎不在链接上）。
      // posAtCoords 用法与 src/editor/plugins/image.ts 落点定位一致。
      const view = getView(state);
      if (view === null) return null;
      const coords = view.posAtCoords({ left: x, top: y });
      if (coords === null) return null;
      return resolveLinkAt(view, coords.pos);
    },
    toggleMark(markName: string): void {
      const view = getView(state);
      if (view === null) return;
      const markType = view.state.schema.marks[markName];
      if (markType === undefined) return;
      toggleMark(markType)(view.state, (tr) => view.dispatch(tr));
    },
    setLink(href: string): void {
      const view = getView(state);
      if (view === null) return;
      const linkType = view.state.schema.marks['link'];
      if (linkType === undefined) return;
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.addMark(from, to, linkType.create({ href })));
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
