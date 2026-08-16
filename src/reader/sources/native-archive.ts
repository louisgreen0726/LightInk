import { invoke } from '@tauri-apps/api/core';

import type {
  ArchiveEntryMetadata,
  ArchiveProvider,
  ReaderTarget,
} from './types.js';

export const NATIVE_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'cbr',
  'cb7',
  'rar',
  '7z',
]);

export interface NativeArchiveEntry extends ArchiveEntryMetadata {
  readonly id: string;
  readonly filename: string;
  readonly encrypted: boolean;
  readonly solid: boolean;
  readonly split: boolean;
}

interface NativeArchiveOpenResult {
  readonly archiveId: string;
  readonly format: string;
  readonly accessMode: 'random' | 'sequential';
  readonly solid: boolean;
  readonly encrypted: boolean;
  readonly multivolume: boolean;
  readonly entries: readonly NativeArchiveEntry[];
}

export interface NativeArchiveInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface ArchivePasswordRequest {
  readonly displayName: string;
  readonly retry: boolean;
}

export type ArchivePasswordProvider = (
  request: ArchivePasswordRequest,
) => Promise<string | null>;

export class NativeArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NativeArchiveError';
  }
}

const defaultInvoker: NativeArchiveInvoker = { invoke };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

function archiveError(error: unknown): NativeArchiveError {
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value['code'] === 'string' && typeof value['message'] === 'string') {
      return new NativeArchiveError(value['code'], value['message']);
    }
  }
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as Record<string, unknown>;
      if (typeof parsed['code'] === 'string' && typeof parsed['message'] === 'string') {
        return new NativeArchiveError(parsed['code'], parsed['message']);
      }
    } catch {
      // Tauri may reject with a plain backend message.
    }
  }
  return new NativeArchiveError('ARCHIVE_UNKNOWN', String(error ?? '归档读取失败'));
}

function isPasswordError(error: NativeArchiveError): boolean {
  return (
    error.code === 'ARCHIVE_PASSWORD_REQUIRED' ||
    error.code === 'ARCHIVE_PASSWORD_INCORRECT'
  );
}

function bytesFromIpc(raw: ArrayBuffer | Uint8Array | readonly number[]): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  throw new NativeArchiveError('ARCHIVE_IPC_INVALID', '归档条目返回了无效字节');
}

async function requestPassword(
  provider: ArchivePasswordProvider | undefined,
  displayName: string,
  retry: boolean,
): Promise<string> {
  const password = await provider?.({ displayName, retry });
  if (password === undefined || password === null) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  return password;
}

/** Open a backend-native RAR/7z session without exposing its source bytes to the WebView. */
export async function openNativeArchive(
  target: ReaderTarget,
  options: {
    readonly signal?: AbortSignal;
    readonly invoker?: NativeArchiveInvoker;
    readonly requestPassword?: ArchivePasswordProvider;
  } = {},
): Promise<ArchiveProvider> {
  const invoker = options.invoker ?? defaultInvoker;
  const sourceArgs =
    target.kind === 'local'
      ? { path: target.path, resourceId: undefined }
      : { path: undefined, resourceId: target.resourceId };
  let password: string | undefined;
  let opened: NativeArchiveOpenResult;
  while (true) {
    throwIfAborted(options.signal);
    try {
      opened = await invoker.invoke<NativeArchiveOpenResult>('archive_open', {
        ...sourceArgs,
        password,
      });
      break;
    } catch (error) {
      const structured = archiveError(error);
      if (!isPasswordError(structured)) throw structured;
      password = await requestPassword(
        options.requestPassword,
        target.displayName,
        structured.code === 'ARCHIVE_PASSWORD_INCORRECT',
      );
    }
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await invoker.invoke<void>('archive_close', { archiveId: opened.archiveId });
    } finally {
      if (target.kind === 'remote') {
        await invoker.invoke<void>('remote_close', { resourceId: target.resourceId });
      }
    }
  };
  if (options.signal?.aborted === true) {
    await close().catch(() => undefined);
    throwIfAborted(options.signal);
  }

  return {
    entries: opened.entries,
    accessMode: opened.accessMode,
    async readEntry(entryId, signal) {
      if (closed) {
        throw new NativeArchiveError('ARCHIVE_SESSION_NOT_FOUND', '归档会话已关闭');
      }
      throwIfAborted(signal);
      while (true) {
        try {
          const raw = await invoker.invoke<ArrayBuffer | Uint8Array | number[]>(
            'archive_read_entry',
            { archiveId: opened.archiveId, entryId, password },
          );
          throwIfAborted(signal);
          return bytesFromIpc(raw);
        } catch (error) {
          const structured = archiveError(error);
          if (!isPasswordError(structured)) throw structured;
          password = await requestPassword(
            options.requestPassword,
            target.displayName,
            structured.code === 'ARCHIVE_PASSWORD_INCORRECT',
          );
          throwIfAborted(signal);
        }
      }
    },
    close,
  };
}
