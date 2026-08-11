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

/** Coordinate native close requests without allowing async confirmation races. */
export function createWindowCloseGuard(deps: WindowCloseGuardDeps): WindowCloseGuard {
  let allowNextClose = false;
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

    allowNextClose = true;
    try {
      await deps.closeWindow();
    } catch (error) {
      allowNextClose = false;
      reportError(error);
    }
  };

  return {
    handleCloseRequested(event) {
      if (allowNextClose) {
        allowNextClose = false;
        return null;
      }
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
