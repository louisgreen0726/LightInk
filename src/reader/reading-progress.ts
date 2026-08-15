/**
 * Per-document reading position. Keyed by content hash (preferred) or file path.
 * Stored in localStorage so reopening a book resumes instead of starting over.
 */

export const READING_PROGRESS_KEY_PREFIX = 'lightink.reader.progress.';

export interface ReadingProgress {
  readonly version: 1;
  readonly kind: 'flow' | 'page';
  /** 0-based chapter for flow; 1-based page for pdf/cbz. */
  readonly index: number;
  /** Document scroll ratio 0..1 for flow; unused for page. */
  readonly ratio: number;
  readonly updatedAt: number;
}

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readingProgressKey(id: string): string {
  return `${READING_PROGRESS_KEY_PREFIX}${id}`;
}

export function parseReadingProgress(raw: string | null | undefined): ReadingProgress | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReadingProgress>;
    if (parsed.version !== 1 || (parsed.kind !== 'flow' && parsed.kind !== 'page')) {
      return null;
    }
    const index = parsed.index;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      return null;
    }
    if (typeof parsed.ratio !== 'number' || !Number.isFinite(parsed.ratio)) {
      return null;
    }
    return {
      version: 1,
      kind: parsed.kind,
      index,
      ratio: Math.min(1, Math.max(0, parsed.ratio)),
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
    };
  } catch {
    return null;
  }
}

export function serializeReadingProgress(progress: ReadingProgress): string {
  return JSON.stringify(progress);
}

export function loadReadingProgress(
  storage: ProgressStorage | null | undefined,
  id: string,
): ReadingProgress | null {
  if (storage == null || id === '') {
    return null;
  }
  try {
    return parseReadingProgress(storage.getItem(readingProgressKey(id)));
  } catch {
    return null;
  }
}

export function saveReadingProgress(
  storage: ProgressStorage | null | undefined,
  id: string,
  progress: ReadingProgress,
): void {
  if (storage == null || id === '') {
    return;
  }
  try {
    storage.setItem(readingProgressKey(id), serializeReadingProgress(progress));
  } catch {
    // Quota / privacy mode must not interrupt reading.
  }
}

/** In-chapter progress 0..1 from a scroller's offset into a chapter box. */
export function chapterScrollRatio(
  scrollTop: number,
  chapterTop: number,
  chapterHeight: number,
): number {
  if (!(chapterHeight > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (scrollTop - chapterTop) / chapterHeight));
}

/** Scroll offset that puts the given in-chapter ratio at the top of the pane. */
export function chapterScrollTop(
  chapterTop: number,
  chapterHeight: number,
  ratio: number,
): number {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return Math.max(0, chapterTop + safe * Math.max(0, chapterHeight));
}

export function resolveProgressStorage(
  storage?: ProgressStorage | null,
): ProgressStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // Privacy mode.
  }
  return null;
}
