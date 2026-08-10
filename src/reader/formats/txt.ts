/**
 * `txt` — 纯文本解析（ebook-reader T4）。
 *
 * 字节经 UTF-8 解码；出现替换字符 U+FFFD（非 UTF-8）时回退 GBK，仍失败则按
 * UTF-8 原样显示（best effort）。文本按空行分段为 <p>，逐段 HTML 转义。
 * 纯逻辑、无 DOM 依赖，node 可测。
 */

import type { ReaderContent } from './types.js';

function decodeText(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes);
}

function includesReplacement(s: string): boolean {
  return s.includes('�');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 把纯文本按空行分段为单个章节的 HTML（段内换行 → <br>）。 */
function chaptersFromText(text: string): ReaderContent {
  const trimmed = text.replace(/\r\n?/g, '\n');
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const html = paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return { chapters: [{ title: '', html }] };
}

/**
 * 解析 TXT 字节为阅读内容。UTF-8 优先；非 UTF-8（含替换字符）回退 GBK；
 * GBK 不可用或仍失败时按 UTF-8 原样显示。
 */
export function parseTxt(bytes: Uint8Array): ReaderContent {
  const utf8 = decodeText(bytes, 'utf-8');
  if (!includesReplacement(utf8)) {
    return chaptersFromText(utf8);
  }
  try {
    const gbk = decodeText(bytes, 'gbk');
    if (!includesReplacement(gbk)) {
      return chaptersFromText(gbk);
    }
  } catch {
    /* 当前运行时不支持 GBK 编码，回退 UTF-8。 */
  }
  return chaptersFromText(utf8);
}
