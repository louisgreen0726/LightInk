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
  flowLocatorFromRange,
  markTextRange,
  removeTextRangeMarks,
  resolveTextQuoteRange,
} from './annotation-locator.js';
import { createAnnotationSidebar, type AnnotationSidebar } from './annotation-sidebar.js';
import {
  createSelectionToolbar,
  type SelectionToolbar,
} from './selection-toolbar.js';
import { showNoteDialog } from './note-dialog.js';
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
  let loadGeneration = 0;
  let activeLoadController: AbortController | null = null;
  let destroyed = false;
  let flowRenderGeneration = 0;
  let flowContentDispose: (() => void) | null = null;
  const annotationWriteQueue = new AnnotationWriteQueue();
  const remoteImagePolicy = deps.remoteImagePolicy ?? sessionRemoteImagePolicy;
  let releaseRemoteImages: Array<() => void> = [];

  const stateListeners = new Set<ReaderStateListener>();
  let readerState: ReaderState = Object.freeze({
    phase: 'empty',
    current: 0,
    total: 0,
    progress: 0,
    scale: 1,
    locationKind: null,
  });

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

  /** 移除标注（侧栏/划选工具栏共用）：更新集合、清正文 mark、保存。 */
  const removeAnnotationById = (id: string): void => {
    annotations = annotations.filter((a) => a.id !== id);
    for (const doc of flowDocuments()) {
      removeTextRangeMarks(doc.body, id);
    }
    sidebar?.render(annotations);
    void saveAnnotations();
  };

  const hideSelectionToolbar = (): void => {
    pendingSelection = null;
    selectionToolbar?.hide();
  };

  /** 工具栏动作派发（R3）：确认后才创建/移除标注。 */
  const ensureSelectionToolbar = (): void => {
    if (selectionToolbar !== null || deps.writeAnnotations === undefined) {
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
        if (action === 'removeHighlight') {
          pending.frame?.contentWindow?.getSelection()?.removeAllRanges();
          if (pending.existingHighlightId !== null) {
            removeAnnotationById(pending.existingHighlightId);
          }
          return;
        }
        if (action === 'note') {
          void (async () => {
            const input = await showNoteDialog(document, '', { t });
            if (input === null) {
              return; // 取消：保留选区、不产生标注
            }
            pending.frame?.contentWindow?.getSelection()?.removeAllRanges();
            appendAnnotation('note', pending.locator, pending.quote, input);
          })();
          return;
        }
        pending.frame?.contentWindow?.getSelection()?.removeAllRanges();
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
    const maxScroll = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
    const progress =
      maxScroll === 0 ? 1 : Math.min(1, Math.max(0, scrollHost.scrollTop / maxScroll));
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
    // 工具栏按视口坐标固定定位，滚动后指向失效——直接隐藏。
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  const onPageScroll = (): void => {
    syncPageState();
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  scrollHost.addEventListener('scroll', onFlowScroll, { passive: true });

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
        const input = await showNoteDialog(document, '', { t });
        if (input === null) {
          return;
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
          return;
        }
        if (loc.format === 'cbz') {
          cbzHandle?.scrollToPage(loc.page);
          syncPageState();
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
        if (mark !== undefined) {
          mark.scrollIntoView({ block: 'center' });
          return;
        }
        if (loc.format === 'flow' || loc.format === 'text') {
          const chapter = loc.format === 'flow' ? loc.chapter : 0;
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
          .querySelector<HTMLElement>(
            `[data-chapter-index="${loc.format === 'flow' ? loc.chapter : 0}"]`,
          )
          ?.scrollIntoView({ block: 'center' });
      },
      onRemove: (annotation) => {
        removeAnnotationById(annotation.id);
      },
      onEditNote: (annotation) => {
        void (async () => {
          const input = await showNoteDialog(document, annotation.note ?? '', { t });
          if (input === null) {
            return;
          }
          annotations = annotations.map((a) =>
            a.id === annotation.id ? { ...a, note: input } : a,
          );
          sidebar?.render(annotations);
          void saveAnnotations();
        })();
      },
    });
    sidebar.element.setAttribute('aria-hidden', sidebarVisible ? 'false' : 'true');
    root.append(sidebarBackdrop, sidebar.element);
    sidebar.render(annotations);
  }

  /** 切换侧栏显隐，并让窄窗 drawer 获得或释放键盘焦点。 */
  function setSidebarVisible(visible: boolean): void {
    sidebarVisible = visible;
    if (visible) {
      ensureSidebar();
    }
    root.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    sidebar?.element.setAttribute('aria-hidden', sidebarVisible ? 'false' : 'true');
    if (sidebarBackdrop !== null) {
      sidebarBackdrop.hidden = !sidebarVisible;
    }
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
  }

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
        markTextRange(doc.body, range, hl.id);
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
    if (deps.writeAnnotations === undefined) {
      return;
    }
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

  const renderChapters = (chapters: ReaderChapter[]): void => {
    clearFlowBindings();
    pageHost.removeEventListener('scroll', onPageScroll);
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
          syncFlowState();
        };
        const onClick = (event: MouseEvent): void => {
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
            targetArticle?.scrollIntoView({ block: 'start' });
            const targetId = params.get('target');
            const targetFrame = targetArticle?.querySelector<HTMLIFrameElement>(
              '.lightink-reader-chapter-frame',
            );
            targetFrame?.contentDocument?.getElementById(targetId ?? '')?.scrollIntoView({
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
          }
        };
        frameDocument.addEventListener('click', onClick);
        frameDocument.addEventListener('mouseup', onMouseUp);
        frameDocument.addEventListener('keydown', onKeyDown);
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
          frameDocument.removeEventListener('keydown', onKeyDown);
        });
      };
      frame.addEventListener('load', onLoad, { once: true });
      releaseRemoteImages.push(() => frame.removeEventListener('load', onLoad));
      frame.srcdoc = flowFrameSource(chapter.html);
      article.append(heading, frame);
      scrollHost.appendChild(article);
      chapterIndex += 1;
    }
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
    const previousFlowDispose = flowContentDispose;
    flowContentDispose = null;
    const previousPdf = pdfHandle;
    const previousCbz = cbzHandle;
    pdfHandle = staged.pdf;
    cbzHandle = staged.cbz;
    pageHost.removeEventListener('scroll', onPageScroll);
    pageHost.replaceWith(staged.host);
    pageHost = staged.host;
    pageHost.addEventListener('scroll', onPageScroll, { passive: true });
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
    if (!PAGE_EXTS.has(loadedExt)) {
      renderHighlights();
    }
    ensureSidebar();
  };

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
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      handle.scrollToPage(handle.controller.page - 1);
      syncPageState();
      event.preventDefault();
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      handle.scrollToPage(handle.controller.page + 1);
      syncPageState();
      event.preventDefault();
    } else if (event.key === '+' || event.key === '=') {
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
            renderChapters(content.chapters);
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
          setReaderPhase('ready');
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
      scrollHost.removeEventListener('scroll', onFlowScroll);
      pageHost.removeEventListener('scroll', onPageScroll);
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
    isSidebarVisible: () => sidebarVisible,
    isAnnotationEnabled: () => annotationsEnabled,
  };
}
