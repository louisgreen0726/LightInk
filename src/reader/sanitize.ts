/**
 * Reader HTML sanitization for untrusted EPUB, MOBI, and FB2 content.
 * DOMPurify parses with the same DOM model used by rendering, then applies a
 * deliberately small reading allowlist and URL policy.
 */

import createDOMPurify, {
  type DOMPurify,
  type UponSanitizeAttributeHookEvent,
  type WindowLike,
} from 'dompurify';

const READER_TAGS = [
  'a',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'rp',
  'rt',
  'ruby',
  's',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
] as const;

const READER_ATTRIBUTES = [
  'alt',
  'colspan',
  'dir',
  'height',
  'href',
  'id',
  'lang',
  'reversed',
  'rowspan',
  'scope',
  'src',
  'start',
  'title',
  'value',
  'width',
] as const;

const URL_ATTRIBUTES = new Set(['href', 'src']);
const SAFE_RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isAllowedReaderUrl(tagName: string, attribute: string, rawValue: string): boolean {
  const value = rawValue.trim();
  if (value === '' || CONTROL_CHARACTERS.test(value)) {
    return false;
  }
  if (value.startsWith('//')) {
    return true;
  }
  const match = value.match(SCHEME);
  if (match === null) {
    return true;
  }
  const scheme = match[1]!.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return true;
  }
  if (attribute === 'src' && tagName === 'img') {
    return scheme === 'blob' || (scheme === 'data' && SAFE_RASTER_DATA_URL.test(value));
  }
  return false;
}

let purifierWindow: WindowLike | null = null;
let purifier: DOMPurify | null = null;

function readerPurifier(): DOMPurify {
  const currentWindow = globalThis.window as unknown as WindowLike | undefined;
  if (currentWindow === undefined) {
    throw new Error('Reader HTML sanitization requires a DOM window');
  }
  if (purifier !== null && purifierWindow === currentWindow) {
    return purifier;
  }

  const next = createDOMPurify(currentWindow);
  next.addHook(
    'uponSanitizeAttribute',
    (node: Element, event: UponSanitizeAttributeHookEvent) => {
      const attribute = event.attrName.toLowerCase();
      if (
        URL_ATTRIBUTES.has(attribute) &&
        !isAllowedReaderUrl(node.tagName.toLowerCase(), attribute, event.attrValue)
      ) {
        event.keepAttr = false;
      }
    },
  );
  purifierWindow = currentWindow;
  purifier = next;
  return next;
}

/** Sanitize untrusted flow-format HTML before it reaches any rendering DOM. */
export function sanitizeHtml(input: string): string {
  return readerPurifier().sanitize(input, {
    ALLOWED_TAGS: [...READER_TAGS],
    ALLOWED_ATTR: [...READER_ATTRIBUTES],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: true,
    FORBID_TAGS: [
      'applet',
      'base',
      'button',
      'embed',
      'form',
      'iframe',
      'input',
      'link',
      'math',
      'meta',
      'object',
      'script',
      'select',
      'style',
      'svg',
      'template',
      'textarea',
    ],
    FORBID_ATTR: ['style', 'srcset', 'ping', 'formaction', 'xlink:href'],
    RETURN_TRUSTED_TYPE: false,
  });
}
