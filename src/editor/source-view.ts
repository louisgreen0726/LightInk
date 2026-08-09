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
import { convertHtmlToMarkdown } from './html-to-markdown.js';

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
export function applySourceMetrics(el: HTMLElement): void {
  el.style.boxSizing = 'border-box';
  el.style.margin = '0';
  el.style.border = 'none';
  el.style.padding = '8px';
  // 与 theme.css 编辑器代码字体同一字体栈：高亮层 <code> 受
  // `.lightink-tab-host code` 规则影响，若两层字体不同，字形宽度逐字漂移，
  // 选区洗色与可见文字错位（用户感知为「源码模式选中有问题」）。
  el.style.fontFamily = 'var(--lightink-font-mono, "Cascadia Code", "JetBrains Mono", Consolas, monospace)';
  // Follow reading zoom: tier code size × user font scale (same as code blocks).
  el.style.fontSize = 'calc(var(--lightink-font-size-code, 13.5px) * var(--lightink-font-scale, 1))';
  el.style.lineHeight = 'var(--lightink-line-height-code, 1.55)';
  el.style.whiteSpace = 'pre-wrap';
  el.style.wordBreak = 'break-word';
  el.style.overflowWrap = 'break-word';
  el.style.fontVariantLigatures = 'none';
  el.style.tabSize = '2';
  // 字距/字偶距必须两层一致（2026-08-09 实测错位根因）：
  //   - textarea 的 UA 默认 letter-spacing: normal，而高亮层继承
  //     `.lightink-tab-host` 的 0.01em（按宿主字号折算的绝对值随继承链下传）；
  //   - 根节点的 text-rendering: optimizeLegibility 会继承到高亮层并启用
  //     kerning，textarea 则是 auto——每个字偶对推进宽度不同，逐字累积漂移。
  el.style.letterSpacing = 'normal';
  el.style.textRendering = 'auto';
  // 关掉字偶距/连字相关 OpenType 特性，避免高亮层与 textarea 几何再分叉。
  el.style.fontKerning = 'none';
  el.style.fontFeatureSettings = '"liga" 0, "calt" 0';
  // textarea 的垂直滚动条不能独占内容宽度，否则它会比背后的 pre 提前折行。
  el.style.scrollbarGutter = 'stable';
}

/**
 * 中和 `.lightink-tab-host code { font-size: 0.92em }` 等通用行内代码规则。
 * 高亮 code 必须完整继承 pre 的度量，否则长行与透明 textarea 的折行点不同，
 * 原生选区背景便会覆盖到另一段可见源码上。
 */
export function applySourceHighlightMetrics(el: HTMLElement): void {
  el.style.fontFamily = 'inherit';
  el.style.fontSize = 'inherit';
  el.style.lineHeight = 'inherit';
  el.style.whiteSpace = 'inherit';
  el.style.wordBreak = 'inherit';
  el.style.overflowWrap = 'inherit';
  el.style.fontVariantLigatures = 'inherit';
  el.style.tabSize = 'inherit';
  el.style.letterSpacing = 'inherit';
  el.style.textRendering = 'inherit';
  el.style.fontKerning = 'inherit';
  el.style.fontFeatureSettings = 'inherit';
  el.style.fontWeight = 'inherit';
  el.style.fontStyle = 'inherit';
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
  /** 高亮层 <code> 元素（enter 时创建，随 overlay 移除）。 */
  private codeEl: HTMLElement | null = null;
  private savedHostPosition = '';
  private savedHostHeight = '';
  private savedHostOverflow = '';
  /** 进入源码前编辑区 overflow，退出时还原（避免双滚动条）。 */
  private savedAreaOverflow = '';
  private savedAreaOverflowX = '';
  private savedAreaOverflowY = '';
  /** 源码态视口尺寸跟随（enter 注册，exit 移除）。 */
  private onWindowResize: (() => void) | null = null;
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
    wrapper.style.background = 'var(--lightink-bg)';
    wrapper.style.overflow = 'hidden';

    const pre = doc.createElement('pre');
    // 专用类：theme.css 据此中和 `.lightink-tab-host pre` 的代码块样式
    //（背景/边框/圆角/滚动条样式会泄漏进源码叠加层）。
    pre.className = 'lightink-source-highlight';
    pre.style.position = 'absolute';
    pre.style.inset = '0';
    // overflow hidden：滚动只由 textarea 同步驱动（hidden 仍可编程滚动），
    // 否则 pre/textarea/编辑区三层各出一条滚动条（双滚动条问题）。
    pre.style.overflow = 'hidden';
    pre.style.pointerEvents = 'none';
    pre.style.color = 'var(--lightink-fg)';
    pre.style.background = 'transparent';
    applySourceMetrics(pre);

    const code = doc.createElement('code');
    code.className = 'hljs language-markdown';
    applySourceHighlightMetrics(code);
    code.innerHTML = renderHighlightedSource(text);
    pre.appendChild(code);

    const textarea = doc.createElement('textarea');
    textarea.className = 'lightink-source-editor';
    textarea.style.position = 'absolute';
    textarea.style.inset = '0';
    textarea.style.overflow = 'auto';
    textarea.style.background = 'transparent';
    textarea.style.color = 'transparent';
    textarea.style.caretColor = 'var(--lightink-fg)';
    textarea.style.outline = 'none';
    textarea.style.resize = 'none';
    applySourceMetrics(textarea);
    textarea.value = text;
    textarea.spellcheck = false;

    const onInput = (): void => {
      this.refreshFromTextarea();
    };
    const onScroll = (): void => {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    };
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('scroll', onScroll);
    // R8：源码模式粘贴富文本（text/html）同样转结构化 Markdown 插入，不插入原始
    // HTML 标签；无 text/html 或转换失败则回落原生纯文本粘贴，保证不丢内容。
    const onPaste = (event: ClipboardEvent): void => {
      const cd = event.clipboardData;
      if (cd === null) return;
      const pastedHtml = cd.getData('text/html');
      if (pastedHtml === '') return;
      const md = convertHtmlToMarkdown(pastedHtml);
      if (md === '') return; // 回落原生纯文本粘贴
      event.preventDefault();
      const ta2 = this.textarea;
      if (ta2 === null) return;
      // 用 execCommand('insertText') 走 textarea 原生 undo 栈，Ctrl+Z 可回退
      // （同 R2 源码替换取舍）；宿主不支持时回退 setRangeText，保证内容不丢。
      ta2.focus();
      let inserted = false;
      try {
        inserted = doc.execCommand('insertText', false, md);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        ta2.setRangeText(md, ta2.selectionStart, ta2.selectionEnd, 'end');
      }
      this.refreshFromTextarea();
    };
    textarea.addEventListener('paste', onPaste);

    wrapper.appendChild(pre);
    wrapper.appendChild(textarea);

    this.savedHostPosition = this.host.style.position;
    this.savedHostHeight = this.host.style.height;
    this.savedHostOverflow = this.host.style.overflow;
    this.host.style.position = 'relative';
    // 源码态把宿主钳制到编辑区视口高并裁掉溢出：背后的 WYSIWYG 内容不再
    // 撑长页面（编辑区不出现页面级滚动条），滚动完全由 textarea 承担，
    // 整个源码模式只留一条滚动条。
    this.host.style.overflow = 'hidden';
    const area = this.host.parentElement;
    // 同时锁住编辑区本身的 overflow：仅关 host 时，#lightink-editor-area 仍可能
    // 因 host 内边距/测量时序或底层 ProseMirror 残留高度出现第二条滚动条
    // （2026-08-09 Tauri 实测双滚动条）。
    if (area !== null) {
      this.savedAreaOverflow = area.style.overflow;
      this.savedAreaOverflowX = area.style.overflowX;
      this.savedAreaOverflowY = area.style.overflowY;
      area.style.overflow = 'hidden';
    } else {
      this.savedAreaOverflow = '';
      this.savedAreaOverflowX = '';
      this.savedAreaOverflowY = '';
    }
    const fitViewport = (): void => {
      if (area !== null) {
        this.host.style.height = `${area.clientHeight}px`;
      }
    };
    fitViewport();
    window.addEventListener('resize', fitViewport);
    this.onWindowResize = fitViewport;
    this.host.appendChild(wrapper);

    this.wrapper = wrapper;
    this.textarea = textarea;
    this.codeEl = code;
    this.lastSynced = text;
    textarea.focus();
  }

  /** 高亮层重绘 + 变更同步（textarea 内容变化的统一入口）。 */
  private refreshFromTextarea(): void {
    if (this.codeEl !== null && this.textarea !== null) {
      this.codeEl.innerHTML = renderHighlightedSource(this.textarea.value);
    }
    // 即时同步（先于 host 的 handleContentChanged 冒泡）：让背后编辑器
    // 跟随 textarea，使脏标记/崩溃快照/导出/大纲等所有读取 editor 的站点都读到最新源码。
    this.syncIfChanged();
  }

  /**
   * 在源码 textarea 光标处插入片段并同步回编辑器（源码态下「插入」菜单的
   * 统一路径；非源码态为空操作）。插入后光标落在片段末尾。
   */
  insertSnippetAtCursor(text: string): void {
    if (!this.controller.isSourceMode() || this.textarea === null) return;
    const ta = this.textarea;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    this.refreshFromTextarea();
    ta.focus();
  }

  /** 源码 textarea 是否有非空选区（源码态右键菜单的启用判定）。 */
  hasTextSelection(): boolean {
    if (!this.controller.isSourceMode() || this.textarea === null) return false;
    return this.textarea.selectionEnd > this.textarea.selectionStart;
  }

  /** 聚焦源码 textarea（右键菜单剪贴板动作执行前确保 execCommand 作用于它）。 */
  focusEditor(): void {
    this.textarea?.focus();
  }

  /** 源码态全选 textarea（R10 菜单「全选」）。非源码态为空操作。 */
  selectAll(): void {
    if (!this.controller.isSourceMode() || this.textarea === null) return;
    const ta = this.textarea;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  }

  /** 退出源码模式，把 textarea 文本写回编辑器。 */
  exit(): void {
    if (!this.controller.isSourceMode() || this.wrapper === null) return;
    this.controller.exitSource(this.currentText());
    if (this.onWindowResize !== null) {
      window.removeEventListener('resize', this.onWindowResize);
      this.onWindowResize = null;
    }
    this.wrapper.remove();
    this.wrapper = null;
    this.textarea = null;
    this.codeEl = null;
    this.host.style.position = this.savedHostPosition;
    this.host.style.height = this.savedHostHeight;
    this.host.style.overflow = this.savedHostOverflow;
    const area = this.host.parentElement;
    if (area !== null) {
      area.style.overflow = this.savedAreaOverflow;
      area.style.overflowX = this.savedAreaOverflowX;
      area.style.overflowY = this.savedAreaOverflowY;
    }
    this.savedAreaOverflow = '';
    this.savedAreaOverflowX = '';
    this.savedAreaOverflowY = '';
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
