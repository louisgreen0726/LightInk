export const REMOTE_IMAGE_SOURCE_ATTRIBUTE = 'data-lightink-remote-src';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;
const SAFE_INLINE_IMAGE = /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/i;

/** Return a canonical remote image URL, or null for local/unsupported input. */
export function normalizeRemoteImageUrl(source: string): string | null {
  if (CONTROL_CHARACTERS.test(source)) return null;
  const value = source.trim();
  if (value === '') return null;
  const candidate = value.startsWith('//')
    ? `https:${value}`
    : ABSOLUTE_HTTP_URL.test(value)
      ? value
      : null;
  if (candidate === null) return null;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function isSafeInlineImageUrl(source: string): boolean {
  return !CONTROL_CHARACTERS.test(source) && SAFE_INLINE_IMAGE.test(source.trim());
}

export type RemoteImageAllowedListener = (url: string) => void;

export interface RemoteImagePolicy {
  isAllowed(source: string): boolean;
  allowOnce(source: string): string | null;
  subscribe(listener: RemoteImageAllowedListener): () => void;
}

/** Session-only consent store. It never reads from or writes to persistent storage. */
export class SessionRemoteImagePolicy implements RemoteImagePolicy {
  private readonly allowed = new Set<string>();
  private readonly listeners = new Set<RemoteImageAllowedListener>();

  isAllowed(source: string): boolean {
    const url = normalizeRemoteImageUrl(source);
    return url !== null && this.allowed.has(url);
  }

  allowOnce(source: string): string | null {
    const url = normalizeRemoteImageUrl(source);
    if (url === null) return null;
    if (!this.allowed.has(url)) {
      this.allowed.add(url);
      for (const listener of this.listeners) listener(url);
    }
    return url;
  }

  subscribe(listener: RemoteImageAllowedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const sessionRemoteImagePolicy: RemoteImagePolicy = new SessionRemoteImagePolicy();

/** Convert remote image sources in a detached DOM into inert attributes. */
export function makeRemoteImagesInert(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const source = image.getAttribute('src') ?? '';
    const remoteUrl = normalizeRemoteImageUrl(source);
    if (remoteUrl === null) continue;
    image.removeAttribute('src');
    image.setAttribute(REMOTE_IMAGE_SOURCE_ATTRIBUTE, remoteUrl);
  }
}

/**
 * Replace inert remote images with load-once controls. The returned cleanup
 * releases policy subscriptions when the containing view is rerendered.
 */
export function bindBlockedRemoteImages(
  root: ParentNode,
  loadLabel: string,
  policy: RemoteImagePolicy = sessionRemoteImagePolicy,
): () => void {
  const cleanups: Array<() => void> = [];
  for (const image of root.querySelectorAll<HTMLImageElement>(
    `img[${REMOTE_IMAGE_SOURCE_ATTRIBUTE}]`,
  )) {
    const source = image.getAttribute(REMOTE_IMAGE_SOURCE_ATTRIBUTE) ?? '';
    const remoteUrl = normalizeRemoteImageUrl(source);
    if (remoteUrl === null) {
      image.removeAttribute(REMOTE_IMAGE_SOURCE_ATTRIBUTE);
      continue;
    }

    const reveal = (): void => {
      image.removeAttribute(REMOTE_IMAGE_SOURCE_ATTRIBUTE);
      image.referrerPolicy = 'no-referrer';
      image.loading = 'lazy';
      image.src = remoteUrl;
    };
    if (policy.isAllowed(remoteUrl)) {
      reveal();
      continue;
    }

    const ownerDocument = image.ownerDocument;
    const placeholder = ownerDocument.createElement('span');
    placeholder.className = 'lightink-remote-image-placeholder';
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'lightink-remote-image-load';
    const alt = image.alt.trim();
    button.textContent = alt === '' ? loadLabel : `${loadLabel}: ${alt}`;
    button.setAttribute('aria-label', button.textContent);
    placeholder.appendChild(button);
    image.replaceWith(placeholder);

    let active = true;
    let unsubscribe = (): void => undefined;
    const revealPlaceholder = (): void => {
      if (!active) return;
      active = false;
      unsubscribe();
      reveal();
      placeholder.replaceWith(image);
    };
    unsubscribe = policy.subscribe((allowedUrl) => {
      if (allowedUrl === remoteUrl) revealPlaceholder();
    });
    const onClick = (): void => {
      policy.allowOnce(remoteUrl);
    };
    button.addEventListener('click', onClick);
    cleanups.push(() => {
      active = false;
      unsubscribe();
      button.removeEventListener('click', onClick);
    });
  }
  return () => cleanups.splice(0).forEach((cleanup) => cleanup());
}
