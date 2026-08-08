/**
 * `file-dialog` — 系统文件对话框封装（T3）。
 *
 * 基于 @tauri-apps/plugin-dialog。在无窗口的测试环境里该模块会被
 * `vi.mock('@tauri-apps/plugin-dialog')` 替换，因此这里保持极薄。
 */

import { open, save } from '@tauri-apps/plugin-dialog';

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: 'All Files', extensions: ['*'] },
];

/** 弹出「打开」对话框；用户取消时返回 null。 */
export async function showOpenDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: MARKDOWN_FILTERS,
  });
  // open() 在多选关闭时返回 string | null
  return typeof selected === 'string' ? selected : null;
}

/** 弹出「另存为」对话框；用户取消时返回 null。 */
export async function showSaveDialog(defaultPath?: string): Promise<string | null> {
  const selected = await save({
    defaultPath,
    filters: MARKDOWN_FILTERS,
  });
  return typeof selected === 'string' ? selected : null;
}
