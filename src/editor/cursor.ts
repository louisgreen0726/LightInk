/**
 * Cursor-mode state machine.
 *
 * Implements the Typora-style "cursor in source / cursor out renders" toggle
 * as a pure state machine so it can be unit-tested in vitest without a DOM.
 * `mountEditor` wires the actual DOM listeners; this file just owns the
 * states and transitions.
 *
 * Two per-block states per block:
 *   - `rendered`: the block's markdown source is collapsed into the rendered
 *     ProseMirror node. Moving the caret into the block should transition to
 *     `source` on focus and back to `rendered` on blur.
 *   - `source`: the block's raw markdown is shown inline. Editing happens on
 *     the raw text.
 *
 * Top-level controls "globally focused" vs. "no focused block" so the editor
 * can detect cross-block caret movement and decide whether to re-render the
 * previous block.
 */

export type BlockMode = 'rendered' | 'source';

/** Stable identifier for a block; the editor provides one per ProseMirror node. */
export type BlockId = string;

export interface CursorSnapshot {
  /** The block the caret is currently in. `null` when nothing is focused. */
  readonly focused: BlockId | null;
  /** Mode of every block we have ever tracked, indexed by block id. */
  readonly modes: ReadonlyMap<BlockId, BlockMode>;
}

export interface CursorTransition {
  readonly from: CursorSnapshot;
  readonly to: CursorSnapshot;
  readonly reason: 'focus' | 'blur' | 'toggle' | 'reset' | 'init';
  readonly affected: BlockId[];
}

/** Initial snapshot: no focused block, all unseen blocks default to rendered. */
export function initCursor(): CursorSnapshot {
  return { focused: null, modes: new Map() };
}

/** Read a block's mode (defaulting to rendered when not tracked). */
export function modeOf(snapshot: CursorSnapshot, id: BlockId): BlockMode {
  return snapshot.modes.get(id) ?? 'rendered';
}

/**
 * Transition: caret moved into a different block. The previous block — if any
 * — returns to `rendered` (i.e. `blur`), and the newly focused block becomes
 * `source` (i.e. its markdown source is shown inline).
 */
export function focusBlock(
  snapshot: CursorSnapshot,
  id: BlockId,
): CursorTransition {
  const nextModes = new Map(snapshot.modes);
  const affected: BlockId[] = [];

  if (snapshot.focused !== null && snapshot.focused !== id) {
    nextModes.set(snapshot.focused, 'rendered');
    affected.push(snapshot.focused);
  }
  if (id !== null && id !== snapshot.focused) {
    nextModes.set(id, 'source');
    affected.push(id);
  }

  const to: CursorSnapshot = { focused: id, modes: nextModes };
  return { from: snapshot, to, reason: 'focus', affected };
}

/** Transition: caret left any block (e.g. focus moved out of the editor). */
export function blurAll(snapshot: CursorSnapshot): CursorTransition {
  const nextModes = new Map(snapshot.modes);
  const affected: BlockId[] = [];
  if (snapshot.focused !== null) {
    nextModes.set(snapshot.focused, 'rendered');
    affected.push(snapshot.focused);
  }
  const to: CursorSnapshot = { focused: null, modes: nextModes };
  return { from: snapshot, to, reason: 'blur', affected };
}

/**
 * Toggle the mode of a single block explicitly (e.g. keyboard shortcut).
 * Idempotent on re-toggle: toggling twice on the same block returns to the
 * original mode.
 */
export function toggleBlock(
  snapshot: CursorSnapshot,
  id: BlockId,
): CursorTransition {
  const current = modeOf(snapshot, id);
  const nextModes = new Map(snapshot.modes);
  nextModes.set(id, current === 'rendered' ? 'source' : 'rendered');
  const to: CursorSnapshot = { focused: snapshot.focused, modes: nextModes };
  return { from: snapshot, to, reason: 'toggle', affected: [id] };
}

/** Reset to the initial state — used on editor unmount. */
export function resetCursor(): { from: CursorSnapshot; to: CursorSnapshot; reason: 'reset'; affected: [] } {
  const empty: CursorSnapshot = initCursor();
  return { from: empty, to: empty, reason: 'reset', affected: [] };
}

/**
 * Convenience helper for tests / callers that want the next snapshot without
 * inspecting the transition record.
 */
export function applyTransition(
  _snapshot: CursorSnapshot,
  transition: CursorTransition,
): CursorSnapshot {
  return transition.to;
}
