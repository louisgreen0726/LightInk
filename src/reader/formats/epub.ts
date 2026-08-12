/**
 * `epub` — EPUB 解析（ebook-reader T4）。
 *
 * EPUB 是 zip 容器：读 META-INF/container.xml 定位 OPF，解析 OPF 的 manifest/spine
 * 得到按顺序的 XHTML 章节文件，抽取各 <body> 内容并消毒为章节化 HTML。
 * ZIP central-directory metadata is checked before decompression. Pure string parsing keeps
 * OPF/XHTML handling testable in Node.
 */

import { sanitizeHtml } from '../sanitize.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { openSafeArchive } from './safe-archive.js';
import {
  ParseError,
  ReaderLimitError,
  type ReaderContent,
} from './types.js';
import {
  MAX_READER_IMAGE_BYTES,
  SAFE_READER_IMAGE_MIME_TYPES,
} from './resource-limits.js';

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

interface ArchiveReference {
  path: string;
  fragment: string;
}

/** Resolve a relative package reference without allowing it to walk above the archive root. */
function resolveArchiveReference(basePath: string, href: string): ArchiveReference | null {
  const value = decodeXmlEntities(href).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    return null;
  }
  const hashIndex = value.indexOf('#');
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : '';
  const withoutFragment = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutFragment.indexOf('?');
  const encodedPath = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
  let referencePath: string;
  try {
    referencePath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (referencePath === '') {
    return { path: basePath, fragment };
  }
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  const joined = referencePath.startsWith('/') ? referencePath.slice(1) : dir + referencePath;
  for (const seg of joined.split('/')) {
    if (seg === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else if (seg !== '.' && seg !== '') {
      parts.push(seg);
    }
  }
  return { path: parts.join('/'), fragment };
}

/**
 * Parse EPUB bytes into chapters. Missing/corrupt package data throws ParseError.
 */
export async function parseEpub(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ReaderContent> {
  const archive = await openSafeArchive(bytes, 'EPUB', signal);
  const resourceUrls = new Map<string, string>();
  let returnedContent = false;
  const dispose = (): void => {
    for (const url of resourceUrls.values()) {
      URL.revokeObjectURL(url);
    }
    resourceUrls.clear();
  };
  try {
    // 1. container.xml → OPF 路径。
    let opfPath: string | null = null;
    const containerFile = archive.file('META-INF/container.xml');
    if (containerFile !== null) {
      const container = await containerFile.readText(signal);
      throwIfReaderLoadCancelled(signal);
      const m = container.match(/<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i);
      if (m !== null) {
        opfPath = m[2] ?? m[3] ?? null;
      }
    }
    if (opfPath === null) {
      const opfNames = archive.entries
        .map((entry) => entry.filename)
        .filter((name) => /\.opf$/i.test(name));
      if (opfNames.length === 0) {
        throw new ParseError('EPUB 缺少 OPF 包文件');
      }
      opfPath = opfNames[0]!;
    }
    const opfFile = archive.file(opfPath);
    if (opfFile === null) {
      throw new ParseError('EPUB OPF 文件缺失');
    }
    const opf = await opfFile.readText(signal);
    throwIfReaderLoadCancelled(signal);

    const bookTitle = (
      opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? ''
    ).trim();

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

    const spineItems = spineIds
      .map((idref) => items.get(idref))
      .filter(
        (item): item is ManifestItem =>
          item !== undefined && /x?html/i.test(item.mediaType),
      )
      .map((item) => ({
        item,
        reference: resolveArchiveReference(opfPath, item.href),
      }))
      .filter(
        (entry): entry is { item: ManifestItem; reference: ArchiveReference } =>
          entry.reference !== null,
      );
    const chapterIndexByPath = new Map(
      spineItems.map((entry, index) => [entry.reference.path, index]),
    );
    const manifestByPath = new Map<string, ManifestItem>();
    for (const item of items.values()) {
      const reference = resolveArchiveReference(opfPath, item.href);
      if (reference !== null) {
        manifestByPath.set(reference.path, item);
      }
    }

    const packagedImageUrl = async (path: string, mediaType: string): Promise<string | null> => {
      if (!SAFE_READER_IMAGE_MIME_TYPES.has(mediaType)) {
        return null;
      }
      const existing = resourceUrls.get(path);
      if (existing !== undefined) {
        return existing;
      }
      const file = archive.file(path);
      if (file === null) {
        return null;
      }
      if (file.uncompressedSize > MAX_READER_IMAGE_BYTES) {
        throw new ReaderLimitError(
          'readerImageBytes',
          file.uncompressedSize,
          MAX_READER_IMAGE_BYTES,
        );
      }
      const data = await file.readBytes(signal);
      throwIfReaderLoadCancelled(signal);
      const imageBytes = Uint8Array.from(data);
      const url = URL.createObjectURL(new Blob([imageBytes.buffer], { type: mediaType }));
      resourceUrls.set(path, url);
      return url;
    };

    // 4. Read spine XHTML, resolve packaged images, and rewrite chapter links.
    const chapters: ReaderContent['chapters'] = [];
    for (let idx = 0; idx < spineItems.length; idx += 1) {
      throwIfReaderLoadCancelled(signal);
      const { reference } = spineItems[idx]!;
      const fullPath = reference.path;
      const file = archive.file(fullPath);
      if (file === null) {
        continue;
      }
      const xhtml = await file.readText(signal);
      throwIfReaderLoadCancelled(signal);
      const document = new DOMParser().parseFromString(xhtml, 'text/html');
      const body = document.body;
      for (const image of body.querySelectorAll<HTMLImageElement>('img[src]')) {
        const source = image.getAttribute('src') ?? '';
        const imageReference = resolveArchiveReference(fullPath, source);
        const manifestItem =
          imageReference === null ? undefined : manifestByPath.get(imageReference.path);
        const url =
          imageReference === null || manifestItem === undefined
            ? null
            : await packagedImageUrl(imageReference.path, manifestItem.mediaType);
        if (url === null) {
          image.removeAttribute('src');
        } else {
          image.src = url;
        }
      }
      for (const link of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const href = link.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          continue;
        }
        const linkReference = resolveArchiveReference(fullPath, href);
        if (linkReference === null) {
          continue;
        }
        const targetChapter = chapterIndexByPath.get(linkReference.path);
        if (targetChapter === undefined) {
          link.removeAttribute('href');
          continue;
        }
        const params = new URLSearchParams({ chapter: String(targetChapter) });
        if (linkReference.fragment !== '') {
          params.set('target', linkReference.fragment);
        }
        link.setAttribute('href', `#lightink-chapter?${params.toString()}`);
      }
      const sectionTitle = document.title.trim();
      const title =
        sectionTitle || (idx === 0 && bookTitle ? bookTitle : `Chapter ${idx + 1}`);
      chapters.push({ title, html: sanitizeHtml(body.innerHTML) });
    }

    if (chapters.length === 0) {
      throw new ParseError('EPUB 未找到可读章节内容');
    }
    const warnings = [...items.values()].some((item) => item.mediaType === 'text/css')
      ? (['epubStylesIgnored'] as const)
      : undefined;
    returnedContent = true;
    return { chapters, warnings, dispose };
  } finally {
    await archive.close().catch(() => undefined);
    if (!returnedContent) {
      dispose();
    }
  }
}
