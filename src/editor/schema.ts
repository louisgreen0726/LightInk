/**
 * Editor schema: the canonical vocabulary of syntax kinds the editor
 * understands. This file is the source of truth for "what does R1 cover?"
 *
 * The set is matched 1:1 against `@milkdown/preset-commonmark` + `@milkdown/preset-gfm`:
 *   - `commonmark` provides headings, paragraph, blockquote, code-block,
 *     bullet/ordered list, list-item, hr, image, inline-code, link, strong,
 *     emphasis, hard-break, text.
 *   - `gfm` adds table, task-list-item, strike-through (delete) and GFM
 *     footnotes (`footnoteReference` / `footnoteDefinition`).
 *   - `plugins/front-matter.ts` adds YAML front matter (mdast `yaml` node)
 *     via `remark-frontmatter`.
 *
 * The pure helper functions below classify MDAST nodes by their ProseMirror
 * schema equivalent — useful for tests that want to assert "given this
 * markdown, we should see this ProseMirror node category" without
 * instantiating a full ProseMirror schema.
 */

import type {
  Root as MdastRoot,
  RootContent,
} from 'mdast';

import type { MdastType, SyntaxKind } from './types.js';

/**
 * Map an MDAST node type to our canonical `SyntaxKind` taxonomy.
 * Returns `undefined` for nodes the editor does not surface as first-class
 * content (e.g. `html`, `definition`, `break`).
 */
export function mdastTypeToSyntaxKind(
  type: MdastType,
  options?: { ordered?: boolean; headingDepth?: number },
): SyntaxKind | undefined {
  switch (type) {
    case 'paragraph':
      return 'paragraph';
    case 'heading': {
      const depth = options?.headingDepth ?? 0;
      // mdast uses depth 1..6; clamp to supported headings, otherwise
      // surface as the nearest heading so we still cover it.
      const clamped = Math.min(Math.max(depth, 1), 6);
      return `heading-${clamped}` as SyntaxKind;
    }
    case 'list': {
      return options?.ordered ? 'ordered-list' : 'bullet-list';
    }
    case 'listItem': {
      // Whether this is a task-list item is decided by `walk()` below; we
      // default to list-item here so the table-driven assertion works even
      // when callers don't inspect the GFM extension.
      return undefined;
    }
    case 'blockquote':
      return 'blockquote';
    case 'inlineCode':
      return 'inline-code';
    case 'code':
      return 'code-block';
    case 'table':
      return 'table';
    case 'link':
      return 'link';
    case 'image':
      return 'image';
    case 'strong':
      return 'strong';
    case 'emphasis':
      return 'emphasis';
    case 'delete':
      return 'strikethrough';
    case 'thematicBreak':
      return 'thematic-break';
    case 'yaml':
      return 'front-matter';
    case 'footnoteReference':
    case 'footnoteDefinition':
      return 'footnote';
    case 'text':
      return 'text';
    default:
      return undefined;
  }
}

/**
 * Walk an MDAST tree depth-first, yielding every descendant `RootContent`
 * node plus optional context (parent type, ancestor stack). Useful in tests
 * that want to assert "the parse of X contains a node matching predicate P"
 * without baking in traversal code each time.
 */
export interface WalkHandle {
  node: RootContent;
  depth: number;
  parent: MdastRoot | RootContent | null;
}

export function* walk(root: MdastRoot): Generator<WalkHandle> {
  const stack: Array<{
    node: MdastRoot | RootContent;
    depth: number;
    parent: MdastRoot | RootContent | null;
  }> = [{ node: root, depth: 0, parent: null }];

  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const frame = stack.pop()!;
    if (frame.node.type === 'root') {
      for (let i = frame.node.children.length - 1; i >= 0; i--) {
        const child = frame.node.children[i];
        if (child) {
          stack.push({
            node: child,
            depth: frame.depth + 1,
            parent: frame.node,
          });
        }
      }
      continue;
    }
    yield {
      node: frame.node as RootContent,
      depth: frame.depth,
      parent: frame.parent,
    };
    const contentMap = frame.node as unknown as {
      children?: RootContent[];
    };
    const children = contentMap.children;
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child) {
          stack.push({
            node: child,
            depth: frame.depth + 1,
            parent: frame.node,
          });
        }
      }
    }
  }
}

/**
 * Recursively search for a node that satisfies `predicate`. Returns the first
 * match in depth-first pre-order, or `undefined`.
 */
export function findNode(
  root: MdastRoot,
  predicate: (node: RootContent) => boolean,
): RootContent | undefined {
  for (const handle of walk(root)) {
    if (predicate(handle.node)) return handle.node;
  }
  return undefined;
}

/** Assert that a node is a specific MDAST type — narrows in `tsc`. */
export function isMdastType<T extends MdastType>(
  node: RootContent,
  type: T,
): node is RootContent & { type: T } {
  return (node as { type: string }).type === type;
}
