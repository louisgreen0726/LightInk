/**
 * emoji 自动补全插件（T3 / R7）纯逻辑与 headless 状态推导测试。
 *
 * 覆盖：
 *   - 触发判定 `parseEmojiTrigger`：行中触发、`:` 前不得为查询字符
 *     （行首/空白/CJK/标点均可触发）、查询至少 2 字符、查询必须直达光标；
 *   - 检索 `filterEmoji`：大小写不敏感、主名前缀优先、无匹配为空、limit 截断；
 *   - 插件状态推导（EMOJI_PLUGIN_KEY.getState）：开/关、colonPos 指向 `:`、
 *     无匹配不弹窗、方向键环形选择、Esc 取消后相同触发文本保持关闭且
 *     继续输入可重开；
 *   - commit：`buildEmojiCommitTr` 把 `:query` 替换为 Unicode emoji 字符，
 *     光标落在插入字符之后；handleKeyDown 的 Enter/Esc 路径（stub view）。
 *
 * 菜单 DOM/定位依赖浏览器，不在 node 环境覆盖（与 slash-menu 测试口径一致）。
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import {
  EMOJI_MAX_RESULTS,
  EMOJI_MIN_QUERY_LENGTH,
  EMOJI_PLUGIN_KEY,
  buildEmojiCommitTr,
  createEmojiCompletePlugin,
  filterEmoji,
  parseEmojiTrigger,
  type EmojiState,
} from '../plugins/emoji-complete.js';

/** Minimal schema: doc/paragraph/text is enough for state derivation. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
});

function makeState(text: string): EditorState {
  const doc = schema.nodes.doc!.create(null, [
    schema.nodes.paragraph!.create(null, text === '' ? undefined : schema.text(text)),
  ]);
  return EditorState.create({
    doc,
    schema,
    plugins: [createEmojiCompletePlugin()],
  });
}

/** 光标移到文末并触发一次 apply（菜单状态派生自 doc + selection）。 */
function withCaretAtEnd(state: EditorState): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
}

function emojiState(state: EditorState): EmojiState {
  const value = EMOJI_PLUGIN_KEY.getState(state);
  expect(value).toBeDefined();
  return value!;
}

function keyEvent(key: string): KeyboardEvent {
  let prevented = false;
  return {
    key,
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as KeyboardEvent;
}

describe('parseEmojiTrigger', () => {
  it('triggers at line start with a query of at least 2 characters', () => {
    expect(parseEmojiTrigger(':sm')).toEqual({ query: 'sm' });
    expect(parseEmojiTrigger(':+1')).toEqual({ query: '+1' });
    expect(parseEmojiTrigger(':heart_eyes')).toEqual({ query: 'heart_eyes' });
  });

  it('triggers mid-line when `:` follows whitespace', () => {
    expect(parseEmojiTrigger('hello :smi')).toEqual({ query: 'smi' });
    expect(parseEmojiTrigger('中文 :sm')).toEqual({ query: 'sm' });
  });

  it('triggers when `:` directly follows CJK text or punctuation（中文写作无空格）', () => {
    expect(parseEmojiTrigger('中文:sm')).toEqual({ query: 'sm' });
    expect(parseEmojiTrigger('笑一个:joy')).toEqual({ query: 'joy' });
    expect(parseEmojiTrigger('。:heart')).toEqual({ query: 'heart' });
  });

  it('rejects queries shorter than the minimum length', () => {
    expect(EMOJI_MIN_QUERY_LENGTH).toBe(2);
    expect(parseEmojiTrigger(':')).toBeNull();
    expect(parseEmojiTrigger(':s')).toBeNull();
  });

  it('rejects `:` glued to a preceding word (no whitespace boundary)', () => {
    expect(parseEmojiTrigger('foo:sm')).toBeNull();
    expect(parseEmojiTrigger('12:30')).toBeNull();
  });

  it('rejects when the query does not reach the caret (trailing text/space)', () => {
    expect(parseEmojiTrigger(':sm cat')).toBeNull();
    expect(parseEmojiTrigger(':sm ')).toBeNull();
    expect(parseEmojiTrigger('plain text')).toBeNull();
    expect(parseEmojiTrigger('')).toBeNull();
  });
});

describe('filterEmoji', () => {
  it('ranks name-prefix matches before keyword-only matches', () => {
    // emojilib 主名形如 `grinning_face_with_smiling_eyes`，`grinning` 有主名前缀命中。
    const results = filterEmoji('grinning');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name.startsWith('grinning')).toBe(true);
    const firstKeywordOnly = results.findIndex((c) => !c.name.startsWith('grinning'));
    if (firstKeywordOnly > 0) {
      expect(
        results.slice(0, firstKeywordOnly).every((c) => c.name.startsWith('grinning')),
      ).toBe(true);
    }
  });

  it('matches by keyword and returns insertable Unicode emoji chars', () => {
    const results = filterEmoji('smile');
    expect(results.length).toBeGreaterThan(0);
    // 全部为合法 Unicode emoji 字符（非空、含非 ASCII）。
    for (const candidate of results) {
      expect(candidate.char).not.toBe('');
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7F]/.test(candidate.char)).toBe(true);
    }
    // 已知数据：emojilib 中 `smile` 是 😄 的关键词。
    expect(results.some((c) => c.char === '😄')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(filterEmoji('SMILE')).toEqual(filterEmoji('smile'));
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterEmoji('zzzzqqqq')).toEqual([]);
  });

  it('returns an empty list for blank queries and non-positive limits', () => {
    expect(filterEmoji('')).toEqual([]);
    expect(filterEmoji('   ')).toEqual([]);
    expect(filterEmoji('smile', 0)).toEqual([]);
  });

  it('respects the result limit (default bounded by EMOJI_MAX_RESULTS)', () => {
    const limited = filterEmoji('a', 5);
    expect(limited).toHaveLength(5);
    expect(filterEmoji('a').length).toBeLessThanOrEqual(EMOJI_MAX_RESULTS);
  });
});

describe('emoji plugin state derivation (headless)', () => {
  it('stays closed before any transaction, even on a trigger text', () => {
    expect(emojiState(makeState(':sm')).open).toBe(false);
  });

  it('opens on `:sm` at the caret and points colonPos at the `:`', () => {
    const state = withCaretAtEnd(makeState('hello :sm'));
    const emoji = emojiState(state);
    expect(emoji.open).toBe(true);
    expect(emoji.query).toBe('sm');
    expect(state.doc.textBetween(emoji.colonPos, emoji.colonPos + 1)).toBe(':');
    expect(emoji.selectedIndex).toBe(0);
  });

  it('stays closed for a 1-character query', () => {
    expect(emojiState(withCaretAtEnd(makeState(':s'))).open).toBe(false);
  });

  it('stays closed when `:` is glued to a preceding word', () => {
    expect(emojiState(withCaretAtEnd(makeState('foo:sm'))).open).toBe(false);
  });

  it('stays closed when nothing matches (无匹配不弹窗)', () => {
    expect(emojiState(withCaretAtEnd(makeState(':zzqq'))).open).toBe(false);
  });

  it('stays closed while the selection is a range', () => {
    const base = makeState('hello :sm');
    const ranged = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, 1, base.doc.content.size - 1)),
    );
    expect(emojiState(ranged).open).toBe(false);
  });

  it('cycles selection with delta meta and clamps into range', () => {
    const open = withCaretAtEnd(makeState(':sm'));
    const matchCount = filterEmoji('sm').length;
    expect(matchCount).toBeGreaterThan(1);

    const down = open.apply(open.tr.setMeta(EMOJI_PLUGIN_KEY, { delta: 1 }));
    expect(emojiState(down).selectedIndex).toBe(1);

    // 从 0 向上：环绕到最后一项。
    const wrapped = open.apply(open.tr.setMeta(EMOJI_PLUGIN_KEY, { delta: -1 }));
    expect(emojiState(wrapped).selectedIndex).toBe(matchCount - 1);
  });

  it('Esc cancel keeps the text, stays closed for the same trigger, reopens on new input', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    expect(emojiState(open).open).toBe(true);

    // Esc：只记取消，不动文档。
    const cancelled = open.apply(open.tr.setMeta(EMOJI_PLUGIN_KEY, { cancel: true }));
    expect(cancelled.doc.textContent).toBe('hello :sm');
    expect(emojiState(cancelled).open).toBe(false);

    // 触发文本未变：任意事务（如选区来回）都保持关闭。
    const reselected = cancelled.apply(
      cancelled.tr.setSelection(TextSelection.atEnd(cancelled.doc)),
    );
    expect(emojiState(reselected).open).toBe(false);

    // 继续输入改变 query（:sm → :smi）：自动重开。
    const typed = reselected.apply(
      reselected.tr.insertText('i', reselected.selection.head),
    );
    const reopened = emojiState(typed);
    expect(reopened.open).toBe(true);
    expect(reopened.query).toBe('smi');
  });

  it('closes when the trigger text is deleted', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    const head = open.selection.head;
    // 删除 ':sm'（4 字符）→ 行尾不再是触发形态。
    const deleted = open.apply(open.tr.delete(head - 4, head));
    expect(emojiState(deleted).open).toBe(false);
  });
});

describe('buildEmojiCommitTr', () => {
  it('replaces `:query` with the emoji char and places the caret after it', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    const tr = buildEmojiCommitTr(open, '😄');
    expect(tr).not.toBeNull();
    const committed = open.apply(tr!);
    expect(committed.doc.textContent).toBe('hello 😄');
    // 光标落在 emoji 之后（😄 为 2 个 UTF-16 code unit）。
    const expected = 'hello 😄'.length + 1; // +1: paragraph 起始偏移
    expect(committed.selection.head).toBe(expected);
    // commit 后行尾不再是触发形态：菜单关闭。
    expect(emojiState(committed).open).toBe(false);
  });

  it('returns null when the menu is closed or char is empty', () => {
    expect(buildEmojiCommitTr(makeState(':sm'), '😄')).toBeNull();
    const open = withCaretAtEnd(makeState('hello :sm'));
    expect(buildEmojiCommitTr(open, '')).toBeNull();
  });
});

describe('handleKeyDown (stub view)', () => {
  /** Minimal EditorView stub: state + dispatch + focus（见 table-ops.test.ts 模式）。 */
  function stubView(initial: EditorState): {
    view: EditorView;
    getState: () => EditorState;
  } {
    let current = initial;
    const view = {
      get state() {
        return current;
      },
      dispatch(tr: import('@milkdown/prose/state').Transaction) {
        current = current.apply(tr);
      },
      focus() {
        /* no-op */
      },
    } as unknown as EditorView;
    return { view, getState: () => current };
  }

  function handleKeyDownOf(state: EditorState) {
    const plugin = state.plugins.find(
      (p) => (p.spec as { key?: unknown }).key === EMOJI_PLUGIN_KEY,
    );
    expect(plugin).toBeDefined();
    const handler = plugin!.props.handleKeyDown!;
    // ProseMirror 以插件实例为 this 调用 prop；这里保持相同调用形态。
    return (view: EditorView, event: KeyboardEvent): boolean =>
      handler.call(plugin!, view, event) === true;
  }

  it('Enter commits the highlighted candidate and consumes the event', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    const expected = filterEmoji('sm')[0]!;
    const { view, getState } = stubView(open);

    const event = keyEvent('Enter');
    const handled = handleKeyDownOf(open)(view, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(getState().doc.textContent).toBe(`hello ${expected.char}`);
    expect(emojiState(getState()).open).toBe(false);
  });

  it('Tab also commits; Arrow keys only move the highlight', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    const second = filterEmoji('sm')[1]!;
    const { view, getState } = stubView(open);
    const handler = handleKeyDownOf(open);

    expect(handler(view, keyEvent('ArrowDown'))).toBe(true);
    expect(emojiState(getState()).selectedIndex).toBe(1);
    expect(getState().doc.textContent).toBe('hello :sm');

    expect(handler(view, keyEvent('Tab'))).toBe(true);
    expect(getState().doc.textContent).toBe(`hello ${second.char}`);
  });

  it('Escape cancels without touching the document (输入不受影响)', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    const { view, getState } = stubView(open);

    const event = keyEvent('Escape');
    const handled = handleKeyDownOf(open)(view, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    // 文本原样保留，菜单关闭。
    expect(getState().doc.textContent).toBe('hello :sm');
    expect(emojiState(getState()).open).toBe(false);
    expect(emojiState(getState()).cancelled).toBe(':sm');
  });

  it('returns false for unrelated keys so normal typing continues', () => {
    const open = withCaretAtEnd(makeState('hello :sm'));
    const { view } = stubView(open);
    expect(handleKeyDownOf(open)(view, keyEvent('a'))).toBe(false);
    // 菜单未打开时：Enter/Esc 均不拦截。
    const plain = withCaretAtEnd(makeState('plain text'));
    const plainView = stubView(plain).view;
    expect(handleKeyDownOf(plain)(plainView, keyEvent('Enter'))).toBe(false);
    expect(handleKeyDownOf(plain)(plainView, keyEvent('Escape'))).toBe(false);
  });
});
