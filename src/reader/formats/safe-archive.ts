/**
 * Shared ZIP boundary for reader formats.
 *
 * Central-directory metadata is validated before any entry is decompressed so a
 * small EPUB/CBZ cannot expand without a predictable memory budget.
 */

import type { FileEntry } from '@zip.js/zip.js';

import { ParseError, ReaderLimitError } from './types.js';
import type {
  ArchiveEntryMetadata as CommonArchiveEntryMetadata,
  ArchiveProvider,
  RandomAccessSource,
} from '../sources/types.js';
import { createMemorySource } from '../sources/memory-source.js';
import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const READER_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
  maxEntries: 5_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export interface ArchiveEntryMetadata extends CommonArchiveEntryMetadata {
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

function compressionRatio(entry: ArchiveEntryMetadata): number {
  if (entry.uncompressedSize === 0) {
    return 0;
  }
  if (entry.compressedSize === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(entry.uncompressedSize / entry.compressedSize);
}

class ArchiveBudgetTracker {
  private entryCount = 0;
  private totalUncompressedBytes = 0;

  constructor(private readonly limits: Readonly<ArchiveLimits>) {}

  add(entry: ArchiveEntryMetadata): void {
    this.entryCount += 1;
    if (this.entryCount > this.limits.maxEntries) {
      throw new ReaderLimitError('archiveEntries', this.entryCount, this.limits.maxEntries);
    }
    if (entry.directory) {
      return;
    }
    if (entry.uncompressedSize > this.limits.maxEntryUncompressedBytes) {
      throw new ReaderLimitError(
        'archiveEntryBytes',
        entry.uncompressedSize,
        this.limits.maxEntryUncompressedBytes,
      );
    }
    const ratio = compressionRatio(entry);
    if (ratio > this.limits.maxCompressionRatio) {
      throw new ReaderLimitError(
        'archiveCompressionRatio',
        Number.isFinite(ratio) ? ratio : this.limits.maxCompressionRatio + 1,
        this.limits.maxCompressionRatio,
      );
    }
    this.totalUncompressedBytes += entry.uncompressedSize;
    if (this.totalUncompressedBytes > this.limits.maxTotalUncompressedBytes) {
      throw new ReaderLimitError(
        'archiveTotalBytes',
        this.totalUncompressedBytes,
        this.limits.maxTotalUncompressedBytes,
      );
    }
  }
}

/** Validate synthetic metadata independently of ZIP parsing for boundary tests. */
export function validateArchiveMetadata(
  entries: readonly ArchiveEntryMetadata[],
  limits: Readonly<ArchiveLimits> = READER_ARCHIVE_LIMITS,
): void {
  const tracker = new ArchiveBudgetTracker(limits);
  for (const entry of entries) {
    tracker.add(entry);
  }
}

export interface SafeArchiveEntry extends ArchiveEntryMetadata {
  readonly id: string;
  readonly filename: string;
  readText(signal?: AbortSignal): Promise<string>;
  readBytes(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface SafeArchive extends ArchiveProvider {
  readonly entries: readonly SafeArchiveEntry[];
  file(filename: string): SafeArchiveEntry | null;
}

export type ArchiveInput = Uint8Array | RandomAccessSource;

function isRandomAccessSource(input: ArchiveInput): input is RandomAccessSource {
  return typeof (input as RandomAccessSource).readRange === 'function';
}

/** Open and validate an archive without decompressing its entries. */
export async function openSafeArchive(
  input: ArchiveInput,
  formatName: 'EPUB' | 'CBZ',
  signal?: AbortSignal,
): Promise<SafeArchive> {
  throwIfReaderLoadCancelled(signal);
  const zip = await import('@zip.js/zip.js');
  throwIfReaderLoadCancelled(signal);
  const source = isRandomAccessSource(input) ? input : createMemorySource(input);
  /**
   * zip.js asks its Reader for central-directory slices and entry headers. The
   * adapter keeps those reads on the backend-owned sparse cache instead of
   * materializing the complete archive in the WebView.
   */
  class SourceReader extends zip.Reader<RandomAccessSource> {
    constructor(private readonly randomSource: RandomAccessSource) {
      super(randomSource);
      this.size = randomSource.size;
    }

    override async init(): Promise<void> {
      await super.init?.();
    }

    override readUint8Array(index: number, length: number): Promise<Uint8Array> {
      return this.randomSource.readRange(index, length, signal);
    }
  }
  const reader = new zip.ZipReader(new SourceReader(source));
  const files: FileEntry[] = [];
  const budget = new ArchiveBudgetTracker(READER_ARCHIVE_LIMITS);
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      throwIfReaderLoadCancelled(signal);
      budget.add(entry);
      if (!entry.directory) {
        files.push(entry);
      }
    }
  } catch (error) {
    await reader.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    if (isReaderLoadCancelled(error, signal)) {
      throw new ReaderLoadCancelledError();
    }
    if (error instanceof ReaderLimitError) {
      throw error;
    }
    throw new ParseError(`${formatName} 文件损坏或不是有效的 zip 容器`);
  }

  const entries: SafeArchiveEntry[] = files.map((entry) => ({
    id: entry.filename,
    filename: entry.filename,
    directory: false,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    readText: (entrySignal) => entry.getData(new zip.TextWriter(), { signal: entrySignal }),
    readBytes: (entrySignal) =>
      entry.getData(new zip.Uint8ArrayWriter(), { signal: entrySignal }),
  }));
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));

  return {
    entries,
    accessMode: 'random',
    file: (filename) => byName.get(filename) ?? null,
    readEntry: async (entryId, entrySignal) => {
      const entry = byName.get(entryId);
      if (entry === undefined) {
        throw new ParseError(`归档条目不存在：${entryId}`);
      }
      return entry.readBytes(entrySignal);
    },
    close: async () => {
      await reader.close();
      await source.close();
    },
  };
}
