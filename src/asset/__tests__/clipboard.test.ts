/**
 * 剪贴板图片探测/提取加固测试（R16）：覆盖不同 WebView 的剪贴板形状——
 *   - items 含 image 条目（常规）；
 *   - items 含空 MIME 文件条目（WebView 截图常见，经 getAsFile 兜底）；
 *   - 仅 files 填充（items 缺失）；
 *   - 纯文本 / 空 → 无图。
 * 真实 OS 剪贴板无法头less 测试，仅测结构化提取逻辑。
 */

import { describe, expect, it } from 'vitest';

import { clipboardHasImage, extractClipboardImage } from '../clipboard.js';

interface FileLike {
  type: string;
  name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface ItemLike {
  kind: string;
  type: string;
  getAsFile(): FileLike | null;
}

function fileOf(type: string, bytes: number[], name = ''): FileLike {
  return { type, name, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

function eventOf(opts: { items?: ItemLike[]; files?: FileLike[] }): ClipboardEvent {
  return { clipboardData: { items: opts.items ?? [], files: opts.files ?? [] } } as unknown as ClipboardEvent;
}

function fileItem(mime: string, file: FileLike | null): ItemLike {
  return { kind: 'file', type: mime, getAsFile: () => file };
}

function stringItem(type: string): ItemLike {
  return { kind: 'string', type, getAsFile: () => null };
}

describe('clipboardHasImage', () => {
  it('items 含 image 条目', () => {
    expect(clipboardHasImage(eventOf({ items: [fileItem('image/png', fileOf('image/png', [1]))] }))).toBe(true);
  });

  it('items 含空 MIME 文件条目经 getAsFile 兜底判定', () => {
    expect(clipboardHasImage(eventOf({ items: [fileItem('', fileOf('image/png', [1]))] }))).toBe(true);
  });

  it('仅 files 填充（items 缺失）', () => {
    expect(clipboardHasImage(eventOf({ files: [fileOf('image/png', [1])] }))).toBe(true);
  });

  it('纯文本与空剪贴板无图', () => {
    expect(clipboardHasImage(eventOf({ items: [stringItem('text/plain')] }))).toBe(false);
    expect(clipboardHasImage(eventOf({}))).toBe(false);
  });

  it('文本 + 图片同存视为有图（图片优先）', () => {
    expect(
      clipboardHasImage(eventOf({ items: [stringItem('text/plain'), fileItem('image/png', fileOf('image/png', [1]))] })),
    ).toBe(true);
  });
});

describe('extractClipboardImage', () => {
  it('items image 条目提取字节/MIME/扩展名', async () => {
    const img = await extractClipboardImage(eventOf({ items: [fileItem('image/png', fileOf('image/png', [1, 2, 3]))] }));
    expect(img).not.toBeNull();
    expect(img!.ext).toBe('png');
    expect(img!.mime).toBe('image/png');
    expect(img!.bytes.byteLength).toBe(3);
  });

  it('空 MIME 条目经文件 type 提取', async () => {
    const img = await extractClipboardImage(eventOf({ items: [fileItem('', fileOf('image/jpeg', [9]))] }));
    expect(img).not.toBeNull();
    expect(img!.mime).toBe('image/jpeg');
    expect(img!.ext).toBe('jpg');
  });

  it('仅 files 填充时提取', async () => {
    const img = await extractClipboardImage(eventOf({ files: [fileOf('image/png', [4, 5])] }));
    expect(img).not.toBeNull();
    expect(img!.mime).toBe('image/png');
    expect(img!.bytes.byteLength).toBe(2);
  });

  it('跳过空字节条目，取下一张', async () => {
    const items = [fileItem('image/png', fileOf('image/png', [])), fileItem('image/png', fileOf('image/png', [1]))];
    const img = await extractClipboardImage(eventOf({ items }));
    expect(img).not.toBeNull();
    expect(img!.bytes.byteLength).toBe(1);
  });

  it('无图返回 null', async () => {
    expect(await extractClipboardImage(eventOf({ items: [stringItem('text/plain')] }))).toBeNull();
    expect(await extractClipboardImage(eventOf({}))).toBeNull();
  });
});
