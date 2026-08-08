/**
 * `mountEditor` — the public entry point used by `src/main.ts`.
 *
 * Implementation notes (T2):
 *   - The underlying WYSIWYG engine is Milkdown v7 wired with the
 *     `commonmark` + `gfm` presets. Together they cover every R1 node kind
 *     (headings, lists, task lists, blockquote, code, tables, links, images,
 *     emphasis, strong, strikethrough, hr) without bespoke schemas.
 *   - Reading/writing markdown content is delegated to the downstream
 *     `@milkdown/transformer` + `@milkdown/plugin-history` combo via
 *     `editor.action(ctx => ...)`. Until those plugins land in a later
 *     task, `getMarkdown`/`setMarkdown` fall back to the call-supplied
 *     `initialMarkdown` so the API surface stays stable.
 *   - The returned `EditorInstance` exposes a Promise-friendly interface so
 *     the rest of the app (file IO, tabs, autosave) can plug in during
 *     later tasks.
 */

import { Editor as MilkdownEditor, EditorStatus } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';

import { attachCursorListeners, type CursorEventBinding } from './dom-events.js';
import type { EditorInstance, MountOptions } from './types.js';

interface MountState {
  editor: MilkdownEditor | null;
  cursorBinding: CursorEventBinding | null;
  mounted: boolean;
  /** Last markdown supplied via `setMarkdown`, used as the fallback
   *  serializer source until the transformer plugin is wired up. */
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
  options: MountOptions = {},
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
        .use(commonmark)
        .use(gfm);
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

  function dispatchMarkdown(action: (current: string) => string): string {
    const previous = state.cachedMarkdown;
    const next = action(previous);
    state.cachedMarkdown = next;
    return next;
  }

  return {
    ready,
    setMarkdown(markdown: string): void {
      const value = typeof markdown === 'string' ? markdown : String(markdown ?? '');
      dispatchMarkdown(() => value);
    },
    getMarkdown(): string {
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
