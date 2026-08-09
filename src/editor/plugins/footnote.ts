/**
 * Footnote support (T1 / R4).
 *
 * The WYSIWYG node/mark rendering for footnotes is provided by
 * `@milkdown/preset-gfm`, which already ships:
 *   - `footnote_reference` — inline atom rendered as a superscript
 *     (`<sup data-type="footnote_reference">`), serialized back to `[^id]`;
 *   - `footnote_definition` — block node rendered as a definition entry
 *     (`<dl><dt>label</dt><dd>…</dd></dl>`), serialized back to `[^id]: …`.
 * and registers `remark-gfm` (which includes GFM footnotes) on Milkdown's
 * internal remark instance. The pure parser stack (`parser.ts`) registers
 * the same `remark-gfm`, so both stacks parse `[^id]` references and
 * `[^id]: …` definitions into identical mdast nodes.
 *
 * This module owns the headless-testable helper layer used by tests and by
 * any UI that needs to reason about footnotes (e.g. numbering references by
 * order of first appearance, detecting orphan definitions/references):
 *
 *     extractFootnotes(markdown)        — source → ordered footnote entries
 *     collectFootnotes(root)            — mdast root → ordered entries
 *     footnoteDisplayNumber(list, id)   — 1-based number in reference order
 *     hasFootnotes(markdown)            — cheap boolean gate
 *
 * Failure mode (per technical solution §3): if anything above throws on
 * malformed input, callers should degrade to literal text — the underlying
 * mdast/PM nodes keep the raw source, so no content is lost.
 */

import type { Root as MdastRoot } from 'mdast';

import { parseMarkdownToMdast } from '../parser.js';
import { walk } from '../schema.js';

/** One logical footnote: its identifier, reference count, and definition. */
export interface FootnoteEntry {
  /** Normalized identifier (what `[^id]` and `[^id]:` share). */
  readonly identifier: string;
  /** Display label as authored (defaults to the identifier). */
  readonly label: string;
  /** How many `[^id]` references appear in the document body. */
  readonly referenceCount: number;
  /** Whether a matching `[^id]: …` definition exists. */
  readonly hasDefinition: boolean;
  /** Definition body as plain text (empty string when undefined). */
  readonly definitionText: string;
}

interface MdastNodeLike {
  type: string;
  identifier?: string;
  label?: string;
  value?: string;
  children?: MdastNodeLike[];
}

/** Recursively collect the plain-text content of an mdast subtree. */
function plainText(node: MdastNodeLike): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(plainText).join('');
}

/**
 * Walk an mdast tree and pair footnote references with their definitions.
 * Entries are ordered by first reference appearance in the document body;
 * definitions without any reference are appended afterwards in document
 * order (they still round-trip, and the entry flags them via
 * `referenceCount === 0`).
 */
export function collectFootnotes(root: MdastRoot): FootnoteEntry[] {
  const byIdentifier = new Map<
    string,
    {
      label: string;
      referenceCount: number;
      definitionText: string | null;
    }
  >();
  const order: string[] = [];
  const orphanDefinitions: string[] = [];

  for (const handle of walk(root)) {
    const node = handle.node as unknown as MdastNodeLike;
    if (node.type === 'footnoteReference') {
      const identifier = node.identifier ?? '';
      const existing = byIdentifier.get(identifier);
      if (existing === undefined) {
        byIdentifier.set(identifier, {
          label: node.label ?? identifier,
          referenceCount: 1,
          definitionText: null,
        });
        order.push(identifier);
      } else {
        existing.referenceCount += 1;
      }
    } else if (node.type === 'footnoteDefinition') {
      const identifier = node.identifier ?? '';
      const text = plainText(node);
      const existing = byIdentifier.get(identifier);
      if (existing === undefined) {
        byIdentifier.set(identifier, {
          label: node.label ?? identifier,
          referenceCount: 0,
          definitionText: text,
        });
        orphanDefinitions.push(identifier);
      } else {
        existing.definitionText = text;
      }
    }
  }

  return [...order, ...orphanDefinitions].map((identifier) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const entry = byIdentifier.get(identifier)!;
    return {
      identifier,
      label: entry.label,
      referenceCount: entry.referenceCount,
      hasDefinition: entry.definitionText !== null,
      definitionText: entry.definitionText ?? '',
    };
  });
}

/** Parse markdown and return its footnotes (see `collectFootnotes`). */
export function extractFootnotes(markdown: string): FootnoteEntry[] {
  return collectFootnotes(parseMarkdownToMdast(markdown));
}

/** Whether the markdown contains any footnote reference or definition. */
export function hasFootnotes(markdown: string): boolean {
  return extractFootnotes(markdown).length > 0;
}

/**
 * 1-based display number for a footnote identifier, following the order of
 * first reference (matching the `collectFootnotes` ordering used to render
 * superscripts). Returns null for unknown identifiers.
 */
export function footnoteDisplayNumber(
  entries: readonly FootnoteEntry[],
  identifier: string,
): number | null {
  const index = entries.findIndex((entry) => entry.identifier === identifier);
  return index === -1 ? null : index + 1;
}
