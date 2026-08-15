import { describe, expect, it } from 'vitest';

import {
  decodeBase64WithLimit,
  MAX_BINARY_READER_BYTES,
  MAX_TEXT_READER_BYTES,
  ReaderFileTooLargeError,
  readerByteLimitForPath,
} from '../file-bytes.js';

describe('reader file byte budgets', () => {
  it('uses the text limit for TXT and the binary limit for reader containers', () => {
    expect(readerByteLimitForPath('notes.TXT')).toBe(MAX_TEXT_READER_BYTES);
    expect(readerByteLimitForPath('/books/book.epub')).toBe(MAX_BINARY_READER_BYTES);
    expect(readerByteLimitForPath('book.pdf')).toBe(MAX_BINARY_READER_BYTES);
  });

  it('keeps dot-file text names on the text limit after wiring extOfPath', () => {
    // 回归（T3 advisory）：extOfPath 对点文件返回 ''，但历史上 `.txt` 这类点文件
    // 名按首点后的段走 32MB 文本上限——接线后不得静默落入 128MB 二进制上限。
    expect(readerByteLimitForPath('.txt')).toBe(MAX_TEXT_READER_BYTES);
    expect(readerByteLimitForPath('.md')).toBe(MAX_TEXT_READER_BYTES);
    expect(readerByteLimitForPath('C:\\books\\.markdown')).toBe(MAX_TEXT_READER_BYTES);
    // 非文本点文件与无扩展名/末尾点仍走二进制上限。
    expect(readerByteLimitForPath('.gitignore')).toBe(MAX_BINARY_READER_BYTES);
    expect(readerByteLimitForPath('notes')).toBe(MAX_BINARY_READER_BYTES);
    expect(readerByteLimitForPath('notes.')).toBe(MAX_BINARY_READER_BYTES);
  });

  it('checks exact decoded length before base64 decoding', () => {
    const decode = (value: string): string => (value === 'YWI=' ? 'ab' : 'abc');
    expect(decodeBase64WithLimit('YWI=', 2, decode)).toEqual(new Uint8Array([97, 98]));
    expect(() => decodeBase64WithLimit('YWJj', 2, decode)).toThrow(ReaderFileTooLargeError);
  });

  it('rechecks decoder output at the exact encoded boundary', () => {
    expect(() => decodeBase64WithLimit('YWI=', 2, () => 'abc')).toThrow(
      ReaderFileTooLargeError,
    );
  });
});
