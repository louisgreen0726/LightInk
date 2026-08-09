/**
 * Progressive Select-All (Mod-a):
 *   Outside tables:
 *     1st → current textblock / code_block
 *     2nd → entire document
 *   Inside tables (extra layer before document):
 *     1st → current cell content
 *     2nd → entire table (CellSelection)
 *     3rd → entire document
 *
 * Matches block-editor UX (Notion / ProseKit) and Typora/Obsidian table habits:
 * never jump straight from a cell to full-document markdown selection.
 *
 * @see https://prosekit.dev/concepts/commands/
 * @see https://support.typora.io/Table-Editing/
 */

import { $prose } from '@milkdown/utils';
import { AllSelection, Plugin, TextSelection } from '@milkdown/prose/state';
import type { Command, EditorState, Transaction } from '@milkdown/prose/state';
import { selectAll as pmSelectAll } from '@milkdown/prose/commands';
import {
  CellSelection,
  isInTable,
  selectionCell,
  TableMap,
} from '@milkdown/prose/tables';

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
 * Absolute cell positions for the table that contains the selection.
 * Returns null when not inside a table.
 */
export function currentTableCellBounds(
  state: EditorState,
): { anchor: number; head: number; tableStart: number } | null {
  if (!isInTable(state)) return null;
  let $cell;
  try {
    $cell = selectionCell(state);
  } catch {
    return null;
  }
  if ($cell === null || $cell === undefined) return null;
  const table = $cell.node(-1);
  const map = TableMap.get(table);
  if (map.width <= 0 || map.height <= 0) return null;
  const tableStart = $cell.start(-1);
  const anchor = tableStart + map.positionAt(0, 0, table);
  const head = tableStart + map.positionAt(map.height - 1, map.width - 1, table);
  return { anchor, head, tableStart };
}

/** True when every cell of the enclosing table is selected. */
export function isWholeTableSelected(state: EditorState): boolean {
  if (!(state.selection instanceof CellSelection)) return false;
  const bounds = currentTableCellBounds(state);
  if (bounds === null) return false;
  const sel = state.selection;
  try {
    const table = sel.$anchorCell.node(-1);
    const map = TableMap.get(table);
    const tableStart = sel.$anchorCell.start(-1);
    const rect = map.rectBetween(
      sel.$anchorCell.pos - tableStart,
      sel.$headCell.pos - tableStart,
    );
    return rect.left === 0 && rect.top === 0 && rect.right === map.width && rect.bottom === map.height;
  } catch {
    return false;
  }
}

/** Apply a CellSelection covering the whole enclosing table. */
export function selectWholeTable(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const bounds = currentTableCellBounds(state);
  if (bounds === null) return false;
  if (dispatch) {
    try {
      const sel = CellSelection.create(state.doc, bounds.anchor, bounds.head);
      dispatch(state.tr.setSelection(sel).scrollIntoView());
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Progressive select-all command:
 * - In table: cell text → whole table → document
 * - Elsewhere: current block → document
 */
export const progressiveSelectAll: Command = (state, dispatch) => {
  if (isFullDocumentSelection(state)) {
    // Already all — keep selectAll semantics (idempotent).
    return pmSelectAll(state, dispatch);
  }

  const inTable = isInTable(state);

  // Table path: if the whole table is already selected → expand to document.
  if (inTable && isWholeTableSelected(state)) {
    return pmSelectAll(state, dispatch);
  }

  // Table path: cell/row/col selection (or full cell text) → select whole table.
  if (inTable) {
    const range = currentTextblockRange(state);
    const cellTextFullySelected =
      range !== null && selectionCoversRange(state, range);
    const hasCellSelection = state.selection instanceof CellSelection;

    // Step 1: still inside a cell with partial/no text selection → select cell text.
    if (!hasCellSelection && range !== null && !cellTextFullySelected) {
      if (dispatch) {
        const sel = TextSelection.create(state.doc, range.from, range.to);
        dispatch(state.tr.setSelection(sel).scrollIntoView());
      }
      return true;
    }

    // Step 2: cell text fully selected, or any CellSelection that is not whole table
    // → expand to whole table (not the whole document).
    return selectWholeTable(state, dispatch);
  }

  // Non-table: textblock first, then document.
  const range = currentTextblockRange(state);
  if (range !== null && !selectionCoversRange(state, range)) {
    if (dispatch) {
      const sel = TextSelection.create(state.doc, range.from, range.to);
      dispatch(state.tr.setSelection(sel).scrollIntoView());
    }
    return true;
  }

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
