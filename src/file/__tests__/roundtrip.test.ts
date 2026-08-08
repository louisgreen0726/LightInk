/**
 * roundtrip 流程编排测试：打开/保存/另存为的成功、取消与失败分支。
 * 全部依赖通过 RoundtripDeps 注入 fake，不触达真实 Tauri IPC/对话框。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openFileFlow,
  openPathFlow,
  saveAsFlow,
  saveToPathFlow,
  type RoundtripDeps,
} from '../roundtrip.js';

function makeDeps(overrides: Partial<RoundtripDeps> = {}) {
  const deps: RoundtripDeps = {
    readFile: vi.fn(async () => '磁盘内容'),
    writeFile: vi.fn(async () => undefined),
    clearSnapshot: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => null),
    showSaveDialog: vi.fn(async () => null),
    reportError: vi.fn(),
    ...overrides,
  };
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openFileFlow', () => {
  it('用户取消对话框返回 null', async () => {
    const deps = makeDeps();
    await expect(openFileFlow(deps)).resolves.toBeNull();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('选中文件后读取内容返回', async () => {
    const deps = makeDeps({
      showOpenDialog: vi.fn(async () => 'C:\\docs\\笔记.md'),
      readFile: vi.fn(async () => '# 中文内容 🚀'),
    });
    const result = await openFileFlow(deps);
    expect(result).toEqual({ path: 'C:\\docs\\笔记.md', content: '# 中文内容 🚀' });
  });

  it('读取失败上报错误并返回 null', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => {
        throw '无法读取文件';
      }),
    });
    await expect(openPathFlow(deps, 'C:\\bad.md')).resolves.toBeNull();
    expect(deps.reportError).toHaveBeenCalledOnce();
  });
});

describe('saveToPathFlow', () => {
  it('保存成功后清除对应崩溃快照', async () => {
    const deps = makeDeps();
    await expect(saveToPathFlow(deps, 'C:\\a.md', '新内容')).resolves.toBe(true);
    expect(deps.writeFile).toHaveBeenCalledWith('C:\\a.md', '新内容');
    expect(deps.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });

  it('写入失败返回 false、上报错误且不清快照（保持脏标记语义）', async () => {
    const deps = makeDeps({
      writeFile: vi.fn(async () => {
        throw '磁盘满';
      }),
    });
    await expect(saveToPathFlow(deps, 'C:\\a.md', 'x')).resolves.toBe(false);
    expect(deps.clearSnapshot).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledOnce();
  });

  it('清快照失败不阻断保存成功语义', async () => {
    const deps = makeDeps({
      clearSnapshot: vi.fn(async () => {
        throw '快照删除失败';
      }),
    });
    await expect(saveToPathFlow(deps, 'C:\\a.md', 'x')).resolves.toBe(true);
  });
});

describe('saveAsFlow', () => {
  it('取消对话框返回 null 且不写文件', async () => {
    const deps = makeDeps();
    await expect(saveAsFlow(deps, '内容')).resolves.toBeNull();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('选定新路径后写入并返回路径', async () => {
    const deps = makeDeps({
      showSaveDialog: vi.fn(async () => 'D:\\新文件.md'),
    });
    await expect(saveAsFlow(deps, '另存内容')).resolves.toBe('D:\\新文件.md');
    expect(deps.writeFile).toHaveBeenCalledWith('D:\\新文件.md', '另存内容');
    expect(deps.clearSnapshot).toHaveBeenCalledWith('D:\\新文件.md');
  });

  it('写入失败返回 null', async () => {
    const deps = makeDeps({
      showSaveDialog: vi.fn(async () => 'D:\\x.md'),
      writeFile: vi.fn(async () => {
        throw '只读';
      }),
    });
    await expect(saveAsFlow(deps, '内容')).resolves.toBeNull();
  });
});
