/**
 * `clipboard-md` — Markdown 源复制 / 粘贴解析（R9），`$prose` 插件。
 *
 * 复制（copy/cut）：把选区序列化为 **Markdown 源**写入剪贴板 `text/plain`，
 *   使得「全选复制→粘贴到纯文本编辑器」得到完整 Markdown 源（而非渲染纯文本）。
 * 粘贴（paste）：读取剪贴板 `text/plain`，经 `paste.ts` 的 `routeClipboardPaste`
 *   判定为 Markdown 源时，用 Milkdown parser 解析并替换选区为结构化内容；纯文本
 *   或图片粘贴交默认 / 图片插件。
 *
 * 实现要点：
 *   - prosemirror-view@1.42 **没有** `handleCopy`/`handleCut` 插件 prop——其 copy/cut
 *     始终用 `serializeForClipboard` 写渲染态 `text/plain`。故复制改写在编辑区 DOM
 *     的 **捕获阶段** 监听 `copy`/`cut`：先于 PM 的冒泡处理器写入 `text/plain`=Markdown
 *     并 `stopImmediatePropagation`，避免 PM 覆盖；cut 额外复刻 `deleteSelection`。
 *   - 粘贴走真正的 `handlePaste` prop（PM 在默认解析前先询问）。
 *   - 图片粘贴优先：剪贴板带文件（`files.length>0`）时直接返回 false，交
 *     `imageAssetPlugin` 拦截。
 *   - 序列化/解析复用 Milkdown ctx 的 serializer/parser（经 `@milkdown/utils` 的
 *     `getMarkdown` / `insert` 宏），与编辑器同源、无格式丢失。
 *
 * 纯逻辑 `routeClipboardPaste`（见 `paste.ts`）headless 可测；本文件的 DOM/ctx
 * 装配属编辑器集成面（同既有插件，仅断言工厂形态）。
 */

import { $prose, getMarkdown, insert } from '@milkdown/utils';
import type { Ctx } from '@milkdown/ctx';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { CellSelection } from '@milkdown/prose/tables';
import type { EditorView } from '@milkdown/prose/view';

import { clipboardHasImage } from '../../asset/clipboard.js';
import { routeClipboardPaste } from '../paste.js';
import {
  encodeMatrixClipboardText,
  matrixToHtmlTable,
  selectionToMatrix,
  selectionToTsv,
  setSessionTableMatrix,
} from './table-ops.js';

const PLUGIN_KEY = new PluginKey('lightink-clipboard-md');

/**
 * 构造复制剪贴板数据：`text/plain` 即 Markdown 源（R9 outcome#1 的纯逻辑契约）。
 * 与 `text/html` 解耦——内部粘贴回 LightInk 时由 `handlePaste` 重新解析 `text/plain`。
 */
export function markdownClipboardData(markdown: string): { 'text/plain': string } {
  return { 'text/plain': markdown };
}

export const clipboardMdPlugin = $prose((ctx: Ctx) => {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      // 粘贴：Markdown 源 → 解析替换选区；纯文本/图片交默认 / 图片插件。
      // （view 经 ctx.editorViewCtx 由 insert 宏取得，故此参数不直接使用。）
      handlePaste(view: EditorView, event: ClipboardEvent): boolean {
        const dt = event.clipboardData;
        // 图片粘贴优先交 imageAssetPlugin 拦截。R16：部分 WebView 把截图放
        // 在 items（含空 MIME）而非 files，故用 clipboardHasImage 兜底判定，
        // 否则文本粘贴会拦截并静默丢图。
        if (dt !== null && dt !== undefined && (dt.files.length > 0 || clipboardHasImage(event))) {
          return false;
        }
        // Table cell paste is owned by tableOpsPlugin (TSV / HTML table).
        // Never run markdown insert() over a CellSelection — it destroys the table.
        if (view.state.selection instanceof CellSelection) {
          return false;
        }
        const text = dt?.getData('text/plain') ?? '';
        if (routeClipboardPaste(text) !== 'markdown') {
          return false;
        }
        try {
          insert(text)(ctx);
          return true;
        } catch {
          // 解析失败（parser 异常）→ 交默认粘贴，保证不丢内容。
          return false;
        }
      },
    },
    view(editorView: EditorView) {
      const dom = editorView.dom;

      const writeMarkdownSource = (event: ClipboardEvent): boolean => {
        const { empty, from, to } = editorView.state.selection;
        // 空选区或无 clipboardData：交默认（PM 不会为空选区复制，此处兜底）。
        // CellSelection reports empty=false when cells are selected.
        if (empty || event.clipboardData === null || event.clipboardData === undefined) {
          return false;
        }
        // Table cell / row / column selection: TSV + HTML table.
        // Prefer CellSelection even when empty text looks empty — never fall through
        // to getMarkdown({from,to}) which serializes a broken table fragment.
        if (editorView.state.selection instanceof CellSelection) {
          const matrix = selectionToMatrix(editorView.state);
          if (matrix !== null && matrix.length > 0) {
            // In-session memory survives WebView tab→space normalization.
            setSessionTableMatrix(matrix);
            // Tab-safe wire format (+ TSV trailer for spreadsheets).
            const plain = encodeMatrixClipboardText(matrix);
            event.clipboardData.setData('text/plain', plain);
            const html = matrixToHtmlTable(matrix);
            if (html !== '') {
              try {
                event.clipboardData.setData('text/html', html);
              } catch {
                // Some environments only allow text/plain.
              }
            }
            // Custom MIME when the host allows it (best structure for re-paste).
            try {
              event.clipboardData.setData(
                'application/x-lightink-table',
                JSON.stringify(matrix),
              );
            } catch {
              /* ignore */
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          }
          const tsv = selectionToTsv(editorView.state);
          if (tsv !== null) {
            event.clipboardData.setData('text/plain', tsv);
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          }
          // CellSelection but matrix failed: still block markdown fallback.
          event.preventDefault();
          event.stopImmediatePropagation();
          return true;
        }
        const markdown = getMarkdown({ from, to })(ctx);
        if (markdown === '') {
          return false;
        }
        const payload = markdownClipboardData(markdown);
        event.clipboardData.setData('text/plain', payload['text/plain']);
        // 阻止 PM 冒泡阶段的默认复制（会用渲染态文本覆盖 text/plain）。
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      };

      const onCopy = (event: Event): void => {
        writeMarkdownSource(event as ClipboardEvent);
      };
      const onCut = (event: Event): void => {
        if (writeMarkdownSource(event as ClipboardEvent)) {
          // 复刻 PM cut 的删除语义（因 stopImmediatePropagation 跳过了 PM 处理器）。
          editorView.dispatch(
            editorView.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'),
          );
        }
      };

      // 捕获阶段先于 PM 的冒泡 copy/cut 处理器。
      dom.addEventListener('copy', onCopy, true);
      dom.addEventListener('cut', onCut, true);

      return {
        update() {
          // 选区变化无需重新绑定（监听器读 editorView.state 的实时选区）。
        },
        destroy() {
          dom.removeEventListener('copy', onCopy, true);
          dom.removeEventListener('cut', onCut, true);
        },
      };
    },
  });
});
