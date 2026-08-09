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
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';
import type { Root as MdastRoot } from 'mdast';

import type { ParsedDocument } from './types.js';

/**
 * Get (and cache) a configured `unified` processor instance.
 *
 * Plugin parity with the Milkdown stack (T1 / R4-R5):
 *   - `remark-gfm` matches `@milkdown/preset-gfm` (which registers the same
 *     plugin internally, including GFM footnotes `[^id]`).
 *   - `remark-frontmatter` matches the `remarkFrontmatter` plugin registered
 *     in `plugins/front-matter.ts`, so YAML front matter parses to a `yaml`
 *     node here too instead of being misread as `---` + setext heading.
 *   - `remark-stringify` adds a compiler so `serializeMdastToMarkdown` can
 *     verify pure-stack round-trips without a DOM. It does not affect
 *     `parse` output.
 */
let cachedProcessor: Processor<
  MdastRoot,
  undefined,
  undefined,
  MdastRoot,
  string
> | null = null;

export function getProcessor(): Processor<
  MdastRoot,
  undefined,
  undefined,
  MdastRoot,
  string
> {
  if (cachedProcessor === null) {
    const built = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter)
      .use(remarkStringify);
    cachedProcessor = built.freeze();
  }
  return cachedProcessor;
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
 * Serialize an MDAST tree back to markdown using the same plugin set as
 * parsing (GFM + front matter). Used by round-trip tests and any pure-stack
 * caller that needs "parse → transform → save" without a Milkdown editor.
 */
export function serializeMdastToMarkdown(root: MdastRoot): string {
  return getProcessor().stringify(root);
}

/**
 * Parse a markdown string, serialize it back, and return the result. This is
 * the pure-stack round trip — the WYSIWYG stack performs the equivalent via
 * Milkdown's remark instance (see `plugins/front-matter.ts`).
 */
export function roundTripMarkdown(source: string): string {
  return serializeMdastToMarkdown(parseMarkdownToMdast(source));
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
