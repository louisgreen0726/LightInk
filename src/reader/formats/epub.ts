/**
 * `epub` — EPUB 解析（ebook-reader T4）。
 *
 * EPUB 是 zip 容器：读 META-INF/container.xml 定位 OPF，解析 OPF 的 manifest/spine
 * 得到按顺序的 XHTML 章节文件，抽取各 <body> 内容并消毒为章节化 HTML。
 * ZIP central-directory metadata is checked before decompression. Pure string parsing keeps
 * OPF/XHTML handling testable in Node.
 *
 * T8：包内图片不再 parse 期物化——章节 HTML 中的 img 保留包内规范路径作占位
 * src，由章节 resolveResources/releaseResources 钩子按渲染窗口懒解压并配对
 * revokeObjectURL；archive 随 ReaderContent.dispose 关闭。
 */

import { sanitizeHtml } from '../sanitize.js';
import { sanitizeReaderCss } from '../sanitize-css.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { openSafeArchive } from './safe-archive.js';
import {
  ParseError,
  ReaderLimitError,
  type ReaderContent,
} from './types.js';
import {
  MAX_READER_CSS_BYTES,
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
  // T8：包内图片不再 parse 期物化。materialized/pathByUrl 记录按章节窗口懒物化
  // 的 blob URL（path → { url, refs } 引用计数）；archive 存活至内容 dispose，
  // dispose 兜底 revoke 全部并关闭 archive。
  const materialized = new Map<string, { url: string; refs: number }>();
  const pathByUrl = new Map<string, string>();
  let archiveClosed = false;
  const dispose = (): void => {
    for (const entry of materialized.values()) {
      URL.revokeObjectURL(entry.url);
    }
    materialized.clear();
    pathByUrl.clear();
    if (!archiveClosed) {
      archiveClosed = true;
      void archive.close().catch(() => undefined);
    }
  };
  let returnedContent = false;
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

    const svgImageHref = (image: Element): string =>
      image.getAttribute('href') ??
      image.getAttribute('xlink:href') ??
      image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      '';

    /**
     * Parse 期引用解析与预算校验（T8）：返回包内规范路径作为占位 src，不解压、
     * 不建 object URL。超限检查用 central-directory 元数据，抛错时机/语义与
     * 原 parse 期物化一致；清单外/不安全 MIME/缺失条目返回 null（调用方去 src）。
     */
    const packagedImagePath = (basePath: string, source: string): string | null => {
      const imageReference = resolveArchiveReference(basePath, source);
      const manifestItem =
        imageReference === null ? undefined : manifestByPath.get(imageReference.path);
      if (imageReference === null || manifestItem === undefined) {
        return null;
      }
      if (!SAFE_READER_IMAGE_MIME_TYPES.has(manifestItem.mediaType)) {
        return null;
      }
      const file = archive.file(imageReference.path);
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
      return imageReference.path;
    };

    /**
     * T8 懒物化：章节帧进入视口时把占位 src（包内路径）换成 blob URL。同一图片
     * 跨章共享按引用计数持有；releaseImages 配对还原并按计数 revokeObjectURL。
     */
    const materializeImages = async (doc: Document): Promise<void> => {
      for (const image of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]'))) {
        const source = image.getAttribute('src') ?? '';
        if (source === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) {
          continue; // 已物化（blob:）、内联（data:）或远程图均不归本钩子处理
        }
        const manifestItem = manifestByPath.get(source);
        if (manifestItem === undefined) {
          continue;
        }
        let entry = materialized.get(source);
        if (entry === undefined) {
          const file = archive.file(source);
          if (file === null) {
            continue;
          }
          const data = await file.readBytes();
          const imageBytes = Uint8Array.from(data);
          const url = URL.createObjectURL(
            new Blob([imageBytes.buffer], { type: manifestItem.mediaType }),
          );
          entry = { url, refs: 0 };
          materialized.set(source, entry);
          pathByUrl.set(url, source);
        }
        entry.refs += 1;
        image.setAttribute('src', entry.url);
      }
    };

    /** 与 materializeImages 配对：src 还原为包内路径，引用计数归零即 revoke。幂等。 */
    const releaseImages = (doc: Document): void => {
      for (const image of Array.from(
        doc.querySelectorAll<HTMLImageElement>('img[src^="blob:"]'),
      )) {
        const url = image.getAttribute('src') ?? '';
        const path = pathByUrl.get(url);
        if (path === undefined) {
          continue;
        }
        image.setAttribute('src', path);
        const entry = materialized.get(path);
        if (entry === undefined) {
          continue;
        }
        entry.refs -= 1;
        if (entry.refs <= 0) {
          URL.revokeObjectURL(url);
          materialized.delete(path);
          pathByUrl.delete(url);
        }
      }
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
      let hasPackagedImages = false;

      for (const image of body.querySelectorAll<HTMLImageElement>('img[src]')) {
        const path = packagedImagePath(fullPath, image.getAttribute('src') ?? '');
        if (path === null) {
          image.removeAttribute('src');
        } else {
          // 占位 src = 包内规范路径：帧进入视口时由 resolveResources 物化为 blob URL。
          image.setAttribute('src', path);
          hasPackagedImages = true;
        }
      }
      // 文库版 EPUB 常用 <svg><image xlink:href> 包位图；消毒会丢掉整个 svg。
      for (const svg of [...body.querySelectorAll('svg')]) {
        const replacements: HTMLImageElement[] = [];
        for (const image of svg.querySelectorAll('image')) {
          const path = packagedImagePath(fullPath, svgImageHref(image));
          if (path === null) {
            continue;
          }
          const img = document.createElement('img');
          img.setAttribute('src', path);
          hasPackagedImages = true;
          const width = image.getAttribute('width');
          const height = image.getAttribute('height');
          if (width !== null && width !== '' && !width.includes('%')) {
            img.setAttribute('width', width);
          }
          if (height !== null && height !== '' && !height.includes('%')) {
            img.setAttribute('height', height);
          }
          const alt = image.getAttribute('alt') ?? '';
          if (alt !== '') {
            img.alt = alt;
          }
          replacements.push(img);
        }
        if (replacements.length === 0) {
          svg.remove();
        } else {
          svg.replaceWith(...replacements);
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
      const chapter: ReaderContent['chapters'][number] = {
        title,
        html: sanitizeHtml(body.innerHTML),
      };
      if (hasPackagedImages) {
        chapter.resolveResources = materializeImages;
        chapter.releaseResources = releaseImages;
      }
      chapters.push(chapter);
    }

    if (chapters.length === 0) {
      throw new ParseError('EPUB 未找到可读章节内容');
    }

    const stylesheetParts: string[] = [];
    let stylesheetBytes = 0;
    for (const item of items.values()) {
      const mediaType = item.mediaType.toLowerCase();
      if (mediaType !== 'text/css' && !mediaType.startsWith('text/css;')) {
        continue;
      }
      const reference = resolveArchiveReference(opfPath, item.href);
      if (reference === null) {
        continue;
      }
      const cssFile = archive.file(reference.path);
      if (cssFile === null || cssFile.uncompressedSize > MAX_READER_CSS_BYTES) {
        continue;
      }
      if (stylesheetBytes + cssFile.uncompressedSize > MAX_READER_CSS_BYTES) {
        break;
      }
      const cssText = await cssFile.readText(signal);
      throwIfReaderLoadCancelled(signal);
      stylesheetBytes += cssFile.uncompressedSize;
      stylesheetParts.push(cssText);
    }
    const stylesheet = sanitizeReaderCss(stylesheetParts.join('\n'));
    returnedContent = true;
    return stylesheet === '' ? { chapters, dispose } : { chapters, stylesheet, dispose };
  } finally {
    if (!returnedContent) {
      dispose();
    }
  }
}
