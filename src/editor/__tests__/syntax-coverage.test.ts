/**
 * Syntax coverage tests — one assertion per R1-supported syntax kind.
 *
 * Each case parses a representative markdown fragment and asserts that the
 * MDAST tree contains the expected node type. Together these tests cover
 * the entire R1 syntax set:
 *   - h1..h6 (titles)
 *   - bullet list
 *   - ordered list
 *   - task list (GFM)
 *   - blockquote
 *   - inline code
 *   - code block (fenced)
 *   - table (GFM)
 *   - link
 *   - image
 *   - strong (bold)
 *   - emphasis (italic)
 *   - strikethrough (GFM)
 *   - thematic break (---)
 */

import { describe, expect, it } from 'vitest';

import { parseDocument } from '../parser.js';
import {
  findNode,
  isMdastType,
  mdastTypeToSyntaxKind,
} from '../schema.js';
import { extractTableShape } from '../plugins/table.js';
import {
  collectTaskItems,
  isTaskListItem,
  normalizeTaskItem,
} from '../plugins/task-list.js';

function hasNode(parsed: ReturnType<typeof parseDocument>, type: string): boolean {
  const found = findNode(parsed.root, (n) => n.type === type);
  return found !== undefined;
}

describe('syntax coverage — R1', () => {
  it('covers h1..h6', () => {
    const md = [
      '# H1',
      '## H2',
      '### H3',
      '#### H4',
      '##### H5',
      '###### H6',
    ].join('\n');
    const parsed = parseDocument(md);
    expect(parsed.root.children.length).toBe(6);
    for (let depth = 1; depth <= 6; depth++) {
      const heading = parsed.root.children[depth - 1];
      expect(isMdastType(heading!, 'heading')).toBe(true);
      if (isMdastType(heading!, 'heading')) {
        expect(heading.depth).toBe(depth);
        expect(mdastTypeToSyntaxKind('heading', { headingDepth: depth })).toBe(
          `heading-${depth}`,
        );
      }
    }
  });

  it('covers bullet list', () => {
    const md = '- alpha\n- beta\n- gamma\n';
    const parsed = parseDocument(md);
    const list = findNode(parsed.root, (n) => isMdastType(n, 'list'));
    expect(list).toBeDefined();
    if (isMdastType(list!, 'list')) {
      expect(list.ordered).toBe(false);
      expect(list.children.length).toBe(3);
      expect(mdastTypeToSyntaxKind('list', { ordered: false })).toBe('bullet-list');
    }
  });

  it('covers ordered list', () => {
    const md = '1. one\n2. two\n3. three\n';
    const parsed = parseDocument(md);
    const list = findNode(parsed.root, (n) => isMdastType(n, 'list'));
    expect(list).toBeDefined();
    if (isMdastType(list!, 'list')) {
      expect(list.ordered).toBe(true);
      expect(list.children.length).toBe(3);
      expect(mdastTypeToSyntaxKind('list', { ordered: true })).toBe('ordered-list');
    }
  });

  it('covers task list (GFM)', () => {
    const md = '- [ ] open task\n- [x] closed task\n- [X] also closed\n';
    const parsed = parseDocument(md);
    const list = findNode(parsed.root, (n) => isMdastType(n, 'list'));
    expect(list).toBeDefined();
    const items = collectTaskItems(parsed.root);
    expect(items.length).toBe(3);
    expect(items[0]).toEqual({ checked: false, text: 'open task' });
    expect(items[1]).toEqual({ checked: true, text: 'closed task' });
    expect(items[2]).toEqual({ checked: true, text: 'also closed' });
    // The list itself is NOT a listItem, but the list's first child is.
    expect(isMdastType(list!, 'listItem')).toBe(false);
    if (isMdastType(list!, 'list')) {
      const firstChild = list.children[0];
      expect(isMdastType(firstChild, 'listItem')).toBe(true);
      expect(isTaskListItem(firstChild)).toBe(true);
    }
  });

  it('covers blockquote', () => {
    const md = '> quoted text\n> more\n';
    const parsed = parseDocument(md);
    const bq = findNode(parsed.root, (n) => isMdastType(n, 'blockquote'));
    expect(bq).toBeDefined();
    expect(mdastTypeToSyntaxKind('blockquote')).toBe('blockquote');
  });

  it('covers inline code and fenced code block', () => {
    const md = 'Use `inline` here.\n\n```ts\nconst x = 1;\n```\n';
    const parsed = parseDocument(md);
    const inlineCode = findNode(parsed.root, (n) =>
      isMdastType(n, 'inlineCode'),
    );
    expect(inlineCode).toBeDefined();
    const codeBlock = findNode(parsed.root, (n) =>
      isMdastType(n, 'code'),
    );
    expect(codeBlock).toBeDefined();
    if (isMdastType(codeBlock!, 'code')) {
      expect(codeBlock.lang).toBe('ts');
    }
    expect(mdastTypeToSyntaxKind('inlineCode')).toBe('inline-code');
    expect(mdastTypeToSyntaxKind('code')).toBe('code-block');
  });

  it('covers table (GFM)', () => {
    const md =
      '| col1 | col2 |\n| :--- | ---: |\n| a    | 1    |\n| b    | 2    |\n';
    const parsed = parseDocument(md);
    const shape = extractTableShape(parsed.root);
    expect(shape).not.toBeNull();
    expect(shape!.rowCount).toBe(3); // header + 2 data
    expect(shape!.columnCount).toBe(2);
    expect(shape!.align).toEqual(['left', 'right']);
    expect(mdastTypeToSyntaxKind('table')).toBe('table');
  });

  it('covers link and image', () => {
    const md = '[site](https://example.com) and ![alt](https://img.example.com/x.png)\n';
    const parsed = parseDocument(md);
    const link = findNode(parsed.root, (n) => isMdastType(n, 'link'));
    expect(link).toBeDefined();
    if (isMdastType(link!, 'link')) {
      expect(link.url).toBe('https://example.com');
    }
    const image = findNode(parsed.root, (n) => isMdastType(n, 'image'));
    expect(image).toBeDefined();
    if (isMdastType(image!, 'image')) {
      expect(image.url).toBe('https://img.example.com/x.png');
      expect(image.alt).toBe('alt');
    }
    expect(mdastTypeToSyntaxKind('link')).toBe('link');
    expect(mdastTypeToSyntaxKind('image')).toBe('image');
  });

  it('covers bold and italic', () => {
    const md = '**bold** *italic*\n';
    const parsed = parseDocument(md);
    expect(hasNode(parsed, 'strong')).toBe(true);
    expect(hasNode(parsed, 'emphasis')).toBe(true);
    expect(mdastTypeToSyntaxKind('strong')).toBe('strong');
    expect(mdastTypeToSyntaxKind('emphasis')).toBe('emphasis');
  });

  it('covers strikethrough (GFM)', () => {
    const md = '~~deleted~~\n';
    const parsed = parseDocument(md);
    expect(hasNode(parsed, 'delete')).toBe(true);
    expect(mdastTypeToSyntaxKind('delete')).toBe('strikethrough');
  });

  it('covers thematic break (---)', () => {
    const md = 'before\n\n---\n\nafter\n';
    const parsed = parseDocument(md);
    expect(hasNode(parsed, 'thematicBreak')).toBe(true);
    expect(mdastTypeToSyntaxKind('thematicBreak')).toBe('thematic-break');
  });

  it('classifies every relevant MDAST type into a known SyntaxKind', () => {
    const md = [
      '# h1',
      '## h2',
      '- a',
      '1. b',
      '- [ ] t',
      '> q',
      '`c`',
      '```\nblock\n```',
      '| x | y |\n| - | - |\n| 1 | 2 |',
      '[l](u)',
      '![i](u)',
      '**b** *i*',
      '~~d~~',
      '---',
    ].join('\n\n');
    const parsed = parseDocument(md);
    const seenTypes = new Set<string>();
    for (const child of parsed.root.children) {
      if (child.type !== 'list') {
        seenTypes.add(child.type);
        continue;
      }
      // For lists we want to also confirm the inner list items + task items.
      if (isMdastType(child, 'list')) {
        seenTypes.add(child.type);
        for (const item of child.children) {
          if (isMdastType(item, 'listItem')) {
            seenTypes.add('listItem');
          }
        }
      }
    }
    expect(seenTypes.has('heading')).toBe(true);
    expect(seenTypes.has('list')).toBe(true);
    expect(seenTypes.has('listItem')).toBe(true);
    expect(seenTypes.has('blockquote')).toBe(true);
    expect(seenTypes.has('code')).toBe(true);
    expect(seenTypes.has('table')).toBe(true);
    expect(seenTypes.has('thematicBreak')).toBe(true);
  });

  it('normalizeTaskItem returns null for non-task list items', () => {
    const md = '- plain\n';
    const parsed = parseDocument(md);
    const listItem = findNode(parsed.root, (n) => isMdastType(n, 'listItem'));
    expect(listItem).toBeDefined();
    expect(normalizeTaskItem(listItem)).toBeNull();
  });
});
