/**
 * `annotations` — 标注数据模型与定位器（ebook-reader T6 / R4）。
 *
 * 标注按文件内容哈希（Rust `content_hash` 命令）关联，存 app_data_dir/annotations/。
 * 本模块定义标注与各格式定位器，并提供序列化/解析往返（损坏 JSON 视为空，R4）。
 * 纯逻辑，headless 可测；持久化经 Rust 命令，UI 渲染在 reader-view/sidebar。
 */

/** 标注类型：高亮 / 书签 / 笔记。 */
export type AnnotationKind = 'highlight' | 'bookmark' | 'note';

/** 流式格式（EPUB/MOBI/FB2）定位器：章节索引 + DOM path + 字符区间。 */
export interface FlowLocator {
  format: 'flow';
  chapter: number;
  domPath: string;
  start: number;
  end: number;
}
/** TXT 定位器：全文字符区间。 */
export interface TextLocator {
  format: 'text';
  start: number;
  end: number;
}
/** PDF 定位器：页码 + 选中文本（quote，供无 DOM 的高亮重定位）。 */
export interface PdfLocator {
  format: 'pdf';
  page: number;
  quote: string;
}
/** CBZ 定位器：页码（仅书签/笔记，不支持高亮）。 */
export interface CbzLocator {
  format: 'cbz';
  page: number;
}

export type Locator = FlowLocator | TextLocator | PdfLocator | CbzLocator;

/** 单条标注。 */
export interface Annotation {
  readonly id: string;
  readonly kind: AnnotationKind;
  readonly locator: Locator;
  /** 高亮/笔记引用的原文片段（可空）。 */
  readonly quote?: string;
  /** 用户笔记文本（可空）。 */
  readonly note?: string;
  /** 创建时间（epoch 毫秒）。 */
  readonly createdAt: number;
}

/** 标注集合的序列化形态（带版本号，便于后续迁移）。 */
interface AnnotationFile {
  version: 1;
  annotations: Annotation[];
}

const KINDS: ReadonlySet<AnnotationKind> = new Set(['highlight', 'bookmark', 'note']);
const LOCATOR_FORMATS: ReadonlySet<Locator['format']> = new Set([
  'flow',
  'text',
  'pdf',
  'cbz',
]);

function isLocator(v: unknown): v is Locator {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const format = (v as { format?: unknown }).format;
  return typeof format === 'string' && LOCATOR_FORMATS.has(format as Locator['format']);
}

function isAnnotation(v: unknown): v is Annotation {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.kind === 'string' &&
    KINDS.has(a.kind as AnnotationKind) &&
    isLocator(a.locator) &&
    typeof a.createdAt === 'number'
  );
}

/** 序列化标注集合为 JSON（写盘形态）。 */
export function serializeAnnotations(annotations: readonly Annotation[]): string {
  const file: AnnotationFile = { version: 1, annotations: [...annotations] };
  return JSON.stringify(file);
}

/**
 * 解析标注 JSON。空串/损坏/结构不符都返回空数组（R4：损坏视为空，不阻断阅读）。
 */
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
  const list = (parsed as { annotations?: unknown }).annotations;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(isAnnotation);
}
