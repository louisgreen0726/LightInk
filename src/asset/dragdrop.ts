/**
 * `dragdrop` — 从拖拽事件中提取图片文件字节（T4）。
 *
 * 拖入编辑器的本地文件在 `dataTransfer.files` 里；只接受 `image/*`。
 * 提取逻辑只依赖结构化接口，vitest 可用合成 DataTransfer 形状单测
 * （真实 OS 拖拽无法头less 测试）。
 */

import { extFromFileName, extFromMime, fileNameStem } from './asset-service.js';
import type { ExtractedImage } from './clipboard.js';

/** 同步探测拖拽事件是否携带图片文件（handleDrop 需同步决定拦截）。 */
export function dropHasImage(event: DragEvent): boolean {
  const files = event.dataTransfer?.files;
  if (files === undefined || files === null) {
    return false;
  }
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file !== undefined && file.type.startsWith('image/')) {
      return true;
    }
  }
  return false;
}

/**
 * 异步读取拖拽事件里的全部图片文件（保持原顺序）。非图片与空字节
 * 文件被跳过。扩展名优先取 MIME，缺失时从文件名推断；alt 默认为
 * 文件名主干。
 */
export async function extractDroppedImages(event: DragEvent): Promise<ExtractedImage[]> {
  const files = event.dataTransfer?.files;
  if (files === undefined || files === null) {
    return [];
  }
  const out: ExtractedImage[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file === undefined || !file.type.startsWith('image/')) {
      continue;
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) {
      continue;
    }
    out.push({
      bytes,
      ext: extFromMime(file.type) ?? extFromFileName(file.name) ?? 'png',
      mime: file.type,
      alt: fileNameStem(file.name),
    });
  }
  return out;
}
