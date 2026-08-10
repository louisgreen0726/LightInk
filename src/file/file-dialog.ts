/**
 * `file-dialog` — 系统文件对话框封装（T3）。
 *
 * 基于 @tauri-apps/plugin-dialog。打开与另存为使用不同过滤器：
 *   - 打开：Markdown + 电子书（PDF/EPUB/MOBI/AZW3/FB2/CBZ/TXT）+ 全部；
 *   - 另存为：仅 Markdown（reader 标签只读，不可另存为）。
 *
 * 在无窗口的测试环境里该模块会被 `vi.mock('@tauri-apps/plugin-dialog')`
 * 替换，因此这里保持极薄。
 */

import { open, save } from '@tauri-apps/plugin-dialog';

/** Markdown 过滤器（打开与另存为共用）。 */
const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown'] },
];

/** 只读电子书过滤器（仅出现在「打开」对话框）。 */
const READER_FILTERS = [
  { name: 'eBook', extensions: ['pdf', 'epub', 'mobi', 'azw3', 'fb2', 'cbz', 'txt'] },
];

const ALL_FILES_FILTER = { name: 'All Files', extensions: ['*'] };

/** 「打开」对话框过滤器：Markdown + 电子书 + 全部。 */
export const OPEN_FILTERS = [...MARKDOWN_FILTERS, ...READER_FILTERS, ALL_FILES_FILTER];

/** 「另存为」对话框过滤器：仅 Markdown + 全部（reader 标签只读不另存）。 */
export const SAVE_FILTERS = [...MARKDOWN_FILTERS, ALL_FILES_FILTER];

/** 弹出「打开」对话框；用户取消时返回 null。 */
export async function showOpenDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: OPEN_FILTERS,
  });
  // open() 在多选关闭时返回 string | null
  return typeof selected === 'string' ? selected : null;
}

/** 弹出「另存为」对话框；用户取消时返回 null。 */
export async function showSaveDialog(defaultPath?: string): Promise<string | null> {
  const selected = await save({
    defaultPath,
    filters: SAVE_FILTERS,
  });
  return typeof selected === 'string' ? selected : null;
}
