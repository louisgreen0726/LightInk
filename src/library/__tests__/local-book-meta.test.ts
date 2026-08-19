// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

import { extractLocalBookMeta, isShelfCoverUrl } from '../local-book-meta.js';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function buildCoverEpub(): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add(
    'META-INF/container.xml',
    new Uint8ArrayReader(
      encode(
        '<?xml version="1.0"?><container><rootfiles>' +
          '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
          '</rootfiles></container>',
      ),
    ),
  );
  await zip.add(
    'OEBPS/content.opf',
    new Uint8ArrayReader(
      encode(
        '<?xml version="1.0"?><package>' +
          '<metadata><dc:title>河山记</dc:title><dc:creator>作者甲</dc:creator></metadata>' +
          '<manifest>' +
          '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>' +
          '</manifest>' +
          '<spine><itemref idref="ch1"/></spine>' +
          '</package>',
      ),
    ),
  );
  await zip.add('OEBPS/ch1.xhtml', new Uint8ArrayReader(encode('<html><body><p>一</p></body></html>')));
  await zip.add(
    'OEBPS/images/cover.png',
    new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    { level: 0 },
  );
  return zip.close();
}

describe('extractLocalBookMeta', () => {
  it('reads EPUB title, author, and cover-image', async () => {
    const meta = await extractLocalBookMeta('book.epub', await buildCoverEpub());
    expect(meta.title).toBe('河山记');
    expect(meta.authors).toEqual(['作者甲']);
    expect(meta.coverUrl?.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('isShelfCoverUrl', () => {
  it('accepts data image URLs and https covers', () => {
    expect(isShelfCoverUrl('data:image/png;base64,aaaa')).toBe(true);
    expect(isShelfCoverUrl('https://covers.example/a.jpg')).toBe(true);
    expect(isShelfCoverUrl('javascript:alert(1)')).toBe(false);
    expect(isShelfCoverUrl(undefined)).toBe(false);
    expect(isShelfCoverUrl(null)).toBe(false);
  });
});
