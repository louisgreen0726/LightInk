/**
 * `clipboard` — 从剪贴板事件中提取图片字节（T4）。
 *
 * 截图/复制的图片在 ClipboardEvent 里表现为 `clipboardData.items` 中
 * `kind === 'file'` 且 `type` 以 `image/` 开头的条目。提取逻辑只依赖
 * 结构化接口，vitest 可用合成事件形状单测（真实 OS 剪贴板无法头less
 * 测试）。
 */

import { extFromMime } from './asset-service.js';

/** 从事件提取到的一张图片。 */
export interface ExtractedImage {
  readonly bytes: ArrayBuffer;
  readonly ext: string;
  readonly mime: string;
  /** alt 默认值（拖入本地文件时为文件名主干；剪贴板图为空串）。 */
  readonly alt: string;
}

/**
 * 同步探测事件是否携带图片 —— ProseMirror 的 handlePaste/handleDrop
 * 需要同步决定是否拦截，故探测（同步）与读取字节（异步）分离。
 */
export function clipboardHasImage(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (items === undefined || items === null) {
    return false;
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item !== undefined && item.kind === 'file' && item.type.startsWith('image/')) {
      return true;
    }
  }
  return false;
}

/**
 * 异步读取剪贴板里的第一张图片字节。无图片/条目无法取文件/空字节
 * 时返回 null。MIME 不在已知映射时退化扩展名为 png。
 */
export async function extractClipboardImage(
  event: ClipboardEvent,
): Promise<ExtractedImage | null> {
  const items = event.clipboardData?.items;
  if (items === undefined || items === null) {
    return null;
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined || item.kind !== 'file' || !item.type.startsWith('image/')) {
      continue;
    }
    const file = item.getAsFile();
    if (file === null) {
      continue;
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) {
      continue;
    }
    return {
      bytes,
      ext: extFromMime(item.type) ?? 'png',
      mime: item.type,
      alt: '',
    };
  }
  return null;
}
