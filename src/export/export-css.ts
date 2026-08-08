/**
 * `export-css` — 导出样式装配（T10, R5）。
 *
 * 导出 HTML / PDF 打印视图都是脱离应用的独立文档，所需样式必须内嵌：
 *   - `tokens.css` 经 `?raw` 原样读入：`[data-theme]` 令牌 + hljs 语法高亮
 *     映射全部在此，导出文档带上同一 `data-theme` 属性即与编辑器配色一致
 *     （含语法高亮）；自定义主题 CSS 由调用方经 `buildExportCss(extra)` 追加；
 *   - `katex.min.css` 经 `?inline` 由 Vite 内联；其中 @font-face 引用的
 *     KaTeX 字体由 vite.config.ts 的 `build.assetsInlineLimit` 回调强制
 *     内联为 data URI（woff2/ttf 超过默认 4KB 上限，不设该回调时字体仍是
 *     独立文件、独立 HTML 经 file:// 打开会 404），公式在独立 HTML 中
 *     离线可用；
 *   - `EXPORT_BASE_CSS` 是编辑器内容排版的精简复刻（正文/代码块/引用/表格/
 *     图片等，取自 src/ui/theme.css 的 `.lightink-tab-host` 部分并把作用域
 *     换成 `body`），应用外壳样式（工具栏/标签栏）不进入导出文档。
 *
 * 中文字体策略（R5「PDF 中文无乱码」）：正文 font-family 栈含
 * "Microsoft YaHei" / "PingFang SC" 等系统 CJK 字体，WebView 打印走系统
 * 字体，Windows/macOS 上中文不会出现豆腐块；KaTeX 数学字体随 CSS 内嵌。
 *
 * 注意：vitest（node 环境）不处理 CSS 导入，`?raw`/`?inline` 在测试下得到
 * 空串。因此纯逻辑（html-export / pdf-export）一律以 `cssText` 参数注入，
 * 本模块只做生产装配；测试只断言本模块自身可组合（见 __tests__）。
 */

import katexCss from 'katex/dist/katex.min.css?inline';
import tokensCss from '../theme/tokens.css?raw';

/** 与编辑器内容排版对应的导出基础样式（作用域为 body，无外壳样式）。 */
export const EXPORT_BASE_CSS = `/* LightInk 导出文档基础样式（与编辑器内容排版一致，作用域 body） */
body {
  background: var(--lightink-bg);
  color: var(--lightink-fg);
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.7;
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 32px 48px;
}
pre {
  background: var(--lightink-code-bg);
  border: 1px solid var(--lightink-border);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
}
code {
  font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
}
:not(pre) > code {
  background: var(--lightink-code-bg);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 0.92em;
}
blockquote {
  margin: 0;
  padding-left: 14px;
  border-left: 3px solid var(--lightink-border);
  color: var(--lightink-muted);
}
a { color: var(--lightink-accent); }
hr { border: none; border-top: 1px solid var(--lightink-border); }
img { max-width: 100%; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid var(--lightink-border); padding: 4px 10px; }
th { background: var(--lightink-bg-elevated); }
.lightink-math-block, .lightink-mermaid { margin: 8px 0; }
.lightink-math-error, .lightink-mermaid-error { color: var(--lightink-accent); }
::selection { background: var(--lightink-selection); }
`;

/**
 * 装配导出 CSS：主题令牌 + KaTeX 样式（含内嵌字体）+ 基础排版 + 可选附加
 * CSS（生产为当前自定义主题文本；内置主题时传空串）。
 */
export function buildExportCss(extraCss = ''): string {
  return [tokensCss, katexCss, EXPORT_BASE_CSS, extraCss]
    .filter((part) => part.length > 0)
    .join('\n');
}
