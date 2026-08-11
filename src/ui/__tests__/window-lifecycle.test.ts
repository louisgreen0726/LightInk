import { describe, expect, it, vi } from 'vitest';

import {
  createWindowCloseGuard,
  installWindowCloseProtection,
  type BeforeUnloadEventLike,
} from '../window-lifecycle.js';

function closeEvent() {
  return { preventDefault: vi.fn<() => void>() };
}

describe('native window close guard', () => {
  it('allows a clean window to close without interception', () => {
    const confirmExit = vi.fn(async () => 'cancel' as const);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => false,
      confirmExit,
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots: vi.fn(),
      closeWindow: vi.fn(async () => undefined),
    });
    const event = closeEvent();

    expect(guard.handleCloseRequested(event)).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirmExit).not.toHaveBeenCalled();
  });

  it('shares repeated close events and only permits the programmatic retry', async () => {
    let releaseChoice: ((choice: 'save') => void) | undefined;
    const confirmExit = vi.fn(
      () =>
        new Promise<'save'>((resolve) => {
          releaseChoice = resolve;
        }),
    );
    let guard: ReturnType<typeof createWindowCloseGuard>;
    const retryEvent = closeEvent();
    const closeWindow = vi.fn(async () => {
      expect(guard.handleCloseRequested(retryEvent)).toBeNull();
    });
    guard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit,
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots: vi.fn(),
      closeWindow,
    });
    const firstEvent = closeEvent();
    const repeatedEvent = closeEvent();

    const first = guard.handleCloseRequested(firstEvent);
    const repeated = guard.handleCloseRequested(repeatedEvent);
    expect(repeated).toBe(first);
    expect(confirmExit).toHaveBeenCalledOnce();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    releaseChoice!('save');
    await first;

    expect(closeWindow).toHaveBeenCalledOnce();
    expect(retryEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the window open and flushes snapshots on cancel or save failure', async () => {
    const flushDirtySnapshots = vi.fn();
    const closeWindow = vi.fn(async () => undefined);
    const cancelGuard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit: vi.fn(async (): Promise<'cancel'> => 'cancel'),
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots,
      closeWindow,
    });
    await cancelGuard.handleCloseRequested(closeEvent());

    const failedGuard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit: vi.fn(async (): Promise<'save'> => 'save'),
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots,
      closeWindow,
    });
    await failedGuard.handleCloseRequested(closeEvent());

    expect(flushDirtySnapshots).toHaveBeenCalledTimes(2);
    expect(closeWindow).not.toHaveBeenCalled();
  });
});

describe('browser beforeunload fallback', () => {
  it('blocks unload and flushes recovery snapshots only when dirty', async () => {
    let dirty = true;
    const flushDirtySnapshots = vi.fn();
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => dirty,
      confirmExit: vi.fn(async (): Promise<'cancel'> => 'cancel'),
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots,
      closeWindow: vi.fn(async () => undefined),
    });
    const event = {
      preventDefault: vi.fn(),
      returnValue: 'unchanged',
    } satisfies BeforeUnloadEventLike;

    guard.handleBeforeUnload(event);
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
    expect(flushDirtySnapshots).toHaveBeenCalledOnce();

    dirty = false;
    guard.handleBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('falls back to beforeunload when the native close bridge cannot initialize', async () => {
    const addEventListener = vi.fn();
    const reportError = vi.fn();
    const failure = new Error('window bridge unavailable');
    installWindowCloseProtection({
      window: { addEventListener },
      isNative: true,
      getNativeWindow: vi.fn(async () => {
        throw failure;
      }),
      hasUnsavedChanges: () => false,
      confirmExit: vi.fn(async () => 'cancel' as const),
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots: vi.fn(),
      reportError,
    });

    await vi.waitFor(() => expect(addEventListener).toHaveBeenCalledOnce());
    expect(addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
