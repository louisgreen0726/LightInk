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
import { renderCbzInto, type CbzRenderHandle } from './formats/cbz.js';
import { renderPdfInto, type PdfRenderHandle } from './formats/pdf.js';
import {
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
  type AnnotationKind,
  type Locator,
} from './annotations.js';
import { createAnnotationSidebar, type AnnotationSidebar } from './annotation-sidebar.js';
import type { ReaderInstance, ReaderLoadOptions } from './types.js';
import {
  isReaderLoadCancelled,
  throwIfReaderLoadCancelled,
} from './load-lifecycle.js';
import {
  bindBlockedRemoteImages,
  sessionRemoteImagePolicy,
  type RemoteImagePolicy,
} from '../media/remote-image-policy.js';

const PAGE_EXTS = new Set(['pdf', 'cbz']);

const FLOW_FRAME_CSP = [
  "default-src 'none'",
  "img-src data: blob: http: https:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const FLOW_FRAME_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; overflow: hidden; color: inherit; background: transparent; font: inherit; line-height: 1.7; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; border-collapse: collapse; }
th, td { padding: 0.35rem 0.5rem; border: 1px solid currentColor; }
pre { overflow-x: auto; white-space: pre-wrap; }
a { color: inherit; text-decoration: underline; }
mark.lightink-reader-highlight { background: #f2d675; color: #111; }
.lightink-remote-image-placeholder { display: flex; align-items: center; min-height: 2.5rem; }
`;

function flowFrameSource(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${FLOW_FRAME_CSP}">` +
    `<style>${FLOW_FRAME_CSS}</style></head><body>${html}</body></html>`
  );
}

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
  readBytes?: (filePath: string, signal?: AbortSignal) => Promise<Uint8Array>;
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
  /** Session-only consent for remote images; injectable for focused tests. */
  remoteImagePolicy?: RemoteImagePolicy;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
 */
export function createReaderView(host: HTMLElement, deps: ReaderViewDeps = {}): ReaderInstance {
  const t = deps.t ?? ((key: string) => key);
  const root = document.createElement('div');
  root.className = 'lightink-reader';
  root.setAttribute('role', 'document');
  root.tabIndex = 0;
  root.dataset.readerState = 'empty';

  const scrollHost = document.createElement('div');
  scrollHost.className = 'lightink-reader-scroll';
  scrollHost.dataset.readerHost = 'scroll';

  const createPageHost = (): HTMLDivElement => {
    const element = document.createElement('div');
    element.className = 'lightink-reader-pages';
    element.dataset.readerHost = 'pages';
    element.hidden = true;
    return element;
  };
  let pageHost = createPageHost();

  const empty = document.createElement('div');
  empty.className = 'lightink-reader-empty';
  empty.textContent = t('reader.empty');
  scrollHost.appendChild(empty);

  const status = document.createElement('div');
  status.className = 'lightink-reader-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  root.append(scrollHost, pageHost, status);
  host.appendChild(root);

  const annotationsEnabled =
    deps.getContentHash !== undefined && deps.readAnnotations !== undefined;

  let pdfHandle: PdfRenderHandle | null = null;
  let cbzHandle: CbzRenderHandle | null = null;
  let annotations: Annotation[] = [];
  let contentHash: string | null = null;
  let sidebar: AnnotationSidebar | null = null;
  /** 标注侧栏默认隐藏（用户显式打开才显示，且作为 flex 子项不再覆盖内容）。 */
  let sidebarVisible = false;
  let loadedExt = '';
  let loadGeneration = 0;
  let activeLoadController: AbortController | null = null;
  let destroyed = false;
  let flowRenderGeneration = 0;
  const remoteImagePolicy = deps.remoteImagePolicy ?? sessionRemoteImagePolicy;
  let releaseRemoteImages: Array<() => void> = [];

  const setReaderState = (
    state: 'empty' | 'loading' | 'ready' | 'cancelled' | 'error' | 'destroyed',
  ): void => {
    root.dataset.readerState = state;
    root.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    const messageKey =
      state === 'loading'
        ? 'reader.loading'
        : state === 'cancelled'
          ? 'reader.cancelled'
          : state === 'error'
            ? 'reader.failed'
            : null;
    status.hidden = messageKey === null;
    status.textContent = messageKey === null ? '' : t(messageKey);
  };

  const clearFlowBindings = (): void => {
    flowRenderGeneration += 1;
    releaseRemoteImages.splice(0).forEach((release) => release());
  };
  setReaderState('empty');

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
    if (cbzHandle !== null) {
      return { format: 'cbz', page: cbzHandle.currentPage };
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
          pdfHandle.scrollToPage(loc.page);
          return;
        }
        if (loc.format === 'cbz') {
          cbzHandle?.scrollToPage(loc.page);
          return;
        }
        // flow / text：优先定位到该条高亮的 <mark>，否则到章节。
        const mark = Array.from(
          scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
        )
          .map((frame) =>
            frame.contentDocument?.querySelector<HTMLElement>(
              `[data-annotation-id="${cssEscape(annotation.id)}"]`,
            ) ?? null,
          )
          .find((candidate): candidate is HTMLElement => candidate !== null);
        const target =
          mark ??
          scrollHost.querySelector<HTMLElement>(
            `[data-chapter-index="${loc.format === 'flow' ? loc.chapter : 0}"]`,
          );
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

  /** 切换侧栏显隐：可见时确保已创建，并用 root class 驱动 CSS 布局（不再覆盖内容）。 */
  const setSidebarVisible = (visible: boolean): void => {
    sidebarVisible = visible;
    if (visible) {
      ensureSidebar();
    }
    root.classList.toggle('lightink-reader--sidebar', sidebarVisible);
  };

  const flowDocuments = (): Document[] =>
    Array.from(
      scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    )
      .map((frame) => frame.contentDocument)
      .filter((doc): doc is Document => doc !== null && doc.body !== null);

  /** 在 sandbox 正文文本节点中包裹高亮 quote。 */
  const renderHighlights = (): void => {
    if (PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const highlights = annotations.filter((a) => a.kind === 'highlight' && a.quote !== undefined);
    for (const hl of highlights) {
      // 幂等：该标注的 <mark> 已存在则跳过，避免重复嵌套包裹。
      const documents = flowDocuments();
      if (
        documents.some(
          (doc) =>
            doc.querySelector(`[data-annotation-id="${cssEscape(hl.id)}"]`) !== null,
        )
      ) {
        continue;
      }
      const quote = hl.quote ?? '';
      if (quote.length === 0) {
        continue;
      }
      const preferredChapter =
        hl.locator.format === 'flow' ? documents[hl.locator.chapter] : documents[0];
      const candidates =
        preferredChapter === undefined
          ? documents
          : [preferredChapter, ...documents.filter((doc) => doc !== preferredChapter)];
      let rendered = false;
      for (const doc of candidates) {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null) !== null) {
          const idx = node.nodeValue?.indexOf(quote) ?? -1;
          if (idx >= 0 && node.nodeValue !== null) {
            const range = doc.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + quote.length);
            const mark = doc.createElement('mark');
            mark.className = 'lightink-reader-highlight';
            mark.dataset.annotationId = hl.id;
            mark.appendChild(range.extractContents());
            range.insertNode(mark);
            rendered = true;
            break;
          }
        }
        if (rendered) {
          break;
        }
      }
    }
  };

  const captureFlowSelection = (selection: Selection | null, chapter: number): void => {
    if (deps.writeAnnotations === undefined) {
      return;
    }
    const text = selection?.toString().trim() ?? '';
    if (text.length === 0) {
      return;
    }
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
  };

  const renderChapters = (chapters: ReaderChapter[]): void => {
    clearFlowBindings();
    const renderGeneration = flowRenderGeneration;
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
      const frame = document.createElement('iframe');
      frame.className = 'lightink-reader-chapter-frame';
      frame.dataset.chapterIndex = String(chapterIndex);
      frame.title = chapter.title || t('reader.chapter', { n: String(chapterIndex + 1) });
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('scrolling', 'no');
      frame.referrerPolicy = 'no-referrer';

      const frameChapter = chapterIndex;
      const onLoad = (): void => {
        if (renderGeneration !== flowRenderGeneration || destroyed) {
          return;
        }
        const frameDocument = frame.contentDocument;
        const frameWindow = frame.contentWindow;
        if (frameDocument === null || frameWindow === null) {
          return;
        }
        const computed = getComputedStyle(root);
        frameDocument.body.style.color = computed.color;
        frameDocument.body.style.fontFamily = computed.fontFamily;
        frameDocument.body.style.fontSize = computed.fontSize;

        const syncHeight = (): void => {
          frame.style.height = `${Math.max(1, frameDocument.documentElement.scrollHeight)}px`;
        };
        const onClick = (event: MouseEvent): void => {
          if ((event.target as Element | null)?.closest('a[href]') !== null) {
            event.preventDefault();
          }
        };
        const onMouseUp = (): void => {
          captureFlowSelection(frameWindow.getSelection(), frameChapter);
        };
        frameDocument.addEventListener('click', onClick);
        frameDocument.addEventListener('mouseup', onMouseUp);
        const releaseImages = bindBlockedRemoteImages(
          frameDocument.body,
          t('reader.remoteImageLoad'),
          remoteImagePolicy,
        );
        const resizeObserver =
          typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(syncHeight);
        resizeObserver?.observe(frameDocument.documentElement);
        syncHeight();
        renderHighlights();
        releaseRemoteImages.push(() => {
          resizeObserver?.disconnect();
          releaseImages();
          frameDocument.removeEventListener('click', onClick);
          frameDocument.removeEventListener('mouseup', onMouseUp);
        });
      };
      frame.addEventListener('load', onLoad, { once: true });
      releaseRemoteImages.push(() => frame.removeEventListener('load', onLoad));
      frame.srcdoc = flowFrameSource(chapter.html);
      article.append(heading, frame);
      scrollHost.appendChild(article);
      chapterIndex += 1;
    }
  };

  const stagePages = async (
    filePath: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{
    host: HTMLDivElement;
    pdf: PdfRenderHandle | null;
    cbz: CbzRenderHandle | null;
  }> => {
    const ext = extOfPath(filePath);
    if (ext !== 'pdf' && ext !== 'cbz') {
      throw new ParseError(`暂不支持的页格式：.${ext || '?'}`);
    }
    const stagedHost = createPageHost();
    stagedHost.hidden = false;
    stagedHost.dataset.readerActive = 'true';
    if (ext === 'pdf') {
      const pdf = await renderPdfInto(bytes, stagedHost, signal);
      return { host: stagedHost, pdf, cbz: null };
    }
    const cbz = await renderCbzInto(bytes, stagedHost, signal);
    return { host: stagedHost, pdf: null, cbz };
  };

  const commitStagedPages = (
    staged: {
      host: HTMLDivElement;
      pdf: PdfRenderHandle | null;
      cbz: CbzRenderHandle | null;
    },
  ): void => {
    clearFlowBindings();
    const previousPdf = pdfHandle;
    const previousCbz = cbzHandle;
    pdfHandle = staged.pdf;
    cbzHandle = staged.cbz;
    pageHost.replaceWith(staged.host);
    pageHost = staged.host;
    scrollHost.hidden = true;
    void previousPdf?.destroy().catch(() => undefined);
    void previousCbz?.destroy().catch(() => undefined);
  };

  const loadAnnotations = async (
    filePath: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!annotationsEnabled) {
      return;
    }
    try {
      const nextContentHash = await deps.getContentHash!(filePath);
      if (destroyed || signal.aborted || generation !== loadGeneration) {
        return;
      }
      const nextAnnotations = parseAnnotations(
        await deps.readAnnotations!(nextContentHash),
      );
      if (destroyed || signal.aborted || generation !== loadGeneration) {
        return;
      }
      contentHash = nextContentHash;
      annotations = nextAnnotations;
    } catch {
      if (destroyed || signal.aborted || generation !== loadGeneration) {
        return;
      }
      contentHash = null;
      annotations = [];
      deps.notify?.(t('annotation.loadFailed'));
      return;
    }
    if (!PAGE_EXTS.has(loadedExt)) {
      renderHighlights();
    }
    ensureSidebar();
  };

  // PDF 连续滚动：←/→ 滚到上/下一页，+/- 缩放，0 还原。
  root.addEventListener('keydown', (event) => {
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      handle.scrollToPage(handle.controller.page - 1);
      event.preventDefault();
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      handle.scrollToPage(handle.controller.page + 1);
      event.preventDefault();
    } else if (event.key === '+' || event.key === '=') {
      if (handle.controller.zoomIn()) {
        event.preventDefault();
        void handle.rerender();
      }
    } else if (event.key === '-' || event.key === '_') {
      if (handle.controller.zoomOut()) {
        event.preventDefault();
        void handle.rerender();
      }
    } else if (event.key === '0') {
      if (handle.controller.resetScale()) {
        event.preventDefault();
        void handle.rerender();
      }
    }
  });

  // 书签 / 笔记改由菜单触发（见 ReaderInstance.addBookmark/addNote），不再挂浮动工具栏。

  return {
    async load(filePath: string, options: ReaderLoadOptions = {}): Promise<void> {
      const readBytes = deps.readBytes;
      if (readBytes === undefined) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      if (destroyed) {
        throw new Error('reader-view has been destroyed');
      }

      activeLoadController?.abort();
      const controller = new AbortController();
      activeLoadController = controller;
      const generation = ++loadGeneration;
      const nextExt = extOfPath(filePath);
      const cancelFromCaller = (): void => controller.abort();
      if (options.signal?.aborted === true) {
        controller.abort();
      } else {
        options.signal?.addEventListener('abort', cancelFromCaller, { once: true });
      }
      const isCurrent = (): boolean =>
        !destroyed && !controller.signal.aborted && generation === loadGeneration;
      let completed = false;

      setReaderState('loading');
      try {
        const bytes = await readBytes(filePath, controller.signal);
        throwIfReaderLoadCancelled(controller.signal);
        if (!isCurrent()) {
          return;
        }

        if (PAGE_EXTS.has(nextExt)) {
          const staged = await stagePages(filePath, bytes, controller.signal);
          if (controller.signal.aborted) {
            await staged.pdf?.destroy().catch(() => undefined);
            await staged.cbz?.destroy().catch(() => undefined);
            throwIfReaderLoadCancelled(controller.signal);
          }
          if (!isCurrent()) {
            await staged.pdf?.destroy().catch(() => undefined);
            await staged.cbz?.destroy().catch(() => undefined);
            return;
          }
          loadedExt = nextExt;
          annotations = [];
          contentHash = null;
          sidebar?.render(annotations);
          commitStagedPages(staged);
        } else {
          const content = await parseReaderContent(filePath, bytes, controller.signal);
          throwIfReaderLoadCancelled(controller.signal);
          if (!isCurrent()) {
            return;
          }
          loadedExt = nextExt;
          annotations = [];
          contentHash = null;
          sidebar?.render(annotations);
          const previousPdf = pdfHandle;
          const previousCbz = cbzHandle;
          pdfHandle = null;
          cbzHandle = null;
          renderChapters(content.chapters);
          void previousPdf?.destroy().catch(() => undefined);
          void previousCbz?.destroy().catch(() => undefined);
        }

        await loadAnnotations(filePath, generation, controller.signal);
        throwIfReaderLoadCancelled(controller.signal);
        if (isCurrent()) {
          setReaderState('ready');
          completed = true;
        }
      } catch (error) {
        if (isReaderLoadCancelled(error, controller.signal)) {
          if (!destroyed && generation === loadGeneration) {
            setReaderState('cancelled');
          }
          return;
        }
        if (!isCurrent()) {
          return;
        }
        setReaderState('error');
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', cancelFromCaller);
        if (activeLoadController === controller && !completed) {
          activeLoadController = null;
        }
      }
    },
    async destroy(): Promise<void> {
      if (destroyed) {
        return;
      }
      destroyed = true;
      loadGeneration += 1;
      activeLoadController?.abort();
      activeLoadController = null;
      clearFlowBindings();
      const handle = pdfHandle;
      const cbz = cbzHandle;
      pdfHandle = null;
      cbzHandle = null;
      sidebar?.destroy();
      sidebar = null;
      setReaderState('destroyed');
      root.remove();
      await handle?.destroy().catch(() => undefined);
      await cbz?.destroy().catch(() => undefined);
    },
    addBookmark: () => {
      if (annotationsEnabled) addAnnotation('bookmark');
    },
    addNote: () => {
      if (annotationsEnabled) addAnnotation('note');
    },
    toggleSidebar: () => setSidebarVisible(!sidebarVisible),
    isSidebarVisible: () => sidebarVisible,
    isAnnotationEnabled: () => annotationsEnabled,
  };
}
