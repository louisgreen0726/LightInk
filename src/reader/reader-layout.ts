/**
 * Reader-flow layout (R3).
 *
 * Owns `lightink.reader.flow.layout` (default paginated). Consumes
 * `reading-layout.ts` column/spread math and never reads or writes the
 * editor key `lightink.reading.layout`. PDF/comic hosts must not call
 * these helpers for text-column spreads.
 */

import {
  applyReadingLayout,
  DEFAULT_READING_LAYOUT,
  parseReadingLayout,
  pagedSpreadMetrics,
  readingColumnLayout,
  toggleReadingLayout,
  type LayoutStorage,
  type ReadingColumnLayoutOptions,
  type ReadingLayout,
} from '../ui/reading-layout.js';
import {
  DEFAULT_READER_MEASURE_REM,
  readerTypographyColumnOptions,
  type ReaderTypography,
} from './reader-typography.js';

export const READER_FLOW_LAYOUT_STORAGE_KEY = 'lightink.reader.flow.layout';

export const DEFAULT_READER_FLOW_LAYOUT: ReadingLayout = 'paginated';

/** Paginated flow left/right gutter; narrower than the previous 0.7rem default. */
export const READER_FLOW_PAGED_PADDING_X_REM = 0.4;

export type ReaderFlowLayout = ReadingLayout;

export type ReaderFlowLayoutStorage = LayoutStorage;

export function parseReaderLayout(raw: string | null | undefined): ReaderFlowLayout {
  return raw === 'scroll' ? 'scroll' : DEFAULT_READER_FLOW_LAYOUT;
}

export const parseReaderFlowLayout = parseReaderLayout;

export function loadReaderLayout(
  storage: ReaderFlowLayoutStorage | null | undefined,
): ReaderFlowLayout {
  if (storage == null) {
    return DEFAULT_READER_FLOW_LAYOUT;
  }
  try {
    return parseReaderLayout(storage.getItem(READER_FLOW_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_READER_FLOW_LAYOUT;
  }
}

export const loadReaderFlowLayout = loadReaderLayout;

export function saveReaderLayout(
  storage: ReaderFlowLayoutStorage | null | undefined,
  layout: ReaderFlowLayout,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(READER_FLOW_LAYOUT_STORAGE_KEY, parseReaderLayout(layout));
  } catch {
    // Privacy mode / quota — ignore.
  }
}

export const saveReaderFlowLayout = saveReaderLayout;

export function applyReaderLayout(
  root: { dataset: DOMStringMap; classList: DOMTokenList },
  layout: ReaderFlowLayout,
): void {
  applyReadingLayout(root, parseReaderLayout(layout));
}

export const applyReaderFlowLayout = applyReaderLayout;

/**
 * Host consumers in reader-view / PDF still read html[data-reading-layout].
 * While the reader workspace is showing, that attribute must follow the
 * reader flow key (default paginated) instead of the editor key (default
 * scroll). Leaving reader mode restores the editor layout and never writes
 * either storage key.
 */
export function applyReaderDocumentLayout(
  documentRoot: { dataset: DOMStringMap; classList: DOMTokenList },
  workspaceMode: string | null | undefined,
  readerLayout: ReaderFlowLayout,
  editorLayout: ReadingLayout = DEFAULT_READING_LAYOUT,
): ReadingLayout {
  const next =
    workspaceMode === 'reader'
      ? parseReaderLayout(readerLayout)
      : parseReadingLayout(editorLayout);
  applyReadingLayout(documentRoot, next);
  return next;
}

export function toggleReaderFlowLayout(layout: ReaderFlowLayout): ReaderFlowLayout {
  return toggleReadingLayout(parseReaderLayout(layout));
}

export function readerFlowUsesTextColumns(kind: string): boolean {
  return kind === 'flow';
}

export function readerFlowColumnOptions(
  minRem: number = DEFAULT_READER_MEASURE_REM,
): ReadingColumnLayoutOptions {
  return { minRem, maxColumns: 2 };
}

export function readerFlowColumnLayout(
  containerWidth: number,
  fontSizePx: number,
  minRem: number = DEFAULT_READER_MEASURE_REM,
): { columnWidth: number; columns: number; gap: number } {
  return readingColumnLayout(containerWidth, fontSizePx, readerFlowColumnOptions(minRem));
}

export function readerFlowSpreadMetrics(
  containerWidth: number,
  fontSizePx: number,
  minRem: number = DEFAULT_READER_MEASURE_REM,
): { width: number; columnWidth: number; columns: number; gap: number; step: number } {
  return pagedSpreadMetrics(containerWidth, fontSizePx, readerFlowColumnOptions(minRem));
}

export function readerFlowSpreadFromTypography(
  containerWidth: number,
  fontSizePx: number,
  typography: ReaderTypography,
): { width: number; columnWidth: number; columns: number; gap: number; step: number } {
  return pagedSpreadMetrics(
    containerWidth,
    fontSizePx,
    readerTypographyColumnOptions(typography),
  );
}
