/**
 * 按标题折叠插件（T4 / R2）纯逻辑 + 插件态 + 光标守卫测试。
 *
 * 覆盖：
 *   - 折叠区间 = 该标题后到下一个同级/更高级标题前（更深子标题及其内容一并落入）；
 *   - 无可折叠内容 / 位置已非标题 → null；
 *   - 多折叠区间计算；折叠位置 mapping 迁移 + 失效复验；
 *   - toggleFold 增删与失效守卫；
 *   - 插件态：toggle meta 即时更新集合与 decoration；文档变更迁移位置；
 *   - 光标守卫：空选区落入折叠区间 → appendTransaction 移到该标题（可见）；
 *   - buildFoldDecorations：折叠区间每个顶层块得到 display:none node decoration。
 *
 * 三角 widget DOM 渲染依赖浏览器，不在 node 环境覆盖（factory 惰性不被调用）。
 */

import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';

import {
  FOLD_PLUGIN_KEY,
  buildFoldDecorations,
  collectHeadings,
  computeFoldedRanges,
  createHeadingFoldProsePlugin,
  foldRangeForHeading,
  foldSetEqual,
  migrateFolded,
  toggleFold,
} from '../plugins/heading-fold.js';

/** Minimal schema mirroring Milkdown doc/paragraph/heading + text. */
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
    text: {},
  },
});

interface Block {
  readonly type: 'heading' | 'paragraph';
  readonly level?: number;
  readonly text: string;
}

/** 从块描述构建顶层文档（heading/paragraph 顶层排列）。 */
function buildDoc(blocks: readonly Block[]): import('@milkdown/prose/model').Node {
  const nodes = blocks.map((block) => {
    if (block.type === 'heading') {
      return schema.nodes.heading!.create(
        { level: block.level ?? 1 },
        block.text === '' ? undefined : schema.text(block.text),
      );
    }
    return schema.nodes.paragraph!.create(
      null,
      block.text === '' ? undefined : schema.text(block.text),
    );
  });
  return schema.nodes.doc!.create(null, nodes);
}

/** 取 [from, to) 内的顶层节点文本（按 nodeSize 步进）。 */
function rangeTexts(
  doc: import('@milkdown/prose/model').Node,
  from: number,
  to: number,
): string[] {
  const out: string[] = [];
  let pos = from;
  while (pos < to) {
    const node = doc.nodeAt(pos);
    if (node === null) break;
    out.push(node.textContent);
    pos += node.nodeSize;
  }
  return out;
}

describe('foldRangeForHeading', () => {
  it('折叠区间 = 标题后到下一个同级标题前', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'para1' },
      { type: 'paragraph', text: 'para2' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos = collectHeadings(doc)[0]!.pos;
    const range = foldRangeForHeading(doc, aPos);
    expect(range).not.toBeNull();
    expect(rangeTexts(doc, range!.from, range!.to)).toEqual(['para1', 'para2']);
  });

  it('更深的子标题及其内容落入父标题折叠区间', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'heading', level: 2, text: 'A1' },
      { type: 'paragraph', text: 'under-A1' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos = collectHeadings(doc)[0]!.pos;
    const range = foldRangeForHeading(doc, aPos);
    expect(range).not.toBeNull();
    // 折叠 A 隐藏 ## A1 与其下内容，直到 # B。
    expect(rangeTexts(doc, range!.from, range!.to)).toEqual(['A1', 'under-A1']);
  });

  it('折叠到同级或更高级标题前：h2 折叠在下一个 h1 或 h2 前（不停于 h3）', () => {
    const doc = buildDoc([
      { type: 'heading', level: 2, text: 'X' },
      { type: 'paragraph', text: 'p1' },
      { type: 'heading', level: 3, text: 'deeper' },
      { type: 'paragraph', text: 'p2' },
      { type: 'heading', level: 2, text: 'Y' },
    ]);
    const xPos = collectHeadings(doc)[0]!.pos;
    const range = foldRangeForHeading(doc, xPos);
    expect(range).not.toBeNull();
    // h2 X 折叠覆盖其后的 p1 + ### deeper + p2，直到 h2 Y。
    expect(rangeTexts(doc, range!.from, range!.to)).toEqual(['p1', 'deeper', 'p2']);
  });

  it('无可折叠内容（紧接同级/更高级标题）→ null', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos = collectHeadings(doc)[0]!.pos;
    expect(foldRangeForHeading(doc, aPos)).toBeNull();
  });

  it('位置已非标题 → null', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p' },
    ]);
    const paraPos = collectHeadings(doc)[0]!.pos + 3; // 落到 paragraph
    expect(foldRangeForHeading(doc, paraPos)).toBeNull();
  });

  it('折叠区间延伸到文档末（无后续同级/更高级标题）', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'tail1' },
      { type: 'paragraph', text: 'tail2' },
    ]);
    const aPos = collectHeadings(doc)[0]!.pos;
    const range = foldRangeForHeading(doc, aPos);
    expect(range).not.toBeNull();
    expect(rangeTexts(doc, range!.from, range!.to)).toEqual(['tail1', 'tail2']);
    expect(range!.to).toBe(doc.content.size);
  });
});

describe('computeFoldedRanges', () => {
  it('对每个折叠标题计算区间，失效位置跳过', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'a' },
      { type: 'heading', level: 1, text: 'B' },
      { type: 'paragraph', text: 'b' },
    ]);
    const [aPos, bPos] = collectHeadings(doc).map((h) => h.pos);
    const ranges = computeFoldedRanges(doc, new Set([aPos, bPos, 999999]));
    expect(ranges).toHaveLength(2);
    expect(ranges.some((r) => r.headingPos === aPos)).toBe(true);
    expect(ranges.some((r) => r.headingPos === bPos)).toBe(true);
  });
});

describe('toggleFold', () => {
  it('增加 / 移除折叠位置', () => {
    const doc = buildDoc([{ type: 'heading', level: 1, text: 'A' }]);
    const pos = collectHeadings(doc)[0]!.pos;
    const afterAdd = toggleFold(new Set(), pos, doc);
    expect(afterAdd.has(pos)).toBe(true);
    const afterRemove = toggleFold(afterAdd, pos, doc);
    expect(afterRemove.has(pos)).toBe(false);
  });

  it('非标题位置不改变集合', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p' },
    ]);
    const base = new Set([collectHeadings(doc)[0]!.pos]);
    const paraPos = collectHeadings(doc)[0]!.pos + 3;
    const next = toggleFold(base, paraPos, doc);
    expect([...next]).toEqual([...base]);
  });
});

describe('migrateFolded', () => {
  it('文档变更后位置经 mapping 平移且仍复验为 heading', () => {
    // 初始：A, p, B。折叠 B。在 A 前插入新段落 → B 位置后移。
    const doc0 = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const bPos0 = collectHeadings(doc0)[1]!.pos;
    const tr = (state: import('@milkdown/prose/model').Node) => {
      const s = EditorState.create({ doc: state });
      const insert = schema.nodes.paragraph!.create(null, schema.text('new'));
      return s.tr.insert(0, insert);
    };
    const t = tr(doc0);
    const migrated = migrateFolded(new Set([bPos0]), t);
    // B 迁移后位置应等于新文档中 B 的实际位置。
    const bPosNew = collectHeadings(t.doc)[1]!.pos;
    expect([...migrated]).toEqual([bPosNew]);
  });

  it('折叠的标题被删除 → 失效位置丢弃', () => {
    const doc0 = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos0 = collectHeadings(doc0)[0]!.pos;
    const state = EditorState.create({ doc: doc0 });
    // 删除 A 标题节点（pos 0, nodeSize 3）。
    const t = state.tr.delete(0, 3);
    const migrated = migrateFolded(new Set([aPos0]), t);
    expect(migrated.size).toBe(0);
  });
});

describe('foldSetEqual', () => {
  it('同元素等、不同不等（与顺序无关）', () => {
    expect(foldSetEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(foldSetEqual(new Set([1, 2]), new Set([1, 2, 3]))).toBe(false);
    expect(foldSetEqual(new Set([1]), new Set([2]))).toBe(false);
  });
});

describe('createHeadingFoldProsePlugin 态', () => {
  function stateWith(blocks: readonly Block[]): EditorState {
    return EditorState.create({
      doc: buildDoc(blocks),
      plugins: [createHeadingFoldProsePlugin()],
    });
  }

  it('toggle meta 即时把标题加入折叠集合', () => {
    let state = stateWith([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos = collectHeadings(state.doc)[0]!.pos;
    state = state.apply(state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: aPos }));
    expect(FOLD_PLUGIN_KEY.getState(state)!.folded.has(aPos)).toBe(true);
    // 再次 toggle → 移除（全展开，保存重开默认态）。
    state = state.apply(state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: aPos }));
    expect(FOLD_PLUGIN_KEY.getState(state)!.folded.has(aPos)).toBe(false);
  });

  it('toggle 后 decoration 已重建且包含折叠区间的隐藏 node decoration', () => {
    let state = stateWith([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'hidden' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos = collectHeadings(state.doc)[0]!.pos;
    const beforeFold = FOLD_PLUGIN_KEY.getState(state)!.decorations.find().length;
    state = state.apply(state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: aPos }));
    const afterFold = FOLD_PLUGIN_KEY.getState(state)!.decorations.find().length;
    // 折叠后 DecorationSet 多出：标题折叠 class（1）+ 隐藏区间内 1 个块（1）。
    expect(afterFold).toBe(beforeFold + 2);
    expect(FOLD_PLUGIN_KEY.getState(state)!.folded.has(aPos)).toBe(true);
  });

  it('文档变更后折叠位置迁移', () => {
    let state = stateWith([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const bPos = collectHeadings(state.doc)[1]!.pos;
    state = state.apply(state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: bPos }));
    // 在文档开头插入段落 → B 位置后移，折叠集合应迁移到新位置。
    const insert = schema.nodes.paragraph!.create(null, schema.text('new'));
    state = state.apply(state.tr.insert(0, insert));
    const bPosNew = collectHeadings(state.doc)[1]!.pos;
    expect(FOLD_PLUGIN_KEY.getState(state)!.folded.has(bPosNew)).toBe(true);
    expect(FOLD_PLUGIN_KEY.getState(state)!.folded.has(bPos)).toBe(false);
  });
});

describe('光标守卫 appendTransaction', () => {
  it('空选区落入折叠区间 → 移到该标题（可见，不进隐藏内容）', () => {
    let state = EditorState.create({
      doc: buildDoc([
        { type: 'heading', level: 1, text: 'A' },
        { type: 'paragraph', text: 'hidden content here' },
        { type: 'heading', level: 1, text: 'B' },
      ]),
      plugins: [createHeadingFoldProsePlugin()],
    });
    const aPos = collectHeadings(state.doc)[0]!.pos;
    state = state.apply(state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: aPos }));
    const range = computeFoldedRanges(state.doc, FOLD_PLUGIN_KEY.getState(state)!.folded)[0]!;
    // 把光标放进折叠区间（隐藏段落内）。applyTransaction 才会运行 appendTransaction。
    const inside = range.from + 1;
    const applied = state.applyTransaction(
      state.tr.setSelection(TextSelection.create(state.doc, inside)),
    );
    state = applied.state;
    // appendTransaction 把光标移出折叠区间（不再严格落在隐藏内容内）。
    expect(state.selection.empty).toBe(true);
    const f = state.selection.from;
    expect(f > range.from && f < range.to).toBe(false);
    expect(f).not.toBe(inside);
  });

  it('无折叠时 appendTransaction 不产生事务（返回 null 语义）', () => {
    let state = EditorState.create({
      doc: buildDoc([
        { type: 'heading', level: 1, text: 'A' },
        { type: 'paragraph', text: 'p' },
      ]),
      plugins: [createHeadingFoldProsePlugin()],
    });
    const before = state.selection.from;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)),
    );
    // 无折叠 → 选区原样保留（未被强制移动）。
    expect(state.selection.from).not.toBe(before);
  });
});

describe('buildFoldDecorations', () => {
  it('每个标题得到三角 widget；折叠区间顶层块得隐藏 node decoration', () => {
    const doc = buildDoc([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'paragraph', text: 'p1' },
      { type: 'paragraph', text: 'p2' },
      { type: 'heading', level: 1, text: 'B' },
    ]);
    const aPos = collectHeadings(doc)[0]!.pos;
    const unfolded = buildFoldDecorations(doc, new Set(), () => null).find();
    const folded = buildFoldDecorations(doc, new Set([aPos]), () => null).find();
    // 未折叠：两个标题各一个三角 widget。
    expect(unfolded.length).toBe(2);
    // 折叠 A：额外 标题折叠 class（1）+ 隐藏区间 p1、p2（2）= +3。
    expect(folded.length).toBe(unfolded.length + 3);
  });
});
