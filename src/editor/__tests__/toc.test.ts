/**
 * [TOC] 目录插件（T2 / R6）纯逻辑与 decoration 行为测试。
 *
 * 覆盖：
 *   - 标记段落检测（仅整段 `[TOC]` 触发）；
 *   - 标题树收集（文档顺序 / 层级 / 文本 / 位置）；
 *   - 顶层限定：嵌套在引用/列表内的 `[TOC]` 段落不触发；
 *   - 点击重定位：按文本+序号在当前文档重匹配标题位置；
 *   - 防抖重建语义（变更先映射、refresh meta 统一重建）；
 *   - 文档不被改写，且真实 remark 序列化栈往返安全（`[TOC]` → `\[TOC]`
 *     转义形式 → 重解析还原为字面 `[TOC]` 段落，二次序列化稳定）。
 *
 * widget DOM 渲染与点击跳转依赖浏览器，不在 node 环境覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';

import {
  parseMarkdownToMdast,
  roundTripMarkdown,
} from '../parser.js';
import {
  TOC_MARK,
  TOC_PLUGIN_KEY,
  TOC_REFRESH_META,
  TOC_REBUILD_DEBOUNCE_MS,
  collectTocHeadings,
  collectTocParagraphPositions,
  createTocProsePlugin,
  debounce,
  isTocParagraphNode,
  resolveHeadingPos,
} from '../plugins/toc.js';

/** Minimal schema mirroring Milkdown doc/paragraph/heading plus containers. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    heading: {
      group: 'block',
      content: 'text*',
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${String(node.attrs['level'])}`, 0],
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      toDOM: () => ['blockquote', 0],
    },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      toDOM: () => ['ul', 0],
    },
    list_item: {
      content: 'block+',
      toDOM: () => ['li', 0],
    },
    text: { group: 'inline' },
  },
});

type BlockSpec =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string };

function makeState(blocks: BlockSpec[], withPlugin = false): EditorState {
  const nodes = blocks.map((block) => {
    if (block.kind === 'h') {
      return schema.nodes.heading!.create(
        { level: block.level },
        block.text === '' ? undefined : schema.text(block.text),
      );
    }
    return schema.nodes.paragraph!.create(
      null,
      block.text === '' ? undefined : schema.text(block.text),
    );
  });
  const doc = schema.nodes.doc!.create(null, nodes);
  return EditorState.create({
    doc,
    schema,
    plugins: withPlugin ? [createTocProsePlugin()] : [],
  });
}

function decorationCount(state: EditorState): number {
  const set = TOC_PLUGIN_KEY.getState(state);
  return set === undefined ? 0 : set.find().length;
}

describe('isTocParagraphNode', () => {
  it('true only for a paragraph whose whole text is the literal marker', () => {
    const marker = makeState([{ kind: 'p', text: TOC_MARK }]);
    const markerNode = marker.doc.nodeAt(0)!;
    expect(isTocParagraphNode(markerNode)).toBe(true);

    const padded = makeState([{ kind: 'p', text: '  [TOC]  ' }]);
    expect(isTocParagraphNode(padded.doc.nodeAt(0)!)).toBe(true);
  });

  it('false for mixed text, headings, and lowercase variants', () => {
    const mixed = makeState([
      { kind: 'p', text: '[TOC] extra' },
      { kind: 'p', text: 'see [TOC]' },
      { kind: 'p', text: '[toc]' },
      { kind: 'h', level: 1, text: '[TOC]' },
    ]);
    const found: boolean[] = [];
    mixed.doc.descendants((node) => {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        found.push(isTocParagraphNode(node));
      }
    });
    expect(found).toEqual([false, false, false, false]);
  });
});

describe('collectTocParagraphPositions', () => {
  it('collects every marker paragraph and nothing else', () => {
    const state = makeState([
      { kind: 'h', level: 1, text: '标题' },
      { kind: 'p', text: TOC_MARK },
      { kind: 'p', text: '正文' },
      { kind: 'p', text: TOC_MARK },
    ]);
    const positions = collectTocParagraphPositions(state.doc);
    expect(positions).toHaveLength(2);
    for (const pos of positions) {
      const node = state.doc.nodeAt(pos)!;
      expect(node.type.name).toBe('paragraph');
      expect(node.textContent).toBe(TOC_MARK);
    }
  });

  it('returns empty when no marker paragraph exists', () => {
    const state = makeState([
      { kind: 'h', level: 2, text: '仅标题' },
      { kind: 'p', text: '正文 [TOC] 行内不触发' },
    ]);
    expect(collectTocParagraphPositions(state.doc)).toEqual([]);
  });

  it('ignores marker paragraphs nested inside blockquotes and lists', () => {
    const paragraph = (text: string) =>
      schema.nodes.paragraph!.create(null, schema.text(text));
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.blockquote!.create(null, [paragraph(TOC_MARK)]),
      schema.nodes.bullet_list!.create(null, [
        schema.nodes.list_item!.create(null, [paragraph(TOC_MARK)]),
      ]),
      paragraph(TOC_MARK), // 顶层：唯一应触发的标记段落
    ]);
    const positions = collectTocParagraphPositions(doc);
    expect(positions).toHaveLength(1);
    const node = doc.nodeAt(positions[0]!)!;
    expect(node.type.name).toBe('paragraph');
    expect(node.textContent).toBe(TOC_MARK);
  });
});

describe('collectTocHeadings', () => {
  it('returns headings in document order with level, text, and pos', () => {
    const state = makeState([
      { kind: 'h', level: 1, text: '一级' },
      { kind: 'p', text: TOC_MARK },
      { kind: 'h', level: 2, text: '二级' },
      { kind: 'h', level: 3, text: '三级' },
    ]);
    const headings = collectTocHeadings(state.doc);
    expect(headings.map((h) => [h.level, h.text])).toEqual([
      [1, '一级'],
      [2, '二级'],
      [3, '三级'],
    ]);
    for (const heading of headings) {
      const node = state.doc.nodeAt(heading.pos)!;
      expect(node.type.name).toBe('heading');
      expect(node.textContent).toBe(heading.text);
    }
  });

  it('returns empty for a heading-less document (widget shows empty state)', () => {
    const state = makeState([
      { kind: 'p', text: TOC_MARK },
      { kind: 'p', text: '没有标题' },
    ]);
    expect(collectTocHeadings(state.doc)).toEqual([]);
  });
});

describe('resolveHeadingPos', () => {
  it('locates the nth same-text heading in the current document', () => {
    const state = makeState([
      { kind: 'h', level: 1, text: '重复' },
      { kind: 'p', text: TOC_MARK },
      { kind: 'h', level: 2, text: '唯一' },
      { kind: 'h', level: 2, text: '重复' },
    ]);
    const headings = collectTocHeadings(state.doc);
    expect(resolveHeadingPos(state.doc, '重复', 0)).toBe(headings[0]!.pos);
    expect(resolveHeadingPos(state.doc, '重复', 1)).toBe(headings[2]!.pos);
    expect(resolveHeadingPos(state.doc, '唯一', 0)).toBe(headings[1]!.pos);
  });

  it('follows edits made inside the debounce window (no stale build-time pos)', () => {
    const before = makeState([
      { kind: 'h', level: 1, text: '标题' },
      { kind: 'p', text: TOC_MARK },
      { kind: 'h', level: 2, text: '目标' },
    ]);
    const buildTimePos = collectTocHeadings(before.doc)[1]!.pos;

    // 防抖窗口内在目标标题前插入一个新标题：旧 pos 偏移，重定位仍命中。
    const after = before.apply(
      before.tr.insert(0, schema.nodes.heading!.create({ level: 1 }, schema.text('新标题'))),
    );
    const targetNode = after.doc.nodeAt(
      collectTocHeadings(after.doc).find((h) => h.text === '目标')!.pos,
    )!;
    expect(targetNode.textContent).toBe('目标');
    expect(after.doc.nodeAt(buildTimePos)!.textContent).not.toBe('目标');

    const resolved = resolveHeadingPos(after.doc, '目标', 0);
    expect(resolved).not.toBeNull();
    expect(after.doc.nodeAt(resolved!)).toBe(targetNode);
  });

  it('returns null when the heading no longer exists', () => {
    const state = makeState([
      { kind: 'h', level: 1, text: '标题' },
      { kind: 'p', text: TOC_MARK },
    ]);
    expect(resolveHeadingPos(state.doc, '不存在', 0)).toBeNull();
    expect(resolveHeadingPos(state.doc, '标题', 1)).toBeNull();
  });
});

describe('remark 序列化往返（真实 serializer 栈）', () => {
  it('serializes [TOC] in escaped form, reparses to the literal marker, stays stable', () => {
    const source = `# 标题\n\n${TOC_MARK}\n\n正文\n`;

    // 产品约定：remark-stringify 把 [TOC] 转义为 \[TOC]（link 语法消歧），
    // 用户源码在保存时被规范化为转义形式。
    const once = roundTripMarkdown(source);
    expect(once).toContain(`\\${TOC_MARK}`);
    expect(once).not.toContain(`\n${TOC_MARK}\n`);

    // 重解析：转义形式还原为字面 [TOC] 的段落文本，PM 侧仍触发目录。
    const reparsed = parseMarkdownToMdast(once);
    const markerParagraph = reparsed.children.find(
      (child) => child.type === 'paragraph',
    );
    expect(markerParagraph).toBeDefined();
    const text = (markerParagraph as { children: Array<{ value?: string }> })
      .children
      .map((child) => child.value ?? '')
      .join('');
    expect(text).toBe(TOC_MARK);
    const state = makeState([
      { kind: 'h', level: 1, text: '标题' },
      { kind: 'p', text },
      { kind: 'p', text: '正文' },
    ]);
    expect(collectTocParagraphPositions(state.doc)).toHaveLength(1);

    // 二次序列化稳定：转义形式再往返不再变化。
    expect(roundTripMarkdown(once)).toBe(once);
  });
});

describe('debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses rapid calls into one trailing invocation with latest args', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, TOC_REBUILD_DEBOUNCE_MS);

    debounced('a');
    debounced('b');
    debounced('c');
    vi.advanceTimersByTime(TOC_REBUILD_DEBOUNCE_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('cancel() prevents a pending invocation', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, TOC_REBUILD_DEBOUNCE_MS);
    debounced('x');
    debounced.cancel();
    vi.advanceTimersByTime(TOC_REBUILD_DEBOUNCE_MS * 2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('toc prose plugin decorations (headless)', () => {
  it('adds widget + hiding node decoration per marker paragraph', () => {
    const state = makeState(
      [
        { kind: 'h', level: 1, text: '标题' },
        { kind: 'p', text: TOC_MARK },
        { kind: 'p', text: '正文' },
      ],
      true,
    );
    // 1 widget（目录）+ 1 node decoration（隐藏字面段落）= 2
    expect(decorationCount(state)).toBe(2);
  });

  it('does not alter the document: literal [TOC] paragraph survives (round-trip safe)', () => {
    const state = makeState(
      [
        { kind: 'p', text: TOC_MARK },
        { kind: 'h', level: 1, text: '标题' },
      ],
      true,
    );
    expect(state.doc.textContent).toContain(TOC_MARK);
    expect(collectTocParagraphPositions(state.doc)).toHaveLength(1);
  });

  it('rebuilds decorations only on the debounced refresh meta, not per doc change', () => {
    const state = makeState([{ kind: 'h', level: 1, text: '标题' }], true);
    expect(decorationCount(state)).toBe(0);

    // 文档变更（插入 [TOC] 段落）：防抖窗口内 decoration 仅映射，不重建。
    const tr = state.tr.insert(
      0,
      schema.nodes.paragraph!.create(null, schema.text(TOC_MARK)),
    );
    const changed = state.apply(tr);
    expect(decorationCount(changed)).toBe(0);

    // 防抖调度注入的 refresh meta：统一重建。
    const refreshed = changed.apply(
      changed.tr.setMeta(TOC_PLUGIN_KEY, TOC_REFRESH_META),
    );
    expect(decorationCount(refreshed)).toBe(2);
  });

  it('drops decorations when the marker paragraph is removed after refresh', () => {
    const state = makeState(
      [
        { kind: 'p', text: TOC_MARK },
        { kind: 'h', level: 1, text: '标题' },
      ],
      true,
    );
    expect(decorationCount(state)).toBe(2);

    const tocPos = collectTocParagraphPositions(state.doc)[0]!;
    const tocNode = state.doc.nodeAt(tocPos)!;
    const removed = state.apply(
      state.tr.delete(tocPos, tocPos + tocNode.nodeSize),
    );
    // 删除后映射为空，refresh 后仍为空。
    const refreshed = removed.apply(
      removed.tr.setMeta(TOC_PLUGIN_KEY, TOC_REFRESH_META),
    );
    expect(decorationCount(refreshed)).toBe(0);
  });
});
