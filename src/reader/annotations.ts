/** Versioned annotation data and per-document write serialization. */

export type AnnotationKind = 'highlight' | 'bookmark' | 'note';

export interface TextQuoteAnchor {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface FlowLocator extends TextQuoteAnchor {
  format: 'flow';
  chapter: number;
}

export interface TextLocator extends TextQuoteAnchor {
  format: 'text';
}

export interface PdfLocator {
  format: 'pdf';
  page: number;
  quote: string;
  /**
   * 文字级锚点（PDF 文本层高亮用，偏移/上下文相对该页拼接文本）。
   * 可选：历史 v2 数据与页码级书签/笔记无此字段，照旧加载。
   */
  anchor?: TextQuoteAnchor;
}

export interface CbzLocator {
  format: 'cbz';
  page: number;
}

export type Locator = FlowLocator | TextLocator | PdfLocator | CbzLocator;

export interface Annotation {
  readonly id: string;
  readonly kind: AnnotationKind;
  readonly locator: Locator;
  /** Kept at the annotation level for sidebar display and v1 compatibility. */
  readonly quote?: string;
  readonly note?: string;
  readonly createdAt: number;
}

interface AnnotationFileV2 {
  version: 2;
  annotations: Annotation[];
}

const KINDS: ReadonlySet<AnnotationKind> = new Set(['highlight', 'bookmark', 'note']);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTextAnchor(value: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(value.start) &&
    isNonNegativeInteger(value.end) &&
    (value.end as number) >= (value.start as number) &&
    typeof value.quote === 'string' &&
    typeof value.prefix === 'string' &&
    typeof value.suffix === 'string'
  );
}

function isLocator(value: unknown): value is Locator {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const locator = value as Record<string, unknown>;
  switch (locator.format) {
    case 'flow':
      return isNonNegativeInteger(locator.chapter) && isTextAnchor(locator);
    case 'text':
      return isTextAnchor(locator);
    case 'pdf':
      return (
        isNonNegativeInteger(locator.page) &&
        (locator.page as number) >= 1 &&
        typeof locator.quote === 'string' &&
        // anchor 可选：存在时必须结构合规，缺失（历史页码级定位）照旧通过。
        (locator.anchor === undefined ||
          (typeof locator.anchor === 'object' &&
            locator.anchor !== null &&
            isTextAnchor(locator.anchor as Record<string, unknown>)))
      );
    case 'cbz':
      return isNonNegativeInteger(locator.page) && (locator.page as number) >= 1;
    default:
      return false;
  }
}

function isAnnotation(value: unknown): value is Annotation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const annotation = value as Record<string, unknown>;
  return (
    typeof annotation.id === 'string' &&
    annotation.id.length > 0 &&
    typeof annotation.kind === 'string' &&
    KINDS.has(annotation.kind as AnnotationKind) &&
    isLocator(annotation.locator) &&
    typeof annotation.createdAt === 'number' &&
    Number.isFinite(annotation.createdAt) &&
    (annotation.quote === undefined || typeof annotation.quote === 'string') &&
    (annotation.note === undefined || typeof annotation.note === 'string')
  );
}

function migrateV1Locator(
  value: unknown,
  annotationQuote: string,
): Locator | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const locator = value as Record<string, unknown>;
  switch (locator.format) {
    case 'flow':
      if (
        !isNonNegativeInteger(locator.chapter) ||
        !isNonNegativeInteger(locator.start) ||
        !isNonNegativeInteger(locator.end)
      ) {
        return null;
      }
      return {
        format: 'flow',
        chapter: locator.chapter,
        start: locator.start,
        end: Math.max(locator.start, locator.end),
        quote: annotationQuote,
        prefix: '',
        suffix: '',
      };
    case 'text':
      if (!isNonNegativeInteger(locator.start) || !isNonNegativeInteger(locator.end)) {
        return null;
      }
      return {
        format: 'text',
        start: locator.start,
        end: Math.max(locator.start, locator.end),
        quote: annotationQuote,
        prefix: '',
        suffix: '',
      };
    case 'pdf':
      return isNonNegativeInteger(locator.page) && locator.page >= 1
        ? {
            format: 'pdf',
            page: locator.page,
            quote: typeof locator.quote === 'string' ? locator.quote : annotationQuote,
          }
        : null;
    case 'cbz':
      return isNonNegativeInteger(locator.page) && locator.page >= 1
        ? { format: 'cbz', page: locator.page }
        : null;
    default:
      return null;
  }
}

function migrateV1Annotation(value: unknown): Annotation | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const annotation = value as Record<string, unknown>;
  if (
    typeof annotation.id !== 'string' ||
    annotation.id.length === 0 ||
    typeof annotation.kind !== 'string' ||
    !KINDS.has(annotation.kind as AnnotationKind) ||
    typeof annotation.createdAt !== 'number' ||
    !Number.isFinite(annotation.createdAt)
  ) {
    return null;
  }
  const quote = typeof annotation.quote === 'string' ? annotation.quote : '';
  const locator = migrateV1Locator(annotation.locator, quote);
  if (locator === null) {
    return null;
  }
  return {
    id: annotation.id,
    kind: annotation.kind as AnnotationKind,
    locator,
    quote: typeof annotation.quote === 'string' ? annotation.quote : undefined,
    note: typeof annotation.note === 'string' ? annotation.note : undefined,
    createdAt: annotation.createdAt,
  };
}

export function serializeAnnotations(annotations: readonly Annotation[]): string {
  const file: AnnotationFileV2 = { version: 2, annotations: [...annotations] };
  return JSON.stringify(file);
}

/** Read v2 strictly and migrate valid v1 records on a best-effort basis. */
export function parseAnnotations(json: string): Annotation[] {
  if (json === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const file = parsed as { version?: unknown; annotations?: unknown };
  if (!Array.isArray(file.annotations)) {
    return [];
  }
  if (file.version === 2) {
    return file.annotations.filter(isAnnotation);
  }
  if (file.version === 1) {
    return file.annotations
      .map(migrateV1Annotation)
      .filter((annotation): annotation is Annotation => annotation !== null);
  }
  return [];
}

/** Serialize writes per content hash and invalidate work not yet started after a document switch. */
export class AnnotationWriteQueue {
  private generation = 0;
  private readonly queues = new Map<string, Promise<boolean>>();

  invalidate(): void {
    this.generation += 1;
  }

  enqueue(
    contentHash: string,
    json: string,
    write: (contentHash: string, json: string) => Promise<void>,
    onError?: () => void,
  ): Promise<boolean> {
    const generation = this.generation;
    const previous = this.queues.get(contentHash) ?? Promise.resolve(true);
    const operation = previous
      .catch(() => false)
      .then(async () => {
        if (generation !== this.generation) {
          return false;
        }
        try {
          await write(contentHash, json);
          return generation === this.generation;
        } catch {
          if (generation === this.generation) {
            onError?.();
          }
          return false;
        }
      });
    this.queues.set(contentHash, operation);
    void operation.finally(() => {
      if (this.queues.get(contentHash) === operation) {
        this.queues.delete(contentHash);
      }
    });
    return operation;
  }
}
