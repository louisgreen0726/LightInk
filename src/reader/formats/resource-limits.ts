export const MAX_READER_IMAGE_BYTES = 32 * 1024 * 1024;

export const SAFE_READER_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
