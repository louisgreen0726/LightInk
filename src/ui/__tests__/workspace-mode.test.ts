/**
 * Session-level editor/reader workspace: cold start, round-trip, shelf home.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyWorkspaceSurface,
  applyWorkspaceVisibility,
  createWorkspaceMode,
  DEFAULT_WORKSPACE_MODE,
  parseWorkspaceMode,
  resolveWorkspaceSurface,
  workspaceVisibility,
} from '../workspace-mode.js';

describe('parseWorkspaceMode', () => {
  it('defaults to editor and only accepts reader', () => {
    expect(parseWorkspaceMode(null)).toBe('editor');
    expect(parseWorkspaceMode(undefined)).toBe('editor');
    expect(parseWorkspaceMode('editor')).toBe('editor');
    expect(parseWorkspaceMode('reader')).toBe('reader');
    expect(parseWorkspaceMode('shelf')).toBe('editor');
    expect(parseWorkspaceMode('other')).toBe('editor');
  });
});

describe('resolveWorkspaceSurface', () => {
  it('keeps the editor as the main surface regardless of an open book', () => {
    expect(resolveWorkspaceSurface('editor', false)).toBe('editor');
    expect(resolveWorkspaceSurface('editor', true)).toBe('editor');
  });

  it('uses the shelf when reading with no book, and the reader when a book is open', () => {
    expect(resolveWorkspaceSurface('reader', false)).toBe('shelf');
    expect(resolveWorkspaceSurface('reader', true)).toBe('reader');
  });
});

describe('workspaceVisibility', () => {
  it('shows one peer surface and hides the markdown outline outside the editor', () => {
    expect(workspaceVisibility('editor')).toEqual({
      editorVisible: true,
      shelfVisible: false,
      readerVisible: false,
      outlineHidden: false,
    });
    expect(workspaceVisibility('shelf')).toEqual({
      editorVisible: false,
      shelfVisible: true,
      readerVisible: false,
      outlineHidden: true,
    });
    expect(workspaceVisibility('reader')).toEqual({
      editorVisible: false,
      shelfVisible: false,
      readerVisible: true,
      outlineHidden: true,
    });
  });
});

describe('createWorkspaceMode', () => {
  it('cold-starts as the editor workspace, never a shelf overlay', () => {
    expect(DEFAULT_WORKSPACE_MODE).toBe('editor');
    const workspace = createWorkspaceMode();
    expect(workspace.mode).toBe('editor');
    expect(workspace.hasOpenBook).toBe(false);
    expect(workspace.surface).toBe('editor');
    expect(workspace.snapshot()).toEqual({
      mode: 'editor',
      hasOpenBook: false,
      surface: 'editor',
    });
  });

  it('round-trips editor → reader home → editor as distinct main surfaces', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.enterReader().surface).toBe('shelf');
    expect(workspace.mode).toBe('reader');
    expect(workspace.enterEditor().surface).toBe('editor');
    expect(workspace.mode).toBe('editor');
  });

  it('keeps the shelf as the reader home when no book is open', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    expect(workspace.surface).toBe('shelf');
    expect(workspace.surface).not.toBe('reader');
    expect(workspace.surface).not.toBe('editor');
  });

  it('opens a book and returns to the shelf without leaving reader mode', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    expect(workspace.openBook()).toEqual({
      mode: 'reader',
      hasOpenBook: true,
      surface: 'reader',
    });
    expect(workspace.returnToShelf()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('preserves the open-book flag when returning to the editor', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    workspace.openBook();
    expect(workspace.enterEditor()).toEqual({
      mode: 'editor',
      hasOpenBook: true,
      surface: 'editor',
    });
    expect(workspace.enterReader().surface).toBe('reader');
  });

  it('does not force the reader workspace when a book opens from the editor', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.openBook()).toEqual({
      mode: 'editor',
      hasOpenBook: true,
      surface: 'editor',
    });
  });

  it('reveals the reader surface when a book opens while the shelf is showing', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    expect(workspace.surface).toBe('shelf');
    expect(workspace.openBook()).toEqual({
      mode: 'reader',
      hasOpenBook: true,
      surface: 'reader',
    });
  });

  it('toggleMode preserves the open-book flag', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    workspace.openBook();
    expect(workspace.toggleMode().surface).toBe('editor');
    expect(workspace.hasOpenBook).toBe(true);
    expect(workspace.toggleMode().surface).toBe('reader');
  });

  it('enterReaderHome always lands on the shelf, even if a book was open', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    workspace.openBook();
    workspace.enterEditor();
    expect(workspace.enterReaderHome()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('toggleLibraryEntry maps File→书库 and shelf close onto workspace switches', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.toggleLibraryEntry().surface).toBe('shelf');
    expect(workspace.mode).toBe('reader');
    expect(workspace.toggleLibraryEntry().surface).toBe('editor');
    workspace.toggleLibraryEntry();
    workspace.openBook();
    expect(workspace.toggleLibraryEntry()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('rejects unknown setMode values as editor', () => {
    const workspace = createWorkspaceMode();
    workspace.enterReader();
    expect(workspace.setMode('shelf' as 'editor').mode).toBe('editor');
  });

  it('notifies subscribers only when the snapshot changes', () => {
    const workspace = createWorkspaceMode();
    const listener = vi.fn();
    const unsubscribe = workspace.subscribe(listener);
    workspace.setMode('editor');
    expect(listener).not.toHaveBeenCalled();
    workspace.enterReader();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    unsubscribe();
    workspace.enterEditor();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps independent session instances and never writes localStorage', () => {
    const first = createWorkspaceMode();
    const second = createWorkspaceMode();
    first.enterReader();
    expect(second.mode).toBe('editor');

    const storage = {
      getItem: vi.fn(() => 'reader'),
      setItem: vi.fn(),
    };
    const original = (globalThis as { localStorage?: typeof storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    try {
      const workspace = createWorkspaceMode();
      workspace.enterReader();
      workspace.openBook();
      workspace.enterEditor();
      expect(workspace.mode).toBe('editor');
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete (globalThis as { localStorage?: typeof storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: original,
        });
      }
    }
  });
});

describe('applyWorkspaceSurface', () => {
  it('stamps mode and surface dataset plus exclusive surface classes', () => {
    const classNames = new Set<string>();
    const root = {
      dataset: {} as DOMStringMap,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
    applyWorkspaceSurface(root, { mode: 'reader', surface: 'shelf' });
    expect(root.dataset.workspaceMode).toBe('reader');
    expect(root.dataset.workspaceSurface).toBe('shelf');
    expect(classNames.has('is-workspace-shelf')).toBe(true);
    expect(classNames.has('is-workspace-editor')).toBe(false);
    expect(classNames.has('is-workspace-reader')).toBe(false);

    applyWorkspaceSurface(root, { mode: 'reader', surface: 'reader' });
    expect(root.dataset.workspaceSurface).toBe('reader');
    expect(classNames.has('is-workspace-reader')).toBe(true);
    expect(classNames.has('is-workspace-shelf')).toBe(false);
  });
});

describe('applyWorkspaceVisibility', () => {
  it('hides the editor when the shelf is the workspace, instead of overlaying it', () => {
    const editor = { hidden: false };
    const shelf = { hidden: true };
    const reader = { hidden: true };
    applyWorkspaceVisibility({ editor, shelf, reader }, 'shelf');
    expect(editor.hidden).toBe(true);
    expect(shelf.hidden).toBe(false);
    expect(reader.hidden).toBe(true);

    applyWorkspaceVisibility({ editor, shelf, reader }, 'reader');
    expect(editor.hidden).toBe(true);
    expect(shelf.hidden).toBe(true);
    expect(reader.hidden).toBe(false);

    applyWorkspaceVisibility({ editor, shelf, reader }, 'editor');
    expect(editor.hidden).toBe(false);
    expect(shelf.hidden).toBe(true);
    expect(reader.hidden).toBe(true);
  });
});
