/**
 * `reader` — 只读阅读标签的实例契约（ebook-reader T1）。
 *
 * reader 标签（PDF/EPUB/MOBI/AZW3/FB2/CBZ/TXT）在 TabManager 中以
 * `kind: 'reader'` 与 markdown 编辑标签区分：不挂 Milkdown 编辑器，
 * 永不进入 dirty / autosave / 崩溃快照 / 外部变更检测等可写路径
 * （见 tab-manager 各方法的 kind 守卫）。
 *
 * 本接口当前只定义生命周期契约：由 TabManager 依赖注入的 `mountReader`
 * 创建，`closeTab` 时 `destroy`。格式渲染、目录导航与标注方法由后续任务
 * （reader-view / formats / annotations）在此接口上扩展——届时直接给
 * `ReaderInstance` 增加方法，不改既有签名。
 */

/**
 * 只读阅读视图实例。生命周期由 TabManager 管理（mountReader 创建、
 * closeTab 销毁，对应 markdown 标签的 `editor.destroy`）。reader 标签
 * 活动时，所有编辑器动作（菜单 / 快捷键 / 右键菜单）系统性空转或禁用。
 */
export interface ReaderInstance {
  /**
   * 读取并解析文件，把章节渲染进阅读视图（T4 接入流式格式）。
   * 解析失败（DRM、损坏、不支持）reject，由调用方负责 i18n 错误提示。
   */
  load(filePath: string): Promise<void>;
  /**
   * 销毁阅读视图：移除 DOM、清理监听与渲染资源。closeTab 关闭 reader
   * 标签时调用；失败由调用方上报，不阻断关闭流程。
   */
  destroy(): Promise<void>;
}
