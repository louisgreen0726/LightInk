/**
 * `pdf-export` — PDF 导出（T10, R5）：WebView 打印管线。
 *
 * Tauri WebView2 内 `window.print()` 打开系统打印对话框，用户选择
 * 「另存为 PDF」即得 PDF。因此前端职责是：装配一份与 HTML 导出同一管线
 * 的打印就绪文档（同一 buildHtmlDocument + 图片内嵌，另加 @page / 打印
 * 微调样式），写入隐藏 iframe，加载完成后调用其 contentWindow.print()。
 * 实际 PDF 生成发生在系统打印对话框中，无法在 headless 测试里验证；
 * 可测的边界是「打印 HTML 与导出管线一致 + print 被调用」。
 *
 * 中文无乱码策略：与 HTML 导出共用 export-css 的字体栈（系统 CJK 字体，
 * 见 export-css.ts 头部注释），打印渲染由 WebView 使用系统字体完成，
 * Windows/macOS 上无需内嵌中文字体；KaTeX 数学字体已随 CSS 内嵌。
 */

import { buildHtmlDocument, type HtmlExportOptions } from './html-export.js';

/** 打印微调：页边距 + 取消屏幕版居中窄栏宽度上限。 */
export const PRINT_CSS = `/* LightInk 打印微调 */
@page { margin: 16mm; }
@media print {
  body { max-width: none; padding: 0; }
  pre { white-space: pre-wrap; word-break: break-word; }
}
`;

/** 装配打印就绪 HTML：与 HTML 导出同管线，追加打印样式。 */
export function buildPrintHtml(opts: HtmlExportOptions): string {
  return buildHtmlDocument({ ...opts, cssText: `${opts.cssText}\n${PRINT_CSS}` });
}

/**
 * 触发打印。`print` 由调用方注入（生产为 printViaHiddenIframe，测试为
 * stub）——打印本身不可 headless 验证，此函数只保证管线衔接。
 */
export function runPrint(html: string, print: (html: string) => void): void {
  print(html);
}

/**
 * 生产打印实现：隐藏 iframe 写入打印 HTML，加载完成后调 print()。
 * 打印对话框为模态，立即 remove 可能取消打印，故用 afterprint 监听 +
 * 超时兜底清理，避免隐藏 iframe 常驻 DOM；下次调用也会先移除旧 iframe。
 */
export function printViaHiddenIframe(doc: Document, html: string): void {
  doc.querySelectorAll('iframe.lightink-print-frame').forEach((el) => el.remove());
  const frame = doc.createElement('iframe');
  frame.className = 'lightink-print-frame';
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  frame.srcdoc = html;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    frame.remove();
  };
  frame.addEventListener(
    'load',
    () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      // 打印对话框关闭后清理；部分 WebView 不派发 afterprint，超时兜底。
      frame.contentWindow?.addEventListener('afterprint', cleanup, { once: true });
      setTimeout(cleanup, 60_000);
    },
    { once: true },
  );
  doc.body.appendChild(frame);
}
