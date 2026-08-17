/**
 * Session-level editor/reader workspace (R1).
 *
 * Owns `editor | reader` for the current process only. Never writes
 * localStorage so cold start and module init are always the Markdown
 * editor (R6). `main.ts` and `app-shell` consume snapshots and apply
 * visibility; this module does not touch tab-manager or LibraryView.
 *
 * Surfaces:
 *   - editor: Markdown editor and existing markdown tabs
 *   - shelf:  library as the reader-mode home (a workspace panel, not an overlay)
 *   - reader: an opened book; return-to-shelf stays in reader mode
 */

export type WorkspaceMode = 'editor' | 'reader';
export type WorkspaceSurface = 'editor' | 'shelf' | 'reader';

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'editor';

export interface WorkspaceSnapshot {
  readonly mode: WorkspaceMode;
  readonly hasOpenBook: boolean;
  readonly surface: WorkspaceSurface;
}

export interface WorkspaceVisibility {
  readonly editorVisible: boolean;
  readonly shelfVisible: boolean;
  readonly readerVisible: boolean;
  /** Markdown outline is hidden while the reader workspace is showing. */
  readonly outlineHidden: boolean;
}

export interface WorkspaceSurfaceRoots {
  editor?: { hidden: boolean };
  shelf?: { hidden: boolean };
  reader?: { hidden: boolean };
}

export interface WorkspaceModeController {
  snapshot(): WorkspaceSnapshot;
  readonly mode: WorkspaceMode;
  readonly hasOpenBook: boolean;
  readonly surface: WorkspaceSurface;
  /** Switch workspace. Does not change whether a book is open. */
  setMode(mode: WorkspaceMode): WorkspaceSnapshot;
  enterEditor(): WorkspaceSnapshot;
  enterReader(): WorkspaceSnapshot;
  /** View-menu editor ↔ reader. Preserves the open-book flag. */
  toggleMode(): WorkspaceSnapshot;
  /**
   * Mark a book open. Does not change mode — File→Open of a PDF in the
   * editor workspace still leaves the editor as the main surface.
   */
  openBook(): WorkspaceSnapshot;
  /**
   * Clear the open-book flag. When already in reader mode this returns
   * to the shelf without leaving the reader workspace.
   */
  returnToShelf(): WorkspaceSnapshot;
  /** Reader home: reader mode with the shelf as the main surface. */
  enterReaderHome(): WorkspaceSnapshot;
  /**
   * File→书库 / shelf close:
   * editor → shelf, shelf → editor, open book → shelf (stay in reader).
   */
  toggleLibraryEntry(): WorkspaceSnapshot;
  subscribe(listener: (state: WorkspaceSnapshot) => void): () => void;
}

export function parseWorkspaceMode(raw: unknown): WorkspaceMode {
  return raw === 'reader' ? 'reader' : 'editor';
}

export function resolveWorkspaceSurface(
  mode: WorkspaceMode,
  hasOpenBook: boolean,
): WorkspaceSurface {
  if (mode === 'editor') {
    return 'editor';
  }
  return hasOpenBook ? 'reader' : 'shelf';
}

export function workspaceVisibility(surface: WorkspaceSurface): WorkspaceVisibility {
  return {
    editorVisible: surface === 'editor',
    shelfVisible: surface === 'shelf',
    readerVisible: surface === 'reader',
    outlineHidden: surface !== 'editor',
  };
}

export function applyWorkspaceSurface(
  root: { dataset: DOMStringMap; classList: DOMTokenList },
  snapshot: Pick<WorkspaceSnapshot, 'mode' | 'surface'>,
): void {
  root.dataset.workspaceMode = snapshot.mode;
  root.dataset.workspaceSurface = snapshot.surface;
  root.classList.toggle('is-workspace-editor', snapshot.surface === 'editor');
  root.classList.toggle('is-workspace-shelf', snapshot.surface === 'shelf');
  root.classList.toggle('is-workspace-reader', snapshot.surface === 'reader');
}

/**
 * Show exactly one main surface. Shelf and reader are peers of the
 * editor, not overlays stacked on top of a Markdown tab.
 */
export function applyWorkspaceVisibility(
  roots: WorkspaceSurfaceRoots,
  surface: WorkspaceSurface,
): void {
  const vis = workspaceVisibility(surface);
  if (roots.editor !== undefined) {
    roots.editor.hidden = !vis.editorVisible;
  }
  if (roots.shelf !== undefined) {
    roots.shelf.hidden = !vis.shelfVisible;
  }
  if (roots.reader !== undefined) {
    roots.reader.hidden = !vis.readerVisible;
  }
}

export function createWorkspaceMode(): WorkspaceModeController {
  let mode: WorkspaceMode = DEFAULT_WORKSPACE_MODE;
  let hasOpenBook = false;
  const listeners = new Set<(state: WorkspaceSnapshot) => void>();

  function snapshot(): WorkspaceSnapshot {
    return {
      mode,
      hasOpenBook,
      surface: resolveWorkspaceSurface(mode, hasOpenBook),
    };
  }

  function commit(nextMode: WorkspaceMode, nextOpen: boolean): WorkspaceSnapshot {
    if (mode === nextMode && hasOpenBook === nextOpen) {
      return snapshot();
    }
    mode = nextMode;
    hasOpenBook = nextOpen;
    const state = snapshot();
    for (const listener of [...listeners]) {
      listener(state);
    }
    return state;
  }

  return {
    snapshot,
    get mode() {
      return mode;
    },
    get hasOpenBook() {
      return hasOpenBook;
    },
    get surface() {
      return resolveWorkspaceSurface(mode, hasOpenBook);
    },
    setMode(next) {
      return commit(parseWorkspaceMode(next), hasOpenBook);
    },
    enterEditor() {
      return commit('editor', hasOpenBook);
    },
    enterReader() {
      return commit('reader', hasOpenBook);
    },
    toggleMode() {
      return commit(mode === 'editor' ? 'reader' : 'editor', hasOpenBook);
    },
    openBook() {
      return commit(mode, true);
    },
    returnToShelf() {
      return commit(mode, false);
    },
    enterReaderHome() {
      return commit('reader', false);
    },
    toggleLibraryEntry() {
      if (mode === 'editor') {
        return commit('reader', false);
      }
      if (hasOpenBook) {
        return commit('reader', false);
      }
      return commit('editor', hasOpenBook);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
