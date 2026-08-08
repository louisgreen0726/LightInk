/**
 * Paste handler tests — R10.
 *
 * Verifies that the markdown paste pipeline correctly recognizes AI-style
 * markdown (with code blocks, tables, multi-level headings) and dispatches
 * it through the parser. The "AI-generated markdown" fixture is a realistic
 * multi-section document with every R1 node kind; one full paste → render
 * roundtrip should yield a tree that contains every node type.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPastePayload,
  looksLikeMarkdown,
  payloadHasStructuredBlocks,
} from '../paste.js';
import { collectMdastTypes } from '../parser.js';

const AI_MARKDOWN = [
  '# 项目总结',
  '',
  '## 概述',
  '',
  '本项目实现一个 **轻量级 Markdown 编辑器**。',
  '',
  '## 关键能力',
  '',
  '- 所见即所得编辑',
  '- 支持 *CommonMark + GFM*',
  '- [官方仓库](https://example.com/repo)',
  '![架构图](https://example.com/architecture.png "alt architecture")',
  '',
  '### 任务清单',
  '',
  '- [x] 完成解析器',
  '- [x] 完成粘贴管线',
  '- [ ] 性能压测',
  '',
  '## 技术栈',
  '',
  '| 模块 | 语言 | 状态 |',
  '| --- | --- | --- |',
  '| 前端 | TypeScript | 进行中 |',
  '| 后端 | Rust | 已完成 |',
  '| 编辑内核 | Milkdown | 已完成 |',
  '',
  '## 示例代码',
  '',
  '```ts',
  'import { mountEditor } from "./editor";',
  'const host = document.querySelector("#app")!;',
  'mountEditor(host, { initialMarkdown: "# hello" });',
  '```',
  '',
  '> 注意：所有路径均为相对路径。',
  '',
  '---',
  '',
  '~~旧版已弃用~~ → 新版见上。',
].join('\n');

describe('paste — markdown detection', () => {
  it('treats AI markdown as markdown', () => {
    expect(looksLikeMarkdown(AI_MARKDOWN)).toBe(true);
  });

  it('treats prose as plain text', () => {
    const prose =
      'Hello, world. This is just a normal sentence without any markdown syntax at all.';
    expect(looksLikeMarkdown(prose)).toBe(false);
  });

  it('detects every R1 marker class', () => {
    expect(looksLikeMarkdown('# heading\n')).toBe(true);
    expect(looksLikeMarkdown('- bullet\n')).toBe(true);
    expect(looksLikeMarkdown('1. ordered\n')).toBe(true);
    expect(looksLikeMarkdown('- [ ] task\n')).toBe(true);
    expect(looksLikeMarkdown('> quote\n')).toBe(true);
    expect(looksLikeMarkdown('```\nblock\n```\n')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n| - | - |\n')).toBe(true);
    expect(looksLikeMarkdown('[link](url)\n')).toBe(true);
    expect(looksLikeMarkdown('![image](url)\n')).toBe(true);
    expect(looksLikeMarkdown('~~strike~~\n')).toBe(true);
    expect(looksLikeMarkdown('---\n')).toBe(true);
    expect(looksLikeMarkdown('**strong**\n')).toBe(true); // via link heuristic if short
    expect(looksLikeMarkdown('*emph*\n')).toBe(true);
  });

  it('returns false for empty input', () => {
    expect(looksLikeMarkdown('')).toBe(false);
  });
});

describe('paste — payload construction', () => {
  it('builds a markdown payload for AI markdown with a pre-parsed tree', () => {
    const payload = buildPastePayload(AI_MARKDOWN);
    expect(payload.kind).toBe('markdown');
    expect(payload.text).toBe(AI_MARKDOWN);
    expect(payload.parsed).toBeDefined();
    if (payload.parsed) {
      expect(payload.parsed.root.type).toBe('root');
      expect(payload.parsed.charCount).toBe(AI_MARKDOWN.length);
    }
  });

  it('builds a plain payload for prose', () => {
    const prose =
      'Just talking. No markdown markers anywhere in here.';
    const payload = buildPastePayload(prose);
    expect(payload.kind).toBe('plain');
    expect(payload.parsed).toBeUndefined();
  });

  it('payloadHasStructuredBlocks is true for AI markdown', () => {
    const payload = buildPastePayload(AI_MARKDOWN);
    expect(payloadHasStructuredBlocks(payload)).toBe(true);
  });

  it('a single heading alone has structured blocks (heading counts)', () => {
    const md = '# only\n';
    const payload = buildPastePayload(md);
    expect(payload.kind).toBe('markdown');
    // A single heading does count as "structured": heading != paragraph/text.
    expect(payloadHasStructuredBlocks(payload)).toBe(true);
  });

  it('AI markdown produces a tree containing all R1 syntax categories', () => {
    const payload = buildPastePayload(AI_MARKDOWN);
    expect(payload.kind).toBe('markdown');
    expect(payload.parsed).toBeDefined();
    if (payload.parsed) {
      const types = collectMdastTypes(payload.parsed.root);
      const expectTypes = [
        'heading',
        'paragraph',
        'list',
        'listItem',
        'blockquote',
        'code',
        'table',
        'tableRow',
        'tableCell',
        'link',
        'image',
        'strong',
        'emphasis',
        'delete',
        'thematicBreak',
      ];
      for (const expected of expectTypes) {
        expect(types).toContain(expected);
      }
    }
  });

  it('paste does not mutate input text', () => {
    const original = AI_MARKDOWN;
    buildPastePayload(original);
    expect(AI_MARKDOWN).toBe(original);
  });
});
