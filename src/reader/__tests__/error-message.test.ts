import { describe, expect, it } from 'vitest';

import { translate, type LocaleId } from '../../i18n/messages.js';
import { ReaderCapabilityError, ReaderLimitError } from '../formats/types.js';
import { readerLoadErrorDetail } from '../error-message.js';

const message = (locale: LocaleId, error: unknown): string =>
  readerLoadErrorDetail(error, (key, vars) => translate(locale, key, vars));

describe('reader error localization', () => {
  it('keeps structured frontend limits and capabilities localized', () => {
    expect(message('zh-CN', new ReaderLimitError('archiveEntries', 6, 5))).toContain(
      '实际 6；上限 5',
    );
    expect(message('en', new ReaderCapabilityError('mobiDrm'))).toContain('DRM-protected');
  });

  it('maps archive capability, safety, and cancellation codes without Rust messages', () => {
    expect(
      message('zh-CN', {
        code: 'ARCHIVE_MULTIVOLUME_UNSUPPORTED',
        message: 'raw backend detail',
      }),
    ).toBe('暂不支持多卷压缩包。');
    expect(message('en', { code: 'ARCHIVE_CODEC_UNSUPPORTED', message: 'raw' })).toContain(
      'unsupported compression codec',
    );
    expect(message('zh-CN', new Error('ARCHIVE_NESTING_LIMIT'))).toContain('嵌套深度');
    expect(message('zh-CN', { code: 'ARCHIVE_CANCELLED', message: 'raw' })).toBe(
      '读取操作已取消。',
    );
  });

  it('maps remote cache, validator, Range, auth, and HTTP failures', () => {
    expect(
      message('zh-CN', { code: 'REMOTE_CACHE_SPACE_INSUFFICIENT', message: 'raw' }),
    ).toContain('缓存空间上限不足');
    expect(message('en', { code: 'REMOTE_RESOURCE_CHANGED', message: 'raw' })).toContain(
      'resource changed',
    );
    expect(message('zh-CN', { code: 'REMOTE_RANGE_UNAVAILABLE', message: 'raw' })).toContain(
      '停止支持 Range',
    );
    expect(message('en', { code: 'REMOTE_AUTH_REQUIRED', message: 'raw' })).toContain(
      'Authentication',
    );
    expect(message('zh-CN', { code: 'REMOTE_CREDENTIAL_INVALID', message: 'raw' })).toContain(
      '凭据无效',
    );
    expect(message('en', { code: 'REMOTE_HANDLE_NOT_FOUND', message: 'raw' })).toContain(
      'Reopen',
    );
    expect(message('zh-CN', { code: 'REMOTE_STATE_UNAVAILABLE', message: 'raw' })).toContain(
      '暂时不可用',
    );
    expect(message('en', { code: 'REMOTE_TEXT_ENCODING', message: 'raw' })).toContain(
      'UTF-8 XML',
    );
    expect(
      message('zh-CN', { code: 'REMOTE_HTTP_ERROR', message: 'raw', status: 503 }),
    ).toBe('服务器返回 HTTP 503。');
  });

  it('parses Tauri JSON rejections and never exposes unknown structured backend text', () => {
    expect(
      message('en', JSON.stringify({ code: 'ARCHIVE_CORRUPT', message: 'secret raw detail' })),
    ).toBe('The archive is damaged or incomplete.');
    const unknown = message('zh-CN', { code: 'ARCHIVE_FUTURE_ERROR', message: 'Rust 原始错误' });
    expect(unknown).toContain('ARCHIVE_FUTURE_ERROR');
    expect(unknown).not.toContain('Rust 原始错误');
  });

  it('preserves ordinary frontend errors that have no backend code', () => {
    expect(message('en', new Error('Invalid local document'))).toBe('Invalid local document');
  });
});
