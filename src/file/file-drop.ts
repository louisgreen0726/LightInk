/**
 * `file-drop` — OS 文件拖入窗口的分类逻辑（纯逻辑，headless 可测）。
 *
 * Tauri v2 的 `dragDropEnabled`（默认开启）把 OS 文件拖拽拦截为
 * `tauri://drag-drop` 事件（payload 为绝对路径数组），HTML5 drop 收不到
 * OS 文件——因此拖文件打开/插图必须在该事件层实现。本模块是文件分类的
 * 唯一 owner，供拖入、菜单打开、最近打开、CLI/关联入口复用：
 *   - .md/.markdown → 应用内开 markdown 标签；
 *   - 电子书（pdf/epub/mobi/azw3/fb2/cbz/txt）→ 应用内开只读 reader 标签；
 *   - 图片扩展名（与 asset.rs 白名单一致）→ 落盘 assets 并插入活动编辑器；
 *   - 其余 → 不支持（调用方汇总提示）。
 */

/** 可被应用内打开编辑的扩展名（小写）。 */
export const OPENABLE_EXTS: ReadonlySet<string> = new Set(['md', 'markdown']);

/** 以只读 reader 标签打开的电子书扩展名（小写）。 */
export const READER_EXTS: ReadonlySet<string> = new Set([
  'pdf',
  'epub',
  'mobi',
  'azw3',
  'fb2',
  'cbz',
  'txt',
]);

/** 可插入为图片的扩展名（小写，与 src-tauri/src/asset.rs ALLOWED_EXTS 一致）。 */
export const DROPPED_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
]);

export interface DroppedFilePlan {
  /** 应用内开 markdown 标签的文件（保持拖入顺序）。 */
  readonly markdown: string[];
  /** 应用内开只读 reader 标签的电子书文件。 */
  readonly reader: string[];
  /** 插入活动编辑器的图片文件。 */
  readonly images: string[];
  /** 不支持的文件（调用方决定是否提示）。 */
  readonly unsupported: string[];
}

/** 取小写扩展名（无扩展名/末尾点为 ''）。 */
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** 是否为以只读 reader 标签打开的电子书路径（按扩展名，不访问文件系统）。 */
export function isReaderPath(path: string): boolean {
  return READER_EXTS.has(extOf(path));
}

/** 是否为应用内可编辑的 Markdown 路径（按扩展名，不访问文件系统）。 */
export function isMarkdownPath(path: string): boolean {
  return OPENABLE_EXTS.has(extOf(path));
}

/** 把拖入的路径分类为 markdown / reader / 插图 / 不支持 四组（各组内保持原顺序）。 */
export function planDroppedFiles(paths: readonly string[]): DroppedFilePlan {
  const markdown: string[] = [];
  const reader: string[] = [];
  const images: string[] = [];
  const unsupported: string[] = [];
  for (const path of paths) {
    const ext = extOf(path);
    if (OPENABLE_EXTS.has(ext)) {
      markdown.push(path);
    } else if (READER_EXTS.has(ext)) {
      reader.push(path);
    } else if (DROPPED_IMAGE_EXTS.has(ext)) {
      images.push(path);
    } else {
      unsupported.push(path);
    }
  }
  return { markdown, reader, images, unsupported };
}
