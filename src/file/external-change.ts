/**
 * `external-change` — R13 外部文件变更检测的纯逻辑判定。
 *
 * 检测手段为 mtime、size 与内容指纹对比，不引入文件监听依赖（见
 * 02-technical-solution.md §10）：TabManager 在加载/保存成功时记录磁盘
 * `FileStat` 作为基线（`lastSavedMtime`）；窗口聚焦与定时轮询时再 stat
 * 活动 tab 的路径，用 `hasFileStatChanged` 判定磁盘是否偏离基线。
 *
 * 这里的判定函数是无 IO 的纯逻辑（headless 可测）；时机触发、stat 调用、
 * 冲突/重载对话框的分派在 TabManager（编排）与 main.ts（窗口聚焦/定时器）。
 */

import type { FileStat } from './file-service.js';

/** 未脏文件检测到磁盘更新时，用户的选择（提示「可重新加载」）。 */
export type ExternalReloadChoice = 'reload' | 'ignore';

/** 已脏文件（或保存前）检测到外部冲突时，用户的明确选择（R13 禁止无提示覆盖）。 */
export type ExternalConflictChoice = 'reload' | 'keep' | 'overwrite';

/**
 * 磁盘是否偏离记录基线：
 *   - 基线为 null（未保存过 / stat 失败）→ 不判变更（无可比对的已存盘态）；
 *   - mtime、size 或内容指纹任一不同 → 变更。
 * 因此时间回退、粗粒度时间戳与同大小替换都不会绕过冲突流程。
 */
export function hasFileStatChanged(baseline: FileStat | null, disk: FileStat): boolean {
  if (baseline === null) {
    return false;
  }
  return (
    disk.mtime_ms !== baseline.mtime_ms ||
    disk.size !== baseline.size ||
    disk.fingerprint !== baseline.fingerprint
  );
}
