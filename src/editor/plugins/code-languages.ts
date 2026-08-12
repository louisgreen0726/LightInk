import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

type LanguageModule = { readonly default: LanguageFn };
type LanguageLoader = () => Promise<LanguageModule>;

/**
 * Keep the picker intentionally focused on common document and programming
 * languages. Literal imports let Vite emit one on-demand chunk per grammar.
 */
const LANGUAGE_LOADERS = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
} satisfies Record<string, LanguageLoader>;

export type HighlightLanguage = keyof typeof LANGUAGE_LOADERS;

export const SUPPORTED_HIGHLIGHT_LANGUAGES: readonly HighlightLanguage[] = (
  Object.keys(LANGUAGE_LOADERS) as HighlightLanguage[]
).sort((left, right) => left.localeCompare(right));

const LANGUAGE_ALIASES: Readonly<Record<string, HighlightLanguage>> = {
  atom: 'xml',
  'c#': 'csharp',
  'c++': 'cpp',
  cjs: 'javascript',
  console: 'shell',
  cs: 'csharp',
  cts: 'typescript',
  docker: 'dockerfile',
  golang: 'go',
  h: 'c',
  'h++': 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'xml',
  html: 'xml',
  hxx: 'cpp',
  ipython: 'python',
  irb: 'ruby',
  js: 'javascript',
  jsonc: 'json',
  jsp: 'java',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  mkd: 'markdown',
  mkdown: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  plist: 'xml',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  rss: 'xml',
  sh: 'bash',
  shellsession: 'shell',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  wsf: 'xml',
  xhtml: 'xml',
  xjb: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yml: 'yaml',
  zsh: 'bash',
};

const LANGUAGE_DEPENDENCIES: Partial<
  Readonly<Record<HighlightLanguage, readonly HighlightLanguage[]>>
> = {
  dockerfile: ['bash'],
  markdown: ['xml'],
  shell: ['bash'],
  yaml: ['ruby'],
};

const languagePromises = new Map<HighlightLanguage, Promise<boolean>>();

export function resolveHighlightLanguage(tag: string): HighlightLanguage | null {
  const normalized = tag.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_LOADERS, normalized)) {
    return normalized as HighlightLanguage;
  }
  return LANGUAGE_ALIASES[normalized] ?? null;
}

export function isHighlightLanguageLoaded(language: HighlightLanguage): boolean {
  return hljs.getLanguage(language) !== undefined;
}

/** Load and register a grammar once, including the dependencies declared by highlight.js. */
export async function ensureHighlightLanguage(
  language: HighlightLanguage,
): Promise<boolean> {
  if (isHighlightLanguageLoaded(language)) {
    return true;
  }
  const existing = languagePromises.get(language);
  if (existing !== undefined) {
    return existing;
  }

  const pending = (async (): Promise<boolean> => {
    for (const dependency of LANGUAGE_DEPENDENCIES[language] ?? []) {
      if (!(await ensureHighlightLanguage(dependency))) {
        return false;
      }
    }
    const module = await LANGUAGE_LOADERS[language]();
    if (!isHighlightLanguageLoaded(language)) {
      hljs.registerLanguage(language, module.default);
    }
    return isHighlightLanguageLoaded(language);
  })().catch(() => false);
  languagePromises.set(language, pending);

  const loaded = await pending;
  if (!loaded) {
    languagePromises.delete(language);
  }
  return loaded;
}

export { hljs as highlightEngine };
