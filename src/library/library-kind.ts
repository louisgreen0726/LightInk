/**
 * Shelf book-kind classification (R2).
 *
 * Pure functions only. Does not invent user categories:
 * `cbz` / `cbr` / `cb7` or a comic/zip mediaType → comic;
 * otherwise comic metadata → comic;
 * epub / txt / html and PDF without comic metadata → text.
 */

import type { LibraryComicMetadata, LibraryItem } from './library-client.js';

export type LibraryBookKind = 'text' | 'comic';

export type LibraryKindQuery = Pick<LibraryItem, 'extension' | 'mediaType'> &
  Partial<LibraryComicMetadata>;

const COMIC_EXTENSIONS: ReadonlySet<string> = new Set(['cbz', 'cbr', 'cb7']);

const ZIP_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
]);

const COMIC_ARCHIVE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/x-cbz',
  'application/x-cbr',
  'application/x-cb7',
]);

function normalizeExtension(extension: string | undefined): string {
  return (extension ?? '').trim().replace(/^\./, '').toLowerCase();
}

function mediaTypeBase(mediaType: string | undefined): string {
  return (mediaType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function isComicOrZipMediaType(mediaType: string | undefined): boolean {
  const type = mediaTypeBase(mediaType);
  if (type === '') {
    return false;
  }
  if (type.includes('comic') || ZIP_MEDIA_TYPES.has(type) || COMIC_ARCHIVE_MEDIA_TYPES.has(type)) {
    return true;
  }
  return false;
}

function hasNonEmptyText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function hasComicMetadata(query: LibraryKindQuery): boolean {
  if (hasNonEmptyText(query.series) || hasNonEmptyText(query.number) || hasNonEmptyText(query.volume)) {
    return true;
  }
  if (
    query.pageCount !== undefined &&
    Number.isFinite(query.pageCount) &&
    query.pageCount > 0
  ) {
    return true;
  }
  if (query.readingDirection === 'ltr' || query.readingDirection === 'rtl') {
    return true;
  }
  return query.coverPage !== undefined && Number.isFinite(query.coverPage);
}

/**
 * Classify an imported shelf item as a text book or a comic.
 *
 * Extension and mediaType win first so a CBZ is never a text book.
 * Comic metadata is the fallback for zip/PDF that already carry series,
 * volume, page count, direction, or a cover page. Everything else is text.
 */
export function classifyLibraryKind(query: LibraryKindQuery): LibraryBookKind {
  if (COMIC_EXTENSIONS.has(normalizeExtension(query.extension))) {
    return 'comic';
  }
  if (isComicOrZipMediaType(query.mediaType)) {
    return 'comic';
  }
  if (hasComicMetadata(query)) {
    return 'comic';
  }
  return 'text';
}

export function isComicLibraryKind(query: LibraryKindQuery): boolean {
  return classifyLibraryKind(query) === 'comic';
}

export function isTextLibraryKind(query: LibraryKindQuery): boolean {
  return classifyLibraryKind(query) === 'text';
}
