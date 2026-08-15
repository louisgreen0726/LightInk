/**
 * `reader-view` — 只读阅读视图（T3 骨架 + T4 流式 + T5 页式 + T6 标注）。
 *
 * 流式格式渲染章节化 HTML（滚动宿主）；PDF/CBZ 渲染页（页宿主）。标注按内容哈希
 * （Rust content_hash）关联：加载时读出 → 流式高亮渲染 <mark> + 侧栏列表跳转；
 * 选中正文可加高亮，工具栏可加书签/笔记，侧栏可移除，变更写回 app_data_dir。
 * 只消费主题令牌 var(--lightink-*) 与 --lightink-font-scale。
 */

import './reader.css';
import type { MessageKey } from '../i18n/messages.js';
import { parseReaderContent } from './formats/index.js';
import type { ReaderChapter, ReaderContent } from './formats/types.js';
import { ParseError } from './formats/types.js';
import { sanitizeReaderCss } from './sanitize-css.js';
import { renderCbzInto, type CbzRenderHandle } from './formats/cbz.js';
import { renderPdfInto, type PdfRenderHandle } from './formats/pdf.js';
import {
  AnnotationWriteQueue,
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
  type AnnotationKind,
  type Locator,
} from './annotations.js';
import {
  annotationMarkFromEventTarget,
  flowLocatorFromRange,
  markTextRange,
  pdfTextLocatorFromRange,
  removeTextRangeMarks,
  resolveTextQuoteRange,
} from './annotation-locator.js';
import { createAnnotationSidebar, type AnnotationSidebar } from './annotation-sidebar.js';
import {
  createSelectionToolbar,
  type SelectionToolbar,
} from './selection-toolbar.js';
import { showNoteDialog } from './note-dialog.js';
import { outlineFromEntries } from './outline.js';
import type { OutlineItem } from '../outline/outline-model.js';
import {
  canWrapSearchMark,
  createSearchPanel,
  nearestMatchIndex,
  nextMatchIndex,
  offsetRangeFrom,
  preserveMatchIndex,
  sanitizeSearchQuery,
  unwrapSpans,
  wrapTextRangeWithSpan,
  type PdfSearchMatch,
  type SearchPanel,
} from './search-panel.js';
import type {
  ReaderInstance,
  ReaderLoadOptions,
  ReaderPhase,
  ReaderState,
  ReaderStateListener,
} from './types.js';
import {
  isReaderLoadCancelled,
  throwIfReaderLoadCancelled,
} from './load-lifecycle.js';
import {
  bindBlockedRemoteImages,
  sessionRemoteImagePolicy,
  type RemoteImagePolicy,
} from '../media/remote-image-policy.js';
import {
  chapterScrollRatio,
  chapterScrollTop,
  loadReadingProgress,
  resolveProgressStorage,
  saveReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from './reading-progress.js';
import {
  advancePagedScroller,
  advanceScrolledScroller,
  applyPagedProgress,
  createPagedWheelGate,
  createResizeSettle,
  isReadingNavKey,
  pagedColumnStep,
  pagedProgressRatio,
  pagedSpreadMetrics,
  readingNavDirection,
  snapPagedScroller,
} from '../ui/reading-layout.js';

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
html, body { margin: 0; }
body {
  color: inherit;
  background: transparent;
  font: inherit;
  line-height: 1.8;
}
p { margin: 0 0 0.55em; }
h1, h2, h3 {
  font-weight: 600;
  line-height: 1.35;
  text-align: center;
  text-indent: 0;
}
h1 { font-size: 1.18em; margin: 1.8em 0 1em; }
h2 { font-size: 1.06em; margin: 1.6em 0 0.85em; }
h3 { font-size: 1em; margin: 1.4em 0 0.7em; }
html[data-reading-layout='scroll'],
html[data-reading-layout='scroll'] body {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  height: auto;
  min-height: 0;
  overflow: visible;
}
html[data-reading-layout='paginated'] {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;
  column-width: var(--lightink-reader-column-width, 100%);
  column-count: auto;
  column-gap: var(--lightink-reader-column-gap, 0px);
  column-fill: auto;
  scrollbar-width: none;
}
html[data-reading-layout='paginated']::-webkit-scrollbar {
  width: 0;
  height: 0;
}
html[data-reading-layout='paginated'] body {
  box-sizing: border-box;
  height: auto;
  min-height: 100%;
  max-width: none;
  margin: 0;
  overflow: visible;
}
img, figure, table, pre, h1, h2, h3, h4, h5, h6 { break-inside: avoid; }
img, svg {
  max-width: 100% !important;
  width: auto !important;
  height: auto !important;
  display: block;
  margin: 1.1rem auto;
  object-fit: contain;
}
html[data-reading-layout='paginated'] img,
html[data-reading-layout='paginated'] svg {
  max-height: var(--lightink-reader-page-height, 100%);
}
html[data-reading-layout='paginated'] figure {
  max-width: 100%;
  max-height: var(--lightink-reader-page-height, 100%);
  margin: 1.1rem auto;
}
table { max-width: 100%; border-collapse: collapse; }
th, td { padding: 0.35rem 0.5rem; border: 1px solid currentColor; }
pre { overflow-x: auto; white-space: pre-wrap; }
a { color: inherit; text-decoration: underline; }
mark.lightink-reader-highlight { background: #f2d675; color: #111; }
mark.lightink-reader-highlight[data-annotation-kind='note'] {
  background: rgba(154, 88, 40, 0.22);
  box-shadow: inset 0 -0.12em 0 #9a5828;
  cursor: pointer;
}
.lightink-reader-search-mark { background: rgba(154, 88, 40, 0.22); border-radius: 2px; }
.lightink-reader-search-mark--current {
  background: rgba(154, 88, 40, 0.45);
  outline: 1px solid currentColor;
}
.lightink-remote-image-placeholder { display: flex; align-items: center; min-height: 2.5rem; }
`;

function flowFrameSource(html: string, stylesheet = ''): string {
  const publisher = sanitizeReaderCss(stylesheet);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${FLOW_FRAME_CSP}">` +
    (publisher === '' ? '' : `<style>${publisher}</style>`) +
    `<style>${FLOW_FRAME_CSS}</style></head><body>${html}</body></html>`
  );
}

/**
 * Scroll-mode iframe height: only the inner body content.
 * Never use html.scrollHeight after stretching the iframe — the root
 * viewport is at least as tall as the frame, so a 100000px probe would
 * lock the chapter to a blank page.
 */
export function flowFrameContentHeight(frameDocument: Document): number {
  const body = frameDocument.body;
  if (body === null) {
    return 1;
  }
  return Math.ceil(Math.max(body.scrollHeight, 1));
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

/** 文本层相关变更：层容器插入，或层内部 childList 变更（pdfjs TextLayer.render 异步追加 span）。 */
function isEndOfContent(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).classList.contains('endOfContent');
}

export function isTextLayerMutation(records: readonly MutationRecord[]): boolean {
  return records.some((record) => {
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    if (nodes.length > 0 && nodes.every(isEndOfContent)) {
      return false;
    }
    for (const node of Array.from(record.addedNodes)) {
      if (
        node.nodeType === 1 &&
        (node as Element).classList.contains('lightink-reader-text-layer')
      ) {
        return true;
      }
    }
    const target = record.target;
    return (
      target.nodeType === 1 &&
      typeof (target as Element).closest === 'function' &&
      (target as Element).closest('.lightink-reader-text-layer') !== null &&
      !(target as Element).classList.contains('endOfContent')
    );
  });
}

export interface ReaderViewDeps {
  /** 读取文件原始字节（生产为 invoke read_file_bytes → base64 → Uint8Array）。 */
  readBytes?: (filePath: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** 翻译 i18n key（生产为 i18n.t）。 */
  t?: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
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
  /** Injectable flow parser for lifecycle tests. */
  parseContent?: (
    filePath: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<ReaderContent>;
  /** Injectable progress storage; production uses localStorage. */
  progressStorage?: ProgressStorage | null;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
 */
export function createReaderView(host: HTMLElement, deps: ReaderViewDeps = {}): ReaderInstance {
  const t = deps.t ?? ((key: MessageKey) => key);
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
  let sidebarBackdrop: HTMLButtonElement | null = null;
  /** 标注侧栏默认隐藏；桌面占据固定列，窄窗切换为覆盖式 drawer。 */
  let sidebarVisible = false;
  /** 本阅读标签当前是否可见（切走时需隐藏 portal 到共享 chrome 的覆盖层）。 */
  let tabActive = true;
  /** 划选工具栏（R3）：划选后确认再产生标注；懒创建（标注启用时）。 */
  let selectionToolbar: SelectionToolbar | null = null;
  /** mouseup 时捕获的待确认划选（locator + quote + 命中的已有高亮 id + 来源 frame）。 */
  let pendingSelection: {
    locator: Locator;
    quote: string;
    existingHighlightId: string | null;
    frame: HTMLIFrameElement | null;
  } | null = null;
  let loadedExt = '';
  let readerOutline: OutlineItem[] = [];
  let exportChapters: ReaderChapter[] = [];
  let exportStylesheet = '';
  let loadGeneration = 0;
  let activeLoadController: AbortController | null = null;
  let destroyed = false;
  let flowRenderGeneration = 0;
  let flowContentDispose: (() => void) | null = null;
  /** PDF 搜索面板与当前搜索状态（R2；查询/命中/活动命中索引）。 */
  let searchPanel: SearchPanel | null = null;
  let pdfSearch: { query: string; matches: PdfSearchMatch[]; active: number } | null = null;
  let flowSearch: { query: string; marks: HTMLElement[]; active: number } | null = null;
  let searchGeneration = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  /** 激活跳转待滚动的命中 key（页:起:止）：命中首次就绪时滚动一次后清除。 */
  let pendingSearchScrollKey: string | null = null;
  const annotationWriteQueue = new AnnotationWriteQueue();
  const remoteImagePolicy = deps.remoteImagePolicy ?? sessionRemoteImagePolicy;
  let releaseRemoteImages: Array<() => void> = [];
  const progressStorage = resolveProgressStorage(deps.progressStorage);
  let progressId = '';
  let pendingRestore: ReadingProgress | null = null;
  let lastFlowProgress: ReadingProgress | null = null;
  let restoreAttempts = 0;
  let progressSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutSwitching = false;

  const stateListeners = new Set<ReaderStateListener>();
  let readerState: ReaderState = Object.freeze({
    phase: 'empty',
    current: 0,
    total: 0,
    progress: 0,
    scale: 1,
    locationKind: null,
  });

  const currentProgressSnapshot = (): ReadingProgress | null => {
    if (pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      const page = pdfHandle?.controller.page ?? cbzHandle?.currentPage ?? 0;
      if (page < 1) {
        return null;
      }
      return {
        version: 1,
        kind: 'page',
        index: page,
        ratio: 0,
        updatedAt: Date.now(),
      };
    }
    const total = scrollHost.querySelectorAll('.lightink-reader-chapter').length;
    if (total === 0) {
      return null;
    }
    const chapterIndex = Math.max(0, readerState.current - 1);
    if (document.documentElement.dataset.readingLayout === 'paginated') {
      const scroller = visibleFlowFrame()?.contentDocument?.documentElement;
      return {
        version: 1,
        kind: 'flow',
        index: chapterIndex,
        ratio: scroller === undefined || scroller === null ? 0 : pagedProgressRatio(scroller),
        updatedAt: Date.now(),
      };
    }
    const scroller = flowScrollContainer();
    const article = scrollHost.querySelector<HTMLElement>(
      `.lightink-reader-chapter[data-chapter-index="${chapterIndex}"]`,
    );
    const chapterHeight = article?.offsetHeight ?? 0;
    if (article !== null && chapterHeight > 0) {
      return {
        version: 1,
        kind: 'flow',
        index: chapterIndex,
        ratio: chapterScrollRatio(
          scroller.scrollTop,
          articleOffsetInScroller(article, scroller),
          chapterHeight,
        ),
        updatedAt: Date.now(),
      };
    }
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return {
      version: 1,
      kind: 'flow',
      index: chapterIndex,
      ratio: maxScroll === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)),
      updatedAt: Date.now(),
    };
  };

  const rememberFlowProgress = (): void => {
    const snapshot = currentProgressSnapshot();
    if (snapshot !== null) {
      lastFlowProgress = snapshot;
    }
  };

  const persistReadingProgress = (): void => {
    if (progressId === '' || readerState.phase !== 'ready' || pendingRestore !== null) {
      return;
    }
    rememberFlowProgress();
    if (lastFlowProgress !== null) {
      saveReadingProgress(progressStorage, progressId, lastFlowProgress);
    }
  };

  const schedulePersistReadingProgress = (): void => {
    if (progressSaveTimer !== null) {
      clearTimeout(progressSaveTimer);
    }
    progressSaveTimer = setTimeout(() => {
      progressSaveTimer = null;
      persistReadingProgress();
    }, 400);
  };

  const applySavedProgress = (): boolean => {
    const saved = pendingRestore;
    if (saved === null) {
      return true;
    }
    if (saved.kind === 'page') {
      if (pdfHandle !== null) {
        pdfHandle.scrollToPage(saved.index);
        pendingRestore = null;
        return true;
      }
      if (cbzHandle !== null) {
        cbzHandle.scrollToPage(saved.index);
        pendingRestore = null;
        return true;
      }
      return false;
    }
    const chapters = scrollHost.querySelectorAll('.lightink-reader-chapter');
    if (chapters.length === 0) {
      return false;
    }
    if (document.documentElement.dataset.readingLayout === 'paginated') {
      setActiveChapter(Math.min(saved.index, chapters.length - 1));
      const frame = scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter[data-chapter-index="${Math.min(saved.index, chapters.length - 1)}"] .lightink-reader-chapter-frame`,
      );
      const scroller = frame?.contentDocument?.documentElement;
      if (scroller === undefined || scroller === null || scroller.clientWidth <= 1) {
        restoreAttempts += 1;
        if (restoreAttempts >= 8) {
          pendingRestore = null;
          return true;
        }
        return false;
      }
      applyPagedProgress(scroller, saved.ratio);
      pendingRestore = null;
      return true;
    }
    const scroller = flowScrollContainer();
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll <= 0 && restoreAttempts < 8) {
      restoreAttempts += 1;
      return false;
    }
    const article = chapters[Math.min(saved.index, chapters.length - 1)] as HTMLElement | undefined;
    if (article !== undefined && article.offsetHeight > 0) {
      scroller.scrollTop = Math.min(
        maxScroll,
        chapterScrollTop(
          articleOffsetInScroller(article, scroller),
          article.offsetHeight,
          saved.ratio,
        ),
      );
    } else {
      scroller.scrollTop = Math.min(maxScroll, Math.round(saved.ratio * maxScroll));
    }
    pendingRestore = null;
    return true;
  };

  const applyStateToDom = (state: ReaderState): void => {
    root.dataset.readerState = state.phase;
    root.setAttribute('aria-busy', state.phase === 'loading' ? 'true' : 'false');
    const messageKey =
      state.phase === 'loading'
        ? 'reader.loading'
        : state.phase === 'cancelled'
          ? 'reader.cancelled'
          : state.phase === 'error'
            ? 'reader.failed'
            : null;
    status.hidden = messageKey === null;
    status.textContent = messageKey === null ? '' : t(messageKey);
  };

  const setReaderState = (next: ReaderState): void => {
    const changed =
      readerState.phase !== next.phase ||
      readerState.current !== next.current ||
      readerState.total !== next.total ||
      readerState.progress !== next.progress ||
      readerState.scale !== next.scale ||
      readerState.locationKind !== next.locationKind;
    if (changed) {
      readerState = Object.freeze({ ...next });
    }
    applyStateToDom(readerState);
    if (!changed) return;
    for (const listener of stateListeners) {
      try {
        listener(readerState);
      } catch {
        // Application chrome must not be able to interrupt reader rendering.
      }
    }
  };

  const updateReaderState = (patch: Partial<ReaderState>): void => {
    setReaderState({ ...readerState, ...patch });
  };

  const setReaderPhase = (phase: ReaderPhase, resetMetrics = false): void => {
    setReaderState(
      resetMetrics
        ? { phase, current: 0, total: 0, progress: 0, scale: 1, locationKind: null }
        : { ...readerState, phase },
    );
  };

  const clearFlowBindings = (): void => {
    flowRenderGeneration += 1;
    releaseRemoteImages.splice(0).forEach((release) => release());
  };
  applyStateToDom(readerState);

  const saveAnnotations = async (): Promise<void> => {
    if (contentHash === null || deps.writeAnnotations === undefined) {
      return;
    }
    const saveHash = contentHash;
    const json = serializeAnnotations(annotations);
    await annotationWriteQueue.enqueue(
      saveHash,
      json,
      deps.writeAnnotations,
      () => {
        if (!destroyed && contentHash === saveHash) {
          deps.notify?.(t('annotation.saveFailed'));
        }
      },
    );
  };

  /** 移除标注（侧栏/划选工具栏共用）：更新集合、清正文 mark（flow 正文与 PDF 文本层）、保存。 */
  const removeAnnotationById = (id: string): void => {
    annotations = annotations.filter((a) => a.id !== id);
    for (const doc of flowDocuments()) {
      removeTextRangeMarks(doc.body, id);
    }
    for (const layer of pageHost.querySelectorAll('.lightink-reader-text-layer')) {
      removeTextRangeMarks(layer, id);
    }
    sidebar?.render(annotations);
    void saveAnnotations();
  };

  const hideSelectionToolbar = (): void => {
    pendingSelection = null;
    selectionToolbar?.hide();
  };

  const openNote = (annotation: Annotation): void => {
    if (annotation.kind !== 'note') {
      return;
    }
    void (async () => {
      const generation = loadGeneration;
      const input = await showNoteDialog(
        document,
        annotation.note ?? '',
        { t, editing: true },
        annotation.quote,
      );
      if (input === null || destroyed || generation !== loadGeneration) {
        return;
      }
      annotations = annotations.map((item) =>
        item.id === annotation.id ? { ...item, note: input } : item,
      );
      sidebar?.render(annotations);
      void saveAnnotations();
    })();
  };

  const annotationFromMark = (target: EventTarget | null): Annotation | null => {
    const id = annotationMarkFromEventTarget(target)?.getAttribute('data-annotation-id') ?? '';
    if (id === '') {
      return null;
    }
    return annotations.find((item) => item.id === id) ?? null;
  };

  /** 工具栏动作派发（R3）：确认后才创建/移除标注；复制始终可用。 */
  const ensureSelectionToolbar = (): void => {
    if (selectionToolbar !== null) {
      return;
    }
    selectionToolbar = createSelectionToolbar({
      t,
      onAction: (action) => {
        const pending = pendingSelection;
        pendingSelection = null;
        if (pending === null) {
          return;
        }
        // 确认后清空来源选区（flow 为 iframe 选区，PDF 为主文档选区）。
        const clearSourceSelection = (): void => {
          if (pending.frame !== null) {
            pending.frame.contentWindow?.getSelection()?.removeAllRanges();
          } else {
            window.getSelection()?.removeAllRanges();
          }
        };
        if (action === 'removeHighlight') {
          clearSourceSelection();
          if (pending.existingHighlightId !== null) {
            removeAnnotationById(pending.existingHighlightId);
          }
          return;
        }
        if (action === 'copy') {
          void navigator.clipboard?.writeText(pending.quote).catch(() => undefined);
          return;
        }
        if (deps.writeAnnotations === undefined) {
          return;
        }
        if (action === 'note') {
          void (async () => {
            const generation = loadGeneration;
            const input = await showNoteDialog(document, '', { t }, pending.quote);
            if (input === null) {
              return; // 取消：保留选区、不产生标注
            }
            if (destroyed || generation !== loadGeneration) {
              return; // 弹层期间已切换文档/销毁：丢弃迟到保存
            }
            clearSourceSelection();
            appendAnnotation('note', pending.locator, pending.quote, input);
          })();
          return;
        }
        clearSourceSelection();
        appendAnnotation('highlight', pending.locator, pending.quote, undefined);
      },
    });
    root.appendChild(selectionToolbar.element);
  };

  /** 当前阅读位置的定位器（书签/笔记用）。 */
  const currentPositionLocator = (): Locator => {
    if (pdfHandle !== null) {
      return { format: 'pdf', page: pdfHandle.controller.page, quote: '' };
    }
    if (cbzHandle !== null) {
      return { format: 'cbz', page: cbzHandle.currentPage };
    }
    const chapter = firstVisibleChapter();
    const article = scrollHost.querySelector<HTMLElement>(
      `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
    );
    const body = article?.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')
      ?.contentDocument?.body;
    const text = body?.textContent ?? '';
    const visibleOffset = Math.max(0, scrollHost.scrollTop - (article?.offsetTop ?? 0));
    const progress =
      article === null || article === undefined || article.offsetHeight <= 0
        ? 0
        : Math.min(1, visibleOffset / article.offsetHeight);
    const start = Math.floor(text.length * progress);
    const anchor = {
      start,
      end: start,
      quote: '',
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(start, start + 32),
    };
    if (loadedExt === 'txt') {
      return { format: 'text', ...anchor };
    }
    return { format: 'flow', chapter, ...anchor };
  };

  /** 流式：视口顶部最近的章节索引。 */
  const setActiveChapter = (index: number): void => {
    const chapters = scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter');
    chapters.forEach((chapter) => {
      const current = Number(chapter.dataset.chapterIndex);
      chapter.classList.toggle('is-active', current === index);
    });
  };

  const closestPane = (): HTMLElement | null => {
    if (typeof host.closest !== 'function') {
      return null;
    }
    return host.closest('#lightink-editor-area');
  };

  const chromeHost = (): HTMLElement => {
    if (typeof document !== 'undefined') {
      return document.getElementById('lightink-main') ?? closestPane() ?? root;
    }
    return closestPane() ?? root;
  };

  const flowScrollContainer = (): HTMLElement => closestPane() ?? scrollHost;

  const articleOffsetInScroller = (article: HTMLElement, scroller: HTMLElement): number => {
    const articleRect = article.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return articleRect.top - scrollerRect.top + scroller.scrollTop;
  };

  const chapterFromScroll = (): number => {
    const chapters = Array.from(scrollHost.querySelectorAll('.lightink-reader-chapter'));
    if (chapters.length === 0) {
      return 0;
    }
    const scroller = flowScrollContainer();
    const hostTop = scroller.getBoundingClientRect().top;
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

  const firstVisibleChapter = (): number => {
    if (document.documentElement.dataset.readingLayout === 'paginated') {
      const active = scrollHost.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
      const index = Number(active?.dataset.chapterIndex ?? 0);
      return Number.isSafeInteger(index) ? index : 0;
    }
    return chapterFromScroll();
  };

  const syncFlowState = (): void => {
    if (destroyed || pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const total = scrollHost.querySelectorAll('.lightink-reader-chapter').length;
    if (total === 0) {
      updateReaderState({ current: 0, total: 0, progress: 0, scale: 1, locationKind: null });
      return;
    }
    const current = Math.min(total, firstVisibleChapter() + 1);
    let progress = 1;
    if (document.documentElement.dataset.readingLayout === 'paginated') {
      const scroller = visibleFlowFrame()?.contentDocument?.documentElement;
      if (scroller !== undefined && scroller !== null) {
        const chapterRatio = total === 0 ? 0 : (current - 1) / total;
        const pageRatio = pagedProgressRatio(scroller) / Math.max(1, total);
        progress = Math.min(1, chapterRatio + pageRatio);
      } else {
        progress = total === 0 ? 0 : current / total;
      }
    } else {
      const scroller = flowScrollContainer();
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      progress = maxScroll === 0 ? 1 : Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
    }
    updateReaderState({ current, total, progress, scale: 1, locationKind: 'chapter' });
  };

  const syncPageState = (): void => {
    const current = pdfHandle?.controller.page ?? cbzHandle?.currentPage ?? 0;
    const total = pdfHandle?.controller.totalPages ?? cbzHandle?.totalPages ?? 0;
    const scale = pdfHandle?.controller.scale ?? 1;
    updateReaderState({
      current,
      total,
      progress: total === 0 ? 0 : Math.min(1, Math.max(0, current / total)),
      scale,
      locationKind: total === 0 ? null : 'page',
    });
  };

  const onFlowScroll = (): void => {
    syncFlowState();
    rememberFlowProgress();
    schedulePersistReadingProgress();
    // 工具栏按视口坐标固定定位，滚动后指向失效——直接隐藏。
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  const onPageScroll = (): void => {
    syncPageState();
    schedulePersistReadingProgress();
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  scrollHost.addEventListener('scroll', onFlowScroll, { passive: true });
  const paneScroller = closestPane();
  paneScroller?.addEventListener('scroll', onFlowScroll, { passive: true });
  scrollHost.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        return;
      }
      if (document.documentElement.dataset.readingLayout !== 'paginated') {
        return;
      }
      if (pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
        return;
      }
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      if (gatePagedWheel(delta > 0 ? 1 : -1, advanceReading)) {
        hideSelectionToolbar();
      }
    },
    { passive: false },
  );

  /** 追加标注并同步正文高亮/侧栏/持久化。 */
  const appendAnnotation = (
    kind: AnnotationKind,
    locator: Locator,
    quote: string | undefined,
    note: string | undefined,
  ): void => {
    annotations = [
      ...annotations,
      {
        id: newAnnotationId(),
        kind,
        locator,
        quote,
        note,
        createdAt: Date.now(),
      },
    ];
    renderHighlights();
    sidebar?.render(annotations);
    void saveAnnotations();
  };

  /** 添加书签或笔记（笔记经多行弹层输入，取消不创建）。 */
  const addAnnotation = (kind: AnnotationKind): void => {
    if (kind === 'note') {
      void (async () => {
        const generation = loadGeneration;
        const input = await showNoteDialog(document, '', { t });
        if (input === null) {
          return;
        }
        if (destroyed || generation !== loadGeneration) {
          return; // 弹层期间已切换文档/销毁：丢弃迟到保存
        }
        appendAnnotation('note', currentPositionLocator(), undefined, input);
      })();
      return;
    }
    appendAnnotation(kind, currentPositionLocator(), undefined, undefined);
  };

  function ensureSidebar(): void {
    if (sidebar !== null) {
      return;
    }
    sidebarBackdrop = document.createElement('button');
    sidebarBackdrop.type = 'button';
    sidebarBackdrop.className = 'lightink-reader-sidebar-backdrop';
    sidebarBackdrop.tabIndex = -1;
    sidebarBackdrop.setAttribute('aria-hidden', 'true');
    sidebarBackdrop.hidden = !sidebarVisible;
    sidebarBackdrop.addEventListener('click', () => setSidebarVisible(false));
    sidebar = createAnnotationSidebar({
      t,
      onClose: () => setSidebarVisible(false),
      onJump: (annotation) => {
        const loc = annotation.locator;
        if (loc.format === 'pdf' && pdfHandle !== null) {
          pdfHandle.scrollToPage(loc.page);
          syncPageState();
          pageHost
            .querySelector<HTMLElement>(
              `[data-annotation-id="${cssEscape(annotation.id)}"]`,
            )
            ?.scrollIntoView({ block: 'center' });
          return;
        }
        if (loc.format === 'cbz') {
          cbzHandle?.scrollToPage(loc.page);
          syncPageState();
          return;
        }
        // flow / text：优先定位到该条高亮的 <mark>，否则到章节。
        const chapter =
          loc.format === 'flow' ? loc.chapter : loc.format === 'text' ? 0 : firstVisibleChapter();
        if (document.documentElement.dataset.readingLayout === 'paginated') {
          setActiveChapter(chapter);
        }
        const mark = Array.from(
          scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
        )
          .map((frame) =>
            frame.contentDocument?.querySelector<HTMLElement>(
              `[data-annotation-id="${cssEscape(annotation.id)}"]`,
            ) ?? null,
          )
          .find((candidate): candidate is HTMLElement => candidate !== null);
        if (mark !== undefined) {
          mark.scrollIntoView({ block: 'center' });
          return;
        }
        if (loc.format === 'flow' || loc.format === 'text') {
          const frame = scrollHost.querySelector<HTMLIFrameElement>(
            `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
          );
          const range =
            frame?.contentDocument === null || frame?.contentDocument === undefined
              ? null
              : resolveTextQuoteRange(frame.contentDocument.body, loc);
          const boundary = range?.startContainer;
          const target =
            boundary?.nodeType === Node.ELEMENT_NODE
              ? (boundary as Element)
              : boundary?.parentElement;
          if (target !== undefined && target !== null) {
            target.scrollIntoView({ block: 'center' });
            return;
          }
        }
        scrollHost
          .querySelector<HTMLElement>(`[data-chapter-index="${chapter}"]`)
          ?.scrollIntoView({ block: 'center' });
      },
      onRemove: (annotation) => {
        removeAnnotationById(annotation.id);
      },
      onEditNote: (annotation) => {
        openNote(annotation);
      },
    });
    sidebar.element.setAttribute('aria-hidden', sidebarVisible ? 'false' : 'true');
    sidebar.element.hidden = !tabActive || !sidebarVisible;
    chromeHost().append(sidebarBackdrop, sidebar.element);
    sidebar.render(annotations);
  }

  /** 侧栏覆盖层（含 portal 到共享 chrome 的部分）与当前显隐状态同步。 */
  function syncSidebarOverlayDom(): void {
    const shown = sidebarVisible && tabActive;
    root.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    // chromeHost（#lightink-main）是所有标签共享的，只在侧栏真正显示时占类。
    chromeHost().classList.toggle('lightink-reader--sidebar', shown);
    closestPane()?.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    sidebar?.element.setAttribute('aria-hidden', shown ? 'false' : 'true');
    if (sidebar !== null) {
      sidebar.element.hidden = !shown;
    }
    if (sidebarBackdrop !== null) {
      sidebarBackdrop.hidden = !shown;
    }
  }

  /** 切换侧栏显隐，并让窄窗 drawer 获得或释放键盘焦点。 */
  function setSidebarVisible(visible: boolean): void {
    sidebarVisible = visible;
    if (visible) {
      ensureSidebar();
    }
    syncSidebarOverlayDom();
    if (
      sidebarVisible &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 700px)').matches
    ) {
      sidebar?.element
        .querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')
        ?.focus();
    }
    if (
      !sidebarVisible &&
      sidebar !== null &&
      sidebar.element.contains(document.activeElement)
    ) {
      root.focus();
    }
    syncVisibleFlowFrames();
  }

  /**
   * 标签可见性变化（切换标签时由宿主调用）。侧栏/搜索面板 portal 到共享的
   * #lightink-main，不随标签宿主的 display:none 一起隐藏，必须在此显式同步，
   * 否则会残留在别的标签上并继续操作非活动文档。sidebarVisible 只记用户偏好，
   * 切回标签时自动恢复。
   */
  function setTabActive(active: boolean): void {
    if (tabActive === active) {
      return;
    }
    tabActive = active;
    syncSidebarOverlayDom();
    if (searchPanel !== null) {
      searchPanel.element.hidden = !active;
    }
    if (!active) {
      hideSelectionToolbar();
    }
  }

  const flowDocuments = (): Document[] =>
    Array.from(
      scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    )
      .map((frame) => frame.contentDocument)
      .filter((doc): doc is Document => doc !== null && doc.body !== null);

  /** PDF 文本层标注：把含 anchor 的高亮/笔记渲染到对应页文本层（幂等，层未就绪则跳过）。 */
  const renderPdfHighlights = (): void => {
    for (const hl of annotations) {
      if (hl.kind !== 'highlight' && hl.kind !== 'note') {
        continue;
      }
      const locator = hl.locator;
      if (locator.format !== 'pdf' || locator.anchor === undefined) {
        continue;
      }
      if (
        pageHost.querySelector(
          `.lightink-reader-highlight[data-annotation-id="${cssEscape(hl.id)}"]`,
        ) !== null
      ) {
        continue; // 已渲染
      }
      const slot = pageHost.querySelector<HTMLElement>(
        `.lightink-reader-page-slot[data-page-index="${locator.page - 1}"]`,
      );
      const layer = slot?.querySelector<HTMLElement>('.lightink-reader-text-layer') ?? null;
      if (layer === null) {
        continue; // 该页文本层尚未懒渲染，观察器会在层出现时重试
      }
      const range = resolveTextQuoteRange(layer, locator.anchor);
      if (range !== null && !range.collapsed) {
        markTextRange(layer, range, hl.id, hl.kind);
      }
    }
  };

  /** 文本层懒出现/异步 span 填充/缩放重建后重渲染 PDF 高亮（MutationObserver 驱动）。 */
  let textLayerObserver: MutationObserver | null = null;
  const observeTextLayers = (host: HTMLElement): void => {
    textLayerObserver?.disconnect();
    textLayerObserver = null;
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    let renderQueued = false;
    textLayerObserver = new MutationObserver((records) => {
      if (!isTextLayerMutation(records) || renderQueued) {
        return;
      }
      // pdfjs 逐 span 追加会连发多批记录；合并到微任务末尾渲染一次（幂等防重复）。
      renderQueued = true;
      queueMicrotask(() => {
        renderQueued = false;
        renderPdfHighlights();
        renderPdfSearchMarks(); // 层重建后搜索命中 overlay 一并恢复
      });
    });
    textLayerObserver.observe(host, { childList: true, subtree: true });
  };

  /** PDF 文本层选区（主文档 DOM，无 iframe 偏移）：捕获文字级定位并唤起工具栏。 */
  const onPageHostSelection = (): void => {
    if (pdfHandle === null) {
      return;
    }
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      hideSelectionToolbar();
      return;
    }
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    const layer = container?.closest('.lightink-reader-text-layer') ?? null;
    if (layer === null) {
      // 非文本层选区（canvas/跨页拖选）不处理，但清掉可能滞留的工具栏与过期选区。
      hideSelectionToolbar();
      return;
    }
    const slot = layer.closest<HTMLElement>('.lightink-reader-page-slot');
    const pageIndex = Number(slot?.dataset.pageIndex ?? -1);
    if (!(pageIndex >= 0)) {
      return;
    }
    const locator = pdfTextLocatorFromRange(layer, range, pageIndex + 1);
    if (locator === null) {
      hideSelectionToolbar();
      return;
    }
    const anchorElement =
      selection.anchorNode === null
        ? null
        : selection.anchorNode.nodeType === 1
          ? (selection.anchorNode as Element)
          : selection.anchorNode.parentElement;
    const existingMark = anchorElement?.closest('[data-annotation-id]') ?? null;
    pendingSelection = {
      locator,
      quote: text,
      existingHighlightId: existingMark?.getAttribute('data-annotation-id') ?? null,
      frame: null,
    };
    ensureSelectionToolbar();
    selectionToolbar?.showAt(range.getBoundingClientRect(), {
      canRemoveHighlight: existingMark !== null,
    });
  };

  const onPageHostNoteClick = (event: MouseEvent): void => {
    const annotation = annotationFromMark(event.target);
    if (annotation === null || annotation.kind !== 'note') {
      return;
    }
    event.preventDefault();
    openNote(annotation);
  };

  /** 关闭可能打开中的笔记弹层（切换/销毁时经 Escape 走正规 release，恢复背景 inert）。 */
  const closeOpenNoteDialog = (): void => {
    if (
      typeof document !== 'undefined' &&
      typeof document.querySelector === 'function' &&
      document.querySelector('.lightink-note-dialog') !== null &&
      typeof KeyboardEvent !== 'undefined'
    ) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  };

  /** 清掉全部搜索命中 overlay（span 解包保留文本）。 */
  const clearPdfSearchMarks = (): void => {
    for (const layer of pageHost.querySelectorAll('.lightink-reader-text-layer')) {
      unwrapSpans(layer, 'lightink-reader-search-mark');
      unwrapSpans(layer, 'lightink-reader-search-mark--current');
    }
  };

  /**
   * 在当前已渲染文本层上叠加搜索命中 overlay（全部命中 + 当前命中双样式）。
   * 幂等：已有 key 戳记的 overlay 只校正类名不重包裹（防 observer 自激循环）；
   * 层文本未填充到命中末尾时跳过（防部分包裹定格，等后续批次重试）。
   * 激活滚动经 pendingScrollKey：命中首次就绪（含远页文本层异步出现）时滚动一次，
   * observer 驱动的重渲染不回吸视口。
   */
  const renderPdfSearchMarks = (): void => {
    const state = pdfSearch;
    if (state === null) {
      return;
    }
    const layerFor = (page: number): HTMLElement | null =>
      pageHost.querySelector<HTMLElement>(
        `.lightink-reader-page-slot[data-page-index="${page - 1}"] .lightink-reader-text-layer`,
      );
    const current = state.matches[state.active];
    for (const match of state.matches) {
      const layer = layerFor(match.page);
      if (layer === null) {
        continue; // 未懒渲染的页跳过；层出现时经 observer 重渲染
      }
      const key = `${match.page}:${match.start}:${match.end}`;
      const existing = layer.querySelectorAll<HTMLElement>(
        `[data-search-key="${cssEscape(key)}"]`,
      );
      if (existing.length > 0) {
        // 幂等：已有该命中的 overlay 时只校正当前类名，不做任何重包裹——
        // 重包裹会在被观察的文本层内制造变更，与 observer 形成自激循环。
        const isCurrent = match === current;
        for (const span of existing) {
          span.classList.toggle('lightink-reader-search-mark--current', isCurrent);
          span.classList.toggle('lightink-reader-search-mark', !isCurrent);
        }
      } else if (canWrapSearchMark(layer, key, match.end)) {
        const located = offsetRangeFrom(layer, match.start, match.end);
        if (located !== null) {
          wrapTextRangeWithSpan(
            layer,
            located,
            match === current
              ? 'lightink-reader-search-mark--current'
              : 'lightink-reader-search-mark',
            key,
          );
        }
      } else {
        // 层文本尚未填充到命中末尾：等 observer 后续批次重试。
        continue;
      }
      // 激活滚动：该命中即 pending 目标且为当前命中时，滚动一次即清除。
      if (match === current && pendingSearchScrollKey === key) {
        pendingSearchScrollKey = null;
        layer
          .querySelector('.lightink-reader-search-mark--current')
          ?.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  /** 执行搜索（去抖 200ms：快速输入时不叠加全文档扫描）：命中后跳到首个并渲染 overlay。 */
  const runPdfSearch = (query: string): void => {
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    // 入口即换代：等待去抖窗口内的旧 in-flight 结果与未 fire 的旧定时器同代失效。
    const generation = ++searchGeneration;
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
    }
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void (async () => {
        const matches = await handle.search(query);
        if (destroyed || generation !== searchGeneration || handle !== pdfHandle) {
          return; // 迟到结果（新查询/切换文档）丢弃
        }
        clearPdfSearchMarks();
        const currentPage = handle.controller.page;
        const firstAtOrAfter = matches.findIndex((match) => match.page >= currentPage);
        const active = nearestMatchIndex(matches.length, firstAtOrAfter);
        pdfSearch = { query, matches, active };
        searchPanel?.setStatus(matches.length, active);
        renderPdfSearchMarks();
        // Opening Find or typing a query should not yank the reader back to page 1.
      })();
    }, 200);
  };

  /** 跳到指定命中（环形步进在面板回调中计算）。 */
  const jumpToPdfMatch = (target: number): void => {
    const state = pdfSearch;
    if (state === null || pdfHandle === null) {
      return;
    }
    const index = nextMatchIndex(state.matches.length, state.active, target >= 0 ? 1 : -1);
    if (index < 0) {
      return;
    }
    state.active = index;
    const match = state.matches[index]!;
    pendingSearchScrollKey = `${match.page}:${match.start}:${match.end}`;
    pdfHandle.scrollToPage(match.page);
    syncPageState();
    renderPdfSearchMarks();
    searchPanel?.setStatus(state.matches.length, index);
  };

  const closePdfSearch = (): void => {
    searchGeneration += 1;
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    pendingSearchScrollKey = null;
    pdfSearch = null;
    clearPdfSearchMarks();
    clearFlowSearchMarks();
    flowSearch = null;
    searchPanel?.close();
  };

  const clearFlowSearchMarks = (): void => {
    for (const doc of flowDocuments()) {
      unwrapSpans(doc.body, 'lightink-reader-search-mark');
      unwrapSpans(doc.body, 'lightink-reader-search-mark--current');
    }
  };

  const runFlowSearch = (query: string, options?: { preserveActive?: number }): void => {
    clearFlowSearchMarks();
    const trimmed = query.trim();
    if (trimmed === '' || PAGE_EXTS.has(loadedExt)) {
      flowSearch = null;
      searchPanel?.setStatus(0, -1);
      return;
    }
    const needle = trimmed.toLowerCase();
    const marks: HTMLElement[] = [];
    flowDocuments().forEach((doc, chapter) => {
      const text = doc.body.textContent ?? '';
      const hay =
        text.toLowerCase().length === text.length ? text.toLowerCase() : text;
      const matchNeedle =
        text.toLowerCase().length === text.length ? needle : trimmed;
      let at = hay.indexOf(matchNeedle);
      let ordinal = 0;
      while (at >= 0) {
        const range = offsetRangeFrom(doc.body, at, at + matchNeedle.length);
        if (range !== null) {
          const key = `${chapter}:${ordinal}:${at}`;
          wrapTextRangeWithSpan(doc.body, range, 'lightink-reader-search-mark', key);
          const mark = doc.body.querySelector<HTMLElement>(
            `[data-search-key="${cssEscape(key)}"]`,
          );
          if (mark !== null) {
            marks.push(mark);
          }
        }
        at = hay.indexOf(matchNeedle, at + matchNeedle.length);
        ordinal += 1;
      }
    });
    const scroller = flowScrollContainer();
    const scrollerTop = scroller.getBoundingClientRect().top;
    const firstAtOrAfter = marks.findIndex((mark) => mark.getBoundingClientRect().top >= scrollerTop - 8);
    const fallback = nearestMatchIndex(marks.length, firstAtOrAfter);
    const active = preserveMatchIndex(marks.length, options?.preserveActive ?? -1, fallback);
    flowSearch = { query: trimmed, marks, active };
    if (active >= 0) {
      marks[active]?.classList.add('lightink-reader-search-mark--current');
    }
    searchPanel?.setStatus(marks.length, active);
  };

  const revealFlowMark = (mark: HTMLElement | undefined): void => {
    if (mark === undefined) {
      return;
    }
    const article = mark.ownerDocument?.defaultView?.frameElement?.closest<HTMLElement>(
      '.lightink-reader-chapter',
    );
    const chapter = Number(article?.dataset.chapterIndex ?? Number.NaN);
    const paginated = document.documentElement.dataset.readingLayout === 'paginated';
    if (paginated && Number.isSafeInteger(chapter)) {
      setActiveChapter(chapter);
      const frame = article?.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
      const frameDocument = frame?.contentDocument;
      if (frame !== undefined && frame !== null && frameDocument !== undefined && frameDocument !== null) {
        applyPaginatedDocument(frame, frameDocument, { snap: false });
        const html = frameDocument.documentElement;
        const step = pagedColumnStep(
          Number.parseFloat(html.style.width) || html.clientWidth,
          Number.parseFloat(html.style.columnGap) || 0,
        );
        const left = mark.getBoundingClientRect().left - html.getBoundingClientRect().left + html.scrollLeft;
        html.scrollLeft = Math.max(0, Math.floor(left / step) * step);
        snapPagedScroller(html, step);
        return;
      }
    }
    mark.scrollIntoView({ block: 'center', inline: 'nearest' });
  };

  const jumpToFlowMatch = (direction: 1 | -1): void => {
    const state = flowSearch;
    if (state === null || state.marks.length === 0) {
      return;
    }
    state.marks[state.active]?.classList.remove('lightink-reader-search-mark--current');
    const index = nextMatchIndex(state.marks.length, state.active, direction);
    if (index < 0) {
      return;
    }
    state.active = index;
    state.marks[index]?.classList.add('lightink-reader-search-mark--current');
    revealFlowMark(state.marks[index]);
    searchPanel?.setStatus(state.marks.length, index);
  };

  const runReaderSearch = (query: string): void => {
    if (pdfHandle !== null) {
      runPdfSearch(query);
      return;
    }
    runFlowSearch(query);
  };

  const jumpReaderMatch = (direction: 1 | -1): void => {
    if (pdfHandle !== null) {
      jumpToPdfMatch(direction);
      return;
    }
    jumpToFlowMatch(direction);
  };

  const currentSearchSelection = (): string => {
    if (pendingSelection !== null) {
      const seeded = sanitizeSearchQuery(pendingSelection.quote);
      if (seeded !== '') {
        return seeded;
      }
    }
    for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame',
    )) {
      const seeded = sanitizeSearchQuery(frame.contentWindow?.getSelection()?.toString() ?? '');
      if (seeded !== '') {
        return seeded;
      }
    }
    return sanitizeSearchQuery(typeof window !== 'undefined' ? window.getSelection()?.toString() : '');
  };

  /** 打开阅读器搜索面板（PDF / 流式；CBZ 无文本则空结果）。 */
  const openSearch = (query?: string): void => {
    if (searchPanel === null) {
      searchPanel = createSearchPanel({
        t,
        onQuery: (nextQuery) => runReaderSearch(nextQuery),
        onNext: () => jumpReaderMatch(1),
        onPrev: () => jumpReaderMatch(-1),
        onClose: () => closePdfSearch(),
      });
      chromeHost().appendChild(searchPanel.element);
    }
    const seed = sanitizeSearchQuery(query) || currentSearchSelection();
    if (seed !== '') {
      searchPanel.setQuery(seed);
    }
    const scroller = flowScrollContainer();
    const left = scroller.scrollLeft;
    const top = scroller.scrollTop;
    searchPanel.open();
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
    if (seed !== '') {
      runReaderSearch(seed);
    } else {
      searchPanel.setStatus(
        flowSearch?.marks.length ?? pdfSearch?.matches.length ?? 0,
        flowSearch?.active ?? pdfSearch?.active ?? -1,
      );
    }
  };

  /** 在 sandbox 正文文本节点中包裹高亮 quote（flow/txt）；PDF 走文本层渲染。 */
  const renderHighlights = (): void => {
    if (loadedExt === 'pdf') {
      renderPdfHighlights();
      return;
    }
    if (PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const highlights = annotations.filter(
      (a) => (a.kind === 'highlight' || a.kind === 'note') && a.quote !== undefined,
    );
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
      const locator = hl.locator;
      if (locator.format !== 'flow' && locator.format !== 'text') {
        continue;
      }
      const chapter = locator.format === 'flow' ? locator.chapter : 0;
      const frame = scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
      );
      const doc = frame?.contentDocument;
      if (doc === null || doc === undefined) {
        continue;
      }
      const range = resolveTextQuoteRange(doc.body, locator);
      if (range !== null && !range.collapsed) {
        markTextRange(doc.body, range, hl.id, hl.kind);
      }
    }
  };

  /**
   * 划选 mouseup（flow/txt，iframe 内）：捕获待确认划选并唤起工具栏（R3）。
   * 不再直接建标注——高亮/笔记经工具栏确认，取消高亮在选中已有 mark 时可用。
   */
  const onFlowSelectionMouseUp = (
    selection: Selection | null,
    chapter: number,
    body: HTMLElement,
    frame: HTMLIFrameElement,
  ): void => {
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      hideSelectionToolbar();
      return;
    }
    const locator = flowLocatorFromRange(
      body,
      selection.getRangeAt(0),
      chapter,
      loadedExt === 'txt' ? 'text' : 'flow',
    );
    if (locator === null) {
      hideSelectionToolbar();
      return;
    }
    // 选区锚点落在已有高亮 <mark data-annotation-id> 内时提供"取消高亮"。
    const anchorNode = selection.anchorNode;
    const anchorElement =
      anchorNode === null
        ? null
        : anchorNode.nodeType === 1
          ? (anchorNode as Element)
          : anchorNode.parentElement;
    const existingMark = anchorElement?.closest('[data-annotation-id]') ?? null;
    pendingSelection = {
      locator,
      quote: text,
      existingHighlightId: existingMark?.getAttribute('data-annotation-id') ?? null,
      frame,
    };
    ensureSelectionToolbar();
    if (selectionToolbar === null) {
      return;
    }
    // iframe 内 rect 是 frame 视口坐标，叠加 frame 偏移换算为外层 client 坐标。
    const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    selectionToolbar.showAt(
      {
        left: rangeRect.left + frameRect.left,
        top: rangeRect.top + frameRect.top,
        width: rangeRect.width,
        height: rangeRect.height,
      },
      { canRemoveHighlight: existingMark !== null },
    );
  };

  const jumpToOutlineItem = (item: OutlineItem): void => {
    if (item.page !== undefined) {
      if (pdfHandle !== null) {
        pdfHandle.scrollToPage(item.page);
        syncPageState();
        schedulePersistReadingProgress();
        return;
      }
      if (cbzHandle !== null) {
        cbzHandle.scrollToPage(item.page);
        syncPageState();
        schedulePersistReadingProgress();
      }
      return;
    }
    if (item.chapter !== undefined) {
      if (document.documentElement.dataset.readingLayout === 'paginated') {
        setActiveChapter(item.chapter);
        const frame = scrollHost.querySelector<HTMLIFrameElement>(
          `.lightink-reader-chapter[data-chapter-index="${item.chapter}"] .lightink-reader-chapter-frame`,
        );
        const scroller = frame?.contentDocument?.documentElement;
        if (scroller !== undefined && scroller !== null) {
          scroller.scrollLeft = 0;
        }
      } else {
        scrollHost
          .querySelector<HTMLElement>(`.lightink-reader-chapter[data-chapter-index="${item.chapter}"]`)
          ?.scrollIntoView({ block: 'start' });
      }
      syncFlowState();
      schedulePersistReadingProgress();
    }
  };

  const pagedViewport = (): { width: number; height: number; fontPx: number } => {
    const hostStyle = getComputedStyle(scrollHost);
    const padX = (Number.parseFloat(hostStyle.paddingLeft) || 0) + (Number.parseFloat(hostStyle.paddingRight) || 0);
    const padY = (Number.parseFloat(hostStyle.paddingTop) || 0) + (Number.parseFloat(hostStyle.paddingBottom) || 0);
    const width = Math.max(
      1,
      Math.round((scrollHost.clientWidth || root.clientWidth) - padX),
    );
    const height = Math.max(
      1,
      Math.round((scrollHost.clientHeight || root.clientHeight) - padY),
    );
    const scale =
      getComputedStyle(document.documentElement).getPropertyValue('--lightink-font-scale').trim() ||
      '1';
    const fontPx = parseFloat(getComputedStyle(root).fontSize) * (Number.parseFloat(scale) || 1);
    return { width, height, fontPx };
  };

  const applyPaginatedDocument = (
    frame: HTMLIFrameElement,
    frameDocument: Document,
    options?: { restoreRatio?: number; snap?: boolean },
  ): void => {
    const viewport = pagedViewport();
    const layout = pagedSpreadMetrics(viewport.width, viewport.fontPx);
    const { width, columnWidth, columns, gap, step } = layout;
    const height = viewport.height;
    const html = frameDocument.documentElement;
    const previousRatio = pagedProgressRatio(html);
    html.dataset.readingLayout = 'paginated';
    html.style.minHeight = '0';
    html.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';
    html.style.boxSizing = 'border-box';
    html.style.width = `${width}px`;
    html.style.height = `${height}px`;
    html.style.columnWidth = `${columnWidth}px`;
    html.style.columnCount = 'auto';
    html.style.columnGap = `${gap}px`;
    html.style.columnFill = 'auto';
    html.style.setProperty('--lightink-reader-column-count', String(columns));
    html.style.setProperty('--lightink-reader-column-width', `${columnWidth}px`);
    html.style.setProperty('--lightink-reader-column-gap', `${gap}px`);
    html.style.setProperty('--lightink-reader-page-height', `${height}px`);
    html.style.removeProperty('--lightink-reader-measure');
    frameDocument.body.style.boxSizing = 'border-box';
    frameDocument.body.style.height = 'auto';
    frameDocument.body.style.minHeight = `${height}px`;
    frameDocument.body.style.width = 'auto';
    frameDocument.body.style.maxWidth = 'none';
    frameDocument.body.style.overflow = 'visible';
    frameDocument.body.style.margin = '0';
    frameDocument.body.style.padding = '0';
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    if (options?.restoreRatio !== undefined) {
      applyPagedProgress(html, options.restoreRatio, step);
    } else if (options?.snap !== false) {
      snapPagedScroller(html, step);
      if (html.scrollLeft === 0 && previousRatio > 0) {
        applyPagedProgress(html, previousRatio, step);
      }
    }
  };

  const renderChapters = (chapters: ReaderChapter[], stylesheet = ''): void => {
    clearFlowBindings();
    pageHost.removeEventListener('scroll', onPageScroll);
    pageHost.removeEventListener('mouseup', onPageHostSelection);
    pageHost.removeEventListener('click', onPageHostNoteClick);
    textLayerObserver?.disconnect();
    textLayerObserver = null;
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
        const applyPaginatedMetrics = (): void => {
          applyPaginatedDocument(frame, frameDocument);
        };
        let applyingFrame = false;
        const applyFrameChrome = (): void => {
          const paginated = document.documentElement.dataset.readingLayout === 'paginated';
          frameDocument.documentElement.dataset.readingLayout = paginated ? 'paginated' : 'scroll';
          frameDocument.body.style.color = computed.color;
          frameDocument.body.style.fontFamily = computed.fontFamily;
          const scale = getComputedStyle(document.documentElement)
            .getPropertyValue('--lightink-font-scale')
            .trim() || '1';
          const fontSize = `calc(${computed.fontSize} * ${scale})`;
          frameDocument.body.style.fontSize = fontSize;
          if (!paginated) {
            const html = frameDocument.documentElement;
            html.style.removeProperty('--lightink-reader-column-width');
            html.style.removeProperty('--lightink-reader-column-gap');
            html.style.removeProperty('--lightink-reader-column-count');
            html.style.removeProperty('--lightink-reader-page-height');
            html.style.removeProperty('--lightink-reader-measure');
            html.style.removeProperty('column-width');
            html.style.removeProperty('column-count');
            html.style.removeProperty('column-gap');
            html.style.removeProperty('column-fill');
            html.style.removeProperty('overscroll-behavior');
            html.style.height = 'auto';
            html.style.minHeight = '0';
            html.style.width = '100%';
            html.style.maxWidth = '100%';
            html.style.overflow = 'visible';
            html.scrollLeft = 0;
            frameDocument.body.style.height = 'auto';
            frameDocument.body.style.minHeight = '0';
            frameDocument.body.style.width = '100%';
            frameDocument.body.style.maxWidth = '100%';
            frameDocument.body.style.overflow = 'visible';
            frame.style.width = '100%';
            frame.style.removeProperty('min-height');
            return;
          }
          applyPaginatedMetrics();
        };
        applyFrameChrome();
        requestAnimationFrame(applyFrameChrome);
        frame.dataset.frameReady = 'true';

        const measureScrollHeight = (): number => flowFrameContentHeight(frameDocument);
        const syncHeight = (): void => {
          if (applyingFrame || layoutSwitching) {
            return;
          }
          applyingFrame = true;
          try {
            applyFrameChrome();
            if (document.documentElement.dataset.readingLayout !== 'paginated') {
              const nextHeight = `${measureScrollHeight()}px`;
              if (frame.style.height !== nextHeight) {
                frame.style.height = nextHeight;
              }
            }
          } finally {
            applyingFrame = false;
          }
          if (pendingRestore !== null) {
            applySavedProgress();
          }
          syncFlowState();
        };
        const onClick = (event: MouseEvent): void => {
          const annotation = annotationFromMark(event.target);
          if (annotation !== null && annotation.kind === 'note') {
            event.preventDefault();
            openNote(annotation);
            return;
          }
          const target = event.target;
          const link =
            target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
          if (link === null) {
            return;
          }
          event.preventDefault();
          const href = link.getAttribute('href') ?? '';
          if (href.startsWith('#lightink-chapter?')) {
            const params = new URLSearchParams(href.slice('#lightink-chapter?'.length));
            const chapter = Number(params.get('chapter'));
            if (!Number.isSafeInteger(chapter) || chapter < 0) {
              return;
            }
            const targetArticle = scrollHost.querySelector<HTMLElement>(
              `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
            );
            const targetFrame = targetArticle?.querySelector<HTMLIFrameElement>(
              '.lightink-reader-chapter-frame',
            );
            // 翻页模式下非活动章 display:none，scrollIntoView 无效——先激活目标章
            // 并应用分栏，再滚动到章/目标片段。
            const targetDoc = targetFrame?.contentDocument ?? null;
            if (
              document.documentElement.dataset.readingLayout === 'paginated' &&
              targetArticle !== null &&
              targetArticle.classList.contains('is-active') === false
            ) {
              setActiveChapter(chapter);
              if (targetFrame !== null && targetFrame !== undefined && targetDoc !== null) {
                applyPaginatedDocument(targetFrame, targetDoc, { snap: false });
              }
            }
            targetArticle?.scrollIntoView({ block: 'start' });
            const targetId = params.get('target');
            targetDoc?.getElementById(targetId ?? '')?.scrollIntoView({
              block: 'center',
            });
          } else if (href.startsWith('#')) {
            let targetId = href.slice(1);
            try {
              targetId = decodeURIComponent(targetId);
            } catch {
              return;
            }
            frameDocument.getElementById(targetId)?.scrollIntoView({ block: 'center' });
          }
        };
        const onMouseUp = (): void => {
          onFlowSelectionMouseUp(
            frameWindow.getSelection(),
            frameChapter,
            frameDocument.body,
            frame,
          );
        };
        // 划选发生在 iframe 内，键盘焦点也在 iframe 文档——Escape 需在 frame 内转发。
        const onKeyDown = (event: KeyboardEvent): void => {
          if (event.key === 'Escape' && selectionToolbar?.isVisible() === true) {
            hideSelectionToolbar();
            event.preventDefault();
            return;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'f'
          ) {
            event.preventDefault();
            openSearch(frameWindow.getSelection()?.toString());
            return;
          }
          if (!event.ctrlKey && !event.metaKey && !event.altKey && isReadingNavKey(event.key)) {
            const direction = readingNavDirection(event.key, event.shiftKey);
            if (direction !== null && advanceReading(direction)) {
              event.preventDefault();
            }
          }
        };
        const onWheel = (event: WheelEvent): void => {
          if (event.ctrlKey || event.metaKey) {
            if (event.deltaY === 0) {
              return;
            }
            event.preventDefault();
            frameWindow.parent.document.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                deltaY: event.deltaY,
                clientX: event.clientX,
                clientY: event.clientY,
              }),
            );
            return;
          }
          if (document.documentElement.dataset.readingLayout !== 'paginated') {
            const scroller = flowScrollContainer();
            const line = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
            if (event.deltaY !== 0 || event.deltaX !== 0) {
              event.preventDefault();
              scroller.scrollTop += event.deltaY * line;
              scroller.scrollLeft += event.deltaX * line;
            }
            return;
          }
          const delta =
            Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
          if (delta === 0) {
            return;
          }
          event.preventDefault();
          if (gatePagedWheel(delta > 0 ? 1 : -1, advanceReading)) {
            hideSelectionToolbar();
          }
        };
        frameDocument.addEventListener('click', onClick);
        frameDocument.addEventListener('mouseup', onMouseUp);
        frameDocument.addEventListener('keydown', onKeyDown);
        frameDocument.addEventListener('wheel', onWheel, { passive: false });
        const releaseImages = bindBlockedRemoteImages(
          frameDocument.body,
          t('reader.remoteImageLoad'),
          remoteImagePolicy,
        );
        const resizeObserver =
          typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => {
                if (!applyingFrame && !layoutSwitching) {
                  syncHeight();
                }
              });
        resizeObserver?.observe(frameDocument.body);
        const onImageLoad = (): void => {
          if (!applyingFrame && !layoutSwitching) {
            syncHeight();
          }
        };
        for (const image of Array.from(frameDocument.images)) {
          if (!image.complete) {
            image.addEventListener('load', onImageLoad);
            image.addEventListener('error', onImageLoad);
          }
        }
        syncHeight();
        requestAnimationFrame(syncHeight);
        renderHighlights();
        releaseRemoteImages.push(() => {
          resizeObserver?.disconnect();
          releaseImages();
          frameDocument.removeEventListener('click', onClick);
          frameDocument.removeEventListener('mouseup', onMouseUp);
          frameDocument.removeEventListener('keydown', onKeyDown);
          frameDocument.removeEventListener('wheel', onWheel);
        });
      };
      frame.addEventListener('load', onLoad, { once: true });
      releaseRemoteImages.push(() => frame.removeEventListener('load', onLoad));
      frame.srcdoc = flowFrameSource(chapter.html, stylesheet);
      article.append(heading, frame);
      scrollHost.appendChild(article);
      chapterIndex += 1;
    }
    setActiveChapter(0);
    syncFlowState();
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
      stagedHost.dataset.readerFormat = 'pdf';
      const pdf = await renderPdfInto(bytes, stagedHost, signal);
      return { host: stagedHost, pdf, cbz: null };
    }
    stagedHost.dataset.readerFormat = 'cbz';
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
    const previousFlowDispose = flowContentDispose;
    flowContentDispose = null;
    const previousPdf = pdfHandle;
    const previousCbz = cbzHandle;
    pdfHandle = staged.pdf;
    cbzHandle = staged.cbz;
    pageHost.removeEventListener('scroll', onPageScroll);
    closestPane()?.removeEventListener('scroll', onPageScroll);
    pageHost.removeEventListener('mouseup', onPageHostSelection);
    pageHost.removeEventListener('click', onPageHostNoteClick);
    pageHost.replaceWith(staged.host);
    pageHost = staged.host;
    pageHost.addEventListener('scroll', onPageScroll, { passive: true });
    closestPane()?.addEventListener('scroll', onPageScroll, { passive: true });
    pageHost.addEventListener('mouseup', onPageHostSelection);
    pageHost.addEventListener('click', onPageHostNoteClick);
    observeTextLayers(pageHost); // 文本层懒出现时重渲染该页高亮
    scrollHost.hidden = true;
    syncPageState();
    void previousPdf?.destroy().catch(() => undefined);
    void previousCbz?.destroy().catch(() => undefined);
    previousFlowDispose?.();
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
    renderHighlights(); // flow/txt 正文与 PDF 文本层（含旧 anchor 数据重渲染）
    ensureSidebar();
  };

  const gatePagedWheel = createPagedWheelGate();

  const visibleFlowFrame = (): HTMLIFrameElement | null => {
    if (document.documentElement.dataset.readingLayout === 'paginated') {
      return scrollHost.querySelector<HTMLIFrameElement>(
        '.lightink-reader-chapter.is-active .lightink-reader-chapter-frame',
      );
    }
    const hostRect = scrollHost.getBoundingClientRect();
    for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame[data-frame-ready="true"]',
    )) {
      const rect = frame.getBoundingClientRect();
      if (rect.bottom > hostRect.top && rect.top < hostRect.bottom) {
        return frame;
      }
    }
    return scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
  };

  const advanceReading = (direction: 1 | -1): boolean => {
    if (pdfHandle !== null) {
      pdfHandle.scrollToPage(pdfHandle.controller.page + direction);
      syncPageState();
      schedulePersistReadingProgress();
      return true;
    }
    if (cbzHandle !== null) {
      cbzHandle.scrollToPage(cbzHandle.currentPage + direction);
      syncPageState();
      schedulePersistReadingProgress();
      return true;
    }
    const paginated = document.documentElement.dataset.readingLayout === 'paginated';
    if (paginated) {
      const frame = visibleFlowFrame();
      const scroller = frame?.contentDocument?.documentElement;
      const step =
        scroller === undefined || scroller === null
          ? 0
          : pagedColumnStep(
              Number.parseFloat(scroller.style.width) || scroller.clientWidth,
              Number.parseFloat(scroller.style.columnGap) || 0,
            );
      if (
        scroller !== undefined &&
        scroller !== null &&
        advancePagedScroller(scroller, direction, step)
      ) {
        snapPagedScroller(scroller, step);
        scroller.scrollLeft = Math.round(scroller.scrollLeft / step) * step;
        schedulePersistReadingProgress();
        return true;
      }
      const chapter = firstVisibleChapter() + direction;
      const next = scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
      );
      if (next === null) {
        return false;
      }
      setActiveChapter(chapter);
      const nextFrame = next.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
      const applyChapterPage = (): void => {
        const nextDoc = nextFrame?.contentDocument;
        if (nextFrame === null || nextDoc === undefined || nextDoc === null) {
          return;
        }
        applyPaginatedDocument(nextFrame, nextDoc, { snap: false });
        nextDoc.documentElement.scrollLeft =
          direction < 0
            ? Math.max(0, nextDoc.documentElement.scrollWidth - nextDoc.documentElement.clientWidth)
            : 0;
      };
      applyChapterPage();
      requestAnimationFrame(applyChapterPage);
      syncFlowState();
      schedulePersistReadingProgress();
      return true;
    }
    if (advanceScrolledScroller(scrollHost, direction)) {
      schedulePersistReadingProgress();
      return true;
    }
    return false;
  };

  const syncVisibleFlowFrames = (): void => {
    const hostRect = scrollHost.getBoundingClientRect();
    for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame[data-frame-ready="true"]',
    )) {
      const rect = frame.getBoundingClientRect();
      const visible = rect.bottom > hostRect.top && rect.top < hostRect.bottom;
      if (!visible) {
        continue;
      }
      const frameDocument = frame.contentDocument;
      if (frameDocument === null) {
        continue;
      }
      const scale =
        getComputedStyle(document.documentElement).getPropertyValue('--lightink-font-scale').trim() ||
        '1';
      const computed = getComputedStyle(root);
      frameDocument.body.style.fontSize = `calc(${computed.fontSize} * ${scale})`;
      if (document.documentElement.dataset.readingLayout === 'paginated') {
        applyPaginatedDocument(frame, frameDocument);
      }
    }
  };

  const onFontScaleChange = (): void => {
    if (destroyed) {
      return;
    }
    if (pdfHandle !== null) {
      void pdfHandle.rerender();
      return;
    }
    syncVisibleFlowFrames();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('lightink:font-scale', onFontScaleChange);
  }

  const refreshOpenSearch = (): void => {
    if (searchPanel?.isOpen() !== true) {
      return;
    }
    const query = (searchPanel.getQuery() || flowSearch?.query || pdfSearch?.query || '').trim();
    if (query === '') {
      return;
    }
    if (pdfHandle !== null) {
      runPdfSearch(query);
      return;
    }
    runFlowSearch(query, { preserveActive: flowSearch?.active });
  };

  const remasureScrollFrames = (): void => {
    layoutSwitching = true;
    try {
      for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
        '.lightink-reader-chapter-frame[data-frame-ready="true"]',
      )) {
        const frameDocument = frame.contentDocument;
        if (frameDocument === null) {
          continue;
        }
        const html = frameDocument.documentElement;
        const body = frameDocument.body;
        html.dataset.readingLayout = 'scroll';
        html.style.removeProperty('--lightink-reader-column-width');
        html.style.removeProperty('--lightink-reader-column-gap');
        html.style.removeProperty('--lightink-reader-column-count');
        html.style.removeProperty('--lightink-reader-page-height');
        html.style.removeProperty('--lightink-reader-measure');
        html.style.removeProperty('column-width');
        html.style.removeProperty('column-count');
        html.style.removeProperty('column-gap');
        html.style.removeProperty('column-fill');
        html.style.removeProperty('overscroll-behavior');
        html.style.height = 'auto';
        html.style.minHeight = '0';
        html.style.width = '100%';
        html.style.maxWidth = '100%';
        html.style.overflow = 'visible';
        html.scrollLeft = 0;
        body.style.height = 'auto';
        body.style.minHeight = '0';
        body.style.width = '100%';
        body.style.maxWidth = '100%';
        body.style.overflow = 'visible';
        frame.style.width = '100%';
        frame.style.removeProperty('min-height');
        const nextHeight = `${flowFrameContentHeight(frameDocument)}px`;
        if (frame.style.height !== nextHeight) {
          frame.style.height = nextHeight;
        }
      }
    } finally {
      layoutSwitching = false;
    }
  };

  const syncPaginatedChapter = (): void => {
    if (destroyed || pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const saved = lastFlowProgress ?? currentProgressSnapshot();
    if (saved !== null && progressId !== '') {
      saveReadingProgress(progressStorage, progressId, saved);
    }
    if (document.documentElement.dataset.readingLayout !== 'paginated') {
      remasureScrollFrames();
      if (saved !== null) {
        pendingRestore = saved;
        restoreAttempts = 0;
        applySavedProgress();
      }
      requestAnimationFrame(refreshOpenSearch);
      return;
    }
    if (saved !== null) {
      pendingRestore = saved;
      restoreAttempts = 0;
    }
    setActiveChapter(saved?.index ?? chapterFromScroll());
    const frame = visibleFlowFrame();
    const doc = frame?.contentDocument;
    if (frame !== null && doc !== undefined && doc !== null) {
      applyPaginatedDocument(frame, doc, saved === null ? undefined : { restoreRatio: saved.ratio });
    }
    if (pendingRestore !== null) {
      applySavedProgress();
    }
    requestAnimationFrame(refreshOpenSearch);
  };

  const refreshViewport = (): void => {
    if (destroyed) {
      return;
    }
    if (pdfHandle !== null) {
      void pdfHandle.rerender();
      return;
    }
    if (cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    layoutSwitching = true;
    try {
      if (document.documentElement.dataset.readingLayout === 'paginated') {
        const frame = visibleFlowFrame();
        const doc = frame?.contentDocument;
        if (frame !== null && doc !== undefined && doc !== null) {
          applyPaginatedDocument(frame, doc);
        }
      } else {
        remasureScrollFrames();
      }
    } finally {
      layoutSwitching = false;
    }
    refreshOpenSearch();
    syncFlowState();
  };
  const settleViewportRefresh = createResizeSettle();
  let cancelSettledRefresh: (() => void) | null = null;
  const onWindowResize = (): void => {
    cancelSettledRefresh = settleViewportRefresh(refreshViewport);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowResize);
  }
  const cancelViewportRefresh = (): void => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize);
    }
    cancelSettledRefresh?.();
    cancelSettledRefresh = null;
  };

  const layoutRoot =
    typeof document !== 'undefined' && document.documentElement != null
      ? document.documentElement
      : null;
  const layoutRootObserver =
    layoutRoot === null || typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(syncPaginatedChapter);
  if (layoutRoot !== null) {
    try {
      layoutRootObserver?.observe(layoutRoot, {
        attributes: true,
        attributeFilter: ['data-reading-layout'],
      });
    } catch {
      // Fake documents in unit tests are not MutationObserver targets.
    }
  }

  // PDF 连续滚动：←/→ 滚到上/下一页，+/- 缩放，0 还原。
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (selectionToolbar?.isVisible() === true) {
        hideSelectionToolbar();
        event.preventDefault();
        return;
      }
      if (sidebarVisible) {
        setSidebarVisible(false);
        event.preventDefault();
        return;
      }
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && isReadingNavKey(event.key)) {
      const direction = readingNavDirection(event.key, event.shiftKey);
      if (direction !== null && advanceReading(direction)) {
        event.preventDefault();
        return;
      }
    }
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      if (handle.controller.zoomIn()) {
        event.preventDefault();
        syncPageState();
        void handle.rerender();
      }
    } else if (event.key === '-' || event.key === '_') {
      if (handle.controller.zoomOut()) {
        event.preventDefault();
        syncPageState();
        void handle.rerender();
      }
    } else if (event.key === '0') {
      if (handle.controller.resetScale()) {
        event.preventDefault();
        syncPageState();
        void handle.rerender();
      }
    }
  });

  // 书签 / 笔记改由菜单触发（见 ReaderInstance.addBookmark/addNote），不再挂浮动工具栏。

  return {
    get state() {
      return readerState;
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      try {
        listener(readerState);
      } catch {
        // Keep subscription setup isolated from application chrome failures.
      }
      return () => {
        stateListeners.delete(listener);
      };
    },
    async load(filePath: string, options: ReaderLoadOptions = {}): Promise<void> {
      const readBytes = deps.readBytes;
      if (readBytes === undefined) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      if (destroyed) {
        throw new Error('reader-view has been destroyed');
      }

      activeLoadController?.abort();
      annotationWriteQueue.invalidate();
      hideSelectionToolbar();
      persistReadingProgress();
      progressId = '';
      pendingRestore = null;
      restoreAttempts = 0;
      readerOutline = [];
      exportChapters = [];
      exportStylesheet = '';
      closeOpenNoteDialog(); // 打开中的笔记弹层经 Escape 正规 release（续体守卫丢弃迟到保存）
      closePdfSearch(); // 切换文档清掉搜索状态与命中 overlay
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

      setReaderPhase('loading', true);
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
          readerOutline =
            staged.pdf !== null
              ? await staged.pdf.outline()
              : outlineFromEntries(
                  Array.from({ length: staged.cbz?.totalPages ?? 0 }, (_, index) => ({
                    title: t('annotation.location.page', { page: String(index + 1) }),
                  })),
                  'page',
                );
          if (!isCurrent()) {
            return;
          }
        } else {
          const content = await (deps.parseContent ?? parseReaderContent)(
            filePath,
            bytes,
            controller.signal,
          );
          if (controller.signal.aborted) {
            content.dispose?.();
            throwIfReaderLoadCancelled(controller.signal);
          }
          if (!isCurrent()) {
            content.dispose?.();
            return;
          }
          loadedExt = nextExt;
          annotations = [];
          contentHash = null;
          sidebar?.render(annotations);
          const previousPdf = pdfHandle;
          const previousCbz = cbzHandle;
          const previousFlowDispose = flowContentDispose;
          pdfHandle = null;
          cbzHandle = null;
          flowContentDispose = content.dispose ?? null;
          try {
            renderChapters(content.chapters, content.stylesheet);
            exportChapters = content.chapters;
            exportStylesheet = content.stylesheet ?? '';
            readerOutline = outlineFromEntries(
              content.chapters.map((chapter, index) => ({
                title: chapter.title.trim() || t('reader.chapter', { n: String(index + 1) }),
              })),
              'chapter',
            );
          } catch (error) {
            flowContentDispose?.();
            flowContentDispose = previousFlowDispose;
            throw error;
          }
          void previousPdf?.destroy().catch(() => undefined);
          void previousCbz?.destroy().catch(() => undefined);
          previousFlowDispose?.();
          for (const warning of content.warnings ?? []) {
            deps.notify?.(t(`reader.warning.${warning}`));
          }
        }

        await loadAnnotations(filePath, generation, controller.signal);
        throwIfReaderLoadCancelled(controller.signal);
        if (isCurrent()) {
          progressId = contentHash ?? filePath;
          pendingRestore = loadReadingProgress(progressStorage, progressId);
          restoreAttempts = 0;
          setReaderPhase('ready');
          applySavedProgress();
          if (PAGE_EXTS.has(loadedExt)) {
            syncPageState();
          } else {
            syncFlowState();
          }
          completed = true;
        }
      } catch (error) {
        if (isReaderLoadCancelled(error, controller.signal)) {
          if (!destroyed && generation === loadGeneration) {
            setReaderPhase('cancelled');
          }
          return;
        }
        if (!isCurrent()) {
          return;
        }
        setReaderPhase('error');
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
      persistReadingProgress();
      if (progressSaveTimer !== null) {
        clearTimeout(progressSaveTimer);
        progressSaveTimer = null;
      }
      destroyed = true;
      loadGeneration += 1;
      activeLoadController?.abort();
      activeLoadController = null;
      annotationWriteQueue.invalidate();
      clearFlowBindings();
      const handle = pdfHandle;
      const cbz = cbzHandle;
      const disposeFlowContent = flowContentDispose;
      pdfHandle = null;
      cbzHandle = null;
      flowContentDispose = null;
      sidebar?.destroy();
      sidebar = null;
      sidebarBackdrop?.remove();
      sidebarBackdrop = null;
      selectionToolbar?.destroy();
      selectionToolbar = null;
      pendingSelection = null;
      readerOutline = [];
      exportChapters = [];
      exportStylesheet = '';
      searchGeneration += 1;
      if (searchDebounce !== null) {
        clearTimeout(searchDebounce);
        searchDebounce = null;
      }
      pendingSearchScrollKey = null;
      pdfSearch = null;
      searchPanel?.destroy();
      searchPanel = null;
      scrollHost.removeEventListener('scroll', onFlowScroll);
      paneScroller?.removeEventListener('scroll', onFlowScroll);
      pageHost.removeEventListener('scroll', onPageScroll);
      closestPane()?.removeEventListener('scroll', onPageScroll);
      pageHost.removeEventListener('mouseup', onPageHostSelection);
    pageHost.removeEventListener('click', onPageHostNoteClick);
      textLayerObserver?.disconnect();
      textLayerObserver = null;
      layoutRootObserver?.disconnect();
      cancelViewportRefresh();
      if (typeof document !== 'undefined') {
        document.removeEventListener('lightink:font-scale', onFontScaleChange);
      }
      closeOpenNoteDialog();
      setReaderPhase('destroyed', true);
      stateListeners.clear();
      root.remove();
      disposeFlowContent?.();
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
    setTabActive: (active: boolean): void => setTabActive(active),
    isSidebarVisible: () => sidebarVisible,
    openSearch,
    refreshViewport,
    getOutline: () => readerOutline,
    jumpToOutlineItem,
    isAnnotationEnabled: () => annotationsEnabled,
    getExportHtml: () => {
      if (exportChapters.length === 0) {
        return null;
      }
      const escape = (value: string): string =>
        value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const publisher = sanitizeReaderCss(exportStylesheet);
      const style = publisher === '' ? '' : `<style>${publisher}</style>`;
      return (
        style +
        exportChapters
          .map((chapter, index) => {
            const title = chapter.title.trim() || t('reader.chapter', { n: String(index + 1) });
            return `<section class="lightink-export-chapter"><h1>${escape(title)}</h1>${chapter.html}</section>`;
          })
          .join('')
      );
    },
  };
}
