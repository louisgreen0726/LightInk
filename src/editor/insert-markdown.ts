/**
 * Structured markdown insertion into a live ProseMirror view.
 *
 * Milkdown's `replaceRange` builds a loosely-open Slice via DOM round-trip, which
 * often lands multi-line snippets (tables, lists, fences) as plain text inside the
 * current paragraph. These helpers parse markdown and replace a **whole textblock**
 * (slash line / empty parent) with block content (openStart/openEnd = 0).
 */

import type { Node as PMNode } from '@milkdown/prose/model';
import { Fragment, Slice } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { TextSelection } from '@milkdown/prose/state';

/** Milkdown parser: markdown string → PM doc (or null/undefined on failure). */
export type MarkdownParser = (markdown: string) => PMNode | null | undefined;

/**
 * Expand [from, to] so a block-level snippet replaces the enclosing textblock
 * when the range sits at the start of that block (slash menu / line-start insert).
 * Falls back to the original range when not inside a textblock.
 */
export function expandToTextblockRange(
  doc: PMNode,
  from: number,
  to: number,
): { from: number; to: number } {
  const max = doc.content.size;
  const safeFrom = Math.max(0, Math.min(from, max));
  const safeTo = Math.max(safeFrom, Math.min(to, max));
  try {
    const $from = doc.resolve(safeFrom);
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d).isTextblock) {
        const blockStart = $from.start(d);
        // Only expand when the replace starts at the textblock content start
        // (line-start slash / empty paragraph insert). Mid-line keeps the range.
        if (safeFrom === blockStart) {
          return { from: $from.before(d), to: $from.after(d) };
        }
        return { from: safeFrom, to: safeTo };
      }
    }
  } catch {
    // resolve can throw on extreme positions; keep original range.
  }
  return { from: safeFrom, to: safeTo };
}

/**
 * Replace [from, to] with parsed markdown blocks. Returns false if parse fails
 * or the range is invalid.
 */
export function replaceRangeWithMarkdown(
  view: EditorView,
  from: number,
  to: number,
  markdown: string,
  parse: MarkdownParser,
): boolean {
  const text = typeof markdown === 'string' ? markdown : '';
  if (text.trim() === '') return false;
  let parsed: PMNode | null | undefined;
  try {
    parsed = parse(text);
  } catch {
    return false;
  }
  if (parsed === null || parsed === undefined || parsed.content.size === 0) {
    return false;
  }

  const range = expandToTextblockRange(view.state.doc, from, to);
  const slice = new Slice(Fragment.from(parsed.content), 0, 0);
  try {
    let tr = view.state.tr.replace(range.from, range.to, slice);
    // Place caret at end of inserted content when possible.
    const insertEnd = Math.min(tr.doc.content.size, range.from + slice.content.size);
    try {
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertEnd), -1));
    } catch {
      // keep default selection from replace
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert markdown at the current selection.
 * - Empty textblock / line-start: replace that textblock with structured blocks.
 * - Non-empty selection: replace selection (block-closed slice).
 * - Mid-line empty caret: insert after the enclosing block (keeps typed prefix).
 */
export function insertMarkdownAtSelection(
  view: EditorView,
  markdown: string,
  parse: MarkdownParser,
): boolean {
  const { from, to, empty, $from } = view.state.selection;
  if (empty && $from.parent.isTextblock) {
    if ($from.parentOffset === 0) {
      // Empty or line-start: replace the whole textblock.
      return replaceRangeWithMarkdown(view, $from.before(), $from.after(), markdown, parse);
    }
    // Mid-line: insert after the current block so tables/lists don't smash the paragraph.
    return replaceRangeWithMarkdown(view, $from.after(), $from.after(), markdown, parse);
  }
  // Non-empty selection: replace selection only.
  return replaceRangeWithMarkdown(view, from, to, markdown, parse);
}
