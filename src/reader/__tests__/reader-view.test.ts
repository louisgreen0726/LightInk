/**
 * reader-view 骨架测试：挂载结构（滚动/页两种宿主 + 空态占位）、i18n、销毁移除 DOM。
 * node 环境，最小 fake document（项目无 jsdom/happy-dom）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createReaderView } from '../reader-view.js';

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
}

const originalDocument = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  (globalThis as { document: unknown }).document = new FakeDoc();
});

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document: unknown }).document = originalDocument;
  }
});

function asHost(): HTMLElement {
  return new FakeEl('div') as unknown as HTMLElement;
}

function asFake(el: HTMLElement): FakeEl {
  return el as unknown as FakeEl;
}

describe('createReaderView 骨架', () => {
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
