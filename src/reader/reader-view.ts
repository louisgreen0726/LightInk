/**
 * `reader-view` — 只读阅读视图（T3 骨架 + T4 流式 + T5 页式 + T6 标注）。
 *
 * 流式格式渲染章节化 HTML（滚动宿主）；PDF/CBZ 渲染页（页宿主）。标注按内容哈希
 * （Rust content_hash）关联：加载时读出 → 流式高亮渲染 <mark> + 侧栏列表跳转；
 * 选中正文可加高亮，侧栏可移除，变更写回 app_data_dir（write_annotations）。
 * 只消费主题令牌 var(--lightink-*) 与 --lightink-font-scale。
 */

import './reader.css';
import { parseReaderContent } from './formats/index.js';
import type { ReaderChapter } from './formats/types.js';
import { ParseError } from './formats/types.js';
import { renderCbzInto } from './formats/cbz.js';
import { renderPdfInto, type PdfRenderHandle } from './formats/pdf.js';
import {
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
  type AnnotationKind,
} from './annotations.js';
import { createAnnotationSidebar, type AnnotationSidebar } from './annotation-sidebar.js';
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

/** 仅用于稳定标注 id（无加密强度需求）。 */
function newAnnotationId(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID().slice(0, 8);
  }
  return `a-${Date.now().toString(36)}`;
}

export interface ReaderViewDeps {
  /** 读取文件原始字节（生产为 invoke read_file_bytes → base64 → Uint8Array）。 */
  readBytes?: (filePath: string) => Promise<Uint8Array>;
  /** 翻译 i18n key（生产为 i18n.t）。 */
  t?: (key: string, vars?: Readonly<Record<string, string>>) => string;
  /** 文件内容哈希（Rust content_hash）；缺省则不启用标注。 */
  getContentHash?: (filePath: string) => Promise<string>;
  /** 读标注 JSON（Rust read_annotations）。 */
  readAnnotations?: (contentHash: string) => Promise<string>;
  /** 写标注 JSON（Rust write_annotations）。 */
  writeAnnotations?: (contentHash: string, json: string) => Promise<void>;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
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
  let annotations: Annotation[] = [];
  let contentHash: string | null = null;
  let sidebar: AnnotationSidebar | null = null;
  let isFlow = false;

  const saveAnnotations = async (): Promise<void> => {
    if (contentHash === null || deps.writeAnnotations === undefined) {
      return;
    }
    try {
      await deps.writeAnnotations(contentHash, serializeAnnotations(annotations));
    } catch {
      /* 写失败保留内存态（R4），不阻断阅读 */
    }
  };

  const ensureSidebar = (): void => {
    if (sidebar !== null || root === null) {
      return;
    }
    sidebar = createAnnotationSidebar({
      t,
      onJump: (annotation) => {
        const target = root.querySelector<HTMLElement>(
          `[data-annotation-id="${cssEscape(annotation.id)}"]`,
        );
        if (target !== null) {
          target.scrollIntoView({ block: 'center' });
        } else if (annotation.locator.format === 'pdf' && pdfHandle !== null) {
          if (pdfHandle.controller.setPage(annotation.locator.page)) {
            void pdfHandle.rerender();
          }
        }
      },
      onRemove: (annotation) => {
        annotations = annotations.filter((a) => a.id !== annotation.id);
        sidebar?.render(annotations);
        void saveAnnotations();
      },
    });
    root.appendChild(sidebar.element);
    sidebar.render(annotations);
  };

  /** 在容器文本节点中包裹高亮 quote（best-effort：单个文本节点内命中）。 */
  const renderHighlights = (): void => {
    if (!isFlow) {
      return;
    }
    const highlights = annotations.filter((a) => a.kind === 'highlight' && a.quote !== undefined);
    for (const hl of highlights) {
      const quote = hl.quote ?? '';
      const walker = document.createTreeWalker(scrollHost, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null) !== null) {
        const idx = node.nodeValue?.indexOf(quote) ?? -1;
        if (idx >= 0 && node.nodeValue !== null && quote.length > 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + quote.length);
          const mark = document.createElement('mark');
          mark.className = 'lightink-reader-highlight';
          mark.dataset.annotationId = hl.id;
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
          break; // 每条高亮只包裹首个命中
        }
      }
    }
  };

  const renderChapters = (chapters: ReaderChapter[]): void => {
    isFlow = true;
    scrollHost.hidden = false;
    pageHost.hidden = true;
    delete pageHost.dataset.readerActive;
    scrollHost.replaceChildren();
    let chapterIndex = 0;
    for (const chapter of chapters) {
      const article = document.createElement('article');
      article.className = 'lightink-reader-chapter';
      article.dataset.chapterIndex = String(chapterIndex);
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
    isFlow = false;
    const ext = extOfPath(filePath);
    if (ext !== 'pdf' && ext !== 'cbz') {
      throw new ParseError(`暂不支持的页格式：.${ext || '?'}`);
    }
    scrollHost.hidden = true;
    pageHost.hidden = false;
    pageHost.dataset.readerActive = 'true';
    if (ext === 'pdf') {
      if (pdfHandle !== null) {
        await pdfHandle.destroy();
      }
      pdfHandle = await renderPdfInto(bytes, pageHost);
    } else {
      await renderCbzInto(bytes, pageHost);
    }
  };

  const loadAnnotations = async (filePath: string): Promise<void> => {
    if (deps.getContentHash === undefined || deps.readAnnotations === undefined) {
      return;
    }
    try {
      contentHash = await deps.getContentHash(filePath);
      annotations = parseAnnotations(await deps.readAnnotations(contentHash));
    } catch {
      annotations = [];
    }
    if (isFlow) {
      renderHighlights();
    }
    ensureSidebar();
  };

  // PDF 翻页/缩放：←/→ 翻页，+/- 缩放，0 还原。
  root.addEventListener('keydown', (event) => {
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    let changed = false;
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      changed = handle.controller.prev();
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      changed = handle.controller.next();
    } else if (event.key === '+' || event.key === '=') {
      changed = handle.controller.zoomIn();
    } else if (event.key === '-' || event.key === '_') {
      changed = handle.controller.zoomOut();
    } else if (event.key === '0') {
      changed = handle.controller.resetScale();
    }
    if (changed) {
      event.preventDefault();
      void handle.rerender();
    }
  });

  // 流式正文选中 → 添加高亮（best-effort 定位器：章节 + quote）。
  root.addEventListener('mouseup', () => {
    if (!isFlow || deps.writeAnnotations === undefined) {
      return;
    }
    const selection = document.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (text.length === 0) {
      return;
    }
    const anchor = selection?.anchorNode;
    const chapterEl =
      anchor !== null && anchor !== undefined
        ? (anchor as HTMLElement).closest?.('.lightink-reader-chapter')
        : null;
    const chapter = chapterEl !== null && chapterEl !== undefined
      ? Number(chapterEl.getAttribute('data-chapter-index') ?? '0')
      : 0;
    const annotation: Annotation = {
      id: newAnnotationId(),
      kind: 'highlight' as AnnotationKind,
      locator: { format: 'flow', chapter, domPath: '', start: 0, end: 0 },
      quote: text,
      createdAt: Date.now(),
    };
    annotations = [...annotations, annotation];
    renderHighlights();
    sidebar?.render(annotations);
    void saveAnnotations();
    selection?.removeAllRanges();
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
      await loadAnnotations(filePath);
    },
    async destroy(): Promise<void> {
      if (pdfHandle !== null) {
        await pdfHandle.destroy().catch(() => undefined);
      }
      pdfHandle = null;
      sidebar?.destroy();
      sidebar = null;
      root.remove();
    },
  };
}

/** CSS 标识符转义（标注 id 用于属性选择器时）。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
