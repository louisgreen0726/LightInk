/**
 * export-css 装配测试。注意 vitest（node 环境）不处理 CSS 导入，
 * tokens.css?raw / katex.min.css?inline 在此得到空串 —— 故只断言
 * 本模块自身可组合：基础排版样式在位 + 附加 CSS（自定义主题）拼入。
 * 令牌 / KaTeX 样式的真实内容在 vite build 产物中验证（见任务记录）。
 */

import { describe, expect, it } from 'vitest';

import { buildExportCss, EXPORT_BASE_CSS } from '../export-css.js';

describe('buildExportCss', () => {
  it('基础排版样式包含 CJK 字体栈与内容排版规则', () => {
    expect(EXPORT_BASE_CSS).toContain('Microsoft YaHei');
    expect(EXPORT_BASE_CSS).toContain('PingFang SC');
    expect(EXPORT_BASE_CSS).toContain('table');
    expect(EXPORT_BASE_CSS).toContain('blockquote');
    expect(EXPORT_BASE_CSS).toContain('img {');
  });

  it('附加 CSS（自定义主题）拼接在末尾', () => {
    const css = buildExportCss('/* custom */ body { color: red; }');
    expect(css).toContain(EXPORT_BASE_CSS);
    expect(css).toContain('/* custom */ body { color: red; }');
    expect(css.indexOf(EXPORT_BASE_CSS)).toBeLessThan(css.indexOf('/* custom */'));
  });

  it('空附加 CSS 不产生多余分隔', () => {
    expect(buildExportCss()).toBe(buildExportCss(''));
  });
});
