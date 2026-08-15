// @vitest-environment jsdom

/**
 * reader-view 骨架测试：挂载结构（滚动/页两种宿主 + 空态占位）、i18n、销毁移除 DOM。
 * 骨架用例沿用最小 fake document；划选工具栏用例（R3）用 jsdom 真实 DOM。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createReaderView } from '../reader-view.js';
import { createSelectionToolbar, toolbarPosition } from '../selection-toolbar.js';

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
