/**
 * source-mode 纯逻辑测试（R10）：模式切换与 Markdown 字符串往返。
 *
 * 覆盖：toggleMode、SourceModeController 的 enter/exit 往返（含 LaTeX 公式、表格、
 * 流程图源码的原始保留）、syncSource。SourceView 的 DOM 叠加属挂载态（仅在此断言工厂形态）。
 */
import { describe, expect, it } from 'vitest';

import {
  applySourceHighlightMetrics,
  applySourceMetrics,
  EditorMode,
  SourceModeController,
  SourceView,
  toggleMode,
} from '../source-view.js';

/** 假往返：内存字符串模拟 getMarkdown/setMarkdown。 */
function fakeRoundtrip(initial = '') {
  let md = initial;
  return {
    getMarkdown: () => md,
    setMarkdown: (v: string) => {
      md = v;
    },
    current: () => md,
  };
}

describe('toggleMode (R10)', () => {
  it('switches between wysiwyg and source', () => {
    expect(toggleMode('wysiwyg')).toBe('source');
    expect(toggleMode('source')).toBe('wysiwyg');
  });
});

describe('SourceModeController roundtrip (R10)', () => {
  it('starts in wysiwyg and reports mode correctly', () => {
    const c = new SourceModeController(fakeRoundtrip());
    expect(c.currentMode).toBe('wysiwyg' as EditorMode);
    expect(c.isSourceMode()).toBe(false);
  });

  it('enter returns the current markdown and switches to source', () => {
    const rt = fakeRoundtrip('# 标题\n\n正文');
    const c = new SourceModeController(rt);
    const text = c.enterSource();
    expect(text).toBe('# 标题\n\n正文');
    expect(c.isSourceMode()).toBe(true);
  });

  it('exit writes the (edited) source back to the editor and returns to wysiwyg', () => {
    const rt = fakeRoundtrip('# 旧');
    const c = new SourceModeController(rt);
    c.enterSource();
    c.exitSource('# 新标题\n\n编辑后内容');
    expect(rt.current()).toBe('# 新标题\n\n编辑后内容');
    expect(c.isSourceMode()).toBe(false);
  });

  it('roundtrips LaTeX formulas, tables, and mermaid source without loss', () => {
    const md = [
      '# 文档',
      '',
      '行内 $a^2 + b^2 = c^2$ 公式。',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '| 列1 | 列2 |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '- 任务一',
    ].join('\n');
    const rt = fakeRoundtrip(md);
    const c = new SourceModeController(rt);
    const snapshot = c.enterSource();
    // 源码态可编辑：这里模拟「未改动」直接写回。
    c.exitSource(snapshot);
    expect(rt.current()).toBe(md);
  });

  it('syncSource updates the editor while staying in source mode', () => {
    const rt = fakeRoundtrip('# 旧');
    const c = new SourceModeController(rt);
    c.enterSource();
    c.syncSource('# 同步');
    expect(rt.current()).toBe('# 同步');
    expect(c.isSourceMode()).toBe(true);
  });

  it('syncSource is a no-op when not in source mode', () => {
    const rt = fakeRoundtrip('# 不变');
    const c = new SourceModeController(rt);
    c.syncSource('# 不应写入');
    expect(rt.current()).toBe('# 不变');
    expect(c.isSourceMode()).toBe(false);
  });
});

describe('SourceView (factory shape)', () => {
  it('exposes the SourceView class', () => {
    expect(typeof SourceView).toBe('function');
  });

  it('keeps textarea, highlight pre, and nested code on identical wrapping metrics', () => {
    const surface = { style: {} as Record<string, string> } as unknown as HTMLElement;
    const highlightCode = { style: {} as Record<string, string> } as unknown as HTMLElement;

    applySourceMetrics(surface);
    applySourceHighlightMetrics(highlightCode);

    expect(surface.style.whiteSpace).toBe('pre-wrap');
    expect(surface.style.wordBreak).toBe('break-word');
    expect(surface.style.overflowWrap).toBe('break-word');
    expect(surface.style.scrollbarGutter).toBe('stable');
    expect(surface.style.fontVariantLigatures).toBe('none');
    expect(highlightCode.style.fontSize).toBe('inherit');
    expect(highlightCode.style.lineHeight).toBe('inherit');
    expect(highlightCode.style.whiteSpace).toBe('inherit');
    expect(highlightCode.style.wordBreak).toBe('inherit');
  });
});
