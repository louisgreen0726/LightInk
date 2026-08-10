/**
 * `reader-view` — 只读阅读视图（ebook-reader T3 骨架 + T4 流式渲染 + T5 页式渲染）。
 *
 * 在标签宿主内挂载两种宿主——
 *   - 滚动容器（流式格式 EPUB/MOBI/FB2/TXT）；
 *   - 页容器（页式格式 PDF/CBZ）；
 * 并只消费主题令牌 `var(--lightink-*)` 与字号缩放 `var(--lightink-font-scale)`。
 *
 * `load(path)` 读取字节后按格式分发：流式 → 章节化 HTML 进滚动宿主；PDF → pdfjs 逐页
 * canvas（←/→ 翻页、+/-/0 缩放）；CBZ → 逐页 <img>。解析失败 reject 由调用方提示。
 */

import './reader.css';
import { parseReaderContent } from './formats/index.js';
import type { ReaderChapter } from './formats/types.js';
import { renderCbzInto } from './formats/cbz.js';
import { renderPdfInto, type PdfRenderHandle } from './formats/pdf.js';
import { ParseError } from './formats/types.js';
import type { ReaderInstance } from './types.js';

const PAGE_EXTS = new Set(['pdf', 'cbz']);

function extOfPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

export interface ReaderViewDeps {
  /** 读取文件原始字节（生产为 invoke read_file_bytes → base64 → Uint8Array）。 */
  readBytes?: (filePath: string) => Promise<Uint8Array>;
  /** 翻译 i18n key（生产为 i18n.t）；默认返回 key 本身（headless/测试）。 */
  t?: (key: string, vars?: Readonly<Record<string, string>>) => string;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
 * `load` 按格式渲染；`destroy` 移除视图 DOM。
 */
export function createReaderView(host: HTMLElement, deps: ReaderViewDeps = {}): ReaderInstance {
  const t = deps.t ?? ((key: string) => key);
  const root = document.createElement('div');
  root.className = 'lightink-reader';
  root.setAttribute('role', 'document');

  const scrollHost = document.createElement('div');
  scrollHost.className = 'lightink-reader-scroll';
  scrollHost.dataset.readerHost = 'scroll';

  const pageHost = document.createElement('div');
  pageHost.className = 'lightink-reader-pages';
  pageHost.dataset.readerHost = 'pages';
  pageHost.hidden = true;

  const empty = document.createElement('div');
  empty.className = 'lightink-reader-empty';
  empty.textContent = t('reader.empty');
  scrollHost.appendChild(empty);

  root.append(scrollHost, pageHost);
  host.appendChild(root);

  let pdfHandle: PdfRenderHandle | null = null;

  const renderChapters = (chapters: ReaderChapter[]): void => {
    scrollHost.hidden = false;
    pageHost.hidden = true;
    delete pageHost.dataset.readerActive;
    scrollHost.replaceChildren();
    let chapterIndex = 0;
    for (const chapter of chapters) {
      const article = document.createElement('article');
      article.className = 'lightink-reader-chapter';
      const heading = document.createElement('h1');
      heading.className = 'lightink-reader-chapter-title';
      heading.textContent = chapter.title || t('reader.chapter', { n: String(chapterIndex + 1) });
      const body = document.createElement('div');
      body.className = 'lightink-reader-chapter-body';
      body.innerHTML = chapter.html;
      article.append(heading, body);
      scrollHost.appendChild(article);
      chapterIndex += 1;
    }
  };

  const renderPages = async (filePath: string, bytes: Uint8Array): Promise<void> => {
    const ext = extOfPath(filePath);
    if (ext !== 'pdf' && ext !== 'cbz') {
      throw new ParseError(`暂不支持的页格式：.${ext || '?'}`);
    }
    // 激活页模式：隐藏滚动宿主，显示页宿主。
    scrollHost.hidden = true;
    pageHost.hidden = false;
    pageHost.dataset.readerActive = 'true';
    if (ext === 'pdf') {
      pdfHandle = await renderPdfInto(bytes, pageHost);
    } else {
      await renderCbzInto(bytes, pageHost);
    }
  };

  // PDF 翻页/缩放：←/→ 翻页，+/- 缩放，0 还原（canvas 真实渲染为手工验证）。
  root.addEventListener('keydown', (event) => {
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    const key = event.key;
    let changed = false;
    if (key === 'ArrowLeft' || key === 'PageUp') {
      changed = handle.controller.prev();
    } else if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      changed = handle.controller.next();
    } else if (key === '+' || key === '=') {
      changed = handle.controller.zoomIn();
    } else if (key === '-' || key === '_') {
      changed = handle.controller.zoomOut();
    } else if (key === '0') {
      changed = handle.controller.resetScale();
    }
    if (changed) {
      event.preventDefault();
      void handle.rerender();
    }
  });

  return {
    async load(filePath: string): Promise<void> {
      const readBytes = deps.readBytes;
      if (readBytes === undefined) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      const bytes = await readBytes(filePath);
      if (PAGE_EXTS.has(extOfPath(filePath))) {
        await renderPages(filePath, bytes);
      } else {
        const content = await parseReaderContent(filePath, bytes);
        renderChapters(content.chapters);
      }
    },
    async destroy(): Promise<void> {
      pdfHandle = null;
      root.remove();
    },
  };
}
