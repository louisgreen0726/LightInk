/**
 * pdf-export 测试：打印 HTML 与 HTML 导出同管线（另加打印样式），
 * print 触发经注入 stub 断言 —— 实际 PDF 生成在系统打印对话框中完成，
 * 不可 headless 验证（见 pdf-export.ts 头部注释）。
 */

import { describe, expect, it, vi } from 'vitest';

import { buildPrintHtml, PRINT_CSS, runPrint } from '../pdf-export.js';

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
