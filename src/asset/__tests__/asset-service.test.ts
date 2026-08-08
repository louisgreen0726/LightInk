/**
 * asset-service 单测（node 环境，@tauri-apps/api invoke 全部 mock）：
 *   - bytesToBase64 编码向量与分块；
 *   - MIME / 文件名 → 扩展名映射；
 *   - invoke 参数透传（docPath null ↔ 暂存语义）；
 *   - createAssetSaver 现读文档路径、失败向上传播。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

import {
  bytesToBase64,
  createAssetSaver,
  extFromFileName,
  extFromMime,
  fileNameStem,
  migrateStagingAssets,
  saveAsset,
} from '../asset-service.js';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe('bytesToBase64', () => {
  it('encodes known vectors', () => {
    expect(bytesToBase64(new TextEncoder().encode('Hello'))).toBe('SGVsbG8=');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
  });

  it('handles buffers larger than the chunk size', () => {
    const big = new Uint8Array(0x8000 * 3 + 17);
    for (let i = 0; i < big.length; i += 1) {
      big[i] = i % 251;
    }
    // 与 Rust 侧解码器共享的 RFC 4648 语义：长度对则分块无缝。
    const encoded = bytesToBase64(big);
    expect(encoded.length % 4).toBe(0);
    expect(encoded).toBe(
      btoa(String.fromCharCode(...big)), // 单次编码作对照（测试数据可控）
    );
  });
});

describe('extFromMime / extFromFileName / fileNameStem', () => {
  it('maps known image MIME types', () => {
    expect(extFromMime('image/png')).toBe('png');
    expect(extFromMime('IMAGE/JPEG')).toBe('jpg');
    expect(extFromMime('image/svg+xml')).toBe('svg');
    expect(extFromMime('text/plain')).toBeNull();
    expect(extFromMime('image/bmp')).toBeNull();
  });

  it('falls back to file name extension', () => {
    expect(extFromFileName('照片.JPG')).toBe('jpg');
    expect(extFromFileName('a/b/c.webp')).toBe('webp');
    expect(extFromFileName('no-ext')).toBeNull();
    expect(extFromFileName('evil.exe')).toBeNull();
  });

  it('strips extension for alt stems', () => {
    expect(fileNameStem('C:\\pics\\猫 猫.png')).toBe('猫 猫');
    expect(fileNameStem('archive.tar.gz')).toBe('archive.tar');
    expect(fileNameStem('noext')).toBe('noext');
  });
});

describe('invoke wrappers', () => {
  it('saveAsset passes docPath/sessionId/base64/ext through', async () => {
    invokeMock.mockResolvedValue('assets/img-x.png');
    const rel = await saveAsset('C:\\docs\\a.md', 'untitled-a1', 'QUJD', 'png');
    expect(rel).toBe('assets/img-x.png');
    expect(invokeMock).toHaveBeenCalledWith('save_asset', {
      docPath: 'C:\\docs\\a.md',
      sessionId: 'untitled-a1',
      bytesBase64: 'QUJD',
      ext: 'png',
    });
  });

  it('saveAsset with null docPath goes to staging', async () => {
    invokeMock.mockResolvedValue('assets/img-y.png');
    await saveAsset(null, 'untitled-b2', 'QUJD', 'png');
    expect(invokeMock).toHaveBeenCalledWith(
      'save_asset',
      expect.objectContaining({ docPath: null, sessionId: 'untitled-b2' }),
    );
  });

  it('saveAsset rejects on backend failure', async () => {
    invokeMock.mockRejectedValue('磁盘已满');
    await expect(saveAsset(null, 's', 'QUJD', 'png')).rejects.toBe('磁盘已满');
  });

  it('migrateStagingAssets passes session and doc path', async () => {
    invokeMock.mockResolvedValue(['assets/img-x.png']);
    const moved = await migrateStagingAssets('untitled-a1', 'C:\\docs\\a.md');
    expect(moved).toEqual(['assets/img-x.png']);
    expect(invokeMock).toHaveBeenCalledWith('migrate_staging_assets', {
      sessionId: 'untitled-a1',
      docPath: 'C:\\docs\\a.md',
    });
  });
});

describe('createAssetSaver', () => {
  it('reads the doc path at call time (post save-as goes to new doc)', async () => {
    let docPath: string | null = null;
    const save = vi.fn(async () => 'assets/ok.png');
    const saver = createAssetSaver({ saveAsset: save, getDocPath: () => docPath, sessionId: 's1' });

    await saver(new Uint8Array([65, 66, 67]).buffer, 'png');
    expect(save).toHaveBeenLastCalledWith(null, 's1', 'QUJD', 'png');

    docPath = 'D:\\notes\\新文档.md';
    await saver(new Uint8Array([65]).buffer, 'gif');
    expect(save).toHaveBeenLastCalledWith('D:\\notes\\新文档.md', 's1', 'QQ==', 'gif');
  });

  it('propagates saver rejection to the caller', async () => {
    const saver = createAssetSaver({
      saveAsset: vi.fn(async () => {
        throw new Error('落盘失败');
      }),
      getDocPath: () => null,
      sessionId: 's1',
    });
    await expect(saver(new Uint8Array([1]).buffer, 'png')).rejects.toThrow('落盘失败');
  });
});
