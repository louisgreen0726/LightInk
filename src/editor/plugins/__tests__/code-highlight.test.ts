/**
 * Code highlight plugin tests (T5 / R4 + full language registry + language select).
 *
 * Headless coverage:
 *   - `highlightCode` per core language → HTML with `hljs-*` classes.
 *   - Full highlight.js registry exposed via `listSupportedLanguages`.
 *   - Unlabeled / unknown language → escaped plain text, no hljs markup.
 *   - Language select value normalization + option population.
 *   - Decoration map fence info-string → language correctly.
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';

import {
  buildCodeDecorations,
  codeHighlightPlugin,
  copyButtonClassName,
  copyButtonLabel,
  createLanguagePicker,
  escapeHtml,
  filterLanguages,
  highlightCode,
  languageDisplayLabel,
  languageSelectValue,
  listSupportedLanguages,
  plainLanguageMatches,
  readCodeSource,
  resolveLanguage,
  scopeToClasses,
  setCodeBlockLanguage,
  tokenizeCode,
} from '../code-highlight.js';

// ---------------------------------------------------------------------------
// resolveLanguage
// ---------------------------------------------------------------------------

describe('resolveLanguage', () => {
  it('accepts core languages and common aliases', () => {
    const fences = [
      'js',
      'javascript',
      'ts',
      'typescript',
      'py',
      'python',
      'java',
      'go',
      'golang',
      'rust',
      'rs',
      'c',
      'cpp',
      'c++',
      'csharp',
      'c#',
      'html',
      'xml',
      'css',
      'sql',
      'sh',
      'bash',
      'json',
      'yaml',
      'yml',
      'kotlin',
      'swift',
      'php',
      'ruby',
      'scala',
      'dockerfile',
      'powershell',
      'markdown',
    ];
    for (const fence of fences) {
      expect(resolveLanguage(fence), `fence ${fence}`).not.toBeNull();
    }
  });

  it('canonicalizes aliases to registered language names', () => {
    expect(resolveLanguage('js')).toBe('javascript');
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('py')).toBe('python');
    expect(resolveLanguage('c++')).toBe('cpp');
    expect(resolveLanguage('c#')).toBe('csharp');
    expect(resolveLanguage('cs')).toBe('csharp');
    expect(resolveLanguage('golang')).toBe('go');
    expect(resolveLanguage('html')).toBe('xml');
  });

  it('is case-insensitive and ignores trailing info-string attributes', () => {
    expect(resolveLanguage('JS')).toBe('javascript');
    expect(resolveLanguage('TypeScript')).toBe('typescript');
    expect(resolveLanguage('js {1-3}')).toBe('javascript');
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
// Full language registry
// ---------------------------------------------------------------------------

describe('listSupportedLanguages', () => {
  it('exposes the full highlight.js component language set', () => {
    const langs = listSupportedLanguages();
    // Full package ships ~190 grammars; plain-text markers are filtered out.
    expect(langs.length).toBeGreaterThan(100);
    expect(langs).toContain('javascript');
    expect(langs).toContain('typescript');
    expect(langs).toContain('kotlin');
    expect(langs).toContain('dockerfile');
    expect(langs).not.toContain('plaintext');
    // Sorted for stable picker UI.
    expect(langs).toEqual([...langs].sort((a, b) => a.localeCompare(b)));
  });
});

// ---------------------------------------------------------------------------
// highlightCode
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
    { language: 'kotlin', code: 'fun main() { val x = 1 }', marker: 'hljs-keyword' },
  ];

  it.each(languageSamples)(
    'highlights $language with hljs classes ($marker)',
    ({ language, code, marker }) => {
      const html = highlightCode(language, code);
      expect(html).toContain(marker);
      expect(html).toContain('<span class="hljs-');
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
// tokenizeCode / scopeToClasses
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
// Language select helpers
// ---------------------------------------------------------------------------

/** Minimal DOM fake for language picker construction (no jsdom). */
class FakeEl {
  tagName: string;
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  placeholder = '';
  type = '';
  autocomplete = '';
  spellcheck = false;
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  dataset: Record<string, string> = {};
  parentNode: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeEl): FakeEl {
    this.children = this.children.filter((c) => c !== child);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }

  replaceChildren(...kids: FakeEl[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [...kids];
    for (const c of kids) c.parentNode = this;
  }

  getBoundingClientRect(): {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  } {
    return { top: 10, bottom: 36, left: 20, right: 120, width: 100, height: 26 };
  }

  addEventListener(type: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((x) => x !== fn),
    );
  }

  focus(): void {
    /* no-op */
  }

  select(): void {
    /* no-op */
  }

  contains(node: FakeEl): boolean {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  classList = {
    add: (c: string): void => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      parts.add(c);
      this.className = [...parts].join(' ');
    },
    remove: (c: string): void => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      parts.delete(c);
      this.className = [...parts].join(' ');
    },
    toggle: (c: string, force?: boolean): boolean => {
      const has = this.className.split(/\s+/).includes(c);
      const next = force === undefined ? !has : force;
      if (next) this.classList.add(c);
      else this.classList.remove(c);
      return next;
    },
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };
}

function fakeDoc(): Document {
  const docListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const body = new FakeEl('body');
  return {
    body,
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: (type: string, fn: (...args: unknown[]) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (...args: unknown[]) => void) => {
      const list = docListeners.get(type) ?? [];
      docListeners.set(
        type,
        list.filter((x) => x !== fn),
      );
    },
  } as unknown as Document;
}

describe('language picker helpers', () => {
  it('languageSelectValue normalizes known tags and blanks unknown/plain', () => {
    expect(languageSelectValue('js')).toBe('javascript');
    expect(languageSelectValue('TypeScript')).toBe('typescript');
    expect(languageSelectValue('c#')).toBe('csharp');
    expect(languageSelectValue('')).toBe('');
    expect(languageSelectValue('plaintext')).toBe('');
    expect(languageSelectValue('not-a-lang')).toBe('');
  });

  it('languageDisplayLabel maps empty to Plain text and mermaid to Flowchart', () => {
    expect(languageDisplayLabel('')).toBe('Plain text');
    expect(languageDisplayLabel('python')).toBe('python');
    expect(languageDisplayLabel('mermaid')).toBe('Flowchart');
  });

  it('resolveLanguage recognizes mermaid as a special language', async () => {
    const { resolveLanguage, listSupportedLanguages } = await import('../code-highlight.js');
    expect(resolveLanguage('mermaid')).toBe('mermaid');
    expect(resolveLanguage('Mermaid')).toBe('mermaid');
    expect(listSupportedLanguages()).toContain('mermaid');
  });

  it('filterLanguages does case-insensitive substring match', () => {
    const langs = ['javascript', 'typescript', 'python', 'java'];
    expect(filterLanguages('', langs)).toEqual(langs);
    expect(filterLanguages('script', langs)).toEqual(['javascript', 'typescript']);
    expect(filterLanguages('PY', langs)).toEqual(['python']);
    expect(filterLanguages('zzz', langs)).toEqual([]);
  });

  it('plainLanguageMatches keeps Plain text visible for empty/partial queries', () => {
    expect(plainLanguageMatches('')).toBe(true);
    expect(plainLanguageMatches('plain')).toBe(true);
    expect(plainLanguageMatches('text')).toBe(true);
    expect(plainLanguageMatches('kotlin')).toBe(false);
  });

  it('createLanguagePicker exposes current value and updates via setValue', () => {
    const picker = createLanguagePicker({
      current: 'ts',
      languages: ['javascript', 'typescript', 'python'],
      doc: fakeDoc(),
    });
    expect(picker.getValue()).toBe('typescript');
    picker.setValue('py');
    expect(picker.getValue()).toBe('python');
    picker.setValue('');
    expect(picker.getValue()).toBe('');
    picker.destroy();
  });

  it('setCodeBlockLanguage dispatches setNodeMarkup when language changes', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
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
    const doc = schema.nodes['doc']!.create(
      null,
      schema.nodes['code_block']!.create({ language: 'js' }, schema.text('const x = 1;')),
    );
    const dispatched: unknown[] = [];
    const view = {
      state: {
        doc,
        get tr() {
          return {
            setNodeMarkup: (_pos: number, _type: unknown, attrs: { language: string }) => ({
              attrs,
            }),
          };
        },
      },
      dispatch: (tr: unknown) => {
        dispatched.push(tr);
      },
    };

    expect(setCodeBlockLanguage(view as never, 0, 'python')).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(setCodeBlockLanguage(view as never, 0, 'js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R8 copy button logic
// ---------------------------------------------------------------------------

describe('R8 copy button logic', () => {
  it('readCodeSource preserves multi-line text and indentation exactly', () => {
    const code = 'def f():\n    return 1\n';
    expect(readCodeSource({ textContent: code })).toBe(code);
    expect(readCodeSource({ textContent: 'a\tb\r\nc' })).toBe('a\tb\r\nc');
  });

  it('readCodeSource returns empty string when textContent is null', () => {
    expect(readCodeSource({ textContent: null })).toBe('');
  });

  it('copyButtonLabel toggles between default and copied labels', () => {
    expect(copyButtonLabel(false)).toBe('Copy');
    expect(copyButtonLabel(true)).toBe('Copied');
  });

  it('copyButtonClassName appends copied modifier only when copied', () => {
    expect(copyButtonClassName(false)).toBe('lightink-code-copy-btn');
    expect(copyButtonClassName(true)).toBe(
      'lightink-code-copy-btn lightink-code-copy-btn--copied',
    );
  });
});

// ---------------------------------------------------------------------------
// Milkdown / ProseMirror wiring
// ---------------------------------------------------------------------------

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

function decoAttrs(d: unknown): Record<string, string | undefined> {
  return (d as { type: { attrs: Record<string, string | undefined> } }).type.attrs;
}

describe('codeHighlightPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(codeHighlightPlugin).toBeDefined();
    expect(typeof codeHighlightPlugin).toBe('function');
    const shaped = codeHighlightPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    expect(shaped.plugin()).toBeUndefined();
  });

  it('adds a node decoration with language class for known languages', () => {
    const doc = codeDoc({ language: 'js', code: 'const x = 1;' });
    const found = buildCodeDecorations(doc).find();
    const nodeDeco = found.find((d) => decoAttrs(d)['data-language'] === 'javascript');
    expect(nodeDeco).toBeDefined();
    expect(decoAttrs(nodeDeco)['class']).toBe('hljs language-javascript');
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

  it('highlights shell fence via registered shell language', () => {
    const doc = codeDoc({ language: 'shell', code: 'echo hi # c' });
    const found = buildCodeDecorations(doc).find();
    const lang = found
      .map((d) => decoAttrs(d)['data-language'])
      .find((v): v is string => v !== undefined);
    expect(lang).toBe('shell');
  });

  it('inline decorations land on correct offsets across multiple blocks', () => {
    const doc = codeDoc(
      { language: 'js', code: 'const a = 1;' },
      { language: '', code: 'plain' },
      { language: 'py', code: 'def f(): pass' },
    );
    const found = buildCodeDecorations(doc).find();
    const languages = found
      .map((d) => decoAttrs(d)['data-language'])
      .filter((v): v is string => v !== undefined);
    expect(languages).toEqual(['javascript', 'python']);
  });
});
