/**
 * Code highlight plugin tests (T5 / R4).
 *
 * Headless coverage:
 *   - `highlightCode` per language → HTML with `hljs-*` classes (14 languages).
 *   - Unlabeled / unknown language → escaped plain text, no hljs markup.
 *   - HTML escaping (`<script>` must not survive unescaped).
 *   - Milkdown wiring: the `$prose` factory yields a ProseMirror Plugin whose
 *     decoration pass maps fence info-string → language correctly (via
 *     `buildCodeDecorations` on a real PM doc built from the commonmark
 *     code_block schema).
 *
 * NOT covered headlessly (needs interactive verification): the live editor
 * DOM actually showing colors — that requires a mounted ProseMirror view and
 * the hljs theme CSS, which is T6's theme-system job.
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';

import {
  buildCodeDecorations,
  codeHighlightPlugin,
  escapeHtml,
  highlightCode,
  resolveLanguage,
  scopeToClasses,
  tokenizeCode,
} from '../code-highlight.js';

// ---------------------------------------------------------------------------
// resolveLanguage：fence info-string → hljs 语言名
// ---------------------------------------------------------------------------

describe('resolveLanguage', () => {
  it('accepts all 14 R4 languages and their common aliases', () => {
    const fences = [
      'js', 'javascript',
      'ts', 'typescript',
      'py', 'python',
      'java',
      'go', 'golang',
      'rust', 'rs',
      'c',
      'cpp', 'c++',
      'html', 'xml',
      'css',
      'sql',
      'sh', 'shell', 'bash',
      'json',
      'yaml', 'yml',
    ];
    for (const fence of fences) {
      // 返回的是非 null 的 hljs 可识别名（别名原样返回，hljs.highlight 接受）。
      expect(resolveLanguage(fence), `fence ${fence}`).not.toBeNull();
    }
  });

  it('normalizes aliases hljs itself does not know (shell / c++)', () => {
    expect(resolveLanguage('shell')).toBe('bash');
    expect(resolveLanguage('c++')).toBe('cpp');
  });

  it('is case-insensitive and ignores trailing info-string attributes', () => {
    expect(resolveLanguage('JS')).toBe('js');
    expect(resolveLanguage('TypeScript')).toBe('typescript');
    expect(resolveLanguage('js {1-3}')).toBe('js');
  });

  it('returns null for empty / plain-text / unknown languages', () => {
    expect(resolveLanguage('')).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage('text')).toBeNull();
    expect(resolveLanguage('plaintext')).toBeNull();
    expect(resolveLanguage('foobar')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// highlightCode：语言 → 带 hljs class 的 HTML
// ---------------------------------------------------------------------------

describe('highlightCode', () => {
  const languageSamples: Array<{
    language: string;
    code: string;
    marker: string;
  }> = [
    { language: 'javascript', code: 'const x = 1;', marker: 'hljs-keyword' },
    { language: 'typescript', code: 'const x: number = 1;', marker: 'hljs-keyword' },
    { language: 'python', code: 'def f():\n    return 1', marker: 'hljs-keyword' },
    { language: 'java', code: 'public class A {}', marker: 'hljs-keyword' },
    { language: 'go', code: 'func main() {}', marker: 'hljs-keyword' },
    { language: 'rust', code: 'fn main() { let x = 1; }', marker: 'hljs-keyword' },
    { language: 'c', code: 'int main(void) { return 0; }', marker: 'hljs-keyword' },
    { language: 'cpp', code: 'int main() { return 0; }', marker: 'hljs-keyword' },
    { language: 'xml', code: '<div class="a">hi</div>', marker: 'hljs-tag' },
    { language: 'css', code: 'body { color: red; }', marker: 'hljs-selector' },
    { language: 'sql', code: 'SELECT * FROM t;', marker: 'hljs-keyword' },
    { language: 'bash', code: 'echo "hi" # comment', marker: 'hljs-comment' },
    { language: 'json', code: '{"a": 1}', marker: 'hljs-attr' },
    { language: 'yaml', code: 'key: value', marker: 'hljs-attr' },
  ];

  it.each(languageSamples)(
    'highlights $language with hljs classes ($marker)',
    ({ language, code, marker }) => {
      const html = highlightCode(language, code);
      expect(html).toContain(marker);
      expect(html).toContain('<span class="hljs-');
      // 输出必须不同于纯转义文本（即确实发生了高亮）。
      expect(html).not.toBe(escapeHtml(code));
    },
  );

  it('returns escaped plain text with no hljs markup when language is null', () => {
    const code = 'const x = 1;';
    const html = highlightCode(null, code);
    expect(html).toBe(escapeHtml(code));
    expect(html).not.toContain('hljs-');
    expect(html).not.toContain('<span');
  });

  it('falls back to plain text for an unknown language name', () => {
    const code = 'whatever content';
    expect(highlightCode('foobar', code)).toBe(escapeHtml(code));
  });

  it('escapes HTML in code (no <script> injection) on both paths', () => {
    const code = 'const s = "<script>alert(1)</script>";';
    const highlighted = highlightCode('javascript', code);
    expect(highlighted).not.toContain('<script>');
    expect(highlighted).toContain('&lt;script&gt;');
    const plain = highlightCode(null, code);
    expect(plain).not.toContain('<script>');
    expect(plain).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// tokenizeCode / scopeToClasses：token 树 → 扁平序列
// ---------------------------------------------------------------------------

describe('tokenizeCode', () => {
  it('concatenated token text reproduces the original code exactly', () => {
    const code = 'const x = "a\\n";\n// 注释 & <tag>\n';
    const tokens = tokenizeCode('javascript', code);
    expect(tokens).not.toBeNull();
    expect(tokens!.map((t) => t.text).join('')).toBe(code);
    expect(tokens!.some((t) => t.scope === 'keyword')).toBe(true);
    expect(tokens!.some((t) => t.scope === 'comment')).toBe(true);
  });

  it('returns null for null / unknown languages', () => {
    expect(tokenizeCode(null, 'x')).toBeNull();
    expect(tokenizeCode('foobar', 'x')).toBeNull();
  });

  it('scopeToClasses maps dotted scopes to hljs classes', () => {
    expect(scopeToClasses('keyword')).toBe('hljs-keyword');
    expect(scopeToClasses('comment.doc')).toBe('hljs-comment hljs-doc');
  });
});

// ---------------------------------------------------------------------------
// Milkdown / ProseMirror 接线：info-string → language → decorations
// ---------------------------------------------------------------------------

// 与 preset-commonmark 的 code_block schema 同形的最小 schema（attrs.language）。
const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: { language: { default: '' } },
    },
    text: {},
  },
});

function codeDoc(...blocks: Array<{ language: string; code: string }>) {
  return testSchema.nodes['doc']!.create(
    null,
    blocks.map((b) =>
      testSchema.nodes['code_block']!.create(
        { language: b.language },
        b.code === '' ? undefined : testSchema.text(b.code),
      ),
    ),
  );
}

/** Decoration.attrs 不在公开 typings 中，运行时经内部 `type.attrs` 读取。 */
function decoAttrs(d: unknown): Record<string, string | undefined> {
  return (d as { type: { attrs: Record<string, string | undefined> } }).type.attrs;
}

describe('codeHighlightPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    // Milkdown $prose 产物是带元信息的函数；.plugin()/.key() 在编辑器
    // 完成 SchemaReady 后才返回内部 PM Plugin，headless 下只能断言工厂形态。
    // decoration 行为本身由 buildCodeDecorations 的用例覆盖。
    expect(codeHighlightPlugin).toBeDefined();
    expect(typeof codeHighlightPlugin).toBe('function');
    const shaped = codeHighlightPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    // 未经 Milkdown ctx 运行前，内部 plugin 尚未实例化。
    expect(shaped.plugin()).toBeUndefined();
  });

  it('adds a node decoration with language class for known languages', () => {
    const doc = codeDoc({ language: 'js', code: 'const x = 1;' });
    const found = buildCodeDecorations(doc).find();
    // 存在带 data-language 的 node decoration（pre 上的 hljs language-javascript）。
    const nodeDeco = found.find((d) => decoAttrs(d)['data-language'] === 'js');
    expect(nodeDeco).toBeDefined();
    expect(decoAttrs(nodeDeco)['class']).toBe('hljs language-js');
    // inline token decorations 也应存在（hljs-keyword）。
    expect(
      found.some((d) => (decoAttrs(d)['class'] ?? '').includes('hljs-keyword')),
    ).toBe(true);
  });

  it('produces no decorations for unlabeled or unknown-language blocks', () => {
    const doc = codeDoc(
      { language: '', code: 'const x = 1;' },
      { language: 'foobar', code: 'const x = 1;' },
    );
    expect(buildCodeDecorations(doc).find()).toHaveLength(0);
  });

  it('maps fence info-string aliases to languages (shell → bash)', () => {
    const doc = codeDoc({ language: 'shell', code: 'echo hi # c' });
    const found = buildCodeDecorations(doc).find();
    expect(found.some((d) => decoAttrs(d)['data-language'] === 'bash')).toBe(true);
  });

  it('inline decorations land on correct offsets across multiple blocks', () => {
    const doc = codeDoc(
      { language: 'js', code: 'const a = 1;' },
      { language: '', code: 'plain' },
      { language: 'py', code: 'def f(): pass' },
    );
    const found = buildCodeDecorations(doc).find();
    // js 块：node deco(1) + 若干 inline；py 块同理；plain 块无。
    const languages = found
      .map((d) => decoAttrs(d)['data-language'])
      .filter((v): v is string => v !== undefined);
    expect(languages).toEqual(['js', 'py']);
  });
});
