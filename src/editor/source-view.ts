/**
 * `source-view` — 整窗 WYSIWYG ↔ Markdown 源码模式切换（R10）。
 *
 * 设计（02-technical-solution.md R10）：单窗格切换。源码态把编辑区替换为带语法高亮的
 * 纯文本视图，内容以 `getMarkdown()`/`setMarkdown()` 字符串往返；因数学为 decoration-only
 * 模型，往返的是原始 Markdown 源（含原始 LaTeX），故行内/块级数学、表格两模式往返无丢失。
 * 任意时刻单窗格、无并排（R18 约束）。
 *
 * 分层：
 *   - `SourceModeController`（纯逻辑、headless 可测）：管理模式态 + 以
 *     `getMarkdown/setMarkdown` 字符串往返；`enterSource` 取快照、`exitSource` 写回。
 *   - `SourceView`（DOM 层、挂载态）：在标签宿主上覆盖一个「透明 textarea + 背后高亮
 *     pre/code」的叠加层——textarea 负责可编辑输入（透明文字、可见光标），pre/code 经
 *     highlight.js（markdown 语法，复用 code-highlight 的 highlightCode + 共享 hljs 单例）
 *     提供语法高亮，二者按相同字体度量对齐、滚动同步。
 */

import hljs from 'highlight.js/lib/core';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';

import { highlightCode } from './plugins/code-highlight.js';

// 共享 hljs 单例（与 code-highlight.ts 同一实例）注册 markdown 语法，使 highlightCode
// 能高亮 Markdown 源。仅注册一次。
hljs.registerLanguage('markdown', hljsMarkdown);

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

/** textarea 与 pre 共享的字体度量（必须一致以保证高亮层与输入层逐行对齐）。 */
function applySourceMetrics(el: HTMLElement): void {
  el.style.boxSizing = 'border-box';
  el.style.margin = '0';
  el.style.border = 'none';
  el.style.padding = '8px';
  el.style.fontFamily = 'monospace';
  el.style.fontSize = '14px';
  el.style.lineHeight = '1.5';
  el.style.whiteSpace = 'pre-wrap';
  el.style.wordBreak = 'break-word';
}

/** 把 Markdown 源高亮为 HTML（末尾加换行使最后一行行高与 textarea 对齐）。 */
function renderHighlightedSource(source: string): string {
  return `${highlightCode('markdown', source)}\n`;
}

/**
 * DOM 层：在宿主上覆盖「透明 textarea + 背后高亮 pre/code」叠加层实现可编辑的带高亮
 * 源码视图。进入时把宿主置为定位上下文并覆盖一层不透明背景（隐藏背后编辑器、避免宿主
 * 塌陷）；退出时把 textarea 文本写回编辑器并移除叠加层。属挂载态行为（同既有插件，仅
 * 断言工厂形态）；纯逻辑往返由 SourceModeController 覆盖。
 */
export class SourceView {
  private readonly controller: SourceModeController;
  private wrapper: HTMLDivElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private savedHostPosition = '';
  /** 最近一次同步到编辑器的文本（用于跳过无变化的冗余 setMarkdown/解析）。 */
  private lastSynced = '';

  constructor(private readonly host: HTMLElement, roundtrip: SourceRoundtrip) {
    this.controller = new SourceModeController(roundtrip);
  }

  get isSourceMode(): boolean {
    return this.controller.isSourceMode();
  }

  private currentText(): string {
    return this.textarea?.value ?? '';
  }

  /** 进入源码模式。 */
  enter(): void {
    if (this.controller.isSourceMode() || this.wrapper !== null) return;
    const text = this.controller.enterSource();
    const doc = this.host.ownerDocument;

    const wrapper = doc.createElement('div');
    wrapper.className = 'lightink-source-overlay';
    wrapper.style.position = 'absolute';
    wrapper.style.inset = '0';
    wrapper.style.zIndex = '10';
    wrapper.style.background = '#ffffff';
    wrapper.style.overflow = 'hidden';

    const pre = doc.createElement('pre');
    pre.style.position = 'absolute';
    pre.style.inset = '0';
    pre.style.overflow = 'auto';
    pre.style.pointerEvents = 'none';
    pre.style.color = '#333333';
    applySourceMetrics(pre);

    const code = doc.createElement('code');
    code.className = 'hljs language-markdown';
    code.innerHTML = renderHighlightedSource(text);
    pre.appendChild(code);

    const textarea = doc.createElement('textarea');
    textarea.className = 'lightink-source-editor';
    textarea.style.position = 'absolute';
    textarea.style.inset = '0';
    textarea.style.overflow = 'auto';
    textarea.style.background = 'transparent';
    textarea.style.color = 'transparent';
    textarea.style.caretColor = '#333333';
    textarea.style.outline = 'none';
    textarea.style.resize = 'none';
    applySourceMetrics(textarea);
    textarea.value = text;
    textarea.spellcheck = false;

    const onInput = (): void => {
      code.innerHTML = renderHighlightedSource(textarea.value);
      // 即时同步（target 阶段，先于 host 的 handleContentChanged 冒泡）：让背后编辑器
      // 跟随 textarea，使脏标记/崩溃快照/导出/大纲等所有读取 editor 的站点都读到最新源码。
      this.syncIfChanged();
    };
    const onScroll = (): void => {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    };
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('scroll', onScroll);

    wrapper.appendChild(pre);
    wrapper.appendChild(textarea);

    this.savedHostPosition = this.host.style.position;
    this.host.style.position = 'relative';
    this.host.appendChild(wrapper);

    this.wrapper = wrapper;
    this.textarea = textarea;
    this.lastSynced = text;
    textarea.focus();
  }

  /** 退出源码模式，把 textarea 文本写回编辑器。 */
  exit(): void {
    if (!this.controller.isSourceMode() || this.wrapper === null) return;
    this.controller.exitSource(this.currentText());
    this.wrapper.remove();
    this.wrapper = null;
    this.textarea = null;
    this.host.style.position = this.savedHostPosition;
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
    this.lastSynced = this.currentText();
  }

  /** 仅当 textarea 文本相对上次同步有变化时才 setMarkdown（跳过冗余解析）。 */
  private syncIfChanged(): void {
    const value = this.currentText();
    if (value !== this.lastSynced) {
      this.controller.syncSource(value);
      this.lastSynced = value;
    }
  }

  destroy(): void {
    this.exit();
  }
}
