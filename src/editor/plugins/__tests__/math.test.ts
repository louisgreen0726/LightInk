/**
 * Math plugin tests (T8 / R8).
 *
 * Headless coverage:
 *   - `scanTextMath` / `extractMathSegments`: inline `$…$`, block `$$…$$`,
 *     mixed docs, currency rejection ($5 和 $10), unclosed/empty delimiters,
 *     code-block / inline-code exclusion (via real MDAST from parser.ts),
 *     source-offset accuracy.
 *   - `renderMathHtml` with the REAL katex module: valid latex → katex HTML;
 *     invalid latex → `<code class="lightink-math-error">` wrapping the raw
 *     source; displayMode flag.
 *   - `createKatexLoader`: laziness (factory not called until invoked),
 *     memoization, module-shape validation.
 *   - Error isolation on a real PM doc: one bad + one good formula — the good
 *     one gets rendered decorations, the bad one only the error class, and
 *     the document text itself is never modified.
 *   - Milkdown wiring: `$prose` factory shape (same approach as
 *     code-highlight tests); no math in doc → no decorations / no katex.
 *
 * NOT covered headlessly (needs interactive verification): actual glyphs in
 * the WebView, KaTeX font loading, and the visual placeholder→rendered swap.
 */
import { describe, expect, it, vi } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import katex from 'katex';

import {
  buildMathDecorations,
  createKatexLoader,
  escapeMathHtml,
  extractMathSegments,
  hasMath,
  mathPlugin,
  mathPluginKey,
  renderMathHtml,
  scanTextMath,
  type KatexRenderer,
} from '../math.js';

// ---------------------------------------------------------------------------
// scanTextMath：纯文本 $…$ / $$…$$ 扫描
// ---------------------------------------------------------------------------

describe('scanTextMath', () => {
  it('extracts inline math with source offsets', () => {
    const text = '质能方程 $E=mc^2$ 结束';
    const segments = scanTextMath(text);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'inline', latex: 'E=mc^2' });
    expect(text.slice(segments[0]!.from, segments[0]!.to)).toBe('$E=mc^2$');
  });

  it('extracts block math $$…$$', () => {
    const text = '前文 $$\\int_0^1 x\\,dx$$ 后文';
    const segments = scanTextMath(text);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'block', latex: '\\int_0^1 x\\,dx' });
    expect(text.slice(segments[0]!.from, segments[0]!.to)).toBe('$$\\int_0^1 x\\,dx$$');
  });

  it('does not treat currency as math (价格是 $5 和 $10)', () => {
    expect(scanTextMath('价格是 $5 和 $10 元')).toHaveLength(0);
  });

  it('does not treat an unclosed $ as math', () => {
    expect(scanTextMath('unclosed $foo here')).toHaveLength(0);
  });

  it('does not treat empty $$ $$ / $ $ as math', () => {
    expect(scanTextMath('empty $$ $$ block')).toHaveLength(0);
    expect(scanTextMath('empty $ $ inline')).toHaveLength(0);
  });

  it('requires non-space right after opening $ and before closing $', () => {
    expect(scanTextMath('bad $ x$')).toHaveLength(0);
    expect(scanTextMath('bad $x $')).toHaveLength(0);
    expect(scanTextMath('good $x$')).toHaveLength(1);
  });

  it('rejects a closing $ immediately followed by a digit (pandoc rule)', () => {
    expect(scanTextMath('pay $x$5 more')).toHaveLength(0);
  });

  it('honors \\$ escapes', () => {
    expect(scanTextMath('escaped \\$x$ here')).toHaveLength(0);
    expect(scanTextMath('price is \\$5')).toHaveLength(0);
  });

  it('scans multiple segments in order', () => {
    const text = '$a$ then $$b$$ then $c$';
    const segments = scanTextMath(text);
    expect(segments.map((s) => s.type)).toEqual(['inline', 'block', 'inline']);
    expect(segments.map((s) => s.latex)).toEqual(['a', 'b', 'c']);
    expect(segments.map((s) => s.from)).toEqual([...segments.map((s) => s.from)].sort((x, y) => x - y));
  });

  it('respects baseOffset', () => {
    const segments = scanTextMath('$x$', 42);
    expect(segments[0]).toMatchObject({ from: 42, to: 45 });
  });
});

// ---------------------------------------------------------------------------
// extractMathSegments：markdown 级提取（MDAST，排除 code / inlineCode）
// ---------------------------------------------------------------------------

describe('extractMathSegments', () => {
  it('extracts inline math from a paragraph', () => {
    const md = '质能方程 $E=mc^2$ 广为人知。';
    const segments = extractMathSegments(md);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'inline', latex: 'E=mc^2' });
    expect(md.slice(segments[0]!.from, segments[0]!.to)).toBe('$E=mc^2$');
  });

  it('extracts block math from its own paragraph', () => {
    const md = '前面一段。\n\n$$\\int_0^1 x\\,dx$$\n\n后面一段。';
    const segments = extractMathSegments(md);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'block', latex: '\\int_0^1 x\\,dx' });
    expect(md.slice(segments[0]!.from, segments[0]!.to)).toBe('$$\\int_0^1 x\\,dx$$');
  });

  it('extracts mixed docs and keeps offsets accurate', () => {
    const md = '行内 $a+b$ 与\n\n$$c=d$$\n\n再 $e^f$ 完。';
    const segments = extractMathSegments(md);
    expect(segments.map((s) => s.type)).toEqual(['inline', 'block', 'inline']);
    for (const seg of segments) {
      const slice = md.slice(seg.from, seg.to);
      expect(slice.startsWith('$')).toBe(true);
      expect(slice.endsWith('$')).toBe(true);
      expect(slice).toContain(seg.latex);
    }
  });

  it('does not extract currency from prose', () => {
    expect(extractMathSegments('价格是 $5 和 $10 元。')).toHaveLength(0);
  });

  it('does not extract unclosed or empty delimiters', () => {
    expect(extractMathSegments('unclosed $foo\n\nempty $$ $$')).toHaveLength(0);
  });

  it('does NOT extract math inside fenced code blocks', () => {
    const md = '```\n$E=mc^2$ 与 $$x$$\n```';
    expect(extractMathSegments(md)).toHaveLength(0);
  });

  it('does NOT extract math inside inline code', () => {
    const md = '代码 `$E=mc^2$` 不是公式。';
    expect(extractMathSegments(md)).toHaveLength(0);
  });

  it('does not let math span across an inline-code barrier', () => {
    // `$a` + inlineCode + `$` 不能拼成一个公式。
    const md = '前 $a `code` b$ 后';
    expect(extractMathSegments(md)).toHaveLength(0);
  });

  it('still extracts math next to inline code', () => {
    const md = '看 `$x$` 再看真公式 $y=1$ 完。';
    const segments = extractMathSegments(md);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.latex).toBe('y=1');
  });

  it('extracts math inside emphasis (transparent inline containers)', () => {
    const md = '强调 **$E=mc^2$** 里的公式。';
    const segments = extractMathSegments(md);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.latex).toBe('E=mc^2');
  });

  it('hasMath gates on real math only', () => {
    expect(hasMath('没有公式 $5 和 $10')).toBe(false);
    expect(hasMath('有 $E=mc^2$ 公式')).toBe(true);
    expect(hasMath('```\n$x$\n```')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderMathHtml：真实 KaTeX 渲染 + 语法错误隔离
// ---------------------------------------------------------------------------

describe('renderMathHtml', () => {
  it('renders valid latex to katex HTML', () => {
    const html = renderMathHtml('E=mc^2', false, katex);
    expect(html).toContain('katex');
    expect(html).not.toContain('lightink-math-error');
  });

  it('renders display mode with the display class', () => {
    const html = renderMathHtml('\\int_0^1 x\\,dx', true, katex);
    expect(html).toContain('katex');
    expect(html).toContain('katex-display');
  });

  it('inline mode has no katex-display wrapper', () => {
    const html = renderMathHtml('x', false, katex);
    expect(html).not.toContain('katex-display');
  });

  it('on syntax error wraps the RAW source in an error code element', () => {
    const bad = '\\badcommand{';
    const html = renderMathHtml(bad, false, katex);
    expect(html).toContain('lightink-math-error');
    expect(html.startsWith('<code class="lightink-math-error">')).toBe(true);
    expect(html).toContain(escapeMathHtml(bad));
    // KaTeX 自己的红字错误渲染不得出现（要求原样显示源码）。
    expect(html).not.toContain('katex-error');
  });

  it('escapes HTML inside the error source (no injection)', () => {
    const bad = '\\badcommand{<script>alert(1)</script>';
    const html = renderMathHtml(bad, false, katex);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// createKatexLoader：按需加载语义
// ---------------------------------------------------------------------------

describe('createKatexLoader', () => {
  it('never invokes the factory until the loader is called (lazy)', async () => {
    const factory = vi.fn(async () => ({ renderToString: () => '<span/>' }));
    const load = createKatexLoader(factory);
    // 无公式文档的路径根本不调用 load —— 此处模拟：只构造、不调用。
    expect(factory).not.toHaveBeenCalled();
    await load();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('memoizes the module promise (single import)', async () => {
    const factory = vi.fn(async () => ({ renderToString: () => '<span/>' }));
    const load = createKatexLoader(factory);
    const [a, b] = await Promise.all([load(), load()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('accepts the default-export interop shape (real katex module)', async () => {
    const load = createKatexLoader(() => import('katex'));
    const renderer = await load();
    expect(typeof renderer.renderToString).toBe('function');
    expect(renderer.renderToString('x')).toContain('katex');
  });

  it('rejects modules without renderToString', async () => {
    const load = createKatexLoader(async () => ({}));
    await expect(load()).rejects.toThrow('renderToString');
  });
});

// ---------------------------------------------------------------------------
// buildMathDecorations + 错误隔离（真实 PM 文档 + 真实 KaTeX）
// ---------------------------------------------------------------------------

// 与 preset-commonmark 同形的最小 schema（paragraph + text）。
const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
  },
});

function paraDoc(...paragraphs: string[]) {
  return testSchema.nodes['doc']!.create(
    null,
    paragraphs.map((p) =>
      testSchema.nodes['paragraph']!.create(null, p === '' ? undefined : testSchema.text(p)),
    ),
  );
}

/** Decoration.attrs 不在公开 typings 中，运行时经内部 `type.attrs` 读取（widget 无 attrs）。 */
function decoAttrs(d: unknown): Record<string, string | undefined> | undefined {
  return (d as { type: { attrs?: Record<string, string | undefined> } }).type.attrs;
}

function decoClass(d: unknown): string {
  return decoAttrs(d)?.['class'] ?? '';
}

describe('buildMathDecorations', () => {
  it('returns an empty set when katex is not loaded (lazy: source shown as-is)', () => {
    const doc = paraDoc('有公式 $E=mc^2$ 但不渲染');
    expect(buildMathDecorations(doc, null).find()).toHaveLength(0);
  });

  it('returns no decorations for a math-free document', () => {
    const doc = paraDoc('没有公式，只有 $5 和 $10。');
    expect(buildMathDecorations(doc, katex).find()).toHaveLength(0);
  });

  it('marks rendered inline math with source class + widget', () => {
    const doc = paraDoc('质能 $E=mc^2$ 完');
    const found = buildMathDecorations(doc, katex).find();
    const source = found.filter((d) => decoClass(d) === 'lightink-math-inline-source');
    expect(source).toHaveLength(1);
    // widget decoration（渲染结果）也存在。
    const widgets = found.filter((d) => decoClass(d) === '');
    expect(widgets.length).toBeGreaterThanOrEqual(1);
    // source decoration 覆盖的范围正是 $E=mc^2$。
    const deco = source[0]!;
    expect(doc.textBetween(deco.from, deco.to)).toBe('$E=mc^2$');
  });

  it('marks block math with the block source class', () => {
    const doc = paraDoc('$$\\int_0^1 x\\,dx$$');
    const found = buildMathDecorations(doc, katex).find();
    expect(found.some((d) => decoClass(d) === 'lightink-math-block-source')).toBe(true);
  });

  it('isolates a bad formula: error class on it, good sibling still renders, text untouched', () => {
    const text = '好公式 $E=mc^2$ 与坏公式 $\\badcommand{$ 以及结尾文字。';
    const doc = paraDoc(text);
    const found = buildMathDecorations(doc, katex).find();

    const errors = found.filter((d) => decoClass(d) === 'lightink-math-error');
    expect(errors).toHaveLength(1);
    expect(doc.textBetween(errors[0]!.from, errors[0]!.to)).toBe('$\\badcommand{$');

    const rendered = found.filter((d) => decoClass(d) === 'lightink-math-inline-source');
    expect(rendered).toHaveLength(1);
    expect(doc.textBetween(rendered[0]!.from, rendered[0]!.to)).toBe('$E=mc^2$');

    // 错误公式没有 widget（不渲染），好公式有。
    const widgets = found.filter((d) => decoClass(d) === '');
    expect(widgets).toHaveLength(1);

    // decoration 不修改文档：周围文本原样保留。
    expect(doc.textContent).toBe(text);
  });

  it('bad block formula degrades to error class only', () => {
    const doc = paraDoc('$$\\frac{1$$');
    const found = buildMathDecorations(doc, katex).find();
    expect(found.some((d) => decoClass(d) === 'lightink-math-error')).toBe(true);
    expect(found.some((d) => decoClass(d) === '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Milkdown / ProseMirror 接线
// ---------------------------------------------------------------------------

describe('mathPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(mathPlugin).toBeDefined();
    expect(typeof mathPlugin).toBe('function');
    const shaped = mathPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    // 未经 Milkdown ctx 运行前，内部 plugin 尚未实例化。
    expect(shaped.plugin()).toBeUndefined();
  });

  it('mathPluginKey is namespaced', () => {
    // PluginKey.key 不在公开 typings 中，运行时存在。
    const key = (mathPluginKey as unknown as { key: string }).key;
    expect(key).toContain('lightink-math');
  });

  it('uses an injectable renderer shape compatible with real katex', () => {
    // KatexRenderer 契约与真实模块兼容（编译期 + 运行期双重确认）。
    const renderer: KatexRenderer = katex;
    expect(renderer.renderToString('x')).toContain('katex');
  });
});
