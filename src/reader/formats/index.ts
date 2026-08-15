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
import { extOfPath } from '../../file/path-ext.js';

/**
 * 按文件扩展名解析字节为章节化阅读内容。
 * epub/txt/fb2 同步或异步解析；MOBI 仅支持明确检测过的 PalmDOC/MOBI6 子集。
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
      content = parseMobi(bytes);
      break;
    default:
      throw new ParseError(`暂不支持的阅读格式：.${ext || '?'}`);
  }
  throwIfReaderLoadCancelled(signal);
  return content;
}
