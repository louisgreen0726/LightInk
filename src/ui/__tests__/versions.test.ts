/**
 * 版本历史纯逻辑测试（R13）：newestFirst 按 created_at_ms 降序。
 * 弹层 DOM 行为不在此覆盖（与其它视图惯例一致）。
 */

import { describe, expect, it } from 'vitest';

import { newestFirst, type VersionMeta } from '../versions.js';

function meta(id: string, ms: number): VersionMeta {
  return { id, created_at_ms: ms };
}

describe('newestFirst', () => {
  it('按 created_at_ms 降序（最新在前）', () => {
    const sorted = newestFirst([meta('1', 100), meta('3', 300), meta('2', 200)]);
    expect(sorted.map((m) => m.id)).toEqual(['3', '2', '1']);
  });

  it('不修改原数组', () => {
    const orig = [meta('1', 100), meta('2', 200)];
    newestFirst(orig);
    expect(orig.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('空数组返回空', () => {
    expect(newestFirst([])).toEqual([]);
  });

  it('相同时间戳保持稳定（不交换）', () => {
    const sorted = newestFirst([meta('a', 500), meta('b', 500)]);
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
