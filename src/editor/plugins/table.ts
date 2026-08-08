/**
 * Table mapping helper.
 *
 * Bridging MDAST's `table` / `tableRow` / `tableCell` nodes to ProseMirror
 * `table` nodes (added by `@milkdown/preset-gfm`) is mostly native — the
 * renderer in `index.ts` wires the preset — but unit tests want a way to
 * verify "a parse of a markdown table yields the right MDAST shape" without
 * having to spin up ProseMirror.
 */

import type { Root as MdastRoot } from 'mdast';
import { findNode, isMdastType } from '../schema.js';

export interface TableShape {
  readonly align: ReadonlyArray<'left' | 'right' | 'center' | null>;
  readonly rowCount: number;
  readonly columnCount: number;
}

/** Extract a `TableShape` summary from an MDAST tree, or `null` if none. */
export function extractTableShape(root: MdastRoot): TableShape | null {
  const tableNode = findNode(root, (n) => isMdastType(n, 'table'));
  if (tableNode === undefined) return null;
  if (!isMdastType(tableNode, 'table')) return null;
  const alignRaw = tableNode.align ?? [];
  const align = alignRaw.map((value) =>
    value === 'left' || value === 'right' || value === 'center' || value === null
      ? value
      : null,
  );
  let rowCount = 0;
  let columnCount = 0;
  for (const child of tableNode.children) {
    if (child.type !== 'tableRow') continue;
    rowCount += 1;
    if (child.children.length > columnCount) {
      columnCount = child.children.length;
    }
  }
  return { align, rowCount, columnCount };
}
