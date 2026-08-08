/**
 * Pure markdown parser. Wraps `unified` + `remark-parse` + `remark-gfm` so the
 * rest of the editor (paste handler, "convert source → render" toggle, AI
 * document ingestion) can ingest markdown without dragging the Milkdown
 * `Editor` instance along — and crucially, so unit tests can run in plain
 * Node via vitest without a DOM/WebView.
 *
 * The choice of `remark-gfm` matches `@milkdown/preset-gfm`, which wraps the
 * same plugin internally; the two parsers produce identical MDAST trees for
 * CommonMark + GFM input. Only Markdown spec changes upstream would diverge.
 */

import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root as MdastRoot } from 'mdast';

import type { ParsedDocument } from './types.js';

/** Get (and cache) a configured `unified` processor instance. */
let cachedProcessor: Processor<MdastRoot> | null = null;

export function getProcessor(): Processor<MdastRoot> {
  if (cachedProcessor === null) {
    const built = unified()
      .use(remarkParse)
      .use(remarkGfm) as Processor<MdastRoot>;
    cachedProcessor = built.freeze();
  }
  return cachedProcessor;
}

/** Reset the cached processor — exposed for tests only. */
export function __resetProcessorCacheForTests(): void {
  cachedProcessor = null;
}

/** Parse a markdown string to MDAST. Throws on malformed input. */
export function parseMarkdownToMdast(source: string): MdastRoot {
  if (typeof source !== 'string') {
    throw new TypeError(
      `parseMarkdownToMdast: expected string, got ${typeof source}`,
    );
  }
  const processor = getProcessor();
  const tree = processor.parse(source) as MdastRoot;
  return tree;
}

/**
 * Parse a markdown string and wrap it with the metadata the editor uses
 * (source, MDAST root, word count, character count). This is the main entry
 * point used by paste handlers, file loaders, and tests.
 */
export function parseDocument(source: string): ParsedDocument {
  const root = parseMarkdownToMdast(source);
  const wordCount = countWords(source);
  return {
    source,
    root,
    wordCount,
    charCount: source.length,
  };
}

/**
 * Count whitespace-separated word tokens in a markdown source. This is a
 * rough heuristic — it does not strip markdown syntax — but for the
 * "万字级文档" perf check we just need a stable size proxy.
 */
export function countWords(source: string): number {
  if (!source.length) return 0;
  // Strip fenced code blocks for a more representative "prose" count
  // before tokenizing on whitespace.
  const stripped = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

/** Walk every MDAST node in a tree and return its `type` field. */
export function collectMdastTypes(root: MdastRoot): string[] {
  const out: string[] = [];
  type QueueItem = { type?: string; children?: unknown };
  const queue: QueueItem[] = [root as unknown as QueueItem];
  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined) continue;
    if (typeof frame.type === 'string') out.push(frame.type);
    const children = frame.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child !== null && typeof child === 'object') {
          queue.push(child as QueueItem);
        }
      }
    }
  }
  return out;
}
