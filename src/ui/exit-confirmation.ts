import { showConfirmDialog } from './confirm-dialog.js';

export type ExitChoice = 'save' | 'discard' | 'cancel';

export interface ExitConfirmationLabels {
  readonly title: string;
  readonly message: (documents: string) => string;
  readonly saveAll: string;
  readonly discardAll: string;
  readonly cancel: string;
}

/** Format document titles as a stable, scan-friendly list for the exit dialog. */
export function formatUnsavedDocuments(titles: readonly string[]): string {
  return titles.map((title) => `- ${title}`).join('\n');
}

/** Show one application-exit decision for every currently unsaved document. */
export async function showExitConfirmation(
  doc: Document,
  titles: readonly string[],
  labels: ExitConfirmationLabels,
): Promise<ExitChoice> {
  const choice = await showConfirmDialog(doc, {
    title: labels.title,
    message: labels.message(formatUnsavedDocuments(titles)),
    buttons: [
      { id: 'save', label: labels.saveAll, kind: 'primary' },
      { id: 'discard', label: labels.discardAll, kind: 'danger' },
      { id: 'cancel', label: labels.cancel, kind: 'plain' },
    ],
    cancelId: 'cancel',
  });
  if (choice === 'save' || choice === 'discard') {
    return choice;
  }
  return 'cancel';
}
