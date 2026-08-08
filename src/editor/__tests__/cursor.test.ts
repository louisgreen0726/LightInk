/**
 * Cursor-mode state machine tests.
 *
 * These cover the pure-logic side of the "光标进入已渲染元素可编辑其 Markdown
 * 源码" outcome: the editor renders blocks when the caret leaves them, and
 * shows source while the caret is inside. The DOM event listeners in
 * `dom-events.ts` route real browser events into the same state machine, so
 * passing these tests is sufficient to validate the toggle contract headless.
 */

import { describe, expect, it } from 'vitest';

import {
  applyTransition,
  blurAll,
  focusBlock,
  initCursor,
  modeOf,
  toggleBlock,
  type CursorSnapshot,
} from '../cursor.js';

describe('cursor state machine', () => {
  it('initial state has no focused block and treats unknowns as rendered', () => {
    const s = initCursor();
    expect(s.focused).toBeNull();
    expect(modeOf(s, 'unknown')).toBe('rendered');
  });

  it('focusBlock moves an unseen block into source mode', () => {
    const s0 = initCursor();
    const t = focusBlock(s0, 'p1');
    expect(t.reason).toBe('focus');
    expect(t.affected).toEqual(['p1']);
    expect(t.to.focused).toBe('p1');
    expect(modeOf(t.to, 'p1')).toBe('source');
  });

  it('moving focus from block A to block B returns A to rendered', () => {
    const s0 = focusBlock(initCursor(), 'p1').to;
    const t = focusBlock(s0, 'p2');
    expect(modeOf(t.to, 'p1')).toBe('rendered');
    expect(modeOf(t.to, 'p2')).toBe('source');
    expect(t.affected.sort()).toEqual(['p1', 'p2'].sort());
  });

  it('focusing the same block twice does not flip its mode', () => {
    const s1 = focusBlock(initCursor(), 'p1').to;
    const t = focusBlock(s1, 'p1');
    expect(t.affected).toEqual([]);
    expect(modeOf(t.to, 'p1')).toBe('source');
  });

  it('blurAll returns every previously-focused block to rendered', () => {
    const s1 = focusBlock(initCursor(), 'p1').to;
    const t = blurAll(s1);
    expect(t.reason).toBe('blur');
    expect(t.to.focused).toBeNull();
    expect(modeOf(t.to, 'p1')).toBe('rendered');
  });

  it('toggleBlock flips a block between source and rendered', () => {
    const s0: CursorSnapshot = initCursor();
    const t1 = toggleBlock(s0, 'p1');
    expect(modeOf(t1.to, 'p1')).toBe('source');
    const t2 = toggleBlock(t1.to, 'p1');
    expect(modeOf(t2.to, 'p1')).toBe('rendered');
    const t3 = toggleBlock(t2.to, 'p1');
    expect(modeOf(t3.to, 'p1')).toBe('source');
  });

  it('toggleBlock does not change the focused pointer', () => {
    const s0 = focusBlock(initCursor(), 'p1').to;
    const t = toggleBlock(s0, 'p2');
    expect(t.to.focused).toBe('p1');
    expect(modeOf(t.to, 'p1')).toBe('source');
    expect(modeOf(t.to, 'p2')).toBe('source');
  });

  it('a full focus → blur cycle renders every touched block', () => {
    let snap: CursorSnapshot = initCursor();
    snap = applyTransition(snap, focusBlock(snap, 'p1'));
    snap = applyTransition(snap, focusBlock(snap, 'p2'));
    snap = applyTransition(snap, focusBlock(snap, 'p3'));
    snap = applyTransition(snap, blurAll(snap));
    expect(modeOf(snap, 'p1')).toBe('rendered');
    expect(modeOf(snap, 'p2')).toBe('rendered');
    expect(modeOf(snap, 'p3')).toBe('rendered');
  });

  it('transitions are immutable — older snapshots retain their mode', () => {
    const s0 = initCursor();
    focusBlock(s0, 'p1');
    // The original s0 is unchanged.
    expect(s0.focused).toBeNull();
    expect(modeOf(s0, 'p1')).toBe('rendered');
  });
});
