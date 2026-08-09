/**
 * Shell chrome visibility controller (immersive writing redesign R2/R3).
 *
 * Owns pure reveal/dismiss/hold/hysteresis state for chrome surfaces so the
 * app shell can default to editor-first paint and only show menu/tab chrome on
 * demand. DOM class application stays in app-shell; this module is headless-
 * testable with injectable timers.
 */

export type ChromeSurface = 'menu' | 'tabs';

export interface ChromeControllerOptions {
  /** Leave-delay before auto-dismiss when pointer exits (ms). Default 180. */
  leaveDelayMs?: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
}

export interface ChromeController {
  isRevealed(surface: ChromeSurface): boolean;
  /** Force-show a surface (hotkey / programmatic). */
  reveal(surface: ChromeSurface): void;
  /** Hide unless held open by a nested menu. */
  dismiss(surface: ChromeSurface): void;
  /** Toggle reveal state (hotkey). */
  toggle(surface: ChromeSurface): void;
  /** While true, dismiss/leave will not hide the surface (open dropdown). */
  setHold(surface: ChromeSurface, hold: boolean): void;
  pointerEnter(surface: ChromeSurface): void;
  pointerLeave(surface: ChromeSurface): void;
  /** Test helper: cancel pending leave timers. */
  dispose(): void;
}

interface SurfaceState {
  revealed: boolean;
  hold: boolean;
  pointerInside: boolean;
  leaveTimer: number | null;
}

const DEFAULT_LEAVE_DELAY_MS = 180;

export function createChromeController(
  options: ChromeControllerOptions = {},
): ChromeController {
  const leaveDelayMs = options.leaveDelayMs ?? DEFAULT_LEAVE_DELAY_MS;
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      if (typeof setTimeout === 'undefined') {
        fn();
        return 0;
      }
      return setTimeout(fn, ms) as unknown as number;
    });
  const cancel =
    options.cancel ??
    ((id) => {
      if (typeof clearTimeout !== 'undefined') {
        clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      }
    });

  const states = new Map<ChromeSurface, SurfaceState>();

  function stateOf(surface: ChromeSurface): SurfaceState {
    let state = states.get(surface);
    if (state === undefined) {
      state = {
        revealed: false,
        hold: false,
        pointerInside: false,
        leaveTimer: null,
      };
      states.set(surface, state);
    }
    return state;
  }

  function clearLeave(surface: ChromeSurface): void {
    const state = stateOf(surface);
    if (state.leaveTimer !== null) {
      cancel(state.leaveTimer);
      state.leaveTimer = null;
    }
  }

  function scheduleLeave(surface: ChromeSurface): void {
    const state = stateOf(surface);
    if (state.hold || state.pointerInside) {
      return;
    }
    clearLeave(surface);
    state.leaveTimer = schedule(() => {
      state.leaveTimer = null;
      if (!state.hold && !state.pointerInside) {
        state.revealed = false;
      }
    }, leaveDelayMs);
  }

  function reveal(surface: ChromeSurface): void {
    clearLeave(surface);
    stateOf(surface).revealed = true;
  }

  function dismiss(surface: ChromeSurface): void {
    const state = stateOf(surface);
    if (state.hold) {
      return;
    }
    clearLeave(surface);
    state.revealed = false;
  }

  function toggle(surface: ChromeSurface): void {
    const state = stateOf(surface);
    if (state.revealed) {
      dismiss(surface);
    } else {
      reveal(surface);
    }
  }

  function setHold(surface: ChromeSurface, hold: boolean): void {
    const state = stateOf(surface);
    state.hold = hold;
    if (hold) {
      clearLeave(surface);
      state.revealed = true;
      return;
    }
    // Hold released (dropdown closed): if pointer already left, start hysteresis.
    scheduleLeave(surface);
  }

  function pointerEnter(surface: ChromeSurface): void {
    const state = stateOf(surface);
    state.pointerInside = true;
    clearLeave(surface);
    state.revealed = true;
  }

  function pointerLeave(surface: ChromeSurface): void {
    const state = stateOf(surface);
    state.pointerInside = false;
    scheduleLeave(surface);
  }

  function dispose(): void {
    for (const surface of states.keys()) {
      clearLeave(surface);
    }
  }

  return {
    isRevealed: (surface) => stateOf(surface).revealed,
    reveal,
    dismiss,
    toggle,
    setHold,
    pointerEnter,
    pointerLeave,
    dispose,
  };
}
