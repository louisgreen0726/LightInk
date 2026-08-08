/**
 * file-service 的 invoke 封装测试：验证命令名、参数名与返回值透传。
 * Tauri IPC 在无窗口环境下不可用，因此 mock @tauri-apps/api/core。
 */

import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSnapshot,
  readFile,
  readStaleSnapshot,
  writeFile,
  writeSnapshot,
} from '../file-service.js';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe('file-service', () => {
  it('readFile 调用 read_file 并透传内容', async () => {
    invokeMock.mockResolvedValue('# 你好\n');
    await expect(readFile('C:\\docs\\笔记.md')).resolves.toBe('# 你好\n');
    expect(invokeMock).toHaveBeenCalledWith('read_file', {
      path: 'C:\\docs\\笔记.md',
    });
  });

  it('writeFile 调用 write_file，参数名为 path/content', async () => {
    invokeMock.mockResolvedValue(undefined);
    await writeFile('C:\\docs\\a.md', '内容 🚀');
    expect(invokeMock).toHaveBeenCalledWith('write_file', {
      path: 'C:\\docs\\a.md',
      content: '内容 🚀',
    });
  });

  it('writeFile 失败时 reject Rust 侧错误信息', async () => {
    invokeMock.mockRejectedValue('无法保存到 C:\\a.md: 拒绝访问');
    await expect(writeFile('C:\\a.md', 'x')).rejects.toBe(
      '无法保存到 C:\\a.md: 拒绝访问',
    );
  });

  it('writeSnapshot/clearSnapshot 使用 filePath 参数名', async () => {
    invokeMock.mockResolvedValue(undefined);
    await writeSnapshot('untitled-1', '草稿');
    expect(invokeMock).toHaveBeenCalledWith('write_snapshot', {
      filePath: 'untitled-1',
      content: '草稿',
    });
    await clearSnapshot('C:\\docs\\a.md');
    expect(invokeMock).toHaveBeenCalledWith('clear_snapshot', {
      filePath: 'C:\\docs\\a.md',
    });
  });

  it('readStaleSnapshot 透传可空结果', async () => {
    invokeMock.mockResolvedValue('快照内容');
    await expect(readStaleSnapshot('C:\\a.md')).resolves.toBe('快照内容');
    expect(invokeMock).toHaveBeenCalledWith('read_stale_snapshot', {
      filePath: 'C:\\a.md',
    });
    invokeMock.mockResolvedValue(null);
    await expect(readStaleSnapshot('C:\\a.md')).resolves.toBeNull();
  });
});
