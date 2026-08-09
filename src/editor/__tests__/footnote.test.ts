/**
 * Footnote tests (T1 / R4).
 *
 * Coverage:
 *   - `collectFootnotes` / `extractFootnotes` pairing references with
 *     definitions, in order of first reference.
 *   - `footnoteDisplayNumber` superscript numbering.
 *   - Pure-stack round trip: `[^id]` references and `[^id]: …` definitions
 *     survive parse → serialize. (The WYSIWYG stack performs the same
 *     round trip via preset-gfm's footnote_reference / footnote_definition
 *     schemas, which render superscript references and bottom definitions.)
 */

import { describe, expect, it } from 'vitest';

import { parseDocument, roundTripMarkdown } from '../parser.js';
import {
  collectFootnotes,
  extractFootnotes,
  footnoteDisplayNumber,
  hasFootnotes,
} from '../plugins/footnote.js';

const FOOTNOTE_DOC = [
  'First note[^a] and second[^b], then again[^a].',
  '',
  '[^b]: the second definition',
  '',
  '[^a]: the first definition',
  '',
].join('\n');

describe('extractFootnotes / collectFootnotes', () => {
  it('pairs references with definitions in first-reference order', () => {
    const entries = extractFootnotes(FOOTNOTE_DOC);
    expect(entries.map((e) => e.identifier)).toEqual(['a', 'b']);

    const a = entries[0]!;
    expect(a.referenceCount).toBe(2);
    expect(a.hasDefinition).toBe(true);
    expect(a.definitionText).toBe('the first definition');

    const b = entries[1]!;
    expect(b.referenceCount).toBe(1);
    expect(b.hasDefinition).toBe(true);
    expect(b.definitionText).toBe('the second definition');
  });

  it('leaves references without a definition as literal text (GFM semantics)', () => {
    // micromark-extension-gfm-footnote only tokenizes `[^id]` when a matching
    // definition exists; otherwise the source degrades to plain text — which
    // is also the documented failure mode (no content is ever dropped).
    const parsed = parseDocument('Dangling ref[^nope].\n');
    const paragraph = parsed.root.children[0]!;
    expect(paragraph.type).toBe('paragraph');
    expect(
      (paragraph as { children: Array<{ type: string }> }).children.every(
        (child) => child.type === 'text',
      ),
    ).toBe(true);
    expect(extractFootnotes('Dangling ref[^nope].\n')).toHaveLength(0);
  });

  it('appends orphan definitions after referenced footnotes', () => {
    const md = 'Used[^u].\n\n[^u]: used def\n\n[^orphan]: never referenced\n';
    const entries = extractFootnotes(md);
    expect(entries.map((e) => e.identifier)).toEqual(['u', 'orphan']);
    expect(entries[1]!.referenceCount).toBe(0);
    expect(entries[1]!.hasDefinition).toBe(true);
    expect(entries[1]!.definitionText).toBe('never referenced');
  });

  it('hasFootnotes gates on any reference or definition', () => {
    expect(hasFootnotes(FOOTNOTE_DOC)).toBe(true);
    expect(hasFootnotes('plain text\n')).toBe(false);
  });
});

describe('footnoteDisplayNumber', () => {
  it('numbers by order of first reference, 1-based', () => {
    const entries = extractFootnotes(FOOTNOTE_DOC);
    expect(footnoteDisplayNumber(entries, 'a')).toBe(1);
    expect(footnoteDisplayNumber(entries, 'b')).toBe(2);
    expect(footnoteDisplayNumber(entries, 'missing')).toBeNull();
  });
});

describe('footnote round trip (pure stack)', () => {
  it('keeps references and definitions recognizable after serialize', () => {
    const out = roundTripMarkdown(FOOTNOTE_DOC);
    expect(out).toContain('[^a]');
    expect(out).toContain('[^a]: the first definition');
    expect(out).toContain('[^b]: the second definition');
  });

  it('is idempotent — a second round trip changes nothing', () => {
    const once = roundTripMarkdown(FOOTNOTE_DOC);
    expect(roundTripMarkdown(once)).toBe(once);
  });

  it('reparse of serialized output yields the same footnote structure', () => {
    const reparsed = parseDocument(roundTripMarkdown(FOOTNOTE_DOC));
    const entries = collectFootnotes(reparsed.root);
    expect(entries.map((e) => e.identifier)).toEqual(['a', 'b']);
    expect(entries[0]!.referenceCount).toBe(2);
    expect(entries.every((e) => e.hasDefinition)).toBe(true);
  });
});
