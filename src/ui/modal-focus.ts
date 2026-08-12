export interface ModalFocusOptions {
  readonly initialFocus?: HTMLElement | null;
  readonly onEscape: () => void;
}

let nextModalLabelId = 0;

function elementChildren(parent: unknown): HTMLElement[] {
  const children = (parent as { children?: ArrayLike<unknown> } | null)?.children;
  return children === undefined
    ? []
    : Array.from(children).filter(
        (child): child is HTMLElement => typeof child === 'object' && child !== null,
      );
}

function isFocusable(element: HTMLElement): boolean {
  const shaped = element as HTMLElement & {
    disabled?: boolean;
    hidden?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  if (shaped.disabled === true || shaped.hidden === true) return false;
  if (shaped.getAttribute?.('tabindex') === '-1') return false;
  const tagName = shaped.tagName?.toUpperCase();
  return (
    tagName === 'BUTTON' ||
    tagName === 'INPUT' ||
    tagName === 'SELECT' ||
    tagName === 'TEXTAREA' ||
    (tagName === 'A' && shaped.getAttribute?.('href') != null) ||
    (typeof shaped.tabIndex === 'number' && shaped.tabIndex >= 0)
  );
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  const visit = (element: HTMLElement): void => {
    if (isFocusable(element)) found.push(element);
    for (const child of elementChildren(element)) visit(child);
  };
  for (const child of elementChildren(root)) visit(child);
  return found;
}

/** Connect a dialog title/description without duplicating visible text in aria-label. */
export function labelModal(
  dialog: HTMLElement,
  title: HTMLElement,
  description?: HTMLElement,
): void {
  const id = nextModalLabelId++;
  title.id = `lightink-modal-title-${id}`;
  dialog.setAttribute('aria-labelledby', title.id);
  if (description !== undefined) {
    description.id = `lightink-modal-description-${id}`;
    dialog.setAttribute('aria-describedby', description.id);
  }
}

/** Mount a modal with background inertness, trapped focus, and focus restoration. */
export function mountModalFocus(
  doc: Document,
  overlay: HTMLElement,
  dialog: HTMLElement,
  options: ModalFocusOptions,
): () => void {
  const previousFocus = (doc as Document & { activeElement?: Element | null }).activeElement;
  doc.body.appendChild(overlay);
  const background = elementChildren(doc.body)
    .filter((element) => element !== overlay)
    .map((element) => ({ element, inert: element.inert }));
  for (const { element } of background) element.inert = true;

  dialog.tabIndex = -1;
  const initial = options.initialFocus ?? focusableElements(dialog)[0] ?? dialog;
  initial.focus();

  let released = false;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = (doc as Document & { activeElement?: Element | null }).activeElement;
    const index = focusable.indexOf(active as HTMLElement);
    const nextIndex = event.shiftKey
      ? index <= 0
        ? focusable.length - 1
        : index - 1
      : index < 0 || index === focusable.length - 1
        ? 0
        : index + 1;
    event.preventDefault();
    focusable[nextIndex]!.focus();
  };
  doc.addEventListener('keydown', onKeyDown, true);

  return () => {
    if (released) return;
    released = true;
    doc.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    for (const { element, inert } of background) element.inert = inert;
    const previous = previousFocus as (Element & { focus?: () => void; isConnected?: boolean }) | null;
    if (previous !== null && previous !== undefined && previous.isConnected !== false) {
      previous.focus?.();
    }
  };
}
