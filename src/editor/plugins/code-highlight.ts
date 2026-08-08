/**
 * Code block syntax highlighting plugin (T5 / R4).
 *
 * Design (per docs/sakullla-workflow/.../02-technical-solution.md「代码高亮：
 * highlight.js，按需注册语言」):
 *
 *   - Uses `highlight.js/lib/core` + 14 explicitly imported language grammars
 *     (JS/TS/Python/Java/Go/Rust/C/C++/HTML/CSS/SQL/Shell/JSON/YAML) instead of
 *     the full `highlight.js` bundle, keeping the bundle impact bounded (R12).
 *     Registration is static-but-minimal rather than lazy-dynamic: dynamic
 *     `import()` per language would split grammars into async chunks and force
 *     the ProseMirror decoration pass to be async (highlight → re-decorate),
 *     adding flicker and complexity. 14 core grammars weigh ~90KB minified
 *     (far less gzipped) — acceptable for a desktop Tauri app where the
 *     bundle ships inside the installer.
 *
 *   - The pure logic is headless-testable:
 *       resolveLanguage(infoString)  — fence info-string → hljs language name
 *       tokenizeCode(language, code) — hljs token-tree walk → flat token list
 *       highlightCode(language, code)— token list → HTML string with
 *                                      `hljs-` classes (or escaped plain text)
 *
 *   - The ProseMirror wiring is a *decoration* plugin (`$prose`), not a
 *     nodeView. A nodeView that writes highlighted HTML into `code.innerHTML`
 *     fights ProseMirror's contentDOM text management (selection drift,
 *     mutation observers). Inline decorations keep PM in sole charge of the
 *     DOM text and only attach `hljs-*` classes to ranges — the standard
 *     approach used by milkdown's prism/shiki integrations.
 *
 *   - Unlabeled fences (```) and unknown languages fall back to escaped plain
 *     text: `highlightCode` returns HTML-escaped code with no hljs markup and
 *     the decoration pass returns no decorations. No crash, no classes (R4).
 *
 *   - Theme CSS (actual colors for `hljs-*` classes) is deferred to the T6
 *     theme system; this plugin only emits the semantic classes.
 */

import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

// ---------------------------------------------------------------------------
// Language registration — R4 要求的 14 种语言（按需注册，非全量 bundle）。
// ---------------------------------------------------------------------------

hljs.registerLanguage('javascript', hljsJavascript);
hljs.registerLanguage('typescript', hljsTypescript);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('c', hljsC);
hljs.registerLanguage('cpp', hljsCpp);
hljs.registerLanguage('xml', hljsXml); // 覆盖 HTML（xml 语法含 html 别名）
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('bash', hljsBash); // 覆盖 Shell
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('yaml', hljsYaml);

/** hljs 未内置别名的 fence 标记 → 已注册语法名。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  shell: 'bash',
  'c++': 'cpp',
  'c#': 'cpp', // 近似高亮（未注册 csharp，降级而非报错）
};

/** 显式要求纯文本的 fence 标记（不高亮，也不算 unknown）。 */
const PLAIN_TEXT_MARKERS: ReadonlySet<string> = new Set([
  'text',
  'plain',
  'plaintext',
  'txt',
]);

// ---------------------------------------------------------------------------
// 纯逻辑层（headless 可测）
// ---------------------------------------------------------------------------

/**
 * 把 fence info-string（如 `js`、`TS`、`shell`、` ``` ` 空串）解析为 hljs 可
 * 识别的语言名；空串 / 未知语言返回 null（调用方按纯文本处理）。
 *
 * 返回的可能是别名本身（`js`、`py`）——`hljs.getLanguage` / `hljs.highlight`
 * 都接受别名，因此不做规范化；仅对 hljs 自身未注册别名的标记
 * （`shell`、`c++`）显式映射到已注册语法名。
 */
export function resolveLanguage(infoString: string | null | undefined): string | null {
  if (infoString === null || infoString === undefined) return null;
  // info-string 可能带额外属性（如 ```js {1-3}），只取首段并小写化。
  const tag = infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (tag === '' || PLAIN_TEXT_MARKERS.has(tag)) return null;
  const name = LANGUAGE_ALIASES[tag] ?? tag;
  return hljs.getLanguage(name) !== undefined ? name : null;
}

/** 一段高亮 token：hljs scope（如 `keyword`）+ 原文文本。 */
export interface HighlightToken {
  readonly scope: string | null;
  readonly text: string;
}

interface HljsTokenNode {
  children?: Array<string | HljsTokenNode>;
  scope?: string;
}

interface HljsHighlightResultWithEmitter {
  value: string;
  _emitter?: { root?: HljsTokenNode; rootNode?: HljsTokenNode };
}

/**
 * 用 hljs 把 `code` 解析为扁平 token 序列（scope 链路以 `.` 连接，
 * 如 `comment.doc`）。`language` 为 null/未知时返回 null，表示「走纯文本」。
 *
 * 走的是 hljs 的 token-tree 内部 API（`_emitter.root`），这是把 hljs 结果
 * 映射到 ProseMirror 位置偏移的唯一无损途径（`value` HTML 重新解析会引入
 * 实体解码歧义）。该 API 在 hljs v11 中稳定，但属内部契约——升级 hljs 时
 * 需重跑本文件测试。
 */
export function tokenizeCode(
  language: string | null,
  code: string,
): readonly HighlightToken[] | null {
  if (language === null || hljs.getLanguage(language) === undefined) {
    return null;
  }
  let result: HljsHighlightResultWithEmitter;
  try {
    result = hljs.highlight(code, { language }) as HljsHighlightResultWithEmitter;
  } catch {
    // 语法内部异常（已知 hljs 对某些边缘输入抛错）→ 降级纯文本。
    return null;
  }
  const root = result._emitter?.root ?? result._emitter?.rootNode;
  if (root === undefined) {
    // 内部 API 形态变化 → 退化为「整段无 scope」，至少保证文本完整。
    return [{ scope: null, text: code }];
  }
  const tokens: HighlightToken[] = [];
  const walk = (node: string | HljsTokenNode, scopeChain: readonly string[]): void => {
    if (typeof node === 'string') {
      if (node.length > 0) {
        tokens.push({ scope: scopeChain.length > 0 ? scopeChain.join('.') : null, text: node });
      }
      return;
    }
    const nextChain = typeof node.scope === 'string' ? [...scopeChain, node.scope] : scopeChain;
    for (const child of node.children ?? []) {
      walk(child, nextChain);
    }
  };
  walk(root, []);
  return tokens;
}

/** HTML 转义（纯文本路径与高亮路径共用，保证 `<script>` 不被注入）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** token scope → hljs class 名（`keyword` → `hljs-keyword`，多段各加类）。 */
export function scopeToClasses(scope: string): string {
  return scope
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => `hljs-${part}`)
    .join(' ');
}

/**
 * 高亮 `code` 并返回 HTML 字符串：
 *   - 已知语言 → 带 `hljs-*` class 的 `<span>` 标记；
 *   - `language` 为 null / 未知 → 仅做 HTML 转义的纯文本，无任何 hljs 标记。
 */
export function highlightCode(language: string | null, code: string): string {
  const tokens = tokenizeCode(language, code);
  if (tokens === null) {
    return escapeHtml(code);
  }
  return tokens
    .map((token) =>
      token.scope === null
        ? escapeHtml(token.text)
        : `<span class="${escapeHtml(scopeToClasses(token.scope))}">${escapeHtml(token.text)}</span>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// ProseMirror decoration 层
// ---------------------------------------------------------------------------

export const codeHighlightPluginKey = new PluginKey<DecorationSet>(
  'lightink-code-highlight',
);

/**
 * 为整篇文档构建高亮 decorations：每个已知语言的 code_block 得到一个
 * node decoration（`hljs language-<name>`，供主题/导出识别）加上按 token
 * 偏移的 inline decorations。未知/未标注语言不产生任何 decoration。
 */
export function buildCodeDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true;
    const info = typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
    const language = resolveLanguage(info);
    if (language === null) return false; // 纯文本代码块：无 decoration，不进子树
    const code = node.textContent;
    const tokens = tokenizeCode(language, code);
    if (tokens === null) return false;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `hljs language-${language}`,
        'data-language': language,
      }),
    );
    // code_block 内文本从 pos + 1 开始（节点起始 token 占一位）。
    let offset = pos + 1;
    for (const token of tokens) {
      const end = offset + token.text.length;
      if (token.scope !== null) {
        decorations.push(
          Decoration.inline(offset, end, { class: scopeToClasses(token.scope) }),
        );
      }
      offset = end;
    }
    return false; // code_block 只含文本，无需继续下降
  });
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * Milkdown 插件（`$prose`）：为 code_block 注入语法高亮 decorations。
 * 在 mountEditor 中于 commonmark/gfm/history 之后注册。
 */
export const codeHighlightPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: codeHighlightPluginKey,
      state: {
        init: (_config, state) => buildCodeDecorations(state.doc),
        apply: (tr, old, _oldState, newState) => {
          // 仅文档变化时重算；纯选区/事务元数据变化复用旧集合（大文档 R10）。
          return tr.docChanged ? buildCodeDecorations(newState.doc) : old;
        },
      },
      props: {
        decorations(state) {
          return codeHighlightPluginKey.getState(state);
        },
      },
    }),
);
