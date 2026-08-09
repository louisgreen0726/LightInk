/**
 * YAML front matter plugin (T1 / R5).
 *
 * Problem being fixed: without a front-matter remark extension, a leading
 * `---\ntitle: …\n---` block is parsed by micromark as a thematic break plus
 * a setext heading. The WYSIWYG stack then re-serialized those nodes and
 * silently rewrote the document's front matter (data loss on save).
 *
 * Design (per docs/sakullla-workflow/.../02-technical-solution.md §3):
 *
 *   - Dual parser stacks stay in sync: `remark-frontmatter` is registered
 *     BOTH here (Milkdown's internal remark via `$remark`) and in the pure
 *     parser (`parser.ts`). Both produce an mdast `yaml` node whose `value`
 *     is the raw YAML text between the fences.
 *
 *   - The ProseMirror side is a single atom block node `frontmatter` that
 *     stores the raw YAML text in its `value` attr and renders as a
 *     monospace `<pre class="lightink-frontmatter">` metadata block. Atom +
 *     attr storage (rather than editable text content) guarantees the YAML
 *     is never reflowed/normalized by ProseMirror — round-trip is verbatim.
 *     Per the technical solution, YAML content is not parsed or validated:
 *     preserving it as-is satisfies "不静默删除".
 *
 *   - Serialization emits an mdast `yaml` node; `remark-frontmatter`'s
 *     to-markdown extension writes it back as `---\n<value>\n---`, so block
 *     position and content survive an edit/save cycle unchanged.
 *
 * The pure helpers (`extractFrontMatter`, `hasFrontMatter`,
 * `frontmatterNodeSchema`) are headless-testable; only the two exported
 * Milkdown plugin values require a live editor.
 */

import type { MilkdownPlugin } from '@milkdown/ctx';
import { $nodeSchema, $remark } from '@milkdown/utils';
import type { NodeSchema } from '@milkdown/transformer';
import remarkFrontmatter from 'remark-frontmatter';

import { parseMarkdownToMdast } from '../parser.js';

// ---------------------------------------------------------------------------
// 纯逻辑层：front matter 提取（headless 可测）
// ---------------------------------------------------------------------------

/** Extracted front matter: the raw YAML text between the `---` fences. */
export interface FrontMatterBlock {
  readonly value: string;
}

/**
 * Return the document's leading YAML front matter block, or null when the
 * document does not start with a `---` fence. Only a leading `yaml` node
 * counts — thematic breaks later in the document are not front matter.
 */
export function extractFrontMatter(source: string): FrontMatterBlock | null {
  if (typeof source !== 'string' || !source.startsWith('---')) return null;
  const root = parseMarkdownToMdast(source);
  const first = root.children[0] as { type?: string; value?: unknown } | undefined;
  if (first === undefined || first.type !== 'yaml') return null;
  return { value: typeof first.value === 'string' ? first.value : '' };
}

/** Whether the markdown source begins with a YAML front matter block. */
export function hasFrontMatter(source: string): boolean {
  return extractFrontMatter(source) !== null;
}

// ---------------------------------------------------------------------------
// 节点规范（纯数据，headless 可测 runner 行为）
// ---------------------------------------------------------------------------

/** ProseMirror node id for the front matter block. */
export const FRONTMATTER_NODE_NAME = 'frontmatter';

/**
 * Plain node schema shared by the `$nodeSchema` wrapper below and by unit
 * tests (which drive the runners with fake parser/serializer states).
 */
export function frontmatterNodeSchema(): NodeSchema {
  return {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: {
      value: { default: '', validate: 'string' },
    },
    parseDOM: [
      {
        tag: `pre[data-type="${FRONTMATTER_NODE_NAME}"]`,
        getAttrs: (dom) => ({ value: (dom as HTMLElement).textContent ?? '' }),
      },
    ],
    toDOM: (node) => [
      'pre',
      {
        'data-type': FRONTMATTER_NODE_NAME,
        class: 'lightink-frontmatter',
      },
      String(node.attrs['value'] ?? ''),
    ],
    parseMarkdown: {
      match: (node) => node.type === 'yaml',
      runner: (state, node, proseType) => {
        const value = typeof node['value'] === 'string' ? node['value'] : '';
        state.addNode(proseType, { value });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === FRONTMATTER_NODE_NAME,
      runner: (state, node) => {
        const raw = node.attrs['value'];
        state.addNode('yaml', undefined, typeof raw === 'string' ? raw : '');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * Register `remark-frontmatter` on Milkdown's internal remark instance so
 * the WYSIWYG parser/serializer understands `yaml` mdast nodes — the same
 * plugin `parser.ts` registers on the pure stack.
 */
export const remarkFrontmatterPlugin = $remark(
  'remarkFrontmatter',
  () => remarkFrontmatter,
);

/** ProseMirror node schema for the `frontmatter` atom block. */
export const frontmatterSchema = $nodeSchema(
  FRONTMATTER_NODE_NAME,
  frontmatterNodeSchema,
);

/**
 * Composed Milkdown plugin: remark extension + node schema. Register with
 * `editor.use(frontmatterPlugin)` after the `gfm` preset.
 */
export const frontmatterPlugin: MilkdownPlugin[] = [
  remarkFrontmatterPlugin,
  frontmatterSchema,
].flat();
