// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  bindBlockedRemoteImages,
  makeRemoteImagesInert,
  normalizeRemoteImageUrl,
  REMOTE_IMAGE_SOURCE_ATTRIBUTE,
  SessionRemoteImagePolicy,
} from '../remote-image-policy.js';

describe('normalizeRemoteImageUrl', () => {
  it('canonicalizes only HTTP and HTTPS image sources', () => {
    expect(normalizeRemoteImageUrl(' HTTPS://Example.COM/a.png#cover ')).toBe(
      'https://example.com/a.png#cover',
    );
    expect(normalizeRemoteImageUrl('//cdn.example/cover.png')).toBe(
      'https://cdn.example/cover.png',
    );
    expect(normalizeRemoteImageUrl('http://example.com')).toBe('http://example.com/');
  });

  it('rejects controls, malformed URLs, and unsupported schemes', () => {
    for (const source of [
      '',
      'https://example.com/cover.png\n',
      'javascript:alert(1)',
      'file:///tmp/cover.png',
      'data:image/png;base64,AAAA',
      'chapter/cover.png',
      'http://',
    ]) {
      expect(normalizeRemoteImageUrl(source)).toBeNull();
    }
  });
});

describe('SessionRemoteImagePolicy', () => {
  it('notifies every subscriber once and keeps consent in one policy instance', () => {
    const policy = new SessionRemoteImagePolicy();
    const first = vi.fn();
    const second = vi.fn();
    policy.subscribe(first);
    policy.subscribe(second);

    expect(policy.allowOnce('https://EXAMPLE.com/a.png')).toBe('https://example.com/a.png');
    expect(policy.allowOnce('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(policy.isAllowed('https://example.com/a.png')).toBe(true);
    expect(new SessionRemoteImagePolicy().isAllowed('https://example.com/a.png')).toBe(false);
  });
});

describe('remote image DOM binding', () => {
  function remoteImages(): HTMLDivElement {
    const root = document.createElement('div');
    root.innerHTML =
      '<img alt="cover" src="https://cdn.example/cover.png">' +
      '<img alt="duplicate" src="https://cdn.example/cover.png">' +
      '<img alt="relative" src="images/local.png">' +
      '<img alt="inline" src="data:image/png;base64,AAAA">';
    return root;
  }

  it('removes remote src values before content reaches the live DOM', () => {
    const root = remoteImages();
    makeRemoteImagesInert(root);

    const images = root.querySelectorAll('img');
    expect(images[0]!.getAttribute('src')).toBeNull();
    expect(images[0]!.getAttribute(REMOTE_IMAGE_SOURCE_ATTRIBUTE)).toBe(
      'https://cdn.example/cover.png',
    );
    expect(images[1]!.getAttribute('src')).toBeNull();
    expect(images[2]!.getAttribute('src')).toBe('images/local.png');
    expect(images[3]!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('loads every matching placeholder once without persisting consent', () => {
    const root = remoteImages();
    const policy = new SessionRemoteImagePolicy();
    makeRemoteImagesInert(root);
    const cleanup = bindBlockedRemoteImages(root, 'Load remote image', policy);

    const buttons = root.querySelectorAll<HTMLButtonElement>('.lightink-remote-image-load');
    expect(buttons).toHaveLength(2);
    expect(root.querySelectorAll(`img[${REMOTE_IMAGE_SOURCE_ATTRIBUTE}]`)).toHaveLength(0);
    buttons[0]!.click();

    const loaded = root.querySelectorAll<HTMLImageElement>('img[src^="https://"]');
    expect(loaded).toHaveLength(2);
    for (const image of loaded) {
      expect(image.src).toBe('https://cdn.example/cover.png');
      expect(image.referrerPolicy).toBe('no-referrer');
      expect(image.loading).toBe('lazy');
    }
    expect(root.querySelector('.lightink-remote-image-load')).toBeNull();
    expect(new SessionRemoteImagePolicy().isAllowed(loaded[0]!.src)).toBe(false);
    cleanup();
  });

  it('does not reveal detached placeholders after cleanup', () => {
    const root = remoteImages();
    const policy = new SessionRemoteImagePolicy();
    makeRemoteImagesInert(root);
    const cleanup = bindBlockedRemoteImages(root, 'Load remote image', policy);
    cleanup();

    policy.allowOnce('https://cdn.example/cover.png');
    expect(root.querySelectorAll('.lightink-remote-image-placeholder')).toHaveLength(2);
    expect(root.querySelectorAll<HTMLImageElement>('img[src^="https://"]')).toHaveLength(0);
  });
});
