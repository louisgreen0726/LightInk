/** Internal cancellation marker for superseded or destroyed Reader loads. */
export class ReaderLoadCancelledError extends Error {
  constructor() {
    super('Reader load cancelled');
    this.name = 'ReaderLoadCancelledError';
  }
}

export function throwIfReaderLoadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ReaderLoadCancelledError();
  }
}

export function isReaderLoadCancelled(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || error instanceof ReaderLoadCancelledError;
}
