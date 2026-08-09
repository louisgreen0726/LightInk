/**
 * `file-drop` — OS 文件拖入窗口的分类逻辑（纯逻辑，headless 可测）。
 *
 * Tauri v2 的 `dragDropEnabled`（默认开启）把 OS 文件拖拽拦截为
 * `tauri://drag-drop` 事件（payload 为绝对路径数组），HTML5 drop 收不到
 * OS 文件——因此拖文件打开/插图必须在该事件层实现。本模块只做分类：
 *   - .md/.markdown → 应用内开标签；
 *   - 图片扩展名（与 asset.rs 白名单一致）→ 落盘 assets 并插入活动编辑器；
 *   - 其余 → 不支持（调用方汇总提示）。
 */

/** 可被应用内打开编辑的扩展名（小写）。 */
export const OPENABLE_EXTS: ReadonlySet<string> = new Set(['md', 'markdown']);

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
  /** 应用内开标签的 Markdown 文件（保持拖入顺序）。 */
  readonly markdown: string[];
  /** 插入活动编辑器的图片文件。 */
  readonly images: string[];
  /** 不支持的文件（调用方决定是否提示）。 */
  readonly unsupported: string[];
}

/** 取小写扩展名（无扩展名/末尾点为 ''）。 */
function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** 把拖入的路径分类为 开标签 / 插图 / 不支持 三组（各组内保持原顺序）。 */
export function planDroppedFiles(paths: readonly string[]): DroppedFilePlan {
  const markdown: string[] = [];
  const images: string[] = [];
  const unsupported: string[] = [];
  for (const path of paths) {
    const ext = extOf(path);
    if (OPENABLE_EXTS.has(ext)) {
      markdown.push(path);
    } else if (DROPPED_IMAGE_EXTS.has(ext)) {
      images.push(path);
    } else {
      unsupported.push(path);
    }
  }
  return { markdown, images, unsupported };
}
