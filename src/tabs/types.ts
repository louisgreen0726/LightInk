/**
 * 标签页状态类型（T3）。
 *
 * 多标签状态的唯一 owner 是前端 TabManager：标签列表、活动标签、
 * 每个标签各自的编辑器会话（ProseMirror doc + 脏标记 + 文件路径）。
 */

import type { EditorInstance } from '../editor/types.js';

/** 单个标签页的完整会话状态。 */
export interface TabState {
  /** 稳定 id（`tab-<n>`），用于切换/关闭与快照调度。 */
  readonly id: string;
  /** 已保存到磁盘的文件路径；未命名标签为 null。 */
  filePath: string | null;
  /**
   * 未命名标签的合成 id（`untitled-<n>`）。有效快照键 =
   * `filePath ?? syntheticId`（见 tab-manager 的 snapshotKeyOf）。
   */
  readonly syntheticId: string;
  /** 标签标题（文件名或「未命名-n」）。 */
  title: string;
  /** 脏标记：当前内容与 lastSavedMarkdown 不一致即为 true。 */
  dirty: boolean;
  /** 该标签独占的编辑器实例。 */
  readonly editor: EditorInstance;
  /** 该标签的宿主 DOM 元素（切换时 show/hide）。 */
  readonly hostElement: HTMLElement;
  /** 最近一次已保存（或初始加载）的内容，用于比较得出脏标记。 */
  lastSavedMarkdown: string;
}

/** 关闭未保存标签时用户的三选一。 */
export type CloseChoice = 'save' | 'discard' | 'cancel';
