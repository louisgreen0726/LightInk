/**
 * html-to-markdown 转换层测试（R8）：纯 TS allowlist，覆盖常见可映射标签、
 * 任务列表、嵌套、表格、代码块、引用、实体、透明容器、丢弃标签、宽容降级。
 */
import { describe, expect, it } from 'vitest';

import { convertHtmlToMarkdown, decodeEntities } from '../html-to-markdown.js';

describe('convertHtmlToMarkdown（R8 allowlist）', () => {
  it('空/非串/垃圾输入返回空串不抛出', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
    expect(convertHtmlToMarkdown('   ')).toBe('');
    // 未闭合/错位标签不抛出，尽力降级。
    expect(() => convertHtmlToMarkdown('<div><p>oops</div>')).not.toThrow();
  });

  it('标题与段落', () => {
    expect(convertHtmlToMarkdown('<h1>大标题</h1><p>正文。</p>')).toBe('# 大标题\n\n正文。');
    expect(convertHtmlToMarkdown('<h3>三</h3>')).toBe('### 三');
  });

  it('行内格式：粗/斜/删除/行内代码/链接/图片', () => {
    expect(convertHtmlToMarkdown('<p><b>粗</b> <i>斜</i> <s>删</s> <code>码</code></p>')).toBe(
      '**粗** *斜* ~~删~~ `码`',
    );
    expect(convertHtmlToMarkdown('<a href="https://x.io">链接</a>')).toBe('[链接](https://x.io)');
    expect(convertHtmlToMarkdown('<img src="https://x.io/a.png" alt="图">')).toBe(
      '![图](https://x.io/a.png)',
    );
  });

  it('链接 javascript: 协议仅留文本；无 href 仅留文本', () => {
    expect(convertHtmlToMarkdown('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(convertHtmlToMarkdown('<a>无址</a>')).toBe('无址');
  });

  it('有序/无序列表', () => {
    expect(convertHtmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
    expect(convertHtmlToMarkdown('<ol><li>一</li><li>二</li></ol>')).toBe('1. 一\n2. 二');
  });

  it('任务列表（checkbox checked/unchecked）', () => {
    const md = convertHtmlToMarkdown(
      '<ul><li><input type="checkbox" checked>已完成</li><li><input type="checkbox">待办</li></ul>',
    );
    expect(md).toBe('- [x] 已完成\n- [ ] 待办');
  });

  it('嵌套列表缩进', () => {
    const md = convertHtmlToMarkdown(
      '<ul><li>顶层<ul><li>子项</li></ul></li></ul>',
    );
    expect(md).toBe('- 顶层\n  - 子项');
  });

  it('引用块（多段前缀 > ）', () => {
    const md = convertHtmlToMarkdown('<blockquote><p>第一段</p><p>第二段</p></blockquote>');
    expect(md).toBe('> 第一段\n>\n> 第二段');
  });

  it('代码块（pre>code，保留内部文本不转义）', () => {
    const md = convertHtmlToMarkdown('<pre><code>const x = 1;\nconst y = 2;</code></pre>');
    expect(md).toBe('```\nconst x = 1;\nconst y = 2;\n```');
  });

  it('表格（thead + tbody → GFM）', () => {
    const md = convertHtmlToMarkdown(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('分隔线与换行', () => {
    expect(convertHtmlToMarkdown('<hr>')).toBe('---');
    expect(convertHtmlToMarkdown('<p>行一<br>行二</p>')).toBe('行一\n行二');
  });

  it('实体解码（命名 + 十进制 + 十六进制）', () => {
    expect(decodeEntities('a &amp; b &lt; &gt; &#65; &#x42;')).toBe('a & b < > A B');
    expect(decodeEntities('中文')).toBe('中文');
  });

  it('透明容器放行子节点（div/body/span）', () => {
    expect(convertHtmlToMarkdown('<div><span>包裹</span> 文本</div>')).toBe('包裹 文本');
    expect(convertHtmlToMarkdown('<body><p>正文</p></body>')).toBe('正文');
  });

  it('script/style/head 内容整体丢弃', () => {
    expect(convertHtmlToMarkdown('<style>.x{}</style><p>正文</p>')).toBe('正文');
    expect(convertHtmlToMarkdown('<script>alert(1)</script><p>正文</p>')).toBe('正文');
    expect(convertHtmlToMarkdown('<head><title>t</title></head><body><p>正文</p></body>')).toBe(
      '正文',
    );
  });

  it('未知标签作为透明容器放行', () => {
    expect(convertHtmlToMarkdown('<custom><p>正文</p></custom>')).toBe('正文');
  });

  it('飞书式复合片段：标题+列表+链接+粗体', () => {
    const md = convertHtmlToMarkdown(
      '<h2>会议纪要</h2><ul><li><b>结论</b>：见 <a href="https://doc.example.com">文档</a></li><li>待办</li></ul>',
    );
    expect(md).toBe(
      '## 会议纪要\n\n- **结论**：见 [文档](https://doc.example.com)\n- 待办',
    );
  });

  it('表格内管道符转义', () => {
    const md = convertHtmlToMarkdown(
      '<table><tr><th>a|b</th></tr><tr><td>1</td></tr></table>',
    );
    expect(md).toContain('a\\|b');
  });

  it('代码块内连续空行原样保留（规整不穿透围栏）', () => {
    const md = convertHtmlToMarkdown(
      '<pre><code>fn a(){\n  x();\n\n\n\n  y();\n}</code></pre>',
    );
    expect(md).toBe('```\nfn a(){\n  x();\n\n\n\n  y();\n}\n```');
  });

  it('代码块行尾空白保留；块外多空行仍被压缩', () => {
    const md = convertHtmlToMarkdown(
      '<p>段一</p><pre><code>line one  \nline two</code></pre><p>段二</p>',
    );
    expect(md).toBe('段一\n\n```\nline one  \nline two\n```\n\n段二');
  });
});
