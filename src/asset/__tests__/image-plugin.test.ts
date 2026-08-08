/**
 * 编辑器图片插入流程单测（node 环境，最小 ProseMirror schema + 假 view）。
 *
 * 覆盖 R3 关键行为：
 *   - 粘贴图片落盘成功 → image 节点以相对路径插入文档；
 *   - 落盘失败 → onError 上报且文档不插入任何引用；
 *   - 拖拽多张图 → 全部落盘并按序插入，单张失败不阻断其余。
 *
 * 放在 src/asset/__tests__/ 是因为 T4 的测试文件 scope 限定于此；被测
 * 对象是 src/editor/plugins/image.ts 的纯流程函数。
 */

import { describe, expect, it, vi } from 'vitest';

import { Schema } from '@milkdown/prose/model';
import { EditorState, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import {
  insertImageAt,
  processImageDrop,
  processImagePaste,
  type ImageAssetDeps,
} from '../../editor/plugins/image.js';

/** 含 image 节点的最小 schema（与 commonmark 的 image 节点同形）。 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' } },
    },
    text: {},
  },
});

interface FakeView {
  view: EditorView;
  dispatched: Transaction[];
}

function makeFakeView(posAtCoords?: { pos: number } | null): FakeView {
  const state = EditorState.create({ schema });
  const dispatched: Transaction[] = [];
  const view = {
    state,
    dispatch: (tr: Transaction) => {
      dispatched.push(tr);
    },
    posAtCoords: () => posAtCoords ?? null,
  } as unknown as EditorView;
  return { view, dispatched };
}

function imageUrlsOf(tr: Transaction): string[] {
  const urls: string[] = [];
  tr.doc.descendants((node) => {
    if (node.type.name === 'image') {
      urls.push(String(node.attrs['src']));
    }
    return true;
  });
  return urls;
}

function fakePasteEvent(bytes: number[]): ClipboardEvent {
  return {
    clipboardData: {
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer }),
        },
      ],
    },
  } as unknown as ClipboardEvent;
}

function fakeDropEvent(files: Array<{ name: string; bytes: number[] }>): DragEvent {
  return {
    dataTransfer: {
      files: files.map((f) => ({
        name: f.name,
        type: 'image/png',
        arrayBuffer: async () => new Uint8Array(f.bytes).buffer,
      })),
    },
    clientX: 5,
    clientY: 5,
  } as unknown as DragEvent;
}

describe('insertImageAt', () => {
  it('inserts an image node with relative src', () => {
    const { view, dispatched } = makeFakeView();
    expect(insertImageAt(view, null, 'assets/img-1.png', '')).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(imageUrlsOf(dispatched[0]!)).toEqual(['assets/img-1.png']);
  });
});

describe('processImagePaste', () => {
  it('saves then inserts the returned relative path', async () => {
    const { view, dispatched } = makeFakeView();
    const deps: ImageAssetDeps = {
      saver: vi.fn(async () => 'assets/img-ok.png'),
      onError: vi.fn(),
    };
    const inserted = await processImagePaste(view, fakePasteEvent([1, 2, 3]), deps);
    expect(inserted).toBe(true);
    expect(deps.saver).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'png');
    expect(imageUrlsOf(dispatched[0]!)).toEqual(['assets/img-ok.png']);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('save failure reports error and inserts nothing (outcome 3)', async () => {
    const { view, dispatched } = makeFakeView();
    const deps: ImageAssetDeps = {
      saver: vi.fn(async () => {
        throw new Error('磁盘已满');
      }),
      onError: vi.fn(),
    };
    const inserted = await processImagePaste(view, fakePasteEvent([1]), deps);
    expect(inserted).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(deps.onError).toHaveBeenCalledWith(
      '图片保存失败，未插入引用',
      expect.any(Error),
    );
  });

  it('non-image paste is a no-op', async () => {
    const { view, dispatched } = makeFakeView();
    const deps: ImageAssetDeps = { saver: vi.fn(), onError: vi.fn() };
    const event = {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
    } as unknown as ClipboardEvent;
    expect(await processImagePaste(view, event, deps)).toBe(false);
    expect(deps.saver).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });
});

describe('processImageDrop', () => {
  it('saves and inserts every dropped image in order', async () => {
    const { view, dispatched } = makeFakeView({ pos: 1 });
    let n = 0;
    const deps: ImageAssetDeps = {
      saver: vi.fn(async () => {
        n += 1;
        return `assets/img-${n}.png`;
      }),
      onError: vi.fn(),
    };
    const event = fakeDropEvent([
      { name: 'a.png', bytes: [1] },
      { name: 'b.png', bytes: [2] },
    ]);
    expect(await processImageDrop(view, event, deps)).toBe(2);
    expect(dispatched).toHaveLength(2);
    expect(imageUrlsOf(dispatched[0]!)).toEqual(['assets/img-1.png']);
    expect(imageUrlsOf(dispatched[1]!)).toEqual(['assets/img-2.png']);
  });

  it('a failed image is skipped without blocking the rest', async () => {
    const { view, dispatched } = makeFakeView({ pos: 1 });
    let n = 0;
    const deps: ImageAssetDeps = {
      saver: vi.fn(async () => {
        n += 1;
        if (n === 1) {
          throw new Error('写入失败');
        }
        return 'assets/img-good.png';
      }),
      onError: vi.fn(),
    };
    const event = fakeDropEvent([
      { name: 'bad.png', bytes: [1] },
      { name: 'good.png', bytes: [2] },
    ]);
    expect(await processImageDrop(view, event, deps)).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(imageUrlsOf(dispatched[0]!)).toEqual(['assets/img-good.png']);
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });
});
