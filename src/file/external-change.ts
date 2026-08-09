/**
 * `external-change` — R13 外部文件变更检测的纯逻辑判定。
 *
 * 检测手段为 mtime（+ size）对比，不引入文件监听依赖（见
 * 02-technical-solution.md §10）：TabManager 在加载/保存成功时记录磁盘
 * `FileStat` 作为基线（`lastSavedMtime`）；窗口聚焦与定时轮询时再 stat
 * 活动 tab 的路径，用 `isDiskNewer` 判定磁盘是否比基线更新。
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
 * 磁盘是否比记录基线更新：
 *   - 基线为 null（未保存过 / stat 失败）→ 不判变更（无可比对的已存盘态）；
 *   - mtime 严格更新 → 变更；
 *   - mtime 相同但 size 不同 → 变更（应对粗粒度 mtime 文件系统：同一 mtime
 *     tick 内的外部写入若改了大小仍可识别）。
 * mtime 与 size 均相同视为未变更（无法识别的极小同尺寸改动不属本检测范围）。
 */
export function isDiskNewer(baseline: FileStat | null, disk: FileStat): boolean {
  if (baseline === null) {
    return false;
  }
  if (disk.mtime_ms > baseline.mtime_ms) {
    return true;
  }
  if (disk.mtime_ms === baseline.mtime_ms && disk.size !== baseline.size) {
    return true;
  }
  return false;
}
