/**
 * 链接分类纯逻辑测试（R14）：classifyLink 按 href + 当前文档目录分类。
 * 外链→external、相对/绝对 .md→localMd、其他本地→localFile、空/锚点→invalid。
 */

import { describe, expect, it } from 'vitest';

import { classifyLink, resolveLocalPath } from '../link-navigation.js';

describe('classifyLink external', () => {
  it('http(s) 与协议相对、其他 scheme 归 external', () => {
    expect(classifyLink('https://example.com/a/b', '/docs').kind).toBe('external');
    expect(classifyLink('http://x.org', '/docs').kind).toBe('external');
    expect(classifyLink('mailto:a@b.com', '/docs').kind).toBe('external');
    expect(classifyLink('//cdn.example.com/x', '/docs').kind).toBe('external');
  });

  it('external target 为原始 href', () => {
    expect(classifyLink('https://example.com', '/docs').target).toBe('https://example.com');
  });
});

describe('classifyLink localMd', () => {
  it('相对 .md 按当前文档目录解析', () => {
    const r = classifyLink('note.md', '/docs/sub');
    expect(r.kind).toBe('localMd');
    expect(r.target).toBe('/docs/sub/note.md');
  });

  it('绝对 .md 原样返回', () => {
    expect(classifyLink('/abs/note.md', '/docs').target).toBe('/abs/note.md');
    expect(classifyLink('C:\\abs\\note.md', '/docs').target).toBe('C:\\abs\\note.md');
  });

  it('剥锚点/查询后判定扩展名', () => {
    const r = classifyLink('note.md#section', '/docs');
    expect(r.kind).toBe('localMd');
    expect(r.target).toBe('/docs/note.md');
  });

  it('.markdown 扩展名亦归 localMd', () => {
    expect(classifyLink('a.markdown', '/docs').kind).toBe('localMd');
  });
});

describe('classifyLink localFile', () => {
  it('非 .md 本地文件归 localFile', () => {
    const r = classifyLink('image.png', '/docs');
    expect(r.kind).toBe('localFile');
    expect(r.target).toBe('/docs/image.png');
  });
});

describe('classifyLink invalid', () => {
  it('空与纯锚点归 invalid', () => {
    expect(classifyLink('', '/docs').kind).toBe('invalid');
    expect(classifyLink('   ', '/docs').kind).toBe('invalid');
    expect(classifyLink('#anchor', '/docs').kind).toBe('invalid');
  });
});

describe('resolveLocalPath', () => {
  it('无文档目录时相对原样返回', () => {
    expect(resolveLocalPath('note.md', '')).toBe('note.md');
  });

  it('Windows 盘符绝对路径原样返回', () => {
    expect(resolveLocalPath('D:\\files\\x.md', 'C:\\docs')).toBe('D:\\files\\x.md');
  });
});
