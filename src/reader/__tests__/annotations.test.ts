/**
 * 标注数据模型与序列化往返测试（ebook-reader T6 / R4）。
 * 覆盖各格式定位器、损坏 JSON 视为空、版本化结构。
 */
import { describe, expect, it } from 'vitest';

import {
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
} from '../annotations.js';

const sample: Annotation[] = [
  {
    id: 'h1',
    kind: 'highlight',
    locator: { format: 'flow', chapter: 0, domPath: 'p#x', start: 10, end: 20 },
    quote: '原文片段',
    createdAt: 1700000000000,
  },
  {
    id: 'b1',
    kind: 'bookmark',
    locator: { format: 'pdf', page: 5, quote: '页脚' },
    createdAt: 1700000000001,
  },
  {
    id: 'n1',
    kind: 'note',
    locator: { format: 'text', start: 100, end: 150 },
    note: '一段笔记',
    createdAt: 1700000000002,
  },
  {
    id: 'c1',
    kind: 'bookmark',
    locator: { format: 'cbz', page: 12 },
    createdAt: 1700000000003,
  },
];

describe('serialize/parse 往返', () => {
  it('序列化后解析等价（各格式定位器保留）', () => {
    const back = parseAnnotations(serializeAnnotations(sample));
    expect(back).toHaveLength(sample.length);
    expect(back.map((a) => a.id)).toEqual(['h1', 'b1', 'n1', 'c1']);
    expect(back[0]!.locator).toEqual({ format: 'flow', chapter: 0, domPath: 'p#x', start: 10, end: 20 });
    expect(back[1]!.locator).toEqual({ format: 'pdf', page: 5, quote: '页脚' });
    expect(back[2]!.locator).toEqual({ format: 'text', start: 100, end: 150 });
    expect(back[3]!.locator).toEqual({ format: 'cbz', page: 12 });
    expect(back[0]!.quote).toBe('原文片段');
    expect(back[2]!.note).toBe('一段笔记');
  });

  it('标注 id/kind/createdAt 保留', () => {
    const back = parseAnnotations(serializeAnnotations(sample));
    expect(back[0]).toMatchObject({ id: 'h1', kind: 'highlight', createdAt: 1700000000000 });
  });
});

describe('parseAnnotations 损坏/空处理', () => {
  it('空串返回空数组', () => {
    expect(parseAnnotations('')).toEqual([]);
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseAnnotations('{not json')).toEqual([]);
    expect(parseAnnotations('null')).toEqual([]);
  });

  it('annotations 非数组返回空数组', () => {
    expect(parseAnnotations(JSON.stringify({ version: 1, annotations: 'nope' }))).toEqual([]);
  });

  it('过滤掉结构不合规的条目，保留合规的', () => {
    const mixed = {
      version: 1,
      annotations: [
        sample[0],
        { id: 'bad', kind: 'highlight' }, // 缺 locator/createdAt
        { id: 'bad2', kind: 'unknown', locator: { format: 'flow', chapter: 0, domPath: '', start: 0, end: 0 }, createdAt: 1 },
        sample[1],
      ],
    };
    const back = parseAnnotations(JSON.stringify(mixed));
    expect(back.map((a) => a.id)).toEqual(['h1', 'b1']);
  });
});
