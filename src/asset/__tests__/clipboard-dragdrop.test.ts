/**
 * clipboard / dragdrop 提取逻辑单测（node 环境，合成事件形状）。
 *
 * 真实 OS 剪贴板截图粘贴与文件拖拽无法头less 复现，这里以结构化 fake
 * 覆盖：条目过滤（kind/type）、空字节跳过、MIME→扩展名、alt 默认值。
 */

import { describe, expect, it } from 'vitest';

import { clipboardHasImage, extractClipboardImage } from '../clipboard.js';
import { dropHasImage, extractDroppedImages } from '../dragdrop.js';

interface FakeItem {
  kind: string;
  type: string;
  bytes?: number[] | null;
}

function fakeClipboardEvent(items: FakeItem[]): ClipboardEvent {
  return {
    clipboardData: {
      items: items.map((it) => {
        const bytes = it.bytes;
        return {
          kind: it.kind,
          type: it.type,
          getAsFile: () =>
            bytes === null || bytes === undefined
              ? null
              : { arrayBuffer: async () => new Uint8Array(bytes).buffer },
        };
      }),
    },
  } as unknown as ClipboardEvent;
}

interface FakeFile {
  name: string;
  type: string;
  bytes: number[];
}

function fakeDragEvent(files: FakeFile[]): DragEvent {
  return {
    dataTransfer: {
      files: files.map((f) => ({
        name: f.name,
        type: f.type,
        arrayBuffer: async () => new Uint8Array(f.bytes).buffer,
      })),
    },
    clientX: 10,
    clientY: 20,
  } as unknown as DragEvent;
}

describe('clipboard extraction', () => {
  it('detects and extracts a pasted screenshot (png)', async () => {
    const event = fakeClipboardEvent([
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    ]);
    expect(clipboardHasImage(event)).toBe(true);
    const image = await extractClipboardImage(event);
    expect(image).not.toBeNull();
    expect(image!.ext).toBe('png');
    expect(image!.alt).toBe('');
    expect(new Uint8Array(image!.bytes)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it('returns null / not-handled for text-only clipboard', async () => {
    const event = fakeClipboardEvent([{ kind: 'string', type: 'text/plain' }]);
    expect(clipboardHasImage(event)).toBe(false);
    expect(await extractClipboardImage(event)).toBeNull();
  });

  it('returns null when clipboardData is missing', async () => {
    const event = {} as ClipboardEvent;
    expect(clipboardHasImage(event)).toBe(false);
    expect(await extractClipboardImage(event)).toBeNull();
  });

  it('skips items whose file or bytes are unavailable', async () => {
    const event = fakeClipboardEvent([
      { kind: 'file', type: 'image/png', bytes: null },
      { kind: 'file', type: 'image/png', bytes: [] },
      { kind: 'file', type: 'image/jpeg', bytes: [1, 2, 3] },
    ]);
    const image = await extractClipboardImage(event);
    expect(image!.ext).toBe('jpg');
  });

  it('falls back to png ext for unknown image MIME', async () => {
    const event = fakeClipboardEvent([{ kind: 'file', type: 'image/x-weird', bytes: [1] }]);
    const image = await extractClipboardImage(event);
    expect(image!.ext).toBe('png');
  });
});

describe('drag-drop extraction', () => {
  it('extracts image files, filters non-images, keeps order', async () => {
    const event = fakeDragEvent([
      { name: 'notes.txt', type: 'text/plain', bytes: [65] },
      { name: '猫 猫.png', type: 'image/png', bytes: [1, 2] },
      { name: 'photo.jpg', type: 'image/jpeg', bytes: [3] },
    ]);
    expect(dropHasImage(event)).toBe(true);
    const images = await extractDroppedImages(event);
    expect(images).toHaveLength(2);
    expect(images[0]!.alt).toBe('猫 猫');
    expect(images[0]!.ext).toBe('png');
    expect(images[1]!.alt).toBe('photo');
    expect(images[1]!.ext).toBe('jpg');
  });

  it('detects nothing for non-image drops', async () => {
    const event = fakeDragEvent([{ name: 'a.md', type: 'text/markdown', bytes: [35] }]);
    expect(dropHasImage(event)).toBe(false);
    expect(await extractDroppedImages(event)).toEqual([]);
  });

  it('skips zero-byte files and infers ext from name when MIME unknown', async () => {
    const event = fakeDragEvent([
      { name: 'empty.webp', type: 'image/webp', bytes: [] },
      { name: 'icon.gif', type: 'image/x-unknown-gif', bytes: [71] },
    ]);
    const images = await extractDroppedImages(event);
    expect(images).toHaveLength(1);
    expect(images[0]!.ext).toBe('gif');
  });

  it('handles missing dataTransfer gracefully', async () => {
    const event = {} as DragEvent;
    expect(dropHasImage(event)).toBe(false);
    expect(await extractDroppedImages(event)).toEqual([]);
  });
});
