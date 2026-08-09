/**
 * `html-to-markdown` — R8 富文本粘贴的纯 TS allowlist HTML→Markdown 转换层。
 *
 * 设计取舍：
 *   - **纯 TS、零依赖、不依赖 DOM/DOMParser**：测试在 node 环境跑，且 WebView2 与
 *     node 行为一致；自写极简 tokenizer + 栈式建树 + 递归发射。
 *   - **allowlist**：只识别常见可映射标签（标题/段落/列表/任务项/引用/代码块/行内代码/
 *     链接/图片/粗斜体删除线/表格/分隔线/换行）。未知标签作为透明容器放行其子节点，
 *     script/style/head 及其文本整体丢弃。
 *   - **宽容、不崩溃**：飞书/钉钉/Word/浏览器的 HTML 常残缺（未闭合标签、错位嵌套、
 *     专有属性）。任何异常整体回退为空串，由调用方回退纯文本/默认粘贴，绝不抛出。
 *   - **不追求 100% 还原**：不可靠映射的复杂排版降级为可读近似文本（R8 边界）。
 *
 * 只导出 `convertHtmlToMarkdown`；分词/建树/发射为内部细节，单测经该函数黑盒覆盖。
 */

/** 常见 HTML 实体（含中文写作环境常见的全角空格不在此处——nbsp 解为普通空格）。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '(c)',
  reg: '(r)',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bull: '•',
  middot: '·',
};

/** 解码 HTML 实体（命名 + 十进制 + 十六进制）。未知命名实体保留原样。 */
export function decodeEntities(input: string): string {
  if (input.indexOf('&') === -1) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? whole : safeFromCodePoint(cp);
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? whole : safeFromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
      ? NAMED_ENTITIES[body]
      : whole;
  });
}

function safeFromCodePoint(cp: number): string {
  try {
    if (cp <= 0 || cp > 0x10ffff) return '';
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface OpenToken {
  type: 'open';
  tag: string;
  attrs: Readonly<Record<string, string>>;
  selfClosing: boolean;
}
interface CloseToken {
  type: 'close';
  tag: string;
}
interface TextToken {
  type: 'text';
  value: string;
}
type Token = OpenToken | CloseToken | TextToken;

/** 匹配一个标签：闭合前缀、标签名、属性串（属性值可含引号内的 >）。 */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'=]+)))?/g;

/**
 * 剥离 HTML 注释 / DOCTYPE / CDATA / 处理指令（含未闭合截断情形）：
 * Windows CF_HTML 剪贴板（浏览器 <!--StartFragment-->、Word 条件注释）几乎
 * 必然携带；TAG_RE 不识别它们时会落入文本节点、经 escapeMd 变成可见垃圾
 * 文本（Delivery Review P1）。已知取舍：<pre> 内作为字面示例出现的注释同样
 * 被剥离——真实剪贴板来源中这远比可见垃圾罕见。
 */
const JUNK_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[\s\S]*?\?>/g;

/** 没有闭合标签的 void 元素（allowlist 内）。 */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'wbr']);

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrString)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name !== '') {
      attrs[name] = decodeEntities(value);
    }
  }
  return attrs;
}

function tokenize(html: string): Token[] {
  const cleaned = html.replace(JUNK_RE, '');
  const tokens: Token[] = [];
  TAG_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(cleaned)) !== null) {
    if (m.index > last) {
      const text = cleaned.slice(last, m.index);
      if (text !== '') tokens.push({ type: 'text', value: text });
    }
    last = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      tokens.push({ type: 'close', tag });
    } else {
      const attrs = parseAttrs(m[3]);
      tokens.push({ type: 'open', tag, attrs, selfClosing: VOID_TAGS.has(tag) || m[3].endsWith('/') });
    }
  }
  if (last < cleaned.length) {
    const text = cleaned.slice(last);
    if (text !== '') tokens.push({ type: 'text', value: text });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

interface Node {
  tag: string; // 'root' 或具体标签名；文本节点为 '#text'
  attrs: Record<string, string>;
  children: Node[];
  text?: string; // 仅 #text
}

function node(tag: string, attrs: Record<string, string> = {}): Node {
  return { tag, attrs, children: [] };
}

/** 需要整体丢弃内容（含文本）的标签。 */
const DROP_TAGS = new Set(['script', 'style', 'head', 'noscript', 'iframe', 'svg', 'canvas']);

/** 栈式建树：宽容处理未闭合/错位标签——闭合时回溯到最近同名祖先。 */
function buildTree(tokens: Token[]): Node {
  const root = node('root');
  const stack: Node[] = [root];
  let dropDepth = 0; // 处于被丢弃标签内的深度

  for (const tok of tokens) {
    const top = stack[stack.length - 1];

    if (tok.type === 'text') {
      if (dropDepth === 0) {
        top.children.push({ tag: '#text', attrs: {}, children: [], text: tok.value });
      }
      continue;
    }

    if (tok.type === 'open') {
      if (dropDepth > 0) {
        if (!tok.selfClosing) dropDepth += 1;
        continue;
      }
      if (DROP_TAGS.has(tok.tag) && !tok.selfClosing) {
        dropDepth = 1;
        continue;
      }
      const child = node(tok.tag, { ...tok.attrs });
      top.children.push(child);
      if (!tok.selfClosing) {
        stack.push(child);
      }
      continue;
    }

    // close
    if (dropDepth > 0) {
      dropDepth -= 1;
      continue;
    }
    const idx = (() => {
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tag === tok.tag) return i;
      }
      return -1;
    })();
    if (idx >= 1) {
      stack.length = idx;
    }
    // 无匹配的闭合标签：忽略。
  }
  return root;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const INLINE_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 's', 'strike', 'del', 'code', 'img', 'br',
  'span', 'sub', 'sup', 'small', 'u', 'mark', 'font',
]);

/** 块级标签集合（其余按 inline 处理）。 */
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'table', 'tr', 'hr', 'div', 'section', 'article', 'header', 'footer',
  'figure',
]);

function isBlock(tag: string): boolean {
  return BLOCK_TAGS.has(tag);
}

/** 发射一个节点的 inline 子树（不含块级换行）。 */
function emitInline(n: Node): string {
  let out = '';
  for (const child of n.children) {
    out += emitInlineNode(child);
  }
  return out;
}

function emitInlineNode(n: Node): string {
  if (n.tag === '#text') {
    // 折叠连续空白为单空格（HTML 默认行为，pre 由 extractCodeBlock 另走不折叠路径）。
    return escapeMd(decodeEntities(n.text ?? '')).replace(/[ \t\r\n\f]+/g, ' ');
  }
  switch (n.tag) {
    case 'br':
      return '\n';
    case 'img': {
      const alt = n.attrs.alt ?? '';
      const src = n.attrs.src ?? '';
      if (src === '') return alt;
      return `![${alt}](${src})`;
    }
    case 'a': {
      const inner = emitInline(n).trim();
      const href = n.attrs.href ?? '';
      if (href === '' || href.startsWith('javascript:')) {
        return inner;
      }
      return inner === '' ? href : `[${inner}](${href})`;
    }
    case 'b':
    case 'strong': {
      const inner = emitInline(n);
      return inner === '' ? '' : `**${inner}**`;
    }
    case 'i':
    case 'em': {
      const inner = emitInline(n);
      return inner === '' ? '' : `*${inner}*`;
    }
    case 's':
    case 'strike':
    case 'del': {
      const inner = emitInline(n);
      return inner === '' ? '' : `~~${inner}~~`;
    }
    case 'code': {
      const inner = emitInline(n);
      return inner === '' ? '' : `\`${inner}\``;
    }
    default:
      // 其它 inline/未知 inline 标签：透明放行子节点。
      return emitInline(n);
  }
}

/** 转义 Markdown 行内特殊字符（保守：仅反引号/方括号/星号等在纯文本开头时）。 */
function escapeMd(text: string): string {
  // 不做激进转义以免污染普通中文/英文文本；仅处理会破坏 GFM 结构的裸 HTML 残留尖括号。
  return text.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));
}

/** 收尾规整一段 inline 文本：清理 br 两侧空格、折叠多空格、去首尾空白（保留 <br> 换行）。 */
function cleanInline(text: string): string {
  return text.replace(/ *\n */g, '\n').replace(/ {2,}/g, ' ').trim();
}

/** 节点是否为 inline/文本（块级上下文里据此把连续 inline 子节点聚成一段）。 */
function isInlineNode(n: Node): boolean {
  return n.tag === '#text' || INLINE_TAGS.has(n.tag);
}

/** 发射块级子树：连续 inline/文本子节点聚成一段，块级子节点各自成段，空行分隔。 */
function emitBlockChildren(n: Node): string {
  const parts: string[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const inline = cleanInline(run.map(emitInlineNode).join(''));
    if (inline !== '') parts.push(inline);
    run = [];
  };
  for (const child of n.children) {
    if (isInlineNode(child)) {
      run.push(child);
      continue;
    }
    flush();
    const emitted = emitBlockNode(child);
    if (emitted !== '') parts.push(emitted);
  }
  flush();
  return parts.filter((p) => p !== '').join('\n\n');
}

function emitBlockNode(n: Node): string {
  if (INLINE_TAGS.has(n.tag) && !isBlock(n.tag)) {
    // inline 节点出现在块级上下文：包成一段。
    return cleanInline(emitInline(n));
  }
  switch (n.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(n.tag[1]);
      const inner = cleanInline(emitInline(n));
      return inner === '' ? '' : `${'#'.repeat(level)} ${inner}`;
    }
    case 'p': {
      return cleanInline(emitInline(n));
    }
    case 'hr':
      return '---';
    case 'pre': {
      const code = extractCodeBlock(n);
      return code === '' ? '' : `\`\`\`\n${code}\n\`\`\``;
    }
    case 'blockquote': {
      const inner = emitBlockChildren(n);
      if (inner === '') return '';
      return inner
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    }
    case 'ul':
    case 'ol':
      return emitList(n, n.tag === 'ol');
    case 'table':
      return emitTable(n);
    case 'li':
      // 裸 li（无列表包裹）：按无序项兜底。
      return `- ${emitListItem(n).trim()}`;
    default:
      // 透明容器 / 未知块：递归子节点。
      return emitBlockChildren(n);
  }
}

/** 提取 <pre> 的纯文本（兼容 <pre><code>…</code></pre>）。 */
function extractCodeBlock(pre: Node): string {
  const collect = (n: Node): string => {
    if (n.tag === '#text') return decodeEntities(n.text ?? '');
    if (n.tag === 'br') return '\n';
    return n.children.map(collect).join('');
  };
  // code 子节点取其文本；否则取 pre 全部文本。
  const codeChild = pre.children.find((c) => c.tag === 'code');
  const raw = collect(codeChild ?? pre);
  // 去除首尾换行、规整 \r\n。
  return raw.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
}

/** 发射列表（支持嵌套与任务项 input[type=checkbox]）。 */
function emitList(list: Node, ordered: boolean): string {
  const lines: string[] = [];
  let i = 0;
  for (const child of list.children) {
    if (child.tag !== 'li') continue;
    i += 1;
    const marker = ordered ? `${i}. ` : '- ';
    emitListItemInto(child, marker, 0, lines);
  }
  return lines.join('\n');
}

/** li 的 inline 文本（不含嵌套子列表，不含 checkbox input）。 */
function emitListItem(li: Node): string {
  // li 的 inline/文本子节点作为连续一段（保留原间距、折叠空白、保留 <br>）；input/嵌套列表略过。
  const inlineNodes: Node[] = [];
  for (const child of li.children) {
    if (child.tag === 'ul' || child.tag === 'ol' || child.tag === 'input') continue;
    inlineNodes.push(child);
  }
  return cleanInline(inlineNodes.map(emitInlineNode).join(''));
}

function emitListItemInto(li: Node, marker: string, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  // 任务项：<li><input type="checkbox" checked>…</li>
  const input = li.children.find(
    (c) => c.tag === 'input' && (c.attrs.type ?? '').toLowerCase() === 'checkbox',
  );
  let prefix = marker;
  if (input !== undefined) {
    prefix = input.attrs.checked !== undefined ? '- [x] ' : '- [ ] ';
  }
  const text = emitListItem(li).trim();
  lines.push(`${indent}${prefix}${text}`);
  // 嵌套子列表。
  for (const child of li.children) {
    if (child.tag === 'ul') emitListInto(child, false, depth + 1, lines);
    else if (child.tag === 'ol') emitListInto(child, true, depth + 1, lines);
  }
}

function emitListInto(list: Node, ordered: boolean, depth: number, lines: string[]): void {
  let i = 0;
  for (const child of list.children) {
    if (child.tag !== 'li') continue;
    i += 1;
    const marker = ordered ? `${i}. ` : '- ';
    emitListItemInto(child, marker, depth, lines);
  }
}

/** 发射 GFM 表格（首行表头 + 分隔行 + 数据行）。无 th 时取首 tr 作表头。 */
function emitTable(table: Node): string {
  const rows: { cells: string[]; isHeader: boolean }[] = [];
  const walk = (n: Node): void => {
    for (const child of n.children) {
      if (child.tag === 'tr') {
        const cells = child.children
          .filter((c) => c.tag === 'td' || c.tag === 'th')
          .map((c) => emitInline(c).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
        const isHeader = child.children.some((c) => c.tag === 'th');
        rows.push({ cells, isHeader });
      } else if (['thead', 'tbody', 'tfoot', 'table'].includes(child.tag)) {
        walk(child);
      }
    }
  };
  walk(table);
  if (rows.length === 0) return '';
  const width = rows.reduce((max, r) => Math.max(max, r.cells.length), 0);
  if (width === 0) return '';
  const pad = (cells: string[]): string[] => {
    const out = [...cells];
    while (out.length < width) out.push('');
    return out;
  };
  let headerIdx = rows.findIndex((r) => r.isHeader);
  if (headerIdx === -1) headerIdx = 0;
  const header = pad(rows[headerIdx].cells);
  const body = rows.filter((_, idx) => idx !== headerIdx).map((r) => pad(r.cells));
  const sep = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * 规整空白：折叠非代码区段的 3+ 连续空行、去非代码行尾空白、去首尾空白。
 * 关键：代码块围栏内的内容原样保留——按行扫描跟踪 ``` 围栏开关，仅对非代码行规整，
 * 避免静默压缩代码内空行、剥离行尾空白（篡改代码内容）。
 */
function normalize(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  // 第一遍：非代码行去尾随空白；围栏行与代码行原样。
  const stripped = lines.map((line) => {
    if (/^```/.test(line)) {
      inCode = !inCode;
      return line;
    }
    return inCode ? line : line.replace(/[ \t]+$/g, '');
  });
  // 第二遍：非代码区段内连续空行压缩至最多一个；代码块内空行原样保留。
  const out: string[] = [];
  inCode = false;
  let blankRun = 0;
  for (const line of stripped) {
    if (/^```/.test(line)) {
      inCode = !inCode;
      blankRun = 0;
      out.push(line);
      continue;
    }
    if (inCode) {
      blankRun = 0;
      out.push(line);
      continue;
    }
    if (line === '') {
      blankRun += 1;
      if (blankRun <= 1) out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

/**
 * 将一段富文本 HTML（飞书/钉钉/浏览器/Word 等）转换为近似 GFM Markdown。
 * 任何解析异常返回空串，调用方据此回退纯文本/默认粘贴——绝不抛出。
 */
export function convertHtmlToMarkdown(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  try {
    const tokens = tokenize(html);
    const tree = buildTree(tokens);
    const md = emitBlockChildren(tree);
    return normalize(md);
  } catch {
    return '';
  }
}
