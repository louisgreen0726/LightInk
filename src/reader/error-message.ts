import type { MessageKey } from '../i18n/messages.js';

type Translate = (
  key: MessageKey,
  vars?: Readonly<Record<string, string>>,
) => string;

const LIMIT_KEYS = {
  archiveEntries: 'reader.limit.archiveEntries',
  archiveTotalBytes: 'reader.limit.archiveTotalBytes',
  archiveEntryBytes: 'reader.limit.archiveEntryBytes',
  archiveCompressionRatio: 'reader.limit.archiveCompressionRatio',
  readerImageBytes: 'reader.limit.readerImageBytes',
  pdfPages: 'reader.limit.pdfPages',
  cbzPages: 'reader.limit.cbzPages',
} as const satisfies Readonly<Record<string, MessageKey>>;

const CAPABILITY_KEYS = {
  mobiDrm: 'reader.capability.mobiDrm',
  mobiKf8: 'reader.capability.mobiKf8',
  mobiHuff: 'reader.capability.mobiHuff',
} as const satisfies Readonly<Record<string, MessageKey>>;

const STRUCTURED_KEYS: Readonly<Record<string, MessageKey>> = {
  ARCHIVE_MULTIVOLUME_UNSUPPORTED: 'reader.archive.multivolumeUnsupported',
  ARCHIVE_CODEC_UNSUPPORTED: 'reader.archive.codecUnsupported',
  ARCHIVE_FORMAT_UNSUPPORTED: 'reader.archive.formatUnsupported',
  ARCHIVE_CORRUPT: 'reader.archive.corrupt',
  ARCHIVE_ENTRY_NOT_FOUND: 'reader.archive.corrupt',
  ARCHIVE_IO: 'reader.archive.io',
  ARCHIVE_SOURCE_INVALID: 'reader.archive.io',
  ARCHIVE_SESSION_NOT_FOUND: 'reader.archive.io',
  ARCHIVE_STAGE_NOT_FOUND: 'reader.archive.io',
  ARCHIVE_STATE_UNAVAILABLE: 'reader.archive.io',
  ARCHIVE_TASK_FAILED: 'reader.archive.io',
  ARCHIVE_ENTRY_LIMIT: 'reader.archive.entryLimit',
  ARCHIVE_ENTRY_TOO_LARGE: 'reader.archive.entryTooLarge',
  ARCHIVE_TOTAL_SIZE_LIMIT: 'reader.archive.totalSizeLimit',
  ARCHIVE_COMPRESSION_RATIO_LIMIT: 'reader.archive.compressionRatioLimit',
  ARCHIVE_MEMORY_LIMIT: 'reader.archive.memoryLimit',
  ARCHIVE_NESTING_LIMIT: 'reader.archive.nestingLimit',
  ARCHIVE_REMOTE_CACHE_INCOMPLETE: 'reader.archive.remoteCacheIncomplete',
  ARCHIVE_PASSWORD_REQUIRED: 'reader.archive.passwordRequired',
  ARCHIVE_PASSWORD_INCORRECT: 'reader.archive.passwordIncorrect',
  ARCHIVE_CANCELLED: 'reader.error.cancelled',
  REMOTE_CACHE_SPACE_INSUFFICIENT: 'reader.remote.cacheSpaceInsufficient',
  REMOTE_RESOURCE_CHANGED: 'reader.remote.resourceChanged',
  REMOTE_SIZE_CHANGED: 'reader.remote.resourceChanged',
  REMOTE_RANGE_UNAVAILABLE: 'reader.remote.rangeUnavailable',
  REMOTE_AUTH_REQUIRED: 'reader.remote.authRequired',
  REMOTE_CREDENTIAL_INVALID: 'reader.remote.credentialInvalid',
  REMOTE_FORBIDDEN: 'reader.remote.forbidden',
  REMOTE_HANDLE_NOT_FOUND: 'reader.remote.handleUnavailable',
  REMOTE_HTTP_NOT_ALLOWED: 'reader.remote.httpNotAllowed',
  REMOTE_SCHEME_UNSUPPORTED: 'reader.remote.schemeUnsupported',
  REMOTE_STATE_UNAVAILABLE: 'reader.remote.stateUnavailable',
  REMOTE_TEXT_ENCODING: 'reader.remote.textEncoding',
  REMOTE_URL_INVALID: 'reader.remote.urlInvalid',
  REMOTE_CONTENT_RANGE_INVALID: 'reader.remote.rangeInvalid',
  REMOTE_RANGE_INVALID: 'reader.remote.rangeInvalid',
  REMOTE_RANGE_TOO_LARGE: 'reader.remote.rangeInvalid',
  REMOTE_NETWORK_ERROR: 'reader.remote.networkError',
  REMOTE_CLIENT_ERROR: 'reader.remote.networkError',
  REMOTE_CACHE_IO: 'reader.remote.cacheError',
  REMOTE_CACHE_DB: 'reader.remote.cacheError',
  REMOTE_CACHE_INCOMPLETE: 'reader.archive.remoteCacheIncomplete',
  REMOTE_SIZE_UNKNOWN: 'reader.remote.sizeUnknown',
  REMOTE_DOCUMENT_TOO_LARGE: 'reader.remote.documentTooLarge',
  REMOTE_CANCELLED: 'reader.error.cancelled',
};

interface StructuredError {
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
  readonly actual?: unknown;
  readonly limit?: unknown;
}

function asStructuredError(error: unknown): StructuredError | null {
  if (error !== null && typeof error === 'object') return error as StructuredError;
  if (typeof error !== 'string') return null;
  try {
    const parsed = JSON.parse(error) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as StructuredError)
      : null;
  } catch {
    return null;
  }
}

function knownKey<T extends Readonly<Record<string, MessageKey>>>(
  values: T,
  key: unknown,
): keyof T | null {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(values, key)
    ? (key as keyof T)
    : null;
}

/** Convert backend and parser failures at the UI boundary without exposing Rust messages. */
export function readerLoadErrorDetail(error: unknown, t: Translate): string {
  const candidate = asStructuredError(error);
  if (candidate !== null) {
    const limitKind = knownKey(LIMIT_KEYS, candidate.kind);
    if (
      candidate.name === 'ReaderLimitError' &&
      limitKind !== null &&
      typeof candidate.actual === 'number' &&
      typeof candidate.limit === 'number'
    ) {
      return t(LIMIT_KEYS[limitKind], {
        actual: String(candidate.actual),
        limit: String(candidate.limit),
      });
    }
    const capabilityKind = knownKey(CAPABILITY_KEYS, candidate.kind);
    if (candidate.name === 'ReaderCapabilityError' && capabilityKind !== null) {
      return t(CAPABILITY_KEYS[capabilityKind]);
    }
    const messageCode =
      typeof candidate.message === 'string' && candidate.message in STRUCTURED_KEYS
        ? candidate.message
        : undefined;
    const code = typeof candidate.code === 'string' ? candidate.code : messageCode;
    if (code === 'REMOTE_HTTP_ERROR') {
      return t('reader.remote.httpError', {
        status:
          typeof candidate.status === 'number' || typeof candidate.status === 'string'
            ? String(candidate.status)
            : '?',
      });
    }
    if (code !== undefined) {
      const key = STRUCTURED_KEYS[code];
      return key === undefined
        ? t('reader.error.structuredUnknown', { code })
        : t(key);
    }
  }
  return error instanceof Error ? error.message : String(error ?? '');
}
