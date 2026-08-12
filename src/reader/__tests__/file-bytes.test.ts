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
