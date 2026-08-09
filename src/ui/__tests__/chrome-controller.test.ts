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
});
