/** Add a keyboard-operable edit control without letting ProseMirror steal focus. */
export function appendPreviewEditButton(
  container: HTMLElement,
  label: string,
  onEdit: () => void,
): HTMLButtonElement {
  const button = container.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'lightink-preview-edit';
  button.textContent = '✎';
  button.contentEditable = 'false';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onEdit();
  });
  container.appendChild(button);
  return button;
}
