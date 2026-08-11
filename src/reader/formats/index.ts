/**
 * 流式格式调度（ebook-reader T4）。
 *
 * 按扩展名分发到对应解析器。各解析器经动态 import 懒加载（EPUB 的 jszip 在
 * epub.ts 内动态引入），首屏 bundle 不含格式解析实现。
 */

import { parseEpub } from './epub.js';
import { parseFb2 } from './fb2.js';
import { parseMobi } from './mobi.js';
import { parseTxt } from './txt.js';
import { ParseError, type ReaderContent } from './types.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';

/** 取路径的小写扩展名（无扩展名/末尾点为 ''）。 */
function extOfPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 按文件扩展名解析字节为章节化阅读内容。
 * epub/txt/fb2 同步或异步解析；azw3 复用 mobi 解析（best-effort，仅无 DRM）。
 * 不支持的扩展名抛 ParseError。
 */
export async function parseReaderContent(
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ReaderContent> {
  throwIfReaderLoadCancelled(signal);
  const ext = extOfPath(path);
  let content: ReaderContent;
  switch (ext) {
    case 'txt':
      content = parseTxt(bytes);
      break;
    case 'fb2':
      content = parseFb2(bytes);
      break;
    case 'epub':
      content = await parseEpub(bytes, signal);
      break;
    case 'mobi':
    case 'azw3':
      content = parseMobi(bytes);
      break;
    default:
      throw new ParseError(`暂不支持的阅读格式：.${ext || '?'}`);
  }
  throwIfReaderLoadCancelled(signal);
  return content;
}
