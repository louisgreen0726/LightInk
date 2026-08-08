/**
 * Task-list mapping helper.
 *
 * `remark-gfm` lowers `[ ]` / `[x]` task list items into MDAST `listItem`
 * nodes carrying a `checked: boolean | null` attribute and a plain-text
 * body (the `[ ]` / `[x]` marker is stripped by remark, not preserved in
 * the AST). ProseMirror task-list items (Milkdown's `task_list_item`) read
 * the same MDAST shape.
 *
 * This module exposes pure helpers so tests can verify "given `- [ ] foo`,
 * the parser yields a task-list-shaped listItem" without instantiating
 * ProseMirror.
 */

import type {
  ListItem as MdastListItem,
  Paragraph as MdastParagraph,
  Root as MdastRoot,
} from 'mdast';

import { findNode, isMdastType } from '../schema.js';

export interface NormalizedTaskItem {
  readonly checked: boolean;
  readonly text: string;
}

/**
 * Type-narrowed check: does this MDAST node have the task-list-item shape?
 *
 * `remark-gfm` adds `checked: null` to non-task list items and
 * `checked: boolean` to task items, so we test on that property rather than
 * the (long-since-stripped) bracket prefix.
 */
export function isTaskListItem(
  node: MdastListItem | unknown,
): node is MdastListItem {
  if (node === null || typeof node !== 'object') return false;
  const candidate = node as Partial<MdastListItem>;
  if (candidate.type !== 'listItem') return false;
  return typeof candidate.checked === 'boolean';
}

/**
 * Pull the checkbox status and remaining prose out of an MDAST `listItem`
 * that represents a task. Returns `null` if the node isn't a task item.
 *
 * The text body is taken from the first `paragraph > text` child; the
 * leading `[ ]` / `[x]` has already been stripped by remark.
 */
export function normalizeTaskItem(
  node: MdastListItem | unknown,
): NormalizedTaskItem | null {
  if (!isTaskListItem(node)) return null;
  if (typeof node.checked !== 'boolean') return null;
  const firstChild = node.children?.[0];
  if (firstChild === undefined || firstChild.type !== 'paragraph') {
    return { checked: node.checked, text: '' };
  }
  const paragraph = firstChild as MdastParagraph;
  const text = paragraph.children
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('')
    .trim();
  return { checked: node.checked, text };
}

/**
 * Walk a parsed MDAST tree and collect the normalized task items it contains
 * in source order. Recursively descends into `list` children so nested task
 * items are found too.
 */
export function collectTaskItems(root: MdastRoot): NormalizedTaskItem[] {
  const out: NormalizedTaskItem[] = [];
  function visit(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const obj = node as { type?: string; children?: unknown };
    if (obj.type === 'listItem') {
      const normalized = normalizeTaskItem(obj);
      if (normalized !== null) out.push(normalized);
    }
    const children = obj.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  }
  visit(root);
  return out;
}

/** Convenience wrapper around `findNode` for the first task-list item. */
export function findFirstTaskListItem(
  root: MdastRoot,
): MdastListItem | undefined {
  const found = findNode(root, (n) => isMdastType(n, 'listItem'));
  if (found === undefined || !isMdastType(found, 'listItem')) return undefined;
  return found;
}
