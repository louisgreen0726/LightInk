/**
 * Lightweight i18n service: locale persistence + t().
 * UI rebuilds on locale change via subscribe().
 */

import {
  DEFAULT_LOCALE,
  isLocaleId,
  LOCALE_STORAGE_KEY,
  translate,
  type LocaleId,
  type MessageKey,
} from './messages.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LocaleListener = (locale: LocaleId) => void;

function detectSystemLocale(
  languages: readonly string[] = typeof navigator !== 'undefined'
    ? navigator.languages ?? [navigator.language]
    : ['zh-CN'],
): LocaleId {
  for (const lang of languages) {
    const lower = (lang ?? '').toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

export function loadLocale(storage: StorageLike | null | undefined): LocaleId {
  if (storage != null) {
    try {
      const saved = storage.getItem(LOCALE_STORAGE_KEY);
      if (isLocaleId(saved)) return saved;
    } catch {
      // ignore
    }
  }
  return detectSystemLocale();
}

export function saveLocale(
  storage: StorageLike | null | undefined,
  locale: LocaleId,
): void {
  if (storage == null) return;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export interface I18n {
  readonly locale: LocaleId;
  t(key: MessageKey, vars?: Readonly<Record<string, string>>): string;
  setLocale(locale: LocaleId): void;
  subscribe(listener: LocaleListener): () => void;
}

export function createI18n(
  storage: StorageLike | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
  initial?: LocaleId,
): I18n {
  let locale = initial ?? loadLocale(storage);
  const listeners = new Set<LocaleListener>();

  const applyRoot = (): void => {
    try {
      if (typeof document !== 'undefined') {
        document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
      }
    } catch {
      // ignore
    }
  };
  applyRoot();

  return {
    get locale() {
      return locale;
    },
    t(key, vars) {
      return translate(locale, key, vars);
    },
    setLocale(next) {
      if (next === locale) return;
      locale = next;
      saveLocale(storage, next);
      applyRoot();
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
