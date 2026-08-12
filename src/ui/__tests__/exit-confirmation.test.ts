import { describe, expect, it } from 'vitest';

import { formatUnsavedDocuments, showExitConfirmation } from '../exit-confirmation.js';

describe('application exit confirmation', () => {
  it('lists every unsaved document on its own line', () => {
    expect(formatUnsavedDocuments(['draft.md', 'notes.md'])).toBe(
      '- draft.md\n- notes.md',
    );
  });

  it('exports the themed dialog entry point', () => {
    expect(typeof showExitConfirmation).toBe('function');
  });
});
