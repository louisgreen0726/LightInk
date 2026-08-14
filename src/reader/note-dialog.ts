/**
 * `note-dialog` — 标注笔记多行输入弹层（R4）。
 *
 * 基于 confirm-dialog/modal-focus 的主题化模态：textarea 多行输入 + 保存/取消，
 * resolve 为文本（保存，允许空串）或 null（取消/Esc/遮罩点击）。新建与编辑备注共用，
 * 替换旧 window.prompt 路径。Ctrl/Cmd+Enter 提交（Enter 留给换行）。
 * 样式走 lightink-modal-* 既有体系；textarea 尺寸经内联样式（弹层组件自包含）。
 */

import { labelModal, mountModalFocus } from '../ui/modal-focus.js';
import type { MessageKey } from '../i18n/messages.js';

export interface NoteDialogDeps {
  t: (key: MessageKey) => string;
}

/**
 * 弹出笔记输入层。resolve 为用户输入文本；取消时 resolve null。
 */
export function showNoteDialog(
  doc: Document,
  initialText: string,
  deps: NoteDialogDeps,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let releaseModal = (): void => overlay.remove();
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      releaseModal();
      resolve(value);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-note-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = doc.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = deps.t('annotation.noteDialog.title');

    const textarea = doc.createElement('textarea');
    textarea.className = 'lightink-note-textarea';
    textarea.value = initialText;
    textarea.rows = 5;
    textarea.style.width = '100%';
    textarea.style.minHeight = '6rem';
    textarea.style.resize = 'vertical';
    textarea.style.font = 'inherit';
    textarea.style.boxSizing = 'border-box';
    labelModal(dialog, title, textarea);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';
    const save = doc.createElement('button');
    save.type = 'button';
    save.className = 'lightink-modal-btn lightink-modal-btn--primary';
    save.textContent = deps.t('annotation.noteDialog.save');
    save.addEventListener('click', () => settle(textarea.value));
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancel.textContent = deps.t('annotation.noteDialog.cancel');
    cancel.addEventListener('click', () => settle(null));
    actions.append(save, cancel);

    dialog.append(title, textarea, actions);
    overlay.appendChild(dialog);

    textarea.addEventListener('keydown', (event) => {
      // 多行输入：Enter 换行，Ctrl/Cmd+Enter 提交。
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        settle(textarea.value);
      }
    });
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        settle(null);
      }
    });
    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus: textarea,
      onEscape: () => settle(null),
    });
  });
}
