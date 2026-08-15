/**
 * Stable 16-hex key matching Rust FNV-1a 64 (`content_hash_hex`).
 * Markdown annotations key off the file path so edits do not orphan marks.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

export function markdownAnnotationKey(filePath: string | null, syntheticId: string): string {
  return fnv1a64Hex(filePath === null ? `untitled:${syntheticId}` : `path:${filePath}`);
}
