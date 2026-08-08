/**
 * Shared types used by the editor modules and their tests.
 *
 * The editor is built around a Milkdown-style ProseMirror schema, but for the
 * testable layers we expose a stable, framework-agnostic vocabulary that the
 * pure parser, paste handler, and cursor-toggle state machine all speak.
 */

import type { Root as MdastRoot } from 'mdast';

/** All CommonMark + GFM syntax kinds T2 must cover (R1 + R10). */
export type SyntaxKind =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'paragraph'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list-item'
  | 'blockquote'
  | 'inline-code'
  | 'code-block'
  | 'table'
  | 'link'
  | 'image'
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'thematic-break'
  | 'text';

/**
 * MDAST node `type` literal. mdast's union is exhaustive but verbose; we
 * alias it here so callers don't have to thread `mdast` types everywhere.
 */
export type MdastType =
  | 'root'
  | 'paragraph'
  | 'heading'
  | 'text'
  | 'emphasis'
  | 'strong'
  | 'delete'
  | 'inlineCode'
  | 'code'
  | 'blockquote'
  | 'list'
  | 'listItem'
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'link'
  | 'image'
  | 'thematicBreak'
  | 'break'
  | 'html'
  | 'definition'
  | 'footnoteDefinition'
  | 'footnoteReference';

/** Lightweight wrapper around a parsed MDAST tree with metadata. */
export interface ParsedDocument {
  /** Raw markdown source. */
  readonly source: string;
  /** MDAST root. */
  readonly root: MdastRoot;
  /** Total word count in the source (whitespace-split tokens). */
  readonly wordCount: number;
  /** Total character length of the source. */
  readonly charCount: number;
}

/** Editor mount call options. All fields are optional. */
export interface MountOptions {
  /** Initial markdown to load into the editor. */
  readonly initialMarkdown?: string;
  /** Whether the cursor-toggle behavior is on (default true). */
  readonly cursorToggle?: boolean;
  /**
   * Override the asset directory for pasted images.
   * T2 only stubs this — persistence is delivered by T4.
   */
  readonly assetsDir?: string;
  /**
   * R14：点击文档内链接 mark 时回调（由 main.ts 分类后跳转：外链→浏览器、
   * 本地 .md→新标签、其他本地文件→系统默认程序）。
   */
  readonly onLinkNavigate?: (href: string) => void;
}

/** 当前选区的位置摘要（R7/R3 选区访问器）。 */
export interface SelectionSummary {
  readonly from: number;
  readonly to: number;
  readonly empty: boolean;
}

/** 光标处链接的信息（R7/R3 链接查询）。 */
export interface CursorLink {
  readonly href: string;
  readonly text: string;
}

/** Public handle returned from `mountEditor`. */
export interface EditorInstance {
  /** Promise that resolves once the underlying ProseMirror editor is created. */
  readonly ready: Promise<void>;
  /** Replace editor contents with new markdown. */
  setMarkdown(markdown: string): void;
  /** Read current editor contents as markdown (best-effort serialization). */
  getMarkdown(): string;
  /**
   * 当前选区摘要（{from,to,empty}）。编辑器未就绪时返回 null。
   * 供 R3 上下文菜单启用/禁用与动作使用。
   */
  getSelection(): SelectionSummary | null;
  /**
   * 光标处的链接（href + 文本）。光标不在链接上或编辑器未就绪时返回 null。
   * 供 R3 链接的打开/复制地址使用。
   */
  getLinkAtCursor(): CursorLink | null;
  /**
   * 在当前选区上切换某个 mark（如 'strong'/'emphasis'/'strike_through'/'inlineCode'）。
   * 无选区或未就绪时为空操作。供 R3 上下文菜单格式操作使用。
   */
  toggleMark(markName: string): void;
  /**
   * 用链接 mark 包裹当前选区（href 来自调用方，通常由 prompt 取得）。
   * 无选区或未就绪时为空操作。供 R3 上下文菜单链接操作使用。
   */
  setLink(href: string): void;
  /** Tear the editor down (removes DOM, nulls listeners). */
  destroy(): Promise<void>;
}
