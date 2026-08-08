/**
 * `clipboard` — 从剪贴板事件中提取图片字节（T4，R16 加固）。
 *
 * 截图/复制的图片在 ClipboardEvent 里通常表现为 `clipboardData.items` 中
 * `kind === 'file'` 且 `type` 以 `image/` 开头的条目。但不同 WebView
 * （WebView2/WKWebView/WebKitGTK）形状不一：部分截图项 `type` 为空需经
 * `getAsFile()` 解析；部分仅填充 `files` 而 `items` 缺失。R16 加固：
 *   - [`clipboardHasImage`] 同时检查 items（含空 MIME 经 getAsFile 兜底）与 files；
 *   - [`extractClipboardImage`] 同上多形状兜底，确保截图 Ctrl+V 不再静默失效。
 *
 * 提取逻辑只依赖结构化接口，vitest 可用合成事件形状单测（真实 OS 剪贴板
 * 无法头less 测试）。
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

/** File 的最小结构化形状（与 DOM File 的子集）。 */
interface FileLike {
  readonly type: string;
  readonly name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/** DataTransferItem 的最小结构化形状。 */
interface ItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile(): FileLike | null;
}

/** 读取 item/file 解析出的图片 MIME；非图片返回 ''。 */
function imageMimeOfType(itemType: string, file: FileLike | null): string {
  if (itemType.startsWith('image/')) return itemType;
  // 某些 WebView 截图项 type 为空，需经文件 type 判定。
  if (itemType === '' && file !== null && file.type.startsWith('image/')) return file.type;
  return '';
}

/**
 * 同步探测事件是否携带图片 —— ProseMirror 的 handlePaste/handleDrop
 * 需要同步决定是否拦截，故探测（同步）与读取字节（异步）分离。
 * 覆盖三种 WebView 形状：items 含 image 条目 / items 含空 MIME 文件条目
 * （经 getAsFile 兜底）/ 仅 files 填充。
 */
export function clipboardHasImage(event: ClipboardEvent): boolean {
  const dt = event.clipboardData;
  if (dt === null || dt === undefined) {
    return false;
  }
  const items = dt.items as unknown as ItemLike[] | undefined;
  if (items !== undefined && items !== null) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item !== undefined && item.kind === 'file') {
        // 仅当 MIME 缺失时才同步取文件判定（某些 WebView 截图项 type 为空）。
        const file = item.type === '' ? item.getAsFile() : null;
        if (imageMimeOfType(item.type, file) !== '') {
          return true;
        }
      }
    }
  }
  // 兜底：某些 WebView 仅填充 files。
  const files = dt.files as unknown as FileLike[] | undefined;
  if (files !== undefined && files !== null) {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (file !== undefined && file.type.startsWith('image/')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 异步读取剪贴板里的第一张图片字节（多形状兜底，见 [`clipboardHasImage`]）。
 * 无图片/条目无法取文件/空字节时返回 null。MIME 不在已知映射时退化扩展名 png。
 */
export async function extractClipboardImage(
  event: ClipboardEvent,
): Promise<ExtractedImage | null> {
  const dt = event.clipboardData;
  if (dt === null || dt === undefined) {
    return null;
  }
  const items = dt.items as unknown as ItemLike[] | undefined;
  if (items !== undefined && items !== null) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined || item.kind !== 'file') {
        continue;
      }
      const file = item.getAsFile();
      if (file === null) {
        continue;
      }
      const mime = imageMimeOfType(item.type, file);
      if (mime === '') {
        continue;
      }
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength === 0) {
        continue;
      }
      return { bytes, ext: extFromMime(mime) ?? 'png', mime, alt: '' };
    }
  }
  // 兜底：仅 files 填充的 WebView 形状。
  const files = dt.files as unknown as FileLike[] | undefined;
  if (files !== undefined && files !== null) {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (file === undefined || !file.type.startsWith('image/')) {
        continue;
      }
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength === 0) {
        continue;
      }
      return { bytes, ext: extFromMime(file.type) ?? 'png', mime: file.type, alt: '' };
    }
  }
  return null;
}
