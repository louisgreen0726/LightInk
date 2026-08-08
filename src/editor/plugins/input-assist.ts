/**
 * `input-assist` — Typora 式智能输入（R4），以 `$prose` 插件挂入编辑器：
 *   a) 括号/方括号/花括号/双引号/单引号/反引号/`$` 自动配对（光标置中），选中文字输入
 *      配对字符时包裹选中内容（选区保持内部文本）。单个 transaction 完成插入+选区 →
 *      撤销一步即可完全还原。
 *   b) 空列表项/任务列表项回车 → lift 退出列表（`liftListItem`）。
 *   c) 表格内 Tab → `goToNextCell` 跳格；末格 Tab 自动追加新行（库内置行为）。
 *
 * 列表/任务列表的「回车续接同级项」由 commonmark/gfm preset 默认提供；本插件仅在
 * 空项回车时 lift 退出（早于 preset 的 Enter 处理），其余回车返回 false 交由 preset。
 *
 * 纯逻辑 `planPairInput` 可 headless 测试；列表/表格行为复用 prosemirror-schema-list
 * 与 prosemirror-tables 的成熟命令（经 @milkdown/prose 重导出），确保结构有效。
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { liftListItem } from '@milkdown/prose/schema-list';
import { goToNextCell } from '@milkdown/prose/tables';
import type { EditorView } from '@milkdown/prose/view';
import type { NodeType } from '@milkdown/prose/model';

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

/**
 * 空列表项回车 → lift 退出为段落。仅在光标位于空段落且祖先是 list_item/task_list_item
 * 时尝试 lift；成功返回 true，否则返回 false 交由 preset（续接/分割）。
 */
function maybeExitListItem(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type.name !== 'paragraph' || $from.parent.textContent !== '') {
    return false;
  }
  const nodes = view.state.schema.nodes;
  const candidates: NodeType[] = [nodes.task_list_item, nodes.list_item].filter(
    (type): type is NodeType => type !== undefined && type !== null,
  );
  for (const type of candidates) {
    const lift = liftListItem(type);
    if (lift(view.state, (tr) => view.dispatch(tr))) {
      return true;
    }
  }
  return false;
}

/** 配对输入 + 列表退出 + 表格 Tab 插件。 */
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
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (maybeExitListItem(view)) {
            return true;
          }
        }
        if (event.key === 'Tab') {
          const go = goToNextCell(event.shiftKey ? -1 : 1);
          if (go(view.state, (tr) => view.dispatch(tr))) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
  });
});
