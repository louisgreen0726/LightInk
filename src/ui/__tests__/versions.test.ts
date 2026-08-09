/**
 * 版本历史纯逻辑测试（R13）：newestFirst 按 created_at_ms 降序。
 * 弹层 DOM 行为不在此覆盖（与其它视图惯例一致）。
 */

import { describe, expect, it } from 'vitest';

import { newestFirst, formatRelativeTime, type VersionMeta } from '../versions.js';

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

describe('formatRelativeTime（VS Code 时间线风格）', () => {
  const NOW = 1_000_000_000_000;

  it('<1 分钟为「刚刚」', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime(NOW, NOW)).toBe('刚刚');
  });

  it('<1 小时为「N 分钟前」', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1 分钟前');
    expect(formatRelativeTime(NOW - 45 * 60_000, NOW)).toBe('45 分钟前');
  });

  it('<24 小时为「N 小时前」', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1 小时前');
    expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23 小时前');
  });

  it('<7 天为「N 天前」', () => {
    expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1 天前');
    expect(formatRelativeTime(NOW - 6 * 86_400_000, NOW)).toBe('6 天前');
  });

  it('更早或未来时间返回空串（调用方回落绝对时间）', () => {
    expect(formatRelativeTime(NOW - 7 * 86_400_000, NOW)).toBe('');
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('');
  });
});
