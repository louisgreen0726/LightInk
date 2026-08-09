/**
 * `link-dialog` — themed modal for insert/edit hyperlink (title + URL).
 *
 * Replaces window.prompt for link editing so users can set both display text
 * and href, and cancel cleanly. Styles share the existing modal tokens.
 */

export interface LinkDialogValues {
  readonly text: string;
  readonly href: string;
}

export interface LinkDialogSpec {
  readonly title?: string;
  readonly initialText?: string;
  readonly initialHref?: string;
  /** Confirm button label (default 确定). */
  readonly confirmLabel?: string;
}

export type LinkDialogResult = LinkDialogValues | null;

function isNonEmpty(value: string): boolean {
  return value.trim() !== '';
}

/**
 * Show a themed link editor. Resolves to `{ text, href }` on confirm, or null
 * on cancel (Esc / overlay / 取消).
 */
export function showLinkDialog(
  doc: Document,
  spec: LinkDialogSpec = {},
): Promise<LinkDialogResult> {
  return new Promise<LinkDialogResult>((resolve) => {
    let settled = false;
    const settle = (value: LinkDialogResult): void => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';

    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-link-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', spec.title ?? '编辑链接');

    const heading = doc.createElement('div');
    heading.className = 'lightink-modal-title';
    heading.textContent = spec.title ?? '编辑链接';

    const form = doc.createElement('div');
    form.className = 'lightink-link-dialog-form';

    const textField = buildField(doc, {
      id: 'lightink-link-text',
      label: '显示文本',
      placeholder: '链接标题',
      value: spec.initialText ?? '',
    });
    const hrefField = buildField(doc, {
      id: 'lightink-link-href',
      label: '链接地址',
      placeholder: 'https://… 或 相对路径.md',
      value: spec.initialHref ?? '',
    });
    form.append(textField.wrap, hrefField.wrap);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => settle(null));

    const okBtn = doc.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'lightink-modal-btn lightink-modal-btn--primary';
    okBtn.textContent = spec.confirmLabel ?? '确定';
    okBtn.addEventListener('click', () => {
      const href = hrefField.input.value.trim();
      if (!isNonEmpty(href)) {
        hrefField.input.focus();
        hrefField.wrap.classList.add('is-invalid');
        return;
      }
      const text = textField.input.value.trim() || href;
      settle({ text, href });
    });

    actions.append(cancelBtn, okBtn);
    dialog.append(heading, form, actions);
    overlay.appendChild(dialog);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settle(null);
        return;
      }
      if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        // Confirm from either field.
        if (
          event.target === textField.input ||
          event.target === hrefField.input ||
          event.target === okBtn
        ) {
          event.preventDefault();
          okBtn.click();
        }
      }
    };

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        settle(null);
      }
    });
    hrefField.input.addEventListener('input', () => {
      hrefField.wrap.classList.remove('is-invalid');
    });

    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);

    // Focus text when empty, otherwise URL (common edit path).
    const initialText = (spec.initialText ?? '').trim();
    if (initialText === '') {
      textField.input.focus();
      textField.input.select();
    } else {
      hrefField.input.focus();
      hrefField.input.select();
    }
  });
}

/**
 * Confirm opening a link (Ctrl+click path). Returns true when user confirms.
 */
export function showOpenLinkConfirm(
  doc: Document,
  href: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(ok);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-link-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = doc.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = '打开链接';

    const message = doc.createElement('div');
    message.className = 'lightink-modal-message';
    message.textContent = '确定打开以下链接吗？';

    const target = doc.createElement('div');
    target.className = 'lightink-link-dialog-target';
    target.textContent = href;
    target.setAttribute('title', href);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => settle(false));

    const okBtn = doc.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'lightink-modal-btn lightink-modal-btn--primary';
    okBtn.textContent = '打开';
    okBtn.addEventListener('click', () => settle(true));

    actions.append(cancelBtn, okBtn);
    dialog.append(title, message, target, actions);
    overlay.appendChild(dialog);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
        return;
      }
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        settle(true);
      }
    };
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) settle(false);
    });
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    okBtn.focus();
  });
}

interface FieldParts {
  wrap: HTMLDivElement;
  input: HTMLInputElement;
}

function buildField(
  doc: Document,
  opts: { id: string; label: string; placeholder: string; value: string },
): FieldParts {
  const wrap = doc.createElement('div');
  wrap.className = 'lightink-link-dialog-field';

  const label = doc.createElement('label');
  label.className = 'lightink-link-dialog-label';
  label.htmlFor = opts.id;
  label.textContent = opts.label;

  const input = doc.createElement('input');
  input.type = 'text';
  input.id = opts.id;
  input.className = 'lightink-link-dialog-input';
  input.placeholder = opts.placeholder;
  input.value = opts.value;
  input.autocomplete = 'off';
  input.spellcheck = false;

  wrap.append(label, input);
  return { wrap, input };
}
