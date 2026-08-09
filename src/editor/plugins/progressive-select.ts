/**
 * Progressive Select-All (Mod-a):
 *   1st press → select current textblock / code_block content
 *   2nd press → select entire document
 *
 * Matches block-editor UX (Notion / ProseKit preferBlockSelection) and
 * note-app code-fence behaviour (Joplin Better Code Blocks).
 *
 * @see https://prosekit.dev/concepts/commands/
 * @see https://www.notion.com/help/keyboard-shortcuts
 */

import { $prose } from '@milkdown/utils';
import { AllSelection, Plugin, TextSelection } from '@milkdown/prose/state';
import type { Command, EditorState } from '@milkdown/prose/state';
import { selectAll as pmSelectAll } from '@milkdown/prose/commands';

/**
 * Range covering the textblock that contains the selection anchors.
 * For multi-block selections, covers from start of first block to end of last.
 * Returns null when no textblock can be resolved.
 */
export function currentTextblockRange(
  state: EditorState,
): { from: number; to: number } | null {
  const { $from, $to } = state.selection;

  // Prefer code_block / any textblock depth.
  const fromDepth = textblockDepth($from);
  const toDepth = textblockDepth($to);
  if (fromDepth === null || toDepth === null) {
    return null;
  }
  const from = $from.start(fromDepth);
  const to = $to.end(toDepth);
  if (from >= to && state.doc.textContent.length === 0) {
    return null;
  }
  return { from, to };
}

function textblockDepth($pos: {
  depth: number;
  node: (d: number) => { isTextblock: boolean };
}): number | null {
  for (let d = $pos.depth; d > 0; d -= 1) {
    if ($pos.node(d).isTextblock) {
      return d;
    }
  }
  // depth 0 is doc — not a textblock
  return null;
}

/** True when selection already fully covers the given range. */
export function selectionCoversRange(
  state: EditorState,
  range: { from: number; to: number },
): boolean {
  const { from, to } = state.selection;
  return from <= range.from && to >= range.to;
}

/** True when selection is already the whole document (AllSelection or full span). */
export function isFullDocumentSelection(state: EditorState): boolean {
  if (state.selection instanceof AllSelection) {
    return true;
  }
  const { from, to } = state.selection;
  // TextSelection cannot include the outer doc tokens the way AllSelection does;
  // treat near-full text span as "already all" for progressive step 2.
  return from <= 1 && to >= state.doc.content.size;
}

/**
 * Progressive select-all command:
 * - If current block is not fully selected → select that block.
 * - Else → select whole document.
 */
export const progressiveSelectAll: Command = (state, dispatch) => {
  if (isFullDocumentSelection(state)) {
    // Already all — keep selectAll semantics (idempotent).
    return pmSelectAll(state, dispatch);
  }

  const range = currentTextblockRange(state);
  if (range !== null && !selectionCoversRange(state, range)) {
    if (dispatch) {
      const sel = TextSelection.create(state.doc, range.from, range.to);
      dispatch(state.tr.setSelection(sel).scrollIntoView());
    }
    return true;
  }

  // Block already fully selected (or no textblock) → expand to document.
  return pmSelectAll(state, dispatch);
};

/** Milkdown plugin: bind Mod-a to progressive select-all. */
export const progressiveSelectPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          const isModA =
            (event.key === 'a' || event.key === 'A') &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey;
          if (!isModA) {
            return false;
          }
          const handled = progressiveSelectAll(view.state, view.dispatch.bind(view));
          if (handled) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    }),
);
