import type { ExitChoice } from './exit-confirmation.js';

export interface CloseRequestEventLike {
  preventDefault(): void;
}

export interface BeforeUnloadEventLike extends CloseRequestEventLike {
  returnValue: string;
}

export interface WindowCloseGuardDeps {
  hasUnsavedChanges(): boolean;
  confirmExit(): Promise<ExitChoice>;
  closeAllTabs(action: Exclude<ExitChoice, 'cancel'>): Promise<boolean>;
  flushDirtySnapshots(): void | Promise<void>;
  closeWindow(): Promise<void>;
  reportError?: (error: unknown) => void;
}

export interface WindowCloseGuard {
  handleCloseRequested(event: CloseRequestEventLike): Promise<void> | null;
  handleBeforeUnload(event: BeforeUnloadEventLike): void;
  isHandlingClose(): boolean;
}

export interface NativeWindowCloseTarget {
  destroy(): Promise<void>;
  onCloseRequested(listener: (event: CloseRequestEventLike) => void): Promise<unknown>;
}

export interface BrowserCloseTarget {
  addEventListener(
    type: 'beforeunload',
    listener: (event: BeforeUnloadEventLike) => void,
  ): void;
}

export interface WindowCloseProtectionDeps
  extends Omit<WindowCloseGuardDeps, 'closeWindow'> {
  readonly window: BrowserCloseTarget;
  readonly isNative: boolean;
  readonly getNativeWindow: () => Promise<NativeWindowCloseTarget>;
}

/** Coordinate native close requests without allowing async confirmation races. */
export function createWindowCloseGuard(deps: WindowCloseGuardDeps): WindowCloseGuard {
  let inFlight: Promise<void> | null = null;

  const reportError = (error: unknown): void => {
    deps.reportError?.(error);
  };

  const flushSnapshots = async (): Promise<void> => {
    try {
      await deps.flushDirtySnapshots();
    } catch (error) {
      reportError(error);
    }
  };

  const runCloseDecision = async (): Promise<void> => {
    const choice = await deps.confirmExit();
    if (choice === 'cancel') {
      await flushSnapshots();
      return;
    }
    const closed = await deps.closeAllTabs(choice);
    if (!closed) {
      await flushSnapshots();
      return;
    }

    try {
      await deps.closeWindow();
    } catch (error) {
      reportError(error);
    }
  };

  return {
    handleCloseRequested(event) {
      if (!deps.hasUnsavedChanges()) {
        return null;
      }

      // Tauri requires cancellation during the event callback; awaiting the
      // confirmation first would let the native window be destroyed.
      event.preventDefault();
      if (inFlight !== null) {
        return inFlight;
      }

      const pending = runCloseDecision().catch(reportError);
      inFlight = pending;
      void pending.then(() => {
        if (inFlight === pending) {
          inFlight = null;
        }
      });
      return pending;
    },
    handleBeforeUnload(event) {
      if (!deps.hasUnsavedChanges()) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
      void flushSnapshots();
    },
    isHandlingClose: () => inFlight !== null,
  };
}

/** Bind the shared guard to Tauri close events or the browser beforeunload fallback. */
export function installWindowCloseProtection(deps: WindowCloseProtectionDeps): void {
  const installBrowserFallback = (): void => {
    const guard = createWindowCloseGuard({
      ...deps,
      closeWindow: async () => undefined,
    });
    deps.window.addEventListener('beforeunload', (event) => {
      guard.handleBeforeUnload(event);
    });
  };

  if (!deps.isNative) {
    installBrowserFallback();
    return;
  }

  void deps
    .getNativeWindow()
    .then(async (appWindow) => {
      const guard = createWindowCloseGuard({
        ...deps,
        // Tauri's onCloseRequested wrapper already destroys a clean window.
        // After an intercepted dirty close, destroy directly so close() does
        // not emit another CloseRequested event and re-enter this guard.
        closeWindow: () => appWindow.destroy(),
      });
      await appWindow.onCloseRequested((event) => {
        return guard.handleCloseRequested(event) ?? undefined;
      });
    })
    .catch((error: unknown) => {
      installBrowserFallback();
      deps.reportError?.(error);
    });
}
