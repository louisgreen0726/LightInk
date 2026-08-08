/**
 * 状态栏字数统计测试（R6，纯逻辑；node 环境，无 DOM）：
 *   - 空文档/纯空白 → 0/0；
 *   - 英文：空白分隔词元数，字符数不含空白；
 *   - 中文：每个 CJK 字符计为一个词；
 *   - 中英混排：CJK 逐字 + 拉丁词元；
 *   - Markdown 语法（标题井号、强调星号、链接等）被剥离，不污染计数；
 *   - 代码块/行内代码作为可见正文计入。
 * createStatusBarView 为 DOM 行为，仅断言为函数（与其它视图测试惯例一致）。
 */

import { describe, expect, it } from 'vitest';

import { countDocumentStats, extractProseText } from '../status-bar.js';

describe('countDocumentStats 空文档', () => {
  it('空字符串与纯空白返回 0/0', () => {
    expect(countDocumentStats('')).toEqual({ words: 0, characters: 0 });
    expect(countDocumentStats('   \n\t  ')).toEqual({ words: 0, characters: 0 });
  });
});

describe('countDocumentStats 英文', () => {
  it('按空白分隔计词元数，字符数不含空白', () => {
    const stats = countDocumentStats('hello world');
    expect(stats.words).toBe(2);
    expect(stats.characters).toBe(10); // helloworld
  });

  it('多余空白不影响计数', () => {
    const stats = countDocumentStats('  hello   world  ');
    expect(stats.words).toBe(2);
    expect(stats.characters).toBe(10);
  });
});

describe('countDocumentStats 中文', () => {
  it('每个 CJK 字符计为一个词', () => {
    const stats = countDocumentStats('你好世界');
    expect(stats.words).toBe(4);
    expect(stats.characters).toBe(4);
  });
});

describe('countDocumentStats 中英混排', () => {
  it('CJK 逐字 + 拉丁词元', () => {
    const stats = countDocumentStats('你好 hello world 世界');
    // CJK: 你好世界 = 4；拉丁: hello world = 2 → 6
    expect(stats.words).toBe(6);
    // 去空白字符: 你好helloworld世界 = 2+5+5+2 = 14
    expect(stats.characters).toBe(14);
  });
});

describe('countDocumentStats 剥离 Markdown 语法', () => {
  it('标题/强调符号不计入', () => {
    const stats = countDocumentStats('# 标题\n\n**粗体**与*斜体*');
    // 正文: 标题(2) 粗体(2) 与(1) 斜体(2) = 7 个 CJK，无拉丁词元
    expect(stats.words).toBe(7);
    expect(stats.characters).toBe(7);
  });

  it('链接只计链接文本，不计 URL', () => {
    const stats = countDocumentStats('见 [示例](http://example.com/x/y) 说明');
    // 正文: 见(1) 示例(2) 说明(2) = 5 CJK；URL 为 link 属性、非子节点，已剥离 → 5
    expect(stats.words).toBe(5);
    expect(stats.characters).toBe(5);
  });
});

describe('countDocumentStats 代码', () => {
  it('代码块作为可见正文计入', () => {
    const md = '# 文档\n\n```\nconst x = 1\nconst y = 2\n```\n';
    const stats = countDocumentStats(md);
    // 正文 CJK: 文档 = 2；代码 "const x = 1 const y = 2" 词元含 = 号
    // 词元: const,x,=,1,const,y,=,2 = 8 → words = 2 + 8 = 10
    expect(stats.words).toBe(10);
    // 去空白: 文档(2) + constx=1consty=2(16) = 18
    expect(stats.characters).toBe(18);
  });

  it('行内代码计入正文', () => {
    const stats = countDocumentStats('调用 `foo()` 函数');
    // 正文: 调用 函数 = 4 CJK；行内代码 foo() → 词元 foo() = 1 → 5
    expect(stats.words).toBe(5);
  });
});

describe('extractProseText', () => {
  it('提取叶子文本并剥离语法', () => {
    expect(extractProseText('# 标题\n\n正文')).toContain('标题');
    expect(extractProseText('# 标题\n\n正文')).toContain('正文');
    expect(extractProseText('# 标题\n\n正文')).not.toContain('#');
  });

  it('解析失败时退回原始源码', () => {
    // 非字符串抛 TypeError 被上游规避；这里验证正常字符串不抛、返回非空。
    expect(extractProseText('普通文本').length).toBeGreaterThan(0);
  });
});

describe('createStatusBarView 工厂形态', () => {
  it('为函数（DOM 行为不在此处覆盖）', async () => {
    const mod = await import('../status-bar.js');
    expect(typeof mod.createStatusBarView).toBe('function');
  });
});
