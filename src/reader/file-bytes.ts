import { extOfPath } from '../file/path-ext.js';

export const MAX_TEXT_READER_BYTES = 32 * 1024 * 1024;
export const MAX_BINARY_READER_BYTES = 128 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt']);

export class ReaderFileTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Reader file is too large (${actualBytes} bytes; limit ${limitBytes} bytes)`);
    this.name = 'ReaderFileTooLargeError';
  }
}

export function readerByteLimitForPath(path: string): number {
  const base = path.split(/[\\/]/).pop() ?? path;
  let extension = extOfPath(path);
  if (extension === '' && base.length > 1 && base.startsWith('.') && !base.endsWith('.')) {
    // 点文件（如 `.txt`）：保留接线 extOfPath 前的历史语义——首点后的段仍按扩展名
    // 参与上限判定，点文件命名的文本文件不因此从 32MB 文本上限落入 128MB 二进制上限。
    extension = base.slice(1).toLowerCase();
  }
  return TEXT_EXTENSIONS.has(extension) ? MAX_TEXT_READER_BYTES : MAX_BINARY_READER_BYTES;
}

function decodedBase64Length(base64: string): number {
  if (base64.length % 4 !== 0) {
    throw new Error('Invalid padded base64 length');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function decodeBase64WithLimit(
  base64: string,
  limitBytes: number,
  decode: (value: string) => string = globalThis.atob,
): Uint8Array {
  const expectedBytes = decodedBase64Length(base64);
  if (expectedBytes > limitBytes) {
    throw new ReaderFileTooLargeError(expectedBytes, limitBytes);
  }
  const binary = decode(base64);
  if (binary.length > limitBytes) {
    throw new ReaderFileTooLargeError(binary.length, limitBytes);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeReaderFileBase64(path: string, base64: string): Uint8Array {
  return decodeBase64WithLimit(base64, readerByteLimitForPath(path));
}
