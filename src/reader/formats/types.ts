/**
 * 流式阅读内容模型（ebook-reader T4）。
 *
 * EPUB/MOBI/FB2/TXT 解析器统一产出 `ReaderContent`（章节化 HTML），由 reader-view
 * 渲染到滚动宿主。HTML 经 `sanitizeHtml` 消毒后再放入 chapters[].html。
 */

/** 单个阅读章节。 */
export interface ReaderChapter {
  /** 章节标题（可为空，渲染时回退到序号）。 */
  title: string;
  /** 已消毒的章节正文 HTML。 */
  html: string;
}

/** 按阅读顺序的章节集合。 */
export interface ReaderContent {
  chapters: ReaderChapter[];
  /** Non-fatal fidelity limitations that should be shown once after load. */
  warnings?: readonly ReaderWarningKind[];
  /** Release parser-owned blob/object URLs. Idempotent when provided. */
  dispose?: () => void;
}

export type ReaderWarningKind = 'epubStylesIgnored';

/** 格式解析失败（DRM、损坏、不支持）。携带可向用户展示的原因。 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export type ReaderLimitKind =
  | 'archiveEntries'
  | 'archiveTotalBytes'
  | 'archiveEntryBytes'
  | 'archiveCompressionRatio'
  | 'readerImageBytes'
  | 'pdfPages'
  | 'cbzPages';

/** Structured reader budget failure, localized only at the application boundary. */
export class ReaderLimitError extends ParseError {
  constructor(
    readonly kind: ReaderLimitKind,
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`READER_LIMIT:${kind}:${actual}:${limit}`);
    this.name = 'ReaderLimitError';
  }
}

export type ReaderCapabilityKind = 'mobiDrm' | 'mobiKf8' | 'mobiHuff';

/** Known format variant that LightInk intentionally does not claim to support. */
export class ReaderCapabilityError extends ParseError {
  constructor(readonly kind: ReaderCapabilityKind) {
    super(`READER_CAPABILITY:${kind}`);
    this.name = 'ReaderCapabilityError';
  }
}
