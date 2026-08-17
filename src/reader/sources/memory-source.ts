import type {
  RandomAccessSource,
  ReaderDocumentIdentity,
} from './types.js';

/** In-memory source used by format tests and the legacy local-byte adapter. */
export function createMemorySource(
  bytes: Uint8Array,
  identity: ReaderDocumentIdentity = { id: 'memory' },
): RandomAccessSource {
  let closed = false;
  return {
    size: bytes.byteLength,
    identity,
    async readRange(offset, length, signal) {
      if (closed) {
        throw new Error('Reader source is closed');
      }
      if (signal?.aborted === true) {
        throw new Error('Reader source read cancelled');
      }
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        throw new RangeError('Invalid reader source range');
      }
      const start = Math.min(offset, bytes.byteLength);
      const end = Math.min(bytes.byteLength, start + length);
      return bytes.slice(start, end);
    },
    async close() {
      closed = true;
    },
  };
}
