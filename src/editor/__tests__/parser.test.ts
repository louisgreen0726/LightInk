/**
 * Parser smoke tests. These are the lowest-level unit tests for `parser.ts`:
 * given a markdown string, the parser produces an MDAST tree whose
 * `root.children` count and `type` distribution match expectations.
 */

import { describe, expect, it } from 'vitest';

import {
  collectMdastTypes,
  countWords,
  parseDocument,
  parseMarkdownToMdast,
} from '../parser.js';
import { findNode, isMdastType, mdastTypeToSyntaxKind } from '../schema.js';
import { extractTableShape } from '../plugins/table.js';
import {
  collectTaskItems,
  isTaskListItem,
  normalizeTaskItem,
} from '../plugins/task-list.js';

describe('parser', () => {
  it('parses an empty document to a root-only MDAST', () => {
    const tree = parseMarkdownToMdast('');
    expect(tree.type).toBe('root');
    expect(tree.children.length).toBe(0);
  });

  it('returns a ParsedDocument wrapper with metadata', () => {
    const parsed = parseDocument('# 标题\n\n这是一段文字。\n');
    expect(parsed.source).toBe('# 标题\n\n这是一段文字。\n');
    expect(parsed.root.type).toBe('root');
    expect(parsed.wordCount).toBeGreaterThan(0);
    expect(parsed.charCount).toBeGreaterThan(0);
    expect(parsed.charCount).toBe(parsed.source.length);
  });

  it('collects MDAST types breadth-first', () => {
    const tree = parseMarkdownToMdast('# a\n\nb');
    const types = collectMdastTypes(tree);
    expect(types[0]).toBe('root');
    // first-level children + at least one text node
    expect(types).toContain('paragraph');
    expect(types).toContain('heading');
    expect(types).toContain('text');
  });

  it('findNode locates a node by predicate', () => {
    const tree = parseMarkdownToMdast('hi\n\n# found');
    const heading = findNode(tree, (n) => isMdastType(n, 'heading'));
    expect(heading).toBeDefined();
    expect(isMdastType(heading!, 'heading')).toBe(true);
  });

  it('rejects non-string inputs', () => {
    // @ts-expect-error: testing the runtime guard
    expect(() => parseMarkdownToMdast(undefined)).toThrow(TypeError);
    // @ts-expect-error: testing the runtime guard
    expect(() => parseMarkdownToMdast(123)).toThrow(TypeError);
  });

  it('countWords ignores fenced code blocks', () => {
    const withFence = 'hello world\n\n```\nlorem ipsum dolor sit amet\n```\n\nbye';
    const total = countWords(withFence);
    expect(total).toBeGreaterThanOrEqual(3); // hello, world, bye
    // Fence contents should not be counted.
    expect(total).toBeLessThan(8);
  });

  it('classifies every relevant MDAST type into a known SyntaxKind', () => {
    for (let depth = 1; depth <= 6; depth++) {
      expect(mdastTypeToSyntaxKind('heading', { headingDepth: depth })).toBe(`heading-${depth}`);
    }
    // clamp 边界：depth 0/undefined → heading-1，depth >6 → heading-6。
    expect(mdastTypeToSyntaxKind('heading', { headingDepth: 0 })).toBe('heading-1');
    expect(mdastTypeToSyntaxKind('heading', { headingDepth: 7 })).toBe('heading-6');
    expect(mdastTypeToSyntaxKind('heading', {})).toBe('heading-1');
    expect(mdastTypeToSyntaxKind('list', { ordered: false })).toBe('bullet-list');
    expect(mdastTypeToSyntaxKind('list', { ordered: true })).toBe('ordered-list');
    expect(mdastTypeToSyntaxKind('blockquote')).toBe('blockquote');
    expect(mdastTypeToSyntaxKind('inlineCode')).toBe('inline-code');
    expect(mdastTypeToSyntaxKind('code')).toBe('code-block');
    expect(mdastTypeToSyntaxKind('table')).toBe('table');
    expect(mdastTypeToSyntaxKind('link')).toBe('link');
    expect(mdastTypeToSyntaxKind('image')).toBe('image');
    expect(mdastTypeToSyntaxKind('strong')).toBe('strong');
    expect(mdastTypeToSyntaxKind('emphasis')).toBe('emphasis');
    expect(mdastTypeToSyntaxKind('delete')).toBe('strikethrough');
    expect(mdastTypeToSyntaxKind('thematicBreak')).toBe('thematic-break');
    expect(mdastTypeToSyntaxKind('yaml')).toBe('front-matter');
    expect(mdastTypeToSyntaxKind('footnoteReference')).toBe('footnote');
  });

  it('extracts GFM table shape (row/column/alignment)', () => {
    const parsed = parseDocument('| col1 | col2 |\n| :--- | ---: |\n| a    | 1    |\n| b    | 2    |\n');
    const shape = extractTableShape(parsed.root);
    expect(shape).not.toBeNull();
    expect(shape!.rowCount).toBe(3);
    expect(shape!.columnCount).toBe(2);
    expect(shape!.align).toEqual(['left', 'right']);
  });

  it('collects and normalizes task list items', () => {
    const parsed = parseDocument('- [ ] open\n- [x] done\n');
    const items = collectTaskItems(parsed.root);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ checked: false, text: 'open' });
    expect(items[1]).toEqual({ checked: true, text: 'done' });
    const plain = parseDocument('- plain\n');
    const listItem = findNode(plain.root, (n) => isMdastType(n, 'listItem'));
    expect(isTaskListItem(listItem)).toBe(false);
    expect(normalizeTaskItem(listItem)).toBeNull();
  });

  it('parses a 10k-char mixed-syntax document within a lenient cold-load budget', () => {
    const lines = ['# 万字级', '', '段落含 **加粗**、*斜体*、`行内码` 与 [链接](https://x)。'];
    lines.push('- 列表项', '- [x] 任务', '');
    lines.push('| a | b |', '| - | - |', '| 1 | 2 |', '');
    lines.push('```ts', 'const x = 1;', '```', '', '---', '');
    while (lines.join('\n').length < 10_000) {
      lines.push('重复负载段落，用于达到万字级文档规模。');
    }
    const doc = lines.join('\n');
    const start = Date.now();
    const parsed = parseDocument(doc);
    const elapsedMs = Date.now() - start;
    expect(doc.length).toBeGreaterThan(8_000);
    expect(parsed.root.children.length).toBeGreaterThan(5);
    expect(parsed.wordCount).toBeGreaterThan(50);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('keeps heap growth bounded for repeated parses', () => {
    const nodeProcess = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } })
      .process;
    if (nodeProcess === undefined || typeof nodeProcess.memoryUsage !== 'function') {
      return;
    }
    const doc = '# 万字级\n\n' + '重复负载段落，用于达到万字级文档规模。'.repeat(500);
    const before = nodeProcess.memoryUsage().heapUsed;
    for (let i = 0; i < 5; i++) {
      parseDocument(doc);
    }
    const after = nodeProcess.memoryUsage().heapUsed;
    const deltaMb = (after - before) / 1024 / 1024;
    expect(deltaMb).toBeLessThan(40);
  });
});
