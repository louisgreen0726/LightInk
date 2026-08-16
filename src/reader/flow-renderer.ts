/**
 * `flow-renderer` — 流式章节 iframe 的渲染与生命周期（T5 自 reader-view 拆出）。
 *
 * 负责：章节 <article>/<iframe> 创建（sandbox/CSP srcdoc）、frame load 后的
 * chrome 应用（滚动/翻页双布局，度量统一走 pagedSpreadMetrics + 共享
 * --lightink-reader-column-* 应用器）、帧高度同步、帧内
 * click/mouseup/keydown/wheel 接线与释放、远程图授权配对释放。
 * 编排壳（reader-view）保留生命周期/状态机/进度/接线，经 hooks 回调。
 * 可观察行为（sandbox、CSS 内联顺序、进度语义）与拆出前一致。
 * T8：章节资源钩子（EPUB 懒物化图片）按 IntersectionObserver 视口窗口
 * resolve/release；无 IO 环境退化为帧加载即物化。
 */

import type { MessageKey } from '../i18n/messages.js';
import type { ReaderChapter } from './formats/types.js';
import { sanitizeReaderCss } from './sanitize-css.js';
import {
  bindBlockedRemoteImages,
  type RemoteImagePolicy,
} from '../media/remote-image-policy.js';
import {
  applyPagedProgress,
  applyPagedSpreadVars,
  clearPagedSpreadVars,
  isReadingNavKey,
  pagedProgressRatio,
  pagedSpreadMetrics,
  readingNavDirection,
  snapPagedScroller,
} from '../ui/reading-layout.js';
import { DEFAULT_SHORTCUTS, matchEvent } from '../ui/shortcuts.js';

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
  /* hidden：避免 Windows 经典滚动条槽把栏宽挤窄，末行折出 iframe 后再被裁掉。 */
  overflow: hidden;
  scrollbar-width: none;
}
html[data-reading-layout='scroll']::-webkit-scrollbar,
html[data-reading-layout='scroll'] body::-webkit-scrollbar {
  width: 0;
  height: 0;
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
/* 只锁单张图/标题不被拦腰切断。figure 整块 avoid 会把「图+后面文字」一起推到下一栏，左栏变空。 */
img, table, pre, h1, h2, h3, h4, h5, h6 { break-inside: avoid; }
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
  /* 一图一栏：双栏时一页两张。不给 figure 写 avoid，避免整块内容被推走。 */
  max-width: var(--lightink-reader-column-width, 100%) !important;
  max-height: var(--lightink-reader-page-height, 100%) !important;
  width: auto !important;
  height: auto !important;
  box-sizing: border-box;
  break-inside: avoid;
  column-span: none;
}
html[data-reading-layout='paginated'] figure {
  max-width: var(--lightink-reader-column-width, 100%);
  margin: 1.1rem auto;
  break-inside: auto;
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
 *
 * The last block child's margin-bottom collapses with the (margin-less) body
 * and therefore never shows up in `body.scrollHeight`. Without adding it back
 * the chapter's trailing spacing (paragraph/image bottom margin) gets clipped
 * by the frame's `overflow: hidden`, visually hiding the tail of every chapter.
 *
 * `scrollHeight` can also miss a last wrapped line when the iframe later
 * reserves a classic scrollbar gutter and the line box sits past the
 * previously measured content height. Prefer the last painted box bottom.
 */
export function flowFrameContentHeight(frameDocument: Document): number {
  const body = frameDocument.body;
  if (body === null) {
    return 1;
  }
  const html = frameDocument.documentElement;
  const view = frameDocument.defaultView;
  // 显示态用 overflow:hidden 防滚动条槽；量高时必须暂时 visible，否则
  // 短 iframe 会先裁掉末行，scrollHeight / 绘制底边都会偏短。
  const previousHtmlOverflow = html.style.overflow;
  const previousBodyOverflow = body.style.overflow;
  html.style.overflow = 'visible';
  body.style.overflow = 'visible';
  try {
    const htmlRect = html.getBoundingClientRect();
    let height = Math.max(body.scrollHeight, 1);
    // 沿最后一个子元素向下穿透无 margin 的容器，取第一个非零 margin-bottom
    // （其会与 body 塌陷，故 scrollHeight 未计入）。同时用绘制底边兜住
    // scrollHeight 漏计的末行折行。
    let current: Element | null = body;
    while (current !== null) {
      const last: Element | null = current.lastElementChild;
      if (last === null) {
        break;
      }
      const style = view?.getComputedStyle(last);
      if (style === undefined) {
        break;
      }
      const paintedBottom =
        last.getBoundingClientRect().bottom - htmlRect.top + html.scrollTop;
      if (Number.isFinite(paintedBottom) && paintedBottom > height) {
        height = paintedBottom;
      }
      const marginBottom = Number.parseFloat(style.marginBottom);
      if (Number.isFinite(marginBottom) && marginBottom > 0) {
        height += marginBottom;
        break;
      }
      // last 无 margin：若它自带底部 padding/border，其内部子元素的 margin 已被
      // 容纳进 scrollHeight，不会再塌陷穿透到 body，停止向下。
      const padBottom = Number.parseFloat(style.paddingBottom);
      const borderBottom = Number.parseFloat(style.borderBottomWidth);
      if (
        (Number.isFinite(padBottom) && padBottom > 0) ||
        (Number.isFinite(borderBottom) && borderBottom > 0)
      ) {
        break;
      }
      current = last;
    }
    // 底部安全余量：末行 descender（标题 line-height 1.35 时尤其紧贴 line box 底）
    // 加上字号缩放后的亚像素舍入，会裁掉末行下伸 1–2px，补 0.2em 兜底。
    const bodyStyle = view?.getComputedStyle(body);
    const fontSize = bodyStyle === undefined ? Number.NaN : Number.parseFloat(bodyStyle.fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0) {
      height += fontSize * 0.2;
    }
    return Math.ceil(height);
  } finally {
    html.style.overflow = previousHtmlOverflow;
    body.style.overflow = previousBodyOverflow;
  }
}

/** iframe 内焦点不冒泡到宿主：只转发应用快捷键，不抢复制/全选。 */
export function shouldForwardFrameShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  for (const combo of Object.values(DEFAULT_SHORTCUTS)) {
    if (matchEvent(event, combo)) {
      return true;
    }
  }
  return false;
}

/**
 * 反解 CSS columns 渲染出的总列数 K：scrollWidth = K*columnWidth + (K-1)*gap，
 * 即 K = (scrollWidth + gap) / (columnWidth + gap)。取整容差 scrollWidth 的
 * 亚像素舍入。供分栏末屏补齐（padFinalSpread）与单测共用。
 */
export function totalColumnCount(
  scrollWidth: number,
  columnWidth: number,
  gap: number,
): number {
  if (!Number.isFinite(scrollWidth) || scrollWidth <= 0) {
    return 0;
  }
  const denom = Math.max(1, columnWidth + gap);
  return Math.round((scrollWidth + gap) / denom);
}

/** 编排壳注入的回调：状态机/进度/标注/搜索与工具栏均留在 reader-view。 */
export interface FlowRendererHooks {
  /** 翻译 i18n key（章节标题/远程图占位文案）。 */
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 会话级远程图授权策略（与宿主 reader 共用同一实例）。 */
  remoteImagePolicy: RemoteImagePolicy;
  /** 帧高度同步后同步章节指示/进度（reader-view syncFlowState）。 */
  syncState(): void;
  /** 存在待恢复进度时触发一次恢复（reader-view 检查 pendingRestore）。 */
  applyPendingRestore(): void;
  /** 帧就绪后重渲染流式标注高亮（reader-view renderHighlights）。 */
  renderHighlights(): void;
  /** 笔记 mark 点击：返回 true 表示已处理（渲染器跳过后续链接处理）。 */
  handleNoteMarkClick(event: MouseEvent): boolean;
  /** iframe 内划选 mouseup：捕获待确认划选并唤起工具栏。 */
  onSelectionMouseUp(
    selection: Selection | null,
    chapter: number,
    body: HTMLElement,
    frame: HTMLIFrameElement,
  ): void;
  /** iframe 内 Ctrl+F：打开搜索面板。 */
  openSearch(seed?: string): void;
  /** 键盘翻页导航（reader-view advanceReading）。 */
  advanceReading(direction: 1 | -1): boolean;
  /** 流式滚动容器（帧内滚动模式 wheel 转发目标，reader-view flowScrollContainer）。 */
  scrollContainer(): HTMLElement;
  /** 滚轮翻页导航（含 trackpad 门限；移动后由编排壳隐藏划选工具栏）。 */
  advancePagedWheel(direction: 1 | -1): boolean;
  /** Escape 关闭可见的划选工具栏：返回是否可见并已隐藏。 */
  dismissSelectionToolbar(): boolean;
  /** 布局切换进行中（remeasure 期间跳过帧高度同步）。 */
  isLayoutSwitching(): boolean;
}

export interface FlowRenderer {
  /** 渲染整本书的章节（作废旧渲染代并释放旧帧监听/远程图授权）。 */
  render(chapters: ReaderChapter[], stylesheet?: string): void;
  /** 作废当前渲染代并释放帧监听与远程图授权（切换页格式/销毁时）。 */
  clear(): void;
  /** 翻页模式下激活指定章节（display 切换），滚动模式无副作用类切换。 */
  setActiveChapter(index: number): void;
  /** 当前可见章节的 frame（翻页模式取活动章，滚动模式取视口相交帧）。 */
  visibleFrame(): HTMLIFrameElement | null;
  /** 翻页布局应用到帧文档（度量走 pagedSpreadMetrics + 共享列变量应用器）。 */
  applyPaginatedDocument(
    frame: HTMLIFrameElement,
    frameDocument: Document,
    options?: { restoreRatio?: number; snap?: boolean },
  ): void;
  /** 滚动布局重测全部帧高度（编排壳在 layoutSwitching 期间调用）。 */
  remasureScrollFrames(): void;
  /** 字号变更后重应用可见帧 chrome（含翻页分栏）。 */
  syncVisibleFrames(): void;
  /** 主题切换后重应用全部就绪帧的文字色（R4）。 */
  syncTheme(): void;
}

/**
 * 在 scrollHost 内渲染章节 iframe 并持有其生命周期。
 * root 用于继承宿主排版（color/font 计算值内联进帧）。
 */
export function createFlowRenderer(
  scrollHost: HTMLElement,
  root: HTMLElement,
  hooks: FlowRendererHooks,
): FlowRenderer {
  let flowRenderGeneration = 0;
  let releaseRemoteImages: Array<() => void> = [];

  /** T8：章节资源物化窗口（EPUB 图片按视口可见性 resolve/release，配对 revoke）。 */
  interface ChapterResourceWindow {
    chapter: ReaderChapter;
    frame: HTMLIFrameElement;
    generation: number;
    visible: boolean;
    ready: boolean;
    queue: Promise<void>;
    afterResolve: (() => void) | null;
  }
  let resourceWindows: ChapterResourceWindow[] = [];
  let resourceObserver: IntersectionObserver | null = null;

  /** 按窗口状态串行执行 resolve/release（每章一个 promise 链，避免快进快出竞态）。 */
  const syncChapterResources = (win: ChapterResourceWindow): void => {
    if (win.chapter.resolveResources === undefined && win.chapter.releaseResources === undefined) {
      return;
    }
    win.queue = win.queue
      .then(async () => {
        if (win.generation !== flowRenderGeneration) {
          return;
        }
        const doc = win.frame.contentDocument;
        if (doc === null) {
          return;
        }
        if (win.visible && win.ready) {
          await win.chapter.resolveResources?.(doc);
          win.afterResolve?.();
        } else if (!win.visible) {
          win.chapter.releaseResources?.(doc);
        }
      })
      // 物化/释放失败（如损坏 zip 条目）不中断该章串行队列：吞错保持后续窗口
      // 同步可用，图片保留包内路径占位 src 呈现为破图（T8 懒物化后 parse 期不再
      // 抛此类错误，损坏条目由 parse 期抛错变为渲染期静默破图，属既定语义）。
      .catch(() => undefined);
  };

  const clear = (): void => {
    flowRenderGeneration += 1;
    resourceObserver?.disconnect();
    resourceObserver = null;
    const windows = resourceWindows;
    resourceWindows = [];
    releaseRemoteImages.splice(0).forEach((release) => release());
    // 卸载帧配对释放已物化资源（内容级 dispose 由编排壳兜底 revoke）。
    for (const win of windows) {
      const doc = win.frame.contentDocument;
      if (doc !== null) {
        win.chapter.releaseResources?.(doc);
      }
    }
  };

  const setActiveChapter = (index: number): void => {
    const chapters = scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter');
    chapters.forEach((chapter) => {
      const current = Number(chapter.dataset.chapterIndex);
      chapter.classList.toggle('is-active', current === index);
    });
  };

  const visibleFrame = (): HTMLIFrameElement | null => {
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

  /**
   * 双栏末屏单栏收尾时，CSS columns 的 scrollWidth 只到「上一屏右栏 + 单栏」，
   * 滚动到底会把上一屏右栏错位成左栏（重复）。追加一个 break-before:column 的
   * 空列占位，把 scrollWidth 补齐到整页步进的整数倍，使末屏单栏能对齐到左栏。
   */
  const padFinalSpread = (
    html: HTMLElement,
    frameDocument: Document,
    columnWidth: number,
    columns: number,
    gap: number,
  ): void => {
    for (const existing of frameDocument.querySelectorAll('.lightink-reader-column-pad')) {
      existing.remove();
    }
    if (columns <= 1) {
      return;
    }
    // scrollWidth = K*columnWidth + (K-1)*gap，反解总列数 K。
    const totalColumns = totalColumnCount(html.scrollWidth, columnWidth, gap);
    if (totalColumns % columns === 0) {
      return;
    }
    const pad = frameDocument.createElement('div');
    pad.className = 'lightink-reader-column-pad';
    pad.style.width = `${columnWidth}px`;
    pad.style.height = '1px';
    pad.style.fontSize = '0';
    pad.style.lineHeight = '0';
    pad.style.overflow = 'hidden';
    pad.style.breakBefore = 'column';
    pad.style.breakInside = 'avoid';
    frameDocument.body.appendChild(pad);
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
    applyPagedSpreadVars(html, { columnWidth, columns, gap });
    html.style.setProperty('--lightink-reader-page-height', `${height}px`);
    html.style.removeProperty('--lightink-reader-image-max-height');
    // 一图一栏：只钳制 img/svg。figure 保持可拆，避免「图+后文」整块被推到右栏。
    for (const media of frameDocument.querySelectorAll<HTMLElement>('img, svg')) {
      media.style.maxWidth = `${columnWidth}px`;
      media.style.maxHeight = `${height}px`;
      media.style.width = 'auto';
      media.style.height = 'auto';
      media.style.breakInside = 'avoid';
      media.style.removeProperty('break-before');
      media.style.columnSpan = 'none';
    }
    for (const figure of frameDocument.querySelectorAll<HTMLElement>('figure')) {
      figure.style.maxWidth = `${columnWidth}px`;
      figure.style.breakInside = 'auto';
      figure.style.removeProperty('max-height');
      figure.style.removeProperty('break-before');
      figure.style.removeProperty('column-span');
    }
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
    padFinalSpread(html, frameDocument, columnWidth, columns, gap);
    if (options?.restoreRatio !== undefined) {
      applyPagedProgress(html, options.restoreRatio, step);
    } else if (options?.snap !== false) {
      snapPagedScroller(html, step);
      if (html.scrollLeft === 0 && previousRatio > 0) {
        applyPagedProgress(html, previousRatio, step);
      }
    }
  };

  const render = (chapters: ReaderChapter[], stylesheet = ''): void => {
    clear();
    const renderGeneration = flowRenderGeneration;
    scrollHost.replaceChildren();
    // T8：视口窗口驱动物化/释放；rootMargin 预取一屏邻章。无 IO 环境（jsdom）
    // 时 visible 常 true，退化为帧加载即物化（与原 parse 期物化效果等价）。
    resourceObserver =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const index = Number((entry.target as HTMLElement).dataset.chapterIndex);
                const win = resourceWindows[index];
                if (win === undefined || win.generation !== renderGeneration) {
                  continue;
                }
                win.visible = entry.isIntersecting;
                syncChapterResources(win);
              }
            },
            { root: scrollHost, rootMargin: '100% 0px' },
          );
    let chapterIndex = 0;
    for (const chapter of chapters) {
      const article = document.createElement('article');
      article.className = 'lightink-reader-chapter';
      article.dataset.chapterIndex = String(chapterIndex);
      const heading = document.createElement('h1');
      heading.className = 'lightink-reader-chapter-title';
      heading.textContent =
        chapter.title || hooks.t('reader.chapter', { n: String(chapterIndex + 1) });
      const frame = document.createElement('iframe');
      frame.className = 'lightink-reader-chapter-frame';
      frame.dataset.chapterIndex = String(chapterIndex);
      frame.title =
        chapter.title || hooks.t('reader.chapter', { n: String(chapterIndex + 1) });
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('scrolling', 'no');
      frame.referrerPolicy = 'no-referrer';

      const win: ChapterResourceWindow = {
        chapter,
        frame,
        generation: renderGeneration,
        visible: resourceObserver === null,
        ready: false,
        queue: Promise.resolve(),
        afterResolve: null,
      };
      resourceWindows.push(win);
      resourceObserver?.observe(article);

      const frameChapter = chapterIndex;
      const onLoad = (): void => {
        if (renderGeneration !== flowRenderGeneration) {
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
            for (const pad of frameDocument.querySelectorAll('.lightink-reader-column-pad')) {
              pad.remove();
            }
            clearPagedSpreadVars(html);
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
            html.style.overflow = 'hidden';
            html.scrollLeft = 0;
            frameDocument.body.style.height = 'auto';
            frameDocument.body.style.minHeight = '0';
            frameDocument.body.style.width = '100%';
            frameDocument.body.style.maxWidth = '100%';
            frameDocument.body.style.overflow = 'hidden';
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
          if (applyingFrame || hooks.isLayoutSwitching()) {
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
          hooks.applyPendingRestore();
          hooks.syncState();
        };
        const onClick = (event: MouseEvent): void => {
          if (hooks.handleNoteMarkClick(event)) {
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
          hooks.onSelectionMouseUp(
            frameWindow.getSelection(),
            frameChapter,
            frameDocument.body,
            frame,
          );
        };
        // 划选发生在 iframe 内，键盘焦点也在 iframe 文档——Escape 需在 frame 内转发。
        const onKeyDown = (event: KeyboardEvent): void => {
          if (event.key === 'Escape' && hooks.dismissSelectionToolbar()) {
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
            hooks.openSearch(frameWindow.getSelection()?.toString());
            return;
          }
          if (!event.ctrlKey && !event.metaKey && !event.altKey && isReadingNavKey(event.key)) {
            const direction = readingNavDirection(event.key, event.shiftKey);
            if (direction !== null && hooks.advanceReading(direction)) {
              event.preventDefault();
            }
            return;
          }
          if (shouldForwardFrameShortcut(event)) {
            event.preventDefault();
            frameWindow.parent.document.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: event.key,
                code: event.code,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                bubbles: true,
                cancelable: true,
              }),
            );
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
            const scroller = hooks.scrollContainer();
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
          hooks.advancePagedWheel(delta > 0 ? 1 : -1);
        };
        frameDocument.addEventListener('click', onClick);
        frameDocument.addEventListener('mouseup', onMouseUp);
        frameDocument.addEventListener('keydown', onKeyDown);
        frameDocument.addEventListener('wheel', onWheel, { passive: false });
        const releaseImages = bindBlockedRemoteImages(
          frameDocument.body,
          hooks.t('reader.remoteImageLoad'),
          hooks.remoteImagePolicy,
        );
        const resizeObserver =
          typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => {
                if (!applyingFrame && !hooks.isLayoutSwitching()) {
                  syncHeight();
                }
              });
        resizeObserver?.observe(frameDocument.body);
        const onImageLoad = (): void => {
          if (!applyingFrame && !hooks.isLayoutSwitching()) {
            syncHeight();
          }
        };
        const watchFrameImages = (): void => {
          for (const image of Array.from(frameDocument.images)) {
            if (!image.complete) {
              image.addEventListener('load', onImageLoad);
              image.addEventListener('error', onImageLoad);
            }
          }
        };
        watchFrameImages();
        syncHeight();
        requestAnimationFrame(syncHeight);
        hooks.renderHighlights();
        // T8：帧就绪——章节引用资源（EPUB 图片）按窗口可见性物化；物化完成后
        // 重新挂图片 load 监听并同步帧高（懒物化的图片此时才开始加载）。
        win.ready = true;
        win.afterResolve = () => {
          if (win.generation === flowRenderGeneration) {
            watchFrameImages();
            syncHeight();
          }
        };
        syncChapterResources(win);
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
  };

  const remasureScrollFrames = (): void => {
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
      for (const pad of frameDocument.querySelectorAll('.lightink-reader-column-pad')) {
        pad.remove();
      }
      clearPagedSpreadVars(html);
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
      html.style.overflow = 'hidden';
      html.scrollLeft = 0;
      body.style.height = 'auto';
      body.style.minHeight = '0';
      body.style.width = '100%';
      body.style.maxWidth = '100%';
      body.style.overflow = 'hidden';
      frame.style.width = '100%';
      frame.style.removeProperty('min-height');
      const nextHeight = `${flowFrameContentHeight(frameDocument)}px`;
      if (frame.style.height !== nextHeight) {
        frame.style.height = nextHeight;
      }
    }
  };

  const syncVisibleFrames = (): void => {
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

  const syncTheme = (): void => {
    const computed = getComputedStyle(root);
    for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame[data-frame-ready="true"]',
    )) {
      const frameDocument = frame.contentDocument;
      if (frameDocument === null) {
        continue;
      }
      frameDocument.body.style.color = computed.color;
    }
  };

  return {
    render,
    clear,
    setActiveChapter,
    visibleFrame,
    applyPaginatedDocument,
    remasureScrollFrames,
    syncVisibleFrames,
    syncTheme,
  };
}
