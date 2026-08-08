/**
 * `source-view` — 整窗 WYSIWYG ↔ Markdown 源码模式切换（R10）。
 *
 * 设计（02-technical-solution.md R10）：单窗格切换。源码态把编辑区替换为纯文本视图，
 * 内容以 `getMarkdown()`/`setMarkdown()` 字符串往返；因数学为 decoration-only 模型，
 * 往返的是原始 Markdown 源（含原始 LaTeX），故行内/块级数学、表格两模式往返无丢失。
 * 任意时刻单窗格、无并排（R18 约束）。
 *
 * 分层：
 *   - `SourceModeController`（纯逻辑、headless 可测）：管理模式态 + 以
 *     `getMarkdown/setMarkdown` 字符串往返；`enterSource` 取快照、`exitSource` 写回。
 *   - `SourceView`（DOM 层、挂载态）：在标签宿主上叠加一个等宽 `<textarea>` 显示源码，
 *     进入时隐藏既有子节点、退出时还原并把 textarea 文本写回编辑器。
 *
 * 「带语法高亮」的实时高亮需要 CodeMirror 级组件（超出本任务依赖面）；MVP 以等宽
 * textarea 提供可编辑源码视图，实时高亮列为后续打磨项（见 concerns）。
 */

/** 编辑模式。 */
export type EditorMode = 'wysiwyg' | 'source';

/** 纯逻辑：切换模式。 */
export function toggleMode(mode: EditorMode): EditorMode {
  return mode === 'wysiwyg' ? 'source' : 'wysiwyg';
}

/** 编辑器的 Markdown 往返能力（EditorInstance 子集，便于测试注入）。 */
export interface SourceRoundtrip {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
}

/**
 * 纯逻辑：源码模式控制器。enterSource 取当前 Markdown 快照并切到 source；
 * exitSource 把（可能已编辑的）源码文本写回编辑器并切回 wysiwyg。
 * 因往返的是原始 Markdown 字符串，数学/表格的原始源（LaTeX/GFM）被完整保留。
 */
export class SourceModeController {
  private mode: EditorMode = 'wysiwyg';
  private snapshot = '';

  constructor(private readonly roundtrip: SourceRoundtrip) {}

  get currentMode(): EditorMode {
    return this.mode;
  }

  isSourceMode(): boolean {
    return this.mode === 'source';
  }

  /** 进入源码模式：返回待显示的源码文本（= 编辑器当前 Markdown）。 */
  enterSource(): string {
    this.snapshot = this.roundtrip.getMarkdown();
    this.mode = 'source';
    return this.snapshot;
  }

  /** 退出源码模式：把源码文本写回编辑器（应用编辑）。 */
  exitSource(text: string): void {
    this.roundtrip.setMarkdown(text);
    this.mode = 'wysiwyg';
  }

  /** 不退出模式下把当前源码文本同步回编辑器（供源码态保存/大纲读取）。 */
  syncSource(text: string): void {
    if (this.mode !== 'source') return;
    this.roundtrip.setMarkdown(text);
    this.snapshot = text;
  }
}

/**
 * DOM 层：在宿主上叠加等宽 textarea 实现源码视图。进入时隐藏宿主既有子节点并追加
 * textarea（值为 Markdown 快照）；退出时把 textarea 文本写回编辑器并还原子节点显隐。
 * 属挂载态行为（同既有插件，仅断言工厂形态）；纯逻辑往返由 SourceModeController 覆盖。
 */
export class SourceView {
  private readonly controller: SourceModeController;
  private textarea: HTMLTextAreaElement | null = null;
  /** 进入时被隐藏的子节点，退出时还原。 */
  private hiddenChildren: HTMLElement[] = [];

  constructor(
    private readonly host: HTMLElement,
    roundtrip: SourceRoundtrip,
    private readonly doc: Document = document,
  ) {
    this.controller = new SourceModeController(roundtrip);
  }

  get isSourceMode(): boolean {
    return this.controller.isSourceMode();
  }

  /** 当前 textarea 文本（源码态供保存/大纲同步；非源码态返回空串）。 */
  private currentText(): string {
    return this.textarea?.value ?? '';
  }

  /** 进入源码模式。 */
  enter(): void {
    if (this.controller.isSourceMode()) return;
    const text = this.controller.enterSource();
    const textarea = this.doc.createElement('textarea');
    textarea.className = 'lightink-source-editor';
    textarea.value = text;
    textarea.spellcheck = false;
    // 隐藏既有子节点（编辑器 DOM），退出时还原。
    this.hiddenChildren = [];
    for (const child of Array.from(this.host.children)) {
      const el = child as HTMLElement;
      if (el.style.display !== 'none') {
        el.style.display = 'none';
        this.hiddenChildren.push(el);
      }
    }
    this.host.appendChild(textarea);
    this.textarea = textarea;
    textarea.focus();
  }

  /** 退出源码模式，把 textarea 文本写回编辑器。 */
  exit(): void {
    if (!this.controller.isSourceMode() || this.textarea === null) return;
    this.controller.exitSource(this.currentText());
    this.textarea.remove();
    this.textarea = null;
    for (const child of this.hiddenChildren) {
      child.style.display = '';
    }
    this.hiddenChildren = [];
  }

  /** 切换模式。 */
  toggle(): void {
    if (this.controller.isSourceMode()) {
      this.exit();
    } else {
      this.enter();
    }
  }

  /** 源码态下把当前 textarea 文本同步回编辑器（不退出）。 */
  syncToEditor(): void {
    this.controller.syncSource(this.currentText());
  }

  destroy(): void {
    this.exit();
  }
}
