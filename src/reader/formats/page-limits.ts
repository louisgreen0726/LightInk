import { ReaderLimitError } from './types.js';

export const MAX_PDF_PAGES = 10_000;
export const MAX_CBZ_PAGES = 5_000;

export type PageFormat = 'pdf' | 'cbz';

/** Reject page collections before allocating slots or decoding page bodies. */
export function enforcePageCount(format: PageFormat, pageCount: number): void {
  const limit = format === 'pdf' ? MAX_PDF_PAGES : MAX_CBZ_PAGES;
  if (pageCount > limit) {
    throw new ReaderLimitError(format === 'pdf' ? 'pdfPages' : 'cbzPages', pageCount, limit);
  }
}
