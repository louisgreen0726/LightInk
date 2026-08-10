/**
 * `reader-view` — 只读阅读视图（T3 骨架 + T4 流式 + T5 页式 + T6 标注）。
 *
 * 流式格式渲染章节化 HTML（滚动宿主）；PDF/CBZ 渲染页（页宿主）。标注按内容哈希
 * （Rust content_hash）关联：加载时读出 → 流式高亮渲染 <mark> + 侧栏列表跳转；
 * 选中正文可加高亮，工具栏可加书签/笔记，侧栏可移除，变更写回 app_data_dir。
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
  type Locator,
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

/** CSS 标识符转义（标注 id 用于属性选择器时）。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
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
  /** 非阻断提示（标注读失败/写失败时）。 */
  notify?: (message: string) => void;
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

  const annotationsEnabled =
    deps.getContentHash !== undefined && deps.readAnnotations !== undefined;

  let pdfHandle: PdfRenderHandle | null = null;
  let annotations: Annotation[] = [];
  let contentHash: string | null = null;
  let sidebar: AnnotationSidebar | null = null;
  let loadedExt = '';

  const saveAnnotations = async (): Promise<void> => {
    if (contentHash === null || deps.writeAnnotations === undefined) {
      return;
    }
    try {
      await deps.writeAnnotations(contentHash, serializeAnnotations(annotations));
    } catch {
      deps.notify?.(t('annotation.saveFailed'));
    }
  };

  /** 当前阅读位置的定位器（书签/笔记用）。 */
  const currentPositionLocator = (): Locator => {
    if (pdfHandle !== null) {
      return { format: 'pdf', page: pdfHandle.controller.page, quote: '' };
    }
    if (PAGE_EXTS.has(loadedExt)) {
      return { format: 'cbz', page: 1 };
    }
    if (loadedExt === 'txt') {
      return { format: 'text', start: 0, end: 0 };
    }
    return { format: 'flow', chapter: firstVisibleChapter(), domPath: '', start: 0, end: 0 };
  };

  /** 流式：视口顶部最近的章节索引。 */
  const firstVisibleChapter = (): number => {
    const chapters = Array.from(scrollHost.querySelectorAll('.lightink-reader-chapter'));
    if (chapters.length === 0) {
      return 0;
    }
    const hostTop = scrollHost.getBoundingClientRect().top;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    chapters.forEach((c, i) => {
      const dist = Math.abs((c as HTMLElement).getBoundingClientRect().top - hostTop);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  };

  /** 添加书签或笔记（笔记经 window.prompt 取文本）。 */
  const addAnnotation = (kind: AnnotationKind): void => {
    let note: string | undefined;
    if (kind === 'note') {
      const input =
        typeof window !== 'undefined' && typeof window.prompt === 'function'
          ? window.prompt(t('annotation.notePrompt'))
          : null;
      if (input === null) {
        return;
      }
      note = input;
    }
    annotations = [
      ...annotations,
      {
        id: newAnnotationId(),
        kind,
        locator: currentPositionLocator(),
        note,
        createdAt: Date.now(),
      },
    ];
    sidebar?.render(annotations);
    void saveAnnotations();
  };

  const ensureSidebar = (): void => {
    if (sidebar !== null) {
      return;
    }
    sidebar = createAnnotationSidebar({
      t,
      onJump: (annotation) => {
        const loc = annotation.locator;
        if (loc.format === 'pdf' && pdfHandle !== null) {
          if (pdfHandle.controller.setPage(loc.page)) {
            void pdfHandle.rerender();
          }
          return;
        }
        if (loc.format === 'cbz') {
          const pages = pageHost.querySelectorAll('.lightink-reader-page');
          (pages[loc.page - 1] as HTMLElement | undefined)?.scrollIntoView({ block: 'start' });
          return;
        }
        // flow / text：优先定位到该条高亮的 <mark>，否则到章节。
        const mark = root.querySelector<HTMLElement>(
          `[data-annotation-id="${cssEscape(annotation.id)}"]`,
        );
        const target =
          mark ??
          scrollHost.querySelector<HTMLElement>(`[data-chapter-index="${loc.format === 'flow' ? loc.chapter : 0}"]`);
        target?.scrollIntoView({ block: 'center' });
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

  /** 在容器文本节点中包裹高亮 quote（幂等：已存在的标注跳过；单文本节点命中）。 */
  const renderHighlights = (): void => {
    if (PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const highlights = annotations.filter((a) => a.kind === 'highlight' && a.quote !== undefined);
    for (const hl of highlights) {
      // 幂等：该标注的 <mark> 已存在则跳过，避免重复嵌套包裹。
      if (root.querySelector(`[data-annotation-id="${cssEscape(hl.id)}"]`) !== null) {
        continue;
      }
      const quote = hl.quote ?? '';
      if (quote.length === 0) {
        continue;
      }
      const walker = document.createTreeWalker(scrollHost, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null) !== null) {
        const idx = node.nodeValue?.indexOf(quote) ?? -1;
        if (idx >= 0 && node.nodeValue !== null) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + quote.length);
          const mark = document.createElement('mark');
          mark.className = 'lightink-reader-highlight';
          mark.dataset.annotationId = hl.id;
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
          break;
        }
      }
    }
  };

  const renderChapters = (chapters: ReaderChapter[]): void => {
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
    if (!annotationsEnabled) {
      return;
    }
    try {
      contentHash = await deps.getContentHash!(filePath);
      annotations = parseAnnotations(await deps.readAnnotations!(contentHash));
    } catch {
      annotations = [];
      deps.notify?.(t('annotation.loadFailed'));
      return;
    }
    if (!PAGE_EXTS.has(loadedExt)) {
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

  // 流式正文选中 → 添加高亮。
  root.addEventListener('mouseup', () => {
    if (PAGE_EXTS.has(loadedExt) || deps.writeAnnotations === undefined) {
      return;
    }
    const selection = document.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (text.length === 0) {
      return;
    }
    const anchorEl = (selection?.anchorNode as Element | null | undefined)?.parentElement ?? null;
    const chapterEl = anchorEl?.closest('.lightink-reader-chapter') ?? null;
    const chapter =
      chapterEl !== null && chapterEl !== undefined
        ? Number(chapterEl.getAttribute('data-chapter-index') ?? '0')
        : firstVisibleChapter();
    const annotation: Annotation = {
      id: newAnnotationId(),
      kind: 'highlight',
      locator:
        loadedExt === 'txt'
          ? { format: 'text', start: 0, end: text.length }
          : { format: 'flow', chapter, domPath: '', start: 0, end: 0 },
      quote: text,
      createdAt: Date.now(),
    };
    annotations = [...annotations, annotation];
    renderHighlights();
    sidebar?.render(annotations);
    void saveAnnotations();
    selection?.removeAllRanges();
  });

  // 标注工具栏：书签 / 笔记（标注启用时挂载）。
  if (annotationsEnabled) {
    const toolbar = document.createElement('div');
    toolbar.className = 'lightink-reader-toolbar';
    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.type = 'button';
    bookmarkBtn.className = 'lightink-reader-toolbar-btn';
    bookmarkBtn.textContent = t('annotation.kind.bookmark');
    bookmarkBtn.addEventListener('click', () => addAnnotation('bookmark'));
    const noteBtn = document.createElement('button');
    noteBtn.type = 'button';
    noteBtn.className = 'lightink-reader-toolbar-btn';
    noteBtn.textContent = t('annotation.kind.note');
    noteBtn.addEventListener('click', () => addAnnotation('note'));
    toolbar.append(bookmarkBtn, noteBtn);
    root.appendChild(toolbar);
  }

  return {
    async load(filePath: string): Promise<void> {
      const readBytes = deps.readBytes;
      if (readBytes === undefined) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      loadedExt = extOfPath(filePath);
      const bytes = await readBytes(filePath);
      if (PAGE_EXTS.has(loadedExt)) {
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
