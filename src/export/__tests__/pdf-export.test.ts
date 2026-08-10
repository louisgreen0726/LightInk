/**
 * pdf-export 测试：打印 HTML 与 HTML 导出同管线（另加打印样式），
 * print 触发经注入 stub 断言 —— 实际 PDF 生成在系统打印对话框中完成，
 * 不可 headless 验证（见 pdf-export.ts 头部注释）。
 *
 * 主窗口挂载路径用最小 fake Document（项目无 jsdom/happy-dom）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPrintHtml,
  EXPORT_ROOT_ID,
  extractPrintParts,
  MAIN_WINDOW_PRINT_CSS,
  PRINT_CSS,
  PRINT_STYLE_ID,
  printViaMainWindow,
  runPrint,
} from '../pdf-export.js';

describe('buildPrintHtml', () => {
  it('与导出文档同结构，并追加 @page / 打印微调样式', () => {
    const html = buildPrintHtml({
      title: '打印文档',
      theme: 'warm-light',
      bodyHtml: '<p>中文内容</p>',
      cssText: ':root{--x:1}',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('data-theme="warm-light"');
    expect(html).toContain('<p>中文内容</p>');
    expect(html).toContain('@page');
    expect(html).toContain('@media print');
    // 基础 CSS 在前、打印微调在后（后者可覆盖前者）。
    expect(html.indexOf(':root{--x:1}')).toBeLessThan(html.indexOf(PRINT_CSS));
  });
});

describe('runPrint', () => {
  it('装配好的 HTML 交给注入的 print 实现', () => {
    const print = vi.fn();
    runPrint('<html>doc</html>', print);
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith('<html>doc</html>');
  });
});

describe('extractPrintParts', () => {
  it('抽出 style 与 body 内层', () => {
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<p>正文</p>',
      cssText: '/* css */',
    });
    const parts = extractPrintParts(html);
    expect(parts.bodyHtml).toContain('<p>正文</p>');
    expect(parts.styleText).toContain('/* css */');
    expect(parts.styleText).toContain('@page');
  });

  it('缺标签时回退空串', () => {
    expect(extractPrintParts('<html></html>')).toEqual({ bodyHtml: '', styleText: '' });
  });
});

/** 最小 fake 元素：覆盖 printViaMainWindow 用到的 DOM 子集。 */
class FakeEl {
  id = '';
  textContent = '';
  innerHTML = '';
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();

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

  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

function makeFakeDocument(): {
  doc: Document;
  head: FakeEl;
  body: FakeEl;
  byId: Map<string, FakeEl>;
} {
  const byId = new Map<string, FakeEl>();
  const head = new FakeEl();
  const body = new FakeEl();

  const track = (el: FakeEl): void => {
    if (el.id) byId.set(el.id, el);
  };

  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => {
      void tag;
      return new FakeEl();
    },
    head: {
      appendChild: (el: FakeEl) => {
        head.appendChild(el);
        track(el);
        return el;
      },
    },
    body: {
      appendChild: (el: FakeEl) => {
        body.appendChild(el);
        track(el);
        return el;
      },
    },
  } as unknown as Document;

  return { doc, head, body, byId };
}

describe('printViaMainWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('挂载导出根与打印样式，并对主窗口调用 print', () => {
    vi.useFakeTimers();
    const print = vi.fn();
    const focus = vi.fn();
    const addEventListener = vi.fn();
    // 同步执行 rAF，便于断言挂载与 print 调用。
    const requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    };
    const win = {
      print,
      focus,
      addEventListener,
      requestAnimationFrame,
    } as unknown as Window;

    const { doc, head, body, byId } = makeFakeDocument();
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<h1>导出</h1>',
      cssText: '/* theme */',
    });
    printViaMainWindow(doc, html, win);

    const root = byId.get(EXPORT_ROOT_ID);
    const style = byId.get(PRINT_STYLE_ID);
    expect(root).toBeDefined();
    expect(root?.innerHTML).toContain('<h1>导出</h1>');
    expect(style?.textContent).toContain('/* theme */');
    expect(style?.textContent).toContain(MAIN_WINDOW_PRINT_CSS);
    expect(body.children).toContain(root);
    expect(head.children).toContain(style);
    expect(print).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith(
      'afterprint',
      expect.any(Function),
      expect.objectContaining({ once: true }),
    );

    // 超时兜底清理。
    vi.advanceTimersByTime(60_000);
    expect(byId.get(EXPORT_ROOT_ID)?.parent).toBeNull();
    expect(byId.get(PRINT_STYLE_ID)?.parent).toBeNull();
  });
});
