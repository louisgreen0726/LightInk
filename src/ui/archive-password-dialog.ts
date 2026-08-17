import type { MessageKey } from '../i18n/messages.js';
import { labelModal, mountModalFocus } from './modal-focus.js';

export interface ArchivePasswordDialogSpec {
  readonly displayName: string;
  readonly retry: boolean;
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
}

/** Request an archive password without writing it to persistent browser state. */
export function showArchivePasswordDialog(
  doc: Document,
  spec: ArchivePasswordDialogSpec,
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
    dialog.className = 'lightink-modal-dialog lightink-link-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = doc.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = spec.t('reader.archivePassword.title');

    const message = doc.createElement('div');
    message.className = 'lightink-modal-message';
    message.textContent = spec.t(
      spec.retry
        ? 'reader.archivePassword.incorrect'
        : 'reader.archivePassword.message',
      { name: spec.displayName },
    );
    labelModal(dialog, title, message);

    const form = doc.createElement('form');
    form.className = 'lightink-link-dialog-form';
    const label = doc.createElement('label');
    label.className = 'lightink-link-dialog-label';
    label.htmlFor = 'lightink-archive-password';
    label.textContent = spec.t('reader.archivePassword.label');
    const input = doc.createElement('input');
    input.id = 'lightink-archive-password';
    input.className = 'lightink-link-dialog-input';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.appendChild(input);
    form.appendChild(label);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancel.textContent = spec.t('dialog.cancel');
    cancel.addEventListener('click', () => settle(null));
    const confirm = doc.createElement('button');
    confirm.type = 'submit';
    confirm.className = 'lightink-modal-btn lightink-modal-btn--primary';
    confirm.textContent = spec.t('dialog.open');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value === '') {
        input.focus();
        return;
      }
      settle(input.value);
    });
    actions.append(cancel, confirm);
    dialog.append(title, message, form, actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) settle(null);
    });

    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus: input,
      onEscape: () => settle(null),
    });
  });
}
