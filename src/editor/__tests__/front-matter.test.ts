/**
 * Front matter tests (T1 / R5).
 *
 * Coverage:
 *   - `extractFrontMatter` / `hasFrontMatter` pure helpers.
 *   - Regression pin for the silent-rewrite defect: a leading `---…---`
 *     block must parse as an mdast `yaml` node, never as thematicBreak +
 *     setext heading.
 *   - Pure-stack round trip via `roundTripMarkdown`: front matter block
 *     position and content survive parse → serialize unchanged.
 *   - `frontmatterNodeSchema` runners (driven with fake parser/serializer
 *     states) — the exact logic the Milkdown WYSIWYG stack executes.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode, NodeType } from '@milkdown/prose/model';
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from '@milkdown/transformer';

import {
  parseDocument,
  roundTripMarkdown,
  serializeMdastToMarkdown,
} from '../parser.js';
import {
  extractFrontMatter,
  frontmatterNodeSchema,
  hasFrontMatter,
} from '../plugins/front-matter.js';

const FM_DOC = [
  '---',
  'title: hello',
  'tags:',
  '  - a',
  '  - b',
  '---',
  '',
  '# Body',
  '',
  'Some text.',
  '',
].join('\n');

describe('extractFrontMatter', () => {
  it('extracts the leading YAML block verbatim', () => {
    const fm = extractFrontMatter(FM_DOC);
    expect(fm).not.toBeNull();
    expect(fm!.value).toBe('title: hello\ntags:\n  - a\n  - b');
  });

  it('returns null when there is no front matter', () => {
    expect(extractFrontMatter('# Just a heading\n')).toBeNull();
    expect(extractFrontMatter('before\n\n---\n\nafter\n')).toBeNull();
    expect(extractFrontMatter('')).toBeNull();
  });

  it('hasFrontMatter mirrors extraction', () => {
    expect(hasFrontMatter(FM_DOC)).toBe(true);
    expect(hasFrontMatter('# Body\n')).toBe(false);
  });
});

describe('front matter parse (regression pin)', () => {
  it('parses the leading block as a yaml node, not hr + setext heading', () => {
    const parsed = parseDocument(FM_DOC);
    const types = parsed.root.children.map((child) => child.type);
    expect(types[0]).toBe('yaml');
    expect(types).not.toContain('thematicBreak');
    // `title: hello` must not be reinterpreted as a setext heading.
    expect(parsed.root.children.filter((c) => c.type === 'heading')).toHaveLength(1);
  });
});

describe('front matter round trip (pure stack)', () => {
  it('keeps block position and content unchanged', () => {
    const out = roundTripMarkdown(FM_DOC);
    // Front matter stays at the top with verbatim content.
    expect(out.startsWith('---\ntitle: hello\ntags:\n  - a\n  - b\n---\n')).toBe(true);
    // Body survives intact.
    expect(out).toContain('# Body');
    expect(out).toContain('Some text.');
  });

  it('is idempotent — a second round trip changes nothing', () => {
    const once = roundTripMarkdown(FM_DOC);
    expect(roundTripMarkdown(once)).toBe(once);
  });

  it('reparses serialized output as a yaml node again', () => {
    const reparsed = parseDocument(roundTripMarkdown(FM_DOC));
    expect(reparsed.root.children[0]?.type).toBe('yaml');
  });

  it('leaves documents without front matter untouched in structure', () => {
    const md = '# Title\n\nbefore\n\n---\n\nafter\n';
    const out = serializeMdastToMarkdown(parseDocument(md).root);
    const reparsed = parseDocument(out);
    const types = reparsed.root.children.map((c) => c.type);
    // remark-stringify emits `***` for thematic breaks (avoids ambiguity with
    // front matter fences); either marker must reparse as thematicBreak.
    expect(types).toContain('thematicBreak');
    expect(types[0]).not.toBe('yaml');
  });
});

describe('frontmatterNodeSchema runners', () => {
  it('parseMarkdown runner adds a frontmatter node carrying the raw value', () => {
    const added: Array<{ type: unknown; attrs: unknown }> = [];
    const fakeState = {
      addNode: (type: unknown, attrs: unknown) => {
        added.push({ type, attrs });
      },
    } as unknown as ParserState;
    const proseType = { name: 'frontmatter' } as NodeType;
    const yamlNode = { type: 'yaml', value: 'title: x' } as MarkdownNode;

    const schema = frontmatterNodeSchema();
    expect(schema.parseMarkdown.match(yamlNode)).toBe(true);
    expect(schema.parseMarkdown.match({ type: 'paragraph' } as MarkdownNode)).toBe(false);
    schema.parseMarkdown.runner(fakeState, yamlNode, proseType);

    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe(proseType);
    expect(added[0]!.attrs).toEqual({ value: 'title: x' });
  });

  it('toMarkdown runner emits a yaml node with the stored value', () => {
    const added: Array<{ type: string; value: unknown }> = [];
    const fakeState = {
      addNode: (type: string, _children: unknown, value: unknown) => {
        added.push({ type, value });
      },
    } as unknown as SerializerState;
    const pmNode = {
      type: { name: 'frontmatter' },
      attrs: { value: 'title: x' },
    } as unknown as PMNode;

    const schema = frontmatterNodeSchema();
    expect(schema.toMarkdown.match(pmNode)).toBe(true);
    schema.toMarkdown.runner(fakeState, pmNode);

    expect(added).toEqual([{ type: 'yaml', value: 'title: x' }]);
  });

  it('toMarkdown match ignores other node types', () => {
    const schema = frontmatterNodeSchema();
    const paragraph = { type: { name: 'paragraph' }, attrs: {} } as unknown as PMNode;
    expect(schema.toMarkdown.match(paragraph)).toBe(false);
  });

  it('toDOM renders a pre.lightink-frontmatter with the raw value', () => {
    const schema = frontmatterNodeSchema();
    const pmNode = {
      type: { name: 'frontmatter' },
      attrs: { value: 'title: x' },
    } as unknown as PMNode;
    const dom = schema.toDOM!(pmNode) as unknown as [string, Record<string, string>, string];
    expect(dom[0]).toBe('pre');
    expect(dom[1]['data-type']).toBe('frontmatter');
    expect(dom[1]['class']).toBe('lightink-frontmatter');
    expect(dom[2]).toBe('title: x');
  });
});
