/**
 * Immersive chrome visibility controller tests (R2).
 */

import { describe, expect, it, vi } from 'vitest';

import { createChromeController } from '../chrome-controller.js';

describe('createChromeController', () => {
  it('defaults menu chrome to hidden (editor-first)', () => {
    const chrome = createChromeController();
    expect(chrome.isRevealed('menu')).toBe(false);
  });

  it('reveal / dismiss / toggle work when not held', () => {
    const chrome = createChromeController();
    chrome.reveal('menu');
    expect(chrome.isRevealed('menu')).toBe(true);
    chrome.dismiss('menu');
    expect(chrome.isRevealed('menu')).toBe(false);
    chrome.toggle('menu');
    expect(chrome.isRevealed('menu')).toBe(true);
    chrome.toggle('menu');
    expect(chrome.isRevealed('menu')).toBe(false);
  });

  it('hold keeps surface revealed and blocks dismiss/leave', () => {
    const timers: Array<{ id: number; fn: () => void }> = [];
    let nextId = 1;
    const chrome = createChromeController({
      leaveDelayMs: 50,
      schedule: (fn) => {
        const id = nextId++;
        timers.push({ id, fn });
        return id;
      },
      cancel: (id) => {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx >= 0) timers.splice(idx, 1);
      },
    });

    chrome.pointerEnter('menu');
    chrome.setHold('menu', true);
    chrome.pointerLeave('menu');
    // Flush any scheduled leave — hold must win.
    for (const t of [...timers]) t.fn();
    expect(chrome.isRevealed('menu')).toBe(true);

    chrome.dismiss('menu');
    expect(chrome.isRevealed('menu')).toBe(true);

    chrome.setHold('menu', false);
    // Hold released with pointer outside → leave schedule hides.
    for (const t of [...timers]) t.fn();
    expect(chrome.isRevealed('menu')).toBe(false);
  });

  it('pointer leave uses hysteresis before hide', () => {
    const scheduled: Array<() => void> = [];
    const chrome = createChromeController({
      leaveDelayMs: 100,
      schedule: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      cancel: vi.fn(),
    });

    chrome.pointerEnter('menu');
    expect(chrome.isRevealed('menu')).toBe(true);
    chrome.pointerLeave('menu');
    expect(chrome.isRevealed('menu')).toBe(true);
    expect(scheduled.length).toBe(1);
    scheduled[0]?.();
    expect(chrome.isRevealed('menu')).toBe(false);
  });

  it('re-enter cancels pending leave (no thrash hide)', () => {
    let cancelled = 0;
    const leaveFns: Array<() => void> = [];
    const chrome = createChromeController({
      leaveDelayMs: 100,
      schedule: (fn) => {
        leaveFns.push(fn);
        return leaveFns.length;
      },
      cancel: () => {
        cancelled += 1;
        leaveFns.length = 0;
      },
    });

    chrome.pointerEnter('menu');
    chrome.pointerLeave('menu');
    chrome.pointerEnter('menu');
    expect(cancelled).toBe(1);
    expect(chrome.isRevealed('menu')).toBe(true);
    // Stale leave must not fire after re-enter cancelled it.
    for (const fn of leaveFns) {
      fn();
    }
    expect(chrome.isRevealed('menu')).toBe(true);
  });

  it('tabs surface defaults hidden and is independent of menu', () => {
    const chrome = createChromeController();
    expect(chrome.isRevealed('tabs')).toBe(false);
    chrome.reveal('tabs');
    expect(chrome.isRevealed('tabs')).toBe(true);
    expect(chrome.isRevealed('menu')).toBe(false);
    chrome.reveal('menu');
    chrome.dismiss('tabs');
    expect(chrome.isRevealed('tabs')).toBe(false);
    expect(chrome.isRevealed('menu')).toBe(true);
  });

  it('tabs hold blocks dismiss like menu', () => {
    const chrome = createChromeController();
    chrome.setHold('tabs', true);
    expect(chrome.isRevealed('tabs')).toBe(true);
    chrome.dismiss('tabs');
    expect(chrome.isRevealed('tabs')).toBe(true);
    chrome.setHold('tabs', false);
    chrome.dismiss('tabs');
    expect(chrome.isRevealed('tabs')).toBe(false);
  });

  it('pin keeps surface revealed and blocks dismiss/leave', () => {
    const timers: Array<{ id: number; fn: () => void }> = [];
    let nextId = 1;
    const chrome = createChromeController({
      leaveDelayMs: 50,
      schedule: (fn) => {
        const id = nextId++;
        timers.push({ id, fn });
        return id;
      },
      cancel: (id) => {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx >= 0) timers.splice(idx, 1);
      },
    });

    expect(chrome.isPinned('menu')).toBe(false);
    chrome.setPinned('menu', true);
    expect(chrome.isPinned('menu')).toBe(true);
    expect(chrome.isRevealed('menu')).toBe(true);
    chrome.pointerLeave('menu');
    for (const t of [...timers]) t.fn();
    expect(chrome.isRevealed('menu')).toBe(true);
    chrome.dismiss('menu');
    expect(chrome.isRevealed('menu')).toBe(true);
    chrome.toggle('menu');
    expect(chrome.isRevealed('menu')).toBe(true);

    chrome.setPinned('menu', false);
    chrome.pointerLeave('menu');
    for (const t of [...timers]) t.fn();
    expect(chrome.isRevealed('menu')).toBe(false);
  });

  it('togglePinned returns new state and pins both independently', () => {
    const chrome = createChromeController();
    expect(chrome.togglePinned('tabs')).toBe(true);
    expect(chrome.isPinned('tabs')).toBe(true);
    expect(chrome.isPinned('menu')).toBe(false);
    expect(chrome.togglePinned('tabs')).toBe(false);
    expect(chrome.isPinned('tabs')).toBe(false);
  });
});
