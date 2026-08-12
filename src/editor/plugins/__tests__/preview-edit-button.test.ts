// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { appendPreviewEditButton } from '../preview-edit-button.js';

describe('preview edit button', () => {
  it('provides a labelled keyboard button and dispatches edit once', () => {
    const preview = document.createElement('div');
    const onEdit = vi.fn();
    const button = appendPreviewEditButton(preview, 'Edit source', onEdit);

    expect(button.getAttribute('aria-label')).toBe('Edit source');
    expect(button.getAttribute('title')).toBe('Edit source');
    expect(button.tabIndex).toBe(0);
    button.click();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
