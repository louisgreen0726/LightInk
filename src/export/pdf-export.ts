/**
 * `pdf-export` — PDF 导出（T10, R5）：WebView 打印管线。
 *
 * Tauri WebView 内 `window.print()` 打开系统打印对话框，用户选择
 * 「另存为 PDF」即得 PDF。因此前端职责是：装配一份与 HTML 导出同一管线
 * 的打印就绪文档（同一 buildHtmlDocument + 图片内嵌，另加 @page / 打印
 * 微调样式），装入可打印表面后调用 print()。
 *
 * 平台注意（macOS / Linux WebKit）：
 *   - `iframe.contentWindow.print()` 在 Tauri 的 WKWebView / WebKitGTK 上
 *     会静默失败（上游：tauri#13451 / wry iframe print）。Windows WebView2
 *     可用，但不能只依赖 iframe 路径。
 *   - 因此生产路径改为：把打印文档 body 写入隐藏的主文档导出根节点，
 *     用 `@media print` 隐藏其余 UI 后对 **主窗口** `window.print()`。
 *     这样三端同一实现，且不依赖 iframe 打印。
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

export const EXPORT_ROOT_ID = 'lightink-export-print-root';
export const PRINT_STYLE_ID = 'lightink-export-print-style';

/**
 * 主窗口打印时注入：隐藏应用壳层，只显示导出根。
 * 必须与 `EXPORT_ROOT_ID` 配套。
 */
export const MAIN_WINDOW_PRINT_CSS = `/* LightInk 主窗口导出打印 */
@media print {
  body * { visibility: hidden !important; }
  #${EXPORT_ROOT_ID},
  #${EXPORT_ROOT_ID} * {
    visibility: visible !important;
  }
  #${EXPORT_ROOT_ID} {
    position: absolute !important;
    left: 0 !important;
    top: 0 !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }
}
`;

/** 装配打印就绪 HTML：与 HTML 导出同管线，追加打印样式。 */
export function buildPrintHtml(opts: HtmlExportOptions): string {
  return buildHtmlDocument({ ...opts, cssText: `${opts.cssText}\n${PRINT_CSS}` });
}

/**
 * 从完整打印 HTML 中取出 body 内层与 style 文本，供主窗口挂载。
 * 解析失败时 bodyHtml 回退为空串、styleText 为空（调用方仍可尝试打印）。
 */
export function extractPrintParts(html: string): { bodyHtml: string; styleText: string } {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const styleText = styleMatch?.[1] ?? '';
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? '';
  return { bodyHtml, styleText };
}

/**
 * 触发打印。`print` 由调用方注入（生产为 printViaMainWindow，测试为
 * stub）——打印本身不可 headless 验证，此函数只保证管线衔接。
 */
export function runPrint(html: string, print: (html: string) => void): void {
  print(html);
}

/**
 * 生产打印实现：把导出 HTML 挂到主文档隐藏根节点，主窗口 `window.print()`。
 *
 * 为何不用隐藏 iframe：
 *   macOS WKWebView / Linux WebKitGTK 上 `iframe.contentWindow.print()` 静默
 *   无对话框（tauri#13451）；主窗口 print 三端可用。
 *
 * 清理：afterprint + 超时兜底，避免导出根常驻 DOM；下次调用先移除旧节点。
 */
export function printViaMainWindow(doc: Document, html: string, win: Window = window): void {
  // 清理上次残留。
  doc.getElementById(EXPORT_ROOT_ID)?.remove();
  doc.getElementById(PRINT_STYLE_ID)?.remove();

  const { bodyHtml, styleText } = extractPrintParts(html);

  const styleEl = doc.createElement('style');
  styleEl.id = PRINT_STYLE_ID;
  styleEl.textContent = `${styleText}\n${MAIN_WINDOW_PRINT_CSS}`;

  const root = doc.createElement('div');
  root.id = EXPORT_ROOT_ID;
  // 屏幕上不可见，打印时由 MAIN_WINDOW_PRINT_CSS 改为可见。
  root.setAttribute(
    'style',
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;',
  );
  root.innerHTML = bodyHtml;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    root.remove();
    styleEl.remove();
  };

  doc.head.appendChild(styleEl);
  doc.body.appendChild(root);

  // 等布局/样式应用后再 print（双 rAF：style 插入后一帧再触发）。
  const schedulePrint = (): void => {
    try {
      win.focus();
      win.print();
    } finally {
      // 部分 WebView 不派发 afterprint，超时兜底。
      win.addEventListener('afterprint', cleanup, { once: true });
      setTimeout(cleanup, 60_000);
    }
  };

  if (typeof win.requestAnimationFrame === 'function') {
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(schedulePrint);
    });
  } else {
    setTimeout(schedulePrint, 0);
  }
}

/**
 * @deprecated 保留名以免外部误引用；内部转发到主窗口打印。
 * iframe 路径在 macOS/Linux WebKit 上不可用。
 */
export function printViaHiddenIframe(doc: Document, html: string): void {
  printViaMainWindow(doc, html);
}
