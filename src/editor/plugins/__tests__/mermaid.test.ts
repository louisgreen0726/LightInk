/**
 * Mermaid plugin tests (T9 / R9).
 *
 * Headless coverage:
 *   - `isMermaidBlock`: 'mermaid' true, 'Mermaid' true (case-normalized,
 *     documented leniency), fence-with-attrs true, '' / null / 'js' false.
 *   - `renderMermaidSvg` with an INJECTED fake mermaid module: valid
 *     definition → `{ ok:true, svg }` with a unique `lightink-mermaid-*`
 *     render id; throwing fake → `{ ok:false, message }`; empty definition
 *     rejected without touching mermaid. (Real `mermaid.render` needs DOM /
 *     SVG measure APIs and is untestable headlessly.)
 *   - `createMermaidLoader`: laziness (factory not called until invoked),
 *     memoization, default-export interop, `initialize` called once with
 *     `startOnLoad:false` + `securityLevel:'strict'`, module-shape
 *     validation.
 *   - `collectMermaidDefinitions` / `docHasMermaid` on a real PM doc
 *     (codeSchema pattern from math.test.ts): mermaid code_block detected,
 *     ```js block and plain paragraphs not; the empty result is what gates
 *     the lazy loader in the plugin view (no mermaid → loader never runs).
 *   - `buildMermaidDecorations`: rendered block → `lightink-mermaid-source`
 *     node decoration + SVG widget; error outcome → `lightink-mermaid-error`
 *     only (no widget, source preserved); pending (no result yet) →
 *     `lightink-mermaid-pending`; non-mermaid blocks and text untouched;
 *     coexistence doc (```js + ```mermaid) — only the mermaid block gets
 *     mermaid decorations; document text never modified.
 *   - Milkdown wiring: `$prose` factory shape + namespaced plugin key.
 *
 * NOT covered headlessly (needs interactive verification): actual SVG in
 * the WebView, real mermaid.parse/render behavior, and the visual
 * pending→rendered swap.
 */
import { describe, expect, it, vi } from 'vitest';
import { Schema } from '@milkdown/prose/model';

import {
  buildMermaidDecorations,
  collectMermaidDefinitions,
  createMermaidLoader,
  docHasMermaid,
  isMermaidBlock,
  mermaidPlugin,
  mermaidPluginKey,
  renderMermaidSvg,
  type MermaidModule,
  type MermaidRenderOutcome,
} from '../mermaid.js';

// ---------------------------------------------------------------------------
// isMermaidBlock：fence info-string 识别
// ---------------------------------------------------------------------------

describe('isMermaidBlock', () => {
  it('accepts plain "mermaid"', () => {
    expect(isMermaidBlock('mermaid')).toBe(true);
  });

  it('is case-insensitive ("Mermaid")', () => {
    expect(isMermaidBlock('Mermaid')).toBe(true);
    expect(isMermaidBlock('MERMAID')).toBe(true);
  });

  it('accepts an info-string with trailing attributes (```mermaid {…})', () => {
    expect(isMermaidBlock('mermaid {"theme":"dark"}')).toBe(true);
    expect(isMermaidBlock('  mermaid  ')).toBe(true);
  });

  it('rejects empty / null / undefined', () => {
    expect(isMermaidBlock('')).toBe(false);
    expect(isMermaidBlock('   ')).toBe(false);
    expect(isMermaidBlock(null)).toBe(false);
    expect(isMermaidBlock(undefined)).toBe(false);
  });

  it('rejects other languages (js, mermaid2)', () => {
    expect(isMermaidBlock('js')).toBe(false);
    expect(isMermaidBlock('javascript')).toBe(false);
    expect(isMermaidBlock('mermaid2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderMermaidSvg：注入替身，错误隔离
// ---------------------------------------------------------------------------

const fakeOk: MermaidModule = {
  initialize: () => undefined,
  render: async (_id, definition) => ({ svg: `<svg data-def="${definition}"></svg>` }),
};

describe('renderMermaidSvg', () => {
  it('renders a valid definition to an ok outcome with svg', async () => {
    const outcome = await renderMermaidSvg('graph TD; A-->B', fakeOk);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.svg).toContain('<svg');
  });

  it('passes a unique lightink-mermaid-* render id', async () => {
    const ids: string[] = [];
    const spy: MermaidModule = {
      initialize: () => undefined,
      render: async (id) => {
        ids.push(id);
        return { svg: '<svg/>' };
      },
    };
    await renderMermaidSvg('graph TD; A-->B', spy);
    await renderMermaidSvg('graph TD; C-->D', spy);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^lightink-mermaid-/);
    expect(new Set(ids).size).toBe(2);
  });

  it('trims the definition before rendering', async () => {
    let seen = '';
    const spy: MermaidModule = {
      initialize: () => undefined,
      render: async (_id, def) => {
        seen = def;
        return { svg: '<svg/>' };
      },
    };
    await renderMermaidSvg('  graph TD; A-->B\n', spy);
    expect(seen).toBe('graph TD; A-->B');
  });

  it('converts a throwing render into an error outcome (isolated, never rethrows)', async () => {
    const fakeBad: MermaidModule = {
      initialize: () => undefined,
      render: async () => {
        throw new Error('Parse error on line 1');
      },
    };
    const outcome = await renderMermaidSvg('not a diagram {{{', fakeBad);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('Parse error');
  });

  it('handles non-Error throws', async () => {
    const fakeBad: MermaidModule = {
      initialize: () => undefined,
      render: async () => Promise.reject('string failure'),
    };
    const outcome = await renderMermaidSvg('graph TD;', fakeBad);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('string failure');
  });

  it('rejects an empty definition without calling mermaid', async () => {
    const render = vi.fn();
    const fake: MermaidModule = { initialize: () => undefined, render };
    const outcome = await renderMermaidSvg('   \n ', fake);
    expect(outcome.ok).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createMermaidLoader：按需加载语义
// ---------------------------------------------------------------------------

describe('createMermaidLoader', () => {
  it('never invokes the factory until the loader is called (lazy)', async () => {
    const factory = vi.fn(async () => ({ initialize: () => undefined, render: async () => ({ svg: '' }) }));
    const load = createMermaidLoader(factory);
    // 无 mermaid 块的路径根本不调用 load —— 此处模拟：只构造、不调用。
    expect(factory).not.toHaveBeenCalled();
    await load();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('memoizes the module promise (single import)', async () => {
    const factory = vi.fn(async () => ({ initialize: () => undefined, render: async () => ({ svg: '' }) }));
    const load = createMermaidLoader(factory);
    const [a, b] = await Promise.all([load(), load()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('accepts the default-export interop shape', async () => {
    const inner = { initialize: () => undefined, render: async () => ({ svg: '<svg/>' }) };
    const load = createMermaidLoader(async () => ({ default: inner }));
    expect(await load()).toBe(inner);
  });

  it('initializes once with startOnLoad:false and strict securityLevel', async () => {
    const initialize = vi.fn();
    const load = createMermaidLoader(async () => ({ initialize, render: async () => ({ svg: '' }) }));
    await load();
    await load();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' }),
    );
  });

  it('rejects modules without render', async () => {
    const load = createMermaidLoader(async () => ({}));
    await expect(load()).rejects.toThrow('render');
  });

  it('does not cache a rejected import — the next call retries for real', async () => {
    let attempts = 0;
    const factory = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network flake');
      return { initialize: () => undefined, render: async () => ({ svg: '<svg/>' }) };
    });
    const load = createMermaidLoader(factory);
    await expect(load()).rejects.toThrow('network flake');
    // 第二次调用应真正重试工厂而非复用 rejected promise。
    await expect(load()).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// PM 文档层：识别 / decoration 构建 / 错误隔离 / 与 code-highlight 共存
// ---------------------------------------------------------------------------

// 含 language attr 的 code_block 最小 schema（同 preset-commonmark 形状）。
const codeSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      attrs: { language: { default: '' } },
    },
    text: {},
  },
});

function codeBlock(language: string, code: string) {
  return codeSchema.nodes['code_block']!.create(
    { language },
    code === '' ? undefined : codeSchema.text(code),
  );
}

function para(text: string) {
  return codeSchema.nodes['paragraph']!.create(null, codeSchema.text(text));
}

function docOf(...blocks: ReturnType<typeof codeBlock>[]) {
  return codeSchema.nodes['doc']!.create(null, blocks);
}

/** Decoration.attrs 不在公开 typings 中，运行时经内部 `type.attrs` 读取（widget 无 attrs）。 */
function decoAttrs(d: unknown): Record<string, string | undefined> | undefined {
  return (d as { type: { attrs?: Record<string, string | undefined> } }).type.attrs;
}

function decoClass(d: unknown): string {
  return decoAttrs(d)?.['class'] ?? '';
}

/** widget decoration 的 key 存于内部 `type.spec.key`（非公开 typings）。 */
function decoKey(d: unknown): string | undefined {
  return (d as { type: { spec?: { key?: string } } }).type.spec?.key;
}

const okOutcome = (svg: string): MermaidRenderOutcome => ({ ok: true, svg });

describe('collectMermaidDefinitions / docHasMermaid', () => {
  it('collects mermaid definitions (trimmed, deduplicated)', () => {
    const doc = docOf(
      codeBlock('mermaid', 'graph TD; A-->B'),
      codeBlock('mermaid', 'graph TD; A-->B'),
      codeBlock('mermaid', 'sequenceDiagram; A->>B: hi'),
    );
    expect(collectMermaidDefinitions(doc)).toEqual([
      'graph TD; A-->B',
      'sequenceDiagram; A->>B: hi',
    ]);
    expect(docHasMermaid(doc)).toBe(true);
  });

  it('ignores non-mermaid code blocks and plain paragraphs (lazy-loader gate)', () => {
    const doc = docOf(codeBlock('js', 'console.log(1)'), para('只是正文'));
    expect(collectMermaidDefinitions(doc)).toEqual([]);
    expect(docHasMermaid(doc)).toBe(false);
  });

  it('does not treat an unlabeled fence as mermaid', () => {
    expect(docHasMermaid(docOf(codeBlock('', 'graph TD; A-->B')))).toBe(false);
  });

  it('empty mermaid block is inert: not collected, no error flash while typing', () => {
    const doc = docOf(codeBlock('mermaid', ''));
    expect(collectMermaidDefinitions(doc)).toEqual([]);
    expect(docHasMermaid(doc)).toBe(false);
    const found = buildMermaidDecorations(doc, new Map()).find();
    expect(found).toHaveLength(0);
  });

  it('widget key is content-addressed: same definition keeps DOM, position move does not reuse stale svg', () => {
    const defA = 'graph TD; A-->B';
    const defB = 'graph TD; C-->D';
    const results = new Map([
      [defA, okOutcome('<svg>A</svg>')],
      [defB, okOutcome('<svg>B</svg>')],
    ]);
    const doc1 = docOf(codeBlock('mermaid', defA), codeBlock('mermaid', defB));
    const deco1 = buildMermaidDecorations(doc1, results).find();
    const widgetKeys1 = deco1.filter((d) => decoClass(d) === '').map((d) => decoKey(d));
    // 删除 A 块后 B 块上移到 A 的原位置 —— key 仍随内容，不复用旧 DOM。
    const doc2 = docOf(codeBlock('mermaid', defB));
    const deco2 = buildMermaidDecorations(doc2, results).find();
    const widgetKeys2 = deco2.filter((d) => decoClass(d) === '').map((d) => decoKey(d));
    expect(widgetKeys2).toHaveLength(1);
    expect(widgetKeys1).toContain(widgetKeys2[0]);
    expect(widgetKeys1[0]).not.toBe(widgetKeys2[0]);
  });
});

describe('buildMermaidDecorations', () => {
  it('returns no decorations for a mermaid-free document', () => {
    const doc = docOf(codeBlock('js', 'const a = 1'), para('正文'));
    expect(buildMermaidDecorations(doc, new Map()).find()).toHaveLength(0);
  });

  it('marks a rendered mermaid block with source class + svg widget', () => {
    const doc = docOf(codeBlock('mermaid', 'graph TD; A-->B'));
    const results = new Map([['graph TD; A-->B', okOutcome('<svg/>')]]);
    const found = buildMermaidDecorations(doc, results).find();
    expect(found.some((d) => decoClass(d) === 'lightink-mermaid-source')).toBe(true);
    // widget decoration（渲染结果）也存在，且位于代码块结束之后。
    const source = found.find((d) => decoClass(d) === 'lightink-mermaid-source')!;
    const widgets = found.filter((d) => decoClass(d) === '');
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.from).toBe(source.to);
    // node decoration 覆盖整个代码块（源码仍完整、可编辑）。
    expect(doc.textBetween(source.from, source.to)).toBe('graph TD; A-->B');
  });

  it('error outcome: error class only, no widget, source preserved (R9 isolation)', () => {
    const def = 'not a diagram {{{';
    const doc = docOf(para('前文'), codeBlock('mermaid', def), para('后文'));
    const results = new Map<string, MermaidRenderOutcome>([
      [def, { ok: false, message: 'Parse error on line 1' }],
    ]);
    const found = buildMermaidDecorations(doc, results).find();

    const errors = found.filter((d) => decoClass(d) === 'lightink-mermaid-error');
    expect(errors).toHaveLength(1);
    expect(doc.textBetween(errors[0]!.from, errors[0]!.to)).toBe(def);
    expect(decoAttrs(errors[0])?.['data-mermaid-error']).toContain('Parse error');

    // 错误块没有 widget（不渲染）。
    expect(found.filter((d) => decoClass(d) === '')).toHaveLength(0);

    // decoration 不修改文档：周围内容原样保留。
    expect(doc.textContent).toBe(`前文${def}后文`);
  });

  it('pending block (no result yet) gets the pending class only', () => {
    const doc = docOf(codeBlock('mermaid', 'graph TD; A-->B'));
    const found = buildMermaidDecorations(doc, new Map()).find();
    expect(found.some((d) => decoClass(d) === 'lightink-mermaid-pending')).toBe(true);
    expect(found.filter((d) => decoClass(d) === '')).toHaveLength(0);
  });

  it('error isolation: a bad block does not affect a good sibling', () => {
    const good = 'graph TD; A-->B';
    const bad = 'broken {{{';
    const doc = docOf(codeBlock('mermaid', good), codeBlock('mermaid', bad));
    const results = new Map<string, MermaidRenderOutcome>([
      [good, okOutcome('<svg/>')],
      [bad, { ok: false, message: 'Parse error' }],
    ]);
    const found = buildMermaidDecorations(doc, results);
    expect(found.find().some((d) => decoClass(d) === 'lightink-mermaid-source')).toBe(true);
    expect(found.find().filter((d) => decoClass(d) === '')).toHaveLength(1);
    expect(found.find().some((d) => decoClass(d) === 'lightink-mermaid-error')).toBe(true);
    expect(doc.textContent).toBe(`${good}${bad}`);
  });

  it('coexistence: ```js block untouched by mermaid plugin, ```mermaid block decorated', () => {
    const jsCode = 'console.log("hi")';
    const def = 'graph TD; A-->B';
    const doc = docOf(codeBlock('js', jsCode), codeBlock('mermaid', def));
    const results = new Map([[def, okOutcome('<svg/>')]]);
    const found = buildMermaidDecorations(doc, results).find();

    const mermaidDecos = found.filter((d) => decoClass(d).startsWith('lightink-mermaid'));
    expect(mermaidDecos).toHaveLength(1);
    // 唯一的 mermaid decoration 覆盖的是 mermaid 块，js 块无任何 decoration。
    expect(doc.textBetween(mermaidDecos[0]!.from, mermaidDecos[0]!.to)).toBe(def);
    expect(doc.textContent).toBe(`${jsCode}${def}`);
  });
});

// ---------------------------------------------------------------------------
// Milkdown / ProseMirror 接线
// ---------------------------------------------------------------------------

describe('mermaidPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(mermaidPlugin).toBeDefined();
    expect(typeof mermaidPlugin).toBe('function');
    const shaped = mermaidPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    // 未经 Milkdown ctx 运行前，内部 plugin 尚未实例化。
    expect(shaped.plugin()).toBeUndefined();
  });

  it('mermaidPluginKey is namespaced', () => {
    // PluginKey.key 不在公开 typings 中，运行时存在。
    const key = (mermaidPluginKey as unknown as { key: string }).key;
    expect(key).toContain('lightink-mermaid');
  });
});
