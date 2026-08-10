/**
 * `epub` — EPUB 解析（ebook-reader T4）。
 *
 * EPUB 是 zip 容器：读 META-INF/container.xml 定位 OPF，解析 OPF 的 manifest/spine
 * 得到按顺序的 XHTML 章节文件，抽取各 <body> 内容并消毒为章节化 HTML。
 * jszip 经动态 import 懒加载（独立 chunk，不进首屏 bundle）。纯字符串解析 OPF/XHTML
 * （无 DOMParser），node 可测（测试用 jszip 合成最小 EPUB）。
 */

import { sanitizeHtml } from '../sanitize.js';
import { ParseError, type ReaderContent } from './types.js';

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

/** 从标签字符串中取属性值。 */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 把相对 href 解析到 zip 内的完整路径（相对 OPF 所在目录）。 */
function resolveHref(opfPath: string, href: string): string {
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const seg of (dir + href).split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg !== '.' && seg !== '') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/**
 * 解析 EPUB 字节为章节化阅读内容。jszip 懒加载；OPF 缺失/损坏抛 ParseError。
 */
export async function parseEpub(bytes: Uint8Array): Promise<ReaderContent> {
  // 懒加载 jszip：生产构建独立为 chunk，不进首屏 bundle。
  const JSZip = (await import('jszip')).default;
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ParseError('EPUB 文件损坏或不是有效的 zip 容器');
  }

  // 1. container.xml → OPF 路径。
  let opfPath: string | null = null;
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile !== null) {
    const container = await containerFile.async('string');
    const m = container.match(/<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i);
    if (m !== null) {
      opfPath = m[2] ?? m[3] ?? null;
    }
  }
  if (opfPath === null) {
    const opfNames = Object.keys(zip.files).filter((n) => /\.opf$/i.test(n));
    if (opfNames.length === 0) {
      throw new ParseError('EPUB 缺少 OPF 包文件');
    }
    opfPath = opfNames[0]!;
  }
  const opfFile = zip.file(opfPath);
  if (opfFile === null) {
    throw new ParseError('EPUB OPF 文件缺失');
  }
  const opf = await opfFile.async('string');

  const bookTitle = (opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '').trim();

  // 2. manifest：id → item。
  const items = new Map<string, ManifestItem>();
  const itemRe = /<item\b[^>]*?\/?>/gi;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(opf)) !== null) {
    const tag = im[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    const mediaType = attr(tag, 'media-type') ?? '';
    if (id !== null && href !== null) {
      items.set(id, { id, href, mediaType });
    }
  }

  // 3. spine：阅读顺序。
  const spineIds: string[] = [];
  const spineRe = /<itemref\b[^>]*?\/?>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = spineRe.exec(opf)) !== null) {
    const idref = attr(sm[0], 'idref');
    if (idref !== null) {
      spineIds.push(idref);
    }
  }

  // 4. 逐 spine 读取 XHTML body 为章节。
  const chapters: ReaderContent['chapters'] = [];
  let idx = 0;
  for (const idref of spineIds) {
    const item = items.get(idref);
    if (item === undefined || !/x?html/i.test(item.mediaType)) {
      continue;
    }
    const fullPath = resolveHref(opfPath, decodeXmlEntities(item.href));
    const file = zip.file(fullPath) ?? zip.file(item.href);
    if (file === null) {
      continue;
    }
    const xhtml = await file.async('string');
    const body = xhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
    const sectionTitle = (xhtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    const title =
      sectionTitle || (idx === 0 && bookTitle ? bookTitle : `Chapter ${idx + 1}`);
    chapters.push({ title, html: sanitizeHtml(body) });
    idx += 1;
  }

  if (chapters.length === 0) {
    throw new ParseError('EPUB 未找到可读章节内容');
  }
  return { chapters };
}
