// @vitest-environment jsdom

/**
 * reader-view 骨架测试：挂载结构（滚动/页两种宿主 + 空态占位）、i18n、销毁移除 DOM。
 * 骨架用例沿用最小 fake document；划选工具栏用例（R3）用 jsdom 真实 DOM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';
import { createFlowRenderer, flowFrameContentHeight } from '../flow-renderer.js';
import type { FlowRendererHooks } from '../flow-renderer.js';
import { sessionRemoteImagePolicy } from '../../media/remote-image-policy.js';
import { createSelectionToolbar, toolbarPosition } from '../selection-toolbar.js';
import {
  applyPagedSpreadVars,
  clearPagedSpreadVars,
  pagedSpreadMetrics,
} from '../../ui/reading-layout.js';

/** 最小 fake 元素：覆盖 createReaderView 用到的 DOM 表面。 */
class FakeEl {
  className = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private ownText = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).filter(Boolean).includes(c),
    add: (c: string): void => {
      if (!this.classList.contains(c)) {
        this.className = this.className === '' ? c : `${this.className} ${c}`;
      }
    },
  };

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...kids: FakeEl[]): void {
    for (const kid of kids) {
      this.appendChild(kid);
    }
  }

  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }

  /** 深度查找首个满足断言的元素（含自身）。 */
  find(pred: (el: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) {
      return this;
    }
    for (const child of this.children) {
      const hit = child.find(pred);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }

  addEventListener(): void {
    /* no-op for reader-view tests（T5 起 reader-view 在 root 上挂 keydown） */
  }

  removeEventListener(): void {
    /* no-op */
  }
}

class FakeDoc {
  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }

  addEventListener(): void {
    /* no-op：reader-view 监听 lightink:font-scale */
  }

  removeEventListener(): void {
    /* no-op */
  }
}

const originalDocument = (globalThis as { document?: unknown }).document;

/** 骨架用例沿用 fake document；工具栏用例（文件尾 describe）用 jsdom 真实 DOM。 */
function useFakeDocument(): void {
  beforeEach(() => {
    (globalThis as { document: unknown }).document = new FakeDoc();
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });
}

function asHost(): HTMLElement {
  return new FakeEl('div') as unknown as HTMLElement;
}

function asFake(el: HTMLElement): FakeEl {
  return el as unknown as FakeEl;
}

describe('createReaderView 骨架', () => {
  useFakeDocument();

  it('挂载滚动/页两种宿主与空态占位', () => {
    const host = asHost();
    createReaderView(host);
    const root = asFake(host).children[0]!;
    expect(root.className).toBe('lightink-reader');
    expect(root.getAttribute('role')).toBe('document');

    const scroll = root.find((e) => e.dataset.readerHost === 'scroll');
    const pages = root.find((e) => e.dataset.readerHost === 'pages');
    expect(scroll).not.toBeNull();
    expect(pages).not.toBeNull();
    expect(pages!.hidden).toBe(true); // 默认隐藏页模式宿主（T5 激活）

    const empty = root.find((e) => e.classList.contains('lightink-reader-empty'));
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('reader.empty'); // 默认 t 返回 key 本身
  });

  it('空态文案经注入的 t 翻译', () => {
    const host = asHost();
    createReaderView(host, {
      t: (key) => (key === 'reader.empty' ? 'EMPTY_TEXT' : key),
    });
    const root = asFake(host).children[0]!;
    const empty = root.find((e) => e.classList.contains('lightink-reader-empty'));
    expect(empty!.textContent).toBe('EMPTY_TEXT');
  });

  it('destroy 移除视图 DOM', async () => {
    const host = asHost();
    const view = createReaderView(host);
    expect(asFake(host).children).toHaveLength(1);
    await view.destroy();
    expect(asFake(host).children).toHaveLength(0);
  });

  it('多实例独立 root，销毁互不干扰', async () => {
    const host = asHost();
    const a = createReaderView(host);
    const b = createReaderView(host);
    expect(asFake(host).children).toHaveLength(2);
    await a.destroy();
    expect(asFake(host).children).toHaveLength(1);
    await b.destroy();
    expect(asFake(host).children).toHaveLength(0);
  });
});

describe('划选工具栏（selection-toolbar）', () => {
  const buttonByAction = (toolbar: ReturnType<typeof createSelectionToolbar>, action: string) =>
    toolbar.element.querySelector<HTMLButtonElement>(
      `.lightink-reader-selection-action--${action}`,
    );

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('显示高亮/笔记按钮，取消高亮按需出现', () => {
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: () => undefined });
    document.body.appendChild(toolbar.element);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    expect(toolbar.isVisible()).toBe(true);
    expect(buttonByAction(toolbar, 'highlight')!.textContent).toBe('annotation.highlight');
    expect(buttonByAction(toolbar, 'note')!.textContent).toBe('annotation.note');
    expect(buttonByAction(toolbar, 'copy')!.textContent).toBe('annotation.copy');
    expect(buttonByAction(toolbar, 'removeHighlight')!.hidden).toBe(true);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: true });
    expect(buttonByAction(toolbar, 'removeHighlight')!.hidden).toBe(false);
    toolbar.hide();
    expect(toolbar.isVisible()).toBe(false);
  });

  it('点击动作派发回调并隐藏工具栏', () => {
    const actions: string[] = [];
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: (a) => actions.push(a) });
    document.body.appendChild(toolbar.element);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    buttonByAction(toolbar, 'highlight')!.click();
    expect(actions).toEqual(['highlight']);
    expect(toolbar.isVisible()).toBe(false);
  });

  it('点击工具栏外部隐藏且不派发动作', () => {
    const actions: string[] = [];
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: (a) => actions.push(a) });
    document.body.appendChild(toolbar.element);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(toolbar.isVisible()).toBe(false);
    expect(actions).toEqual([]);
  });

  it('工具栏定位：优先选区上方，越顶下移并夹在视口内', () => {
    const rect = { left: 200, top: 300, width: 100, height: 20 };
    const toolbarSize = { width: 160, height: 32 };
    const viewport = { width: 1280, height: 800 };
    // 上方放得下：贴选区上沿。
    expect(toolbarPosition(rect, toolbarSize, viewport)).toEqual({ left: 170, top: 264 });
    // 选区贴近顶部：下移到选区下方。
    expect(toolbarPosition({ ...rect, top: 10 }, toolbarSize, viewport)).toEqual({ left: 170, top: 34 });
    // 视口窄于工具栏：左移被夹在边距。
    expect(toolbarPosition({ left: -50, top: 300, width: 0, height: 20 }, toolbarSize, viewport)).toEqual({
      left: 4,
      top: 264,
    });
  });
});

describe('flowFrameContentHeight', () => {
  it('uses body content height, not a stretched iframe viewport', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 420 });
    Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, value: 100000 });
    expect(flowFrameContentHeight(doc)).toBe(420);
    iframe.remove();
  });
});

describe('共享翻页布局应用器（T5：markdown 与流式同源）', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('applyPagedSpreadVars 写入 pagedSpreadMetrics 派生的共享列变量', () => {
    const el = document.createElement('div');
    const metrics = pagedSpreadMetrics(1000, 16);
    applyPagedSpreadVars(el, metrics);
    expect(el.style.getPropertyValue('--lightink-reader-column-width')).toBe(
      `${metrics.columnWidth}px`,
    );
    expect(el.style.getPropertyValue('--lightink-reader-column-gap')).toBe(`${metrics.gap}px`);
    expect(el.style.getPropertyValue('--lightink-reader-column-count')).toBe(
      String(metrics.columns),
    );
    clearPagedSpreadVars(el);
    expect(el.style.getPropertyValue('--lightink-reader-column-width')).toBe('');
    expect(el.style.getPropertyValue('--lightink-reader-column-gap')).toBe('');
    expect(el.style.getPropertyValue('--lightink-reader-column-count')).toBe('');
  });

  it('flow-renderer applyPaginatedDocument 写入与 markdown 侧相同的列变量', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, hooks);

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    renderer.applyPaginatedDocument(iframe, doc);

    const html = doc.documentElement;
    const metrics = pagedSpreadMetrics(Math.max(1, scrollHost.clientWidth), 16);
    expect(html.style.getPropertyValue('--lightink-reader-column-width')).toBe(
      `${metrics.columnWidth}px`,
    );
    expect(html.style.getPropertyValue('--lightink-reader-column-count')).toBe(
      String(metrics.columns),
    );
    expect(html.style.columnWidth).toBe(`${metrics.columnWidth}px`);
    iframe.remove();
  });
});

describe('缩放性能（T6：档位合并去抖 + 仅可见章分栏 + 流式锚点不漂移）', () => {
  const rect = (top: number, height: number): DOMRect =>
    ({ top, bottom: top + height, left: 0, right: 400, width: 400, height }) as DOMRect;

  const loadFlowBook = async (
    chapterCount: number,
  ): Promise<{
    host: HTMLDivElement;
    view: ReturnType<typeof createReaderView>;
    scroll: HTMLElement;
    chapters: HTMLElement[];
    frames: HTMLIFrameElement[];
  }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: chapterCount }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>chapter ${index + 1} body</p>`,
        })),
      }),
    });
    await view.load('book.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapters = Array.from(scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter'));
    const frames = Array.from(
      host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    );
    for (const frame of frames) {
      frame.dispatchEvent(new Event('load'));
    }
    // 冲掉帧 load 时排队的 rAF chrome 重放，避免迟到帧改写测试预设的样式。
    await vi.advanceTimersByTimeAsync(50);
    return { host, view, scroll, chapters, frames };
  };

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    document.documentElement.style.removeProperty('--lightink-font-scale');
  });

  it('滚动模式：字号缩放经 ~200ms settle 合并去抖，仅刷新可见帧并保持视口锚点', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'scroll';
    const { view, scroll, chapters, frames } = await loadFlowBook(2);

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 500));
    vi.spyOn(chapters[1]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 800));
    vi.spyOn(frames[1]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 800));
    // 缩放前章高 800、缩放后重排为 1600：锚点恢复必须把视口中心内容按比例带回。
    // （jsdom 会把 calc(16px * 2) 归一化为 calc(32px)，故提取像素数值区分前后。）
    const bodyFontPx = (body: HTMLElement): number =>
      Number(body.style.fontSize.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 0);
    const visibleBody = frames[0]!.contentDocument!.body;
    const scaledUp = (): boolean => bodyFontPx(visibleBody) >= 32;
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockImplementation(() =>
      scaledUp() ? rect(50, 1600) : rect(100, 800),
    );
    vi.spyOn(frames[0]!, 'getBoundingClientRect').mockReturnValue(rect(100, 800));
    scroll.scrollTop = 100;

    document.documentElement.style.setProperty('--lightink-font-scale', '2');
    document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: 2 }));

    // settle 窗口内不重排（连续缩放合并去抖，避免每档整章 column 重排）。
    expect(scaledUp()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    expect(scaledUp()).toBe(true); // 可见帧已按新档刷新
    expect(bodyFontPx(frames[1]!.contentDocument!.body)).toBeLessThan(32); // 离屏帧不动
    // 视口锚点（章内 0.1875 处）回到中心：scrollTop 100 → 200，内容不漂移。
    expect(scroll.scrollTop).toBe(200);
    await view.destroy();
  });

  it('翻页模式：settle 时仅可见章立即重分栏，离屏章激活时才惰性补分栏', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'paginated';
    const { view, scroll, chapters, frames } = await loadFlowBook(3);

    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 500));
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
    vi.spyOn(frames[0]!, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
    for (let i = 1; i < 3; i += 1) {
      vi.spyOn(chapters[i]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 300));
      vi.spyOn(frames[i]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 300));
    }
    // 模拟“未按当前档分栏”的陈旧宽度：可见章 0 与离屏章 1/2 各自不同。
    const htmls = frames.map((frame) => frame.contentDocument!.documentElement);
    htmls[0]!.style.width = '555px';
    htmls[1]!.style.width = '777px';
    htmls[2]!.style.width = '888px';

    document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: 2 }));
    expect(htmls[0]!.style.width).toBe('555px'); // 未到 settle 不重分栏

    await vi.advanceTimersByTimeAsync(200);
    expect(htmls[0]!.style.width).not.toBe('555px'); // 可见章立即重分栏
    expect(htmls[1]!.style.width).toBe('777px'); // 离屏章不参与整批重分栏
    expect(htmls[2]!.style.width).toBe('888px');

    // 激活离屏章 1：惰性补分栏；其余离屏章保持惰性。
    view.jumpToOutlineItem({ level: 1, text: 'Chapter 2', anchor: 1, chapter: 1 });
    expect(htmls[1]!.style.width).not.toBe('777px');
    expect(htmls[2]!.style.width).toBe('888px');
    await view.destroy();
  });
});
