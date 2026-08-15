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
    expect(mdastTypeToSyntaxKind('heading', { headingDepth: 3 })).toBe('heading-3');
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
});
