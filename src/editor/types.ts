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
}

/** Public handle returned from `mountEditor`. */
export interface EditorInstance {
  /** Promise that resolves once the underlying ProseMirror editor is created. */
  readonly ready: Promise<void>;
  /** Replace editor contents with new markdown. */
  setMarkdown(markdown: string): void;
  /** Read current editor contents as markdown (best-effort serialization). */
  getMarkdown(): string;
  /** Tear the editor down (removes DOM, nulls listeners). */
  destroy(): Promise<void>;
}
