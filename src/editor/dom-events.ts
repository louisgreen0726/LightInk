/**
 * DOM event helpers.
 *
 * These helpers attach/blur handlers that drive the cursor-mode state
 * machine in `cursor.ts`. They are written defensively — `mountEditor` runs
 * only inside a Tauri WebView, but the helpers are also touched by lint in
 * test environments, so we no-op gracefully when there is no `window`.
 */

import {
  applyTransition,
  blurAll,
  focusBlock,
  initCursor,
  type BlockId,
  type CursorSnapshot,
  type CursorTransition,
} from './cursor.js';

export interface CursorEventBinding {
  /** The container that hosts the editor. */
  readonly container: HTMLElement;
  /** The currently-focused block id, or `null` when the caret is outside. */
  focusedBlockId: BlockId | null;
  /** Latest snapshot of the cursor state machine. */
  snapshot: CursorSnapshot;
  /** Detach all listeners and clear container state. */
  dispose(): void;
}

/**
 * Translate a focus/blur event into a snapshot transition on the editor's
 * cursor state machine. Returns the new snapshot so callers can chain it
 * without inspecting internals.
 */
export function attachCursorListeners(
  container: HTMLElement,
): CursorEventBinding {
  // Defensive: in headless test environments the DOM globals may still be
  // present (vitest's default env) but they are not tied to a real document
  // with a body — bind only if we can actually attach to a document.
  const canAttach =
    typeof document !== 'undefined' &&
    typeof container.addEventListener === 'function';

  const binding: CursorEventBinding = {
    container,
    focusedBlockId: null,
    snapshot: initCursor(),
    dispose: () => {
      if (canAttach) {
        container.removeEventListener('focusin', focusListener);
        container.removeEventListener('focusout', blurListener);
      }
    },
  };

  const focusListener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const blockEl = target.closest<HTMLElement>('[data-block-id]');
    if (blockEl === null) {
      binding.snapshot = applyTransition(binding.snapshot, blurAll(binding.snapshot));
      binding.focusedBlockId = binding.snapshot.focused;
      return;
    }
    const id = blockEl.dataset.blockId;
    if (typeof id !== 'string' || id.length === 0) return;
    const transition: CursorTransition = focusBlock(binding.snapshot, id);
    binding.snapshot = transition.to;
    binding.focusedBlockId = transition.to.focused;
  };

  const blurListener = (): void => {
    const transition = blurAll(binding.snapshot);
    binding.snapshot = transition.to;
    binding.focusedBlockId = transition.to.focused;
  };

  if (canAttach) {
    container.addEventListener('focusin', focusListener);
    container.addEventListener('focusout', blurListener);
  }

  return binding;
}

/**
 * Sample paste handler delegate. Real DOM `paste` events bubble up through
 * the editor container; this function returns the parsed markdown payload
 * (or a plain-text payload for non-markdown pastes).
 *
 * Kept separate from the DOM listeners so pure-logic tests can exercise the
 * paste → markdown pipeline without instantiating the DOM.
 */
export async function readClipboardText(blob: Blob | null): Promise<string> {
  if (blob === null) return '';
  // Lazy load so this module stays browser-only.
  const BlobCtor = typeof Blob !== 'undefined' ? Blob : null;
  if (BlobCtor === null) return '';
  if (typeof blob.text === 'function') return blob.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : resolve('');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(blob);
  });
}
