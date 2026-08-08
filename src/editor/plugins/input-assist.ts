/**
 * `input-assist` — Typora 式配对输入（R4）：括号/引号/反引号/`$` 自动配对，
 * 选中文字输入配对字符时包裹选中内容。以 `$prose` 插件挂入编辑器。
 *
 * 设计要点：
 *   - 纯逻辑 `planPairInput` 可 headless 测试；`handleTextInput` 用单个 transaction
 *     完成插入与选区调整，故撤销一步即可完全还原（R4 验收「撤销一步可完全还原」）。
 *   - 列表/任务列表回车续接由 commonmark/gfm preset 默认提供（输入 `- `/`- [ ] ` 后回车
 *     自动续接同级项）。空列表项回车退出、表格 Tab 跳格/补行需要 preset 命令集成
 *     （如 splitListItem / TableMap），作为后续关注项，不在本插件猜测实现以免破坏编辑。
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

const PLUGIN_KEY = new PluginKey('lightink-input-assist');

/** 配对字符：开 → 闭。 */
const PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
  '$': '$',
};

export interface PairPlan {
  /** 替换选区的插入文本（自动配对为 open+close；包裹为 open+selection+close）。 */
  insert: string;
  /** 相对插入起点的选区 anchor/head（自动配对居中；包裹选中内部文本）。 */
  anchor: number;
  head: number;
}

/**
 * 纯逻辑：给定输入字符与（可能为空的）选中文本，决定是否配对/包裹。
 * 返回 null 表示非配对字符，交给默认处理。
 */
export function planPairInput(typed: string, selectedText: string): PairPlan | null {
  const closing = PAIRS[typed];
  if (closing === undefined) {
    return null;
  }
  if (selectedText.length > 0) {
    return { insert: typed + selectedText + closing, anchor: 1, head: 1 + selectedText.length };
  }
  return { insert: typed + closing, anchor: 1, head: 1 };
}

/** 配对输入插件（自动配对 + 选中包裹）。 */
export const inputAssistPlugin = $prose(() => {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
        const selectedText = view.state.doc.textBetween(from, to, '');
        const plan = planPairInput(text, selectedText);
        if (plan === null) {
          return false;
        }
        const tr = view.state.tr.insertText(plan.insert, from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + plan.anchor, from + plan.head));
        view.dispatch(tr);
        return true;
      },
    },
  });
});
