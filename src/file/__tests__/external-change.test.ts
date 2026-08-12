/**
 * `external-change` 纯逻辑测试：元数据与内容指纹判定。
 * TabManager 集成（保存前闸门 / 轮询分派）见 tabs/__tests__/tab-manager.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { hasFileStatChanged } from '../external-change.js';
import type { FileStat } from '../file-service.js';

const st = (mtime_ms: number, size: number, fingerprint = 'aaaaaaaaaaaaaaaa'): FileStat => ({
  mtime_ms,
  size,
  fingerprint,
});

describe('hasFileStatChanged', () => {
  it('基线为 null 时不判变更（未保存过 / stat 失败不检测）', () => {
    expect(hasFileStatChanged(null, st(9_999_999, 100))).toBe(false);
  });

  it('磁盘 mtime 严格更新 → 变更', () => {
    expect(hasFileStatChanged(st(1000, 10), st(1001, 10))).toBe(true);
    expect(hasFileStatChanged(st(1000, 10), st(5000, 10))).toBe(true);
  });

  it('磁盘 mtime 回退仍视为变更', () => {
    expect(hasFileStatChanged(st(2000, 10), st(1000, 10))).toBe(true);
  });

  it('mtime 相同且 size 相同 → 未变更', () => {
    expect(hasFileStatChanged(st(1000, 10), st(1000, 10))).toBe(false);
  });

  it('mtime 相同但 size 不同 → 变更（粗粒度 mtime 文件系统兜底）', () => {
    expect(hasFileStatChanged(st(1000, 10), st(1000, 11))).toBe(true);
    expect(hasFileStatChanged(st(1000, 10), st(1000, 9))).toBe(true);
  });

  it('mtime 和 size 相同但指纹变化仍视为变更', () => {
    expect(
      hasFileStatChanged(
        st(1000, 10, 'aaaaaaaaaaaaaaaa'),
        st(1000, 10, 'bbbbbbbbbbbbbbbb'),
      ),
    ).toBe(true);
  });
});
