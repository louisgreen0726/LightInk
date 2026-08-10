/**
 * `fb2` — FictionBook 2 解析（ebook-reader T4）。
 *
 * FB2 是结构化 XML：把 <section> 映射为章节，把 FB2 语义标签转换为 HTML
 * （emphasis→em、strikethrough→s、poem/stanza/v、cite→blockquote 等），剥离
 * 包裹标签（section/body/FictionBook/annotation 等，保留内部文本），结果经
 * sanitizeHtml 消毒。纯字符串实现（无 DOMParser），node 可测；FB2 文本应为 UTF-8。
 */

import { sanitizeHtml } from '../sanitize.js';
import type { ReaderContent } from './types.js';

/** FB2 标签 → HTML 标签的成对改名（开/闭一并）。 */
const RENAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/<(\/?)emphasis\b[^>]*>/gi, '<$1em>'],
  [/<(\/?)strikethrough\b[^>]*>/gi, '<$1s>'],
  [/<(\/?)strong\b[^>]*>/gi, '<$1strong>'],
  [/<(\/?)code\b[^>]*>/gi, '<$1code>'],
  [/<(\/?)sub\b[^>]*>/gi, '<$1sub>'],
  [/<(\/?)sup\b[^>]*>/gi, '<$1sup>'],
  [/<(\/?)poem\b[^>]*>/gi, '<$1div>'],
  [/<(\/?)stanza\b[^>]*>/gi, '<$1p>'],
  [/<(\/?)epigraph\b[^>]*>/gi, '<$1blockquote>'],
  [/<(\/?)cite\b[^>]*>/gi, '<$1blockquote>'],
  [/<(\/?)text-author\b[^>]*>/gi, '<$1p>'],
  [/<(\/?)subtitle\b[^>]*>/gi, '<$1p>'],
];

/** 保留的 HTML 容器标签（其余标签剥离但保留内部文本）。 */
const KEEP_TAGS = new Set([
  'p', 'em', 'strong', 's', 'code', 'sub', 'sup', 'br', 'hr',
  'div', 'blockquote', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
]);

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => safeFromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m && m[1] !== undefined ? m[1] : null;
}

/** 把 FB2 片段（不含 <title>）转换为 HTML：语义改名、链接/换行/图片处理、剥离未知标签。 */
function fb2ToHtml(fragment: string): string {
  let s = fragment;
  for (const [re, rep] of RENAMES) {
    s = s.replace(re, rep);
  }
  // l:href="#id" / l:href="url" → href。
  s = s.replace(/<a\b([^>]*)\bl:href=(["'])#?([^"']*)\2/gi, '<a$1href="#$3"');
  s = s.replace(/<a\b([^>]*)\bl:href=(["'])([^"']*)\2/gi, '<a$1href="$3"');
  // 空行 / 诗行 / 图片。
  s = s.replace(/<empty-line\s*\/?\s*>/gi, '<br>');
  s = s.replace(/<v\b[^>]*>([\s\S]*?)<\/v>/gi, '$1<br>');
  s = s.replace(/<image\b[^>]*\/?>/gi, '');
  // 剥离非保留标签（保留内部文本）：section/title/body/annotation/coverpage/FictionBook 等。
  s = s.replace(/<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, name) => {
    return KEEP_TAGS.has(String(name).toLowerCase()) ? whole : '';
  });
  return s;
}

/** 提取 <title>...</title> 的纯文本（去标签）作为章节标题。 */
function extractTitle(fragment: string): string {
  const titleMatch = fragment.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch === null || titleMatch[1] === undefined) {
    return '';
  }
  return decodeXmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

/**
 * 解析 FB2 字节为章节化阅读内容。取主 <body>（非注释体）的顶层 <section> 为章节；
 * 无 section 时整体作为一个章节。HTML 经消毒。
 */
export function parseFb2(bytes: Uint8Array): ReaderContent {
  const xml = decodeText(bytes);
  const bookTitle = decodeXmlEntities(firstMatch(xml, /<book-title\b[^>]*>([\s\S]*?)<\/book-title>/i) ?? '').trim();

  // 主 body（无 name 属性或 name="body"）。
  const bodies = [...xml.matchAll(/<body\b([^>]*)>([\s\S]*?)<\/body>/gi)];
  const main = bodies.find((b) => !/name=/i.test(b[1] ?? '')) ?? bodies[0];
  const bodyXml = main ? (main[2] ?? '') : xml;

  const chapters: ReaderContent['chapters'] = [];
  const sectionRe = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
  let m: RegExpExecArray | null;
  let matched = false;
  let idx = 0;
  while ((m = sectionRe.exec(bodyXml)) !== null) {
    matched = true;
    const section = m[1] ?? '';
    const title = extractTitle(section) || (idx === 0 && bookTitle ? bookTitle : `Section ${idx + 1}`);
    const bodyHtml = fb2ToHtml(section.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, ''));
    chapters.push({ title, html: sanitizeHtml(bodyHtml) });
    idx += 1;
  }
  if (!matched) {
    const title = bookTitle;
    const bodyHtml = fb2ToHtml(bodyXml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, ''));
    chapters.push({ title, html: sanitizeHtml(bodyHtml) });
  }
  return { chapters };
}
