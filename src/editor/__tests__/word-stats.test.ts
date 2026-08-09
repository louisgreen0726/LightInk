/**
 * word-stats 口径回归测试（R3）：
 * 字数 = CJK 表意字符数 + 拉丁词数；字符数 = 非空白字符数。
 * 与 parser.ts 的 countWords（空白启发式、性能测试 proxy）口径互不影响。
 */

import { describe, expect, it } from 'vitest';

import { computeWordStats } from '../word-stats.js';

describe('computeWordStats（R3 CJK 感知口径）', () => {
  it('空串为 0/0', () => {
    expect(computeWordStats('')).toEqual({ words: 0, characters: 0 });
  });

  it('纯拉丁文本按词计数，字符数不含空白', () => {
    // hello(5) + world(5) = 10 个非空白字符；空格不计入。
    expect(computeWordStats('hello world')).toEqual({ words: 2, characters: 10 });
  });

  it('纯中文按表意字符逐字计数', () => {
    expect(computeWordStats('你好世界')).toEqual({ words: 4, characters: 4 });
  });

  it('中英混排：中文逐字 + 西文按词', () => {
    // 字数 = 2(你好) + 2(hello/world)；字符 = 2 + 5 + 5 = 12（空白不计）。
    expect(computeWordStats('你好 hello world')).toEqual({ words: 4, characters: 12 });
  });

  it('中文标点计入字符但不计入字数', () => {
    expect(computeWordStats('你好。')).toEqual({ words: 2, characters: 3 });
  });

  it('数字串算一个拉丁词；与中文相邻不粘连', () => {
    // 「2024」一词 + 「年」一字。
    expect(computeWordStats('2024年')).toEqual({ words: 2, characters: 5 });
  });

  it('词内撇号/连字符不拆词', () => {
    expect(computeWordStats("don't stop")).toEqual({ words: 2, characters: 9 });
    expect(computeWordStats('well-known')).toEqual({ words: 1, characters: 10 });
  });

  it('扩展 B 区表意字符（代理对）字数与字符各算 1', () => {
    const stats = computeWordStats('\u{20000}');
    expect(stats.words).toBe(1);
    expect(stats.characters).toBe(1);
  });

  it('换行与多余空白不影响字符数', () => {
    expect(computeWordStats('a\nb  c')).toEqual({ words: 3, characters: 3 });
  });

  it('Markdown 标记计入字符数（口径：非空白字符）', () => {
    // 「# 标题」：# 与 标题 均为非空白字符 → 3 字符；字数只算 标题 2 字。
    expect(computeWordStats('# 标题')).toEqual({ words: 2, characters: 3 });
  });
});
