// @vitest-environment jsdom

/**
 * 流式格式解析测试（ebook-reader T4）。
 *
 * 纯函数单测：sanitize、TXT（UTF-8/GBK 回退）、FB2（XML→HTML）、EPUB（jszip 合成
 * 最小 epub）、MOBI（合成最小 PalmDOC，含 DRM 报错）。
 */
import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

import { sanitizeHtml } from '../sanitize.js';
import { parseEpub } from '../formats/epub.js';
import { parseFb2 } from '../formats/fb2.js';
import { parseMobi } from '../formats/mobi.js';
import { parseTxt } from '../formats/txt.js';
import { ParseError, ReaderCapabilityError } from '../formats/types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sanitizeHtml', () => {
  it('移除 script/style 与注释', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
    expect(sanitizeHtml('<style>x{}</style><b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeHtml('a<!-- secret -->b')).toBe('ab');
  });

  it('移除事件处理器属性并拒绝危险 URL 协议', () => {
    const out = sanitizeHtml('<a onclick="evil()" href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('javascript');
  });

  it('按 DOM 解码后的值拒绝协议绕过和危险属性', () => {
    const out = sanitizeHtml(
      '<a href="jav&#x61;script:alert(1)" style="position:fixed" ping="https://track">x</a>' +
        '<img src="data:text/html;base64,PHNjcmlwdD4=" srcset="https://remote/x 2x" onerror="x">',
    );
    expect(out).toBe('<a>x</a><img>');
  });

  it('removes active containers, forms, SVG, and unknown elements', () => {
    const out = sanitizeHtml(
      '<form><input value="secret"><p>kept</p></form>' +
        '<svg><script>alert(1)</script><circle></circle></svg>' +
        '<custom-element><strong>text</strong></custom-element>',
    );
    expect(out).not.toMatch(/form|input|svg|script|circle|custom-element/i);
    expect(out).toContain('<p>kept</p>');
    expect(out).toContain('<strong>text</strong>');
  });

  it('keeps safe relative, fragment, and HTTP links', () => {
    const out = sanitizeHtml(
      '<a href="chapter-2.xhtml#part">next</a>' +
        '<a href="#footnote">note</a>' +
        '<a href="https://example.com/read">web</a>',
    );
    expect(out).toContain('href="chapter-2.xhtml#part"');
    expect(out).toContain('href="#footnote"');
    expect(out).toContain('href="https://example.com/read"');
  });

  it('makes remote images inert while preserving local image sources', () => {
    const container = document.createElement('div');
    container.innerHTML = sanitizeHtml(
      '<img alt="remote" src="https://cdn.example/book.png" srcset="https://cdn.example/book@2x.png 2x">' +
        '<img alt="relative" src="images/cover.png">' +
        '<img alt="inline" src="data:image/png;base64,iVBORw0KGgo=">',
    );

    const images = container.querySelectorAll('img');
    expect(images[0]!.getAttribute('src')).toBeNull();
    expect(images[0]!.getAttribute('srcset')).toBeNull();
    expect(images[0]!.getAttribute('data-lightink-remote-src')).toBe(
      'https://cdn.example/book.png',
    );
    expect(images[1]!.getAttribute('src')).toBe('images/cover.png');
    expect(images[2]!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('保留阅读格式标签', () => {
    const out = sanitizeHtml('<h1>T</h1><p>a <strong>b</strong> <em>c</em></p><blockquote>q</blockquote>');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>c</em>');
    expect(out).toContain('<blockquote>q</blockquote>');
  });
});

describe('parseTxt', () => {
  it('UTF-8 文本按空行分段为单章', () => {
    const content = parseTxt(enc('First line\nSecond line\n\nSecond para'));
    expect(content.chapters).toHaveLength(1);
    expect(content.chapters[0]!.html).toContain('<p>First line<br>Second line</p>');
    expect(content.chapters[0]!.html).toContain('<p>Second para</p>');
  });

  it('转义 HTML 特殊字符', () => {
    const content = parseTxt(enc('a < b & c > d'));
    expect(content.chapters[0]!.html).toContain('a &lt; b &amp; c &gt; d');
  });

  it('非 UTF-8 文本回退 GBK（运行时支持 GBK 时）', () => {
    // “中文”的 GBK 编码（0xD6 0xD0 0xCE 0xC4），不是合法 UTF-8。
    const gbkBuf = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    let gbkDecoded = false;
    try {
      new TextDecoder('gbk'); // 探测运行时是否支持 GBK
      gbkDecoded = true;
    } catch {
      gbkDecoded = false;
    }
    if (!gbkDecoded) {
      return; // 运行时无 GBK，跳过本例（UTF-8 兜底路径在其它用例覆盖）。
    }
    const content = parseTxt(gbkBuf);
    expect(content.chapters[0]!.html).toContain('中文');
  });
});

describe('parseFb2', () => {
  const fb2 = `<?xml version="1.0"?>
<FictionBook>
<description><title-info><book-title>FB2 书名</book-title></title-info></description>
<body>
<section><title><p>第一章</p></title><p>你好 <emphasis>世界</emphasis></p></section>
<section><title><p>第二章</p></title><p>第二 <strong>加粗</strong></p></section>
</body>
</FictionBook>`;

  it('每个 section 成一章，标题取自 <title>', () => {
    const content = parseFb2(enc(fb2));
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.title).toBe('第一章');
    expect(content.chapters[1]!.title).toBe('第二章');
  });

  it('FB2 语义标签转为 HTML', () => {
    const content = parseFb2(enc(fb2));
    expect(content.chapters[0]!.html).toContain('<em>世界</em>');
    expect(content.chapters[1]!.html).toContain('<strong>加粗</strong>');
  });

  it('恢复允许的 embedded image，并在 dispose 时释放 URL', () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:fb2-cover',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = parseFb2(
        enc(`<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
  <body><section><title><p>图章</p></title><p>正文</p><image l:href="#cover"/></section></body>
  <binary id="cover" content-type="image/png">aGVsbG8=</binary>
</FictionBook>`),
      );
      const body = document.createElement('div');
      body.innerHTML = content.chapters[0]!.html;
      expect(body.querySelector('img')?.getAttribute('src')).toBe('blob:fb2-cover');
      content.dispose?.();
      content.dispose?.();
      expect(revoked).toEqual(['blob:fb2-cover']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('拒绝损坏 XML，且不物化不允许的图片 MIME', () => {
    expect(() => parseFb2(enc('<FictionBook><body>'))).toThrow(ParseError);
    const content = parseFb2(
      enc(`<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
  <body><section><image l:href="#vector"/></section></body>
  <binary id="vector" content-type="image/svg+xml">PHN2Zy8+</binary>
</FictionBook>`),
    );
    expect(content.chapters[0]!.html).not.toContain('<img');
  });
});

describe('parseEpub', () => {
  async function buildEpub(withResources = false): Promise<Uint8Array> {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package>' +
            '<metadata><dc:title>EPUB 书名</dc:title></metadata>' +
            '<manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
            (withResources
              ? '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
                '<item id="css" href="styles/book.css" media-type="text/css"/>'
              : '') +
            '</manifest>' +
            '<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>' +
            '</package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>第一章</title></head><body><h1>一</h1><p>甲</p>' +
            (withResources
              ? '<img src="images/pic.png" alt="cover">' +
                '<a href="ch2.xhtml#destination">下一章</a>'
              : '') +
            '</body></html>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch2.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>第二章</title></head><body>' +
            '<h1 id="destination">二</h1><p>乙</p></body></html>',
        ),
      ),
    );
    if (withResources) {
      await zip.add(
        'OEBPS/images/pic.png',
        new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
        { level: 0 },
      );
      await zip.add(
        'OEBPS/styles/book.css',
        new Uint8ArrayReader(enc('body { color: red; }')),
      );
    }
    return zip.close();
  }

  it('按 spine 顺序解析章节并消毒', async () => {
    const content = await parseEpub(await buildEpub());
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.title).toBe('第一章');
    expect(content.chapters[0]!.html).toContain('<h1>一</h1>');
    expect(content.chapters[1]!.title).toBe('第二章');
    expect(content.chapters[1]!.html).toContain('<p>乙</p>');
  });

  it('损坏 zip 抛 ParseError', async () => {
    await expect(parseEpub(new Uint8Array([0, 1, 2, 3]))).rejects.toBeInstanceOf(ParseError);
  });

  it('解析包内图片和章节链接，并在 dispose 时释放资源', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:epub-cover',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = await parseEpub(await buildEpub(true));
      const body = document.createElement('div');
      body.innerHTML = content.chapters[0]!.html;
      expect(body.querySelector('img')?.getAttribute('src')).toBe('blob:epub-cover');
      expect(body.querySelector('a')?.getAttribute('href')).toBe(
        '#lightink-chapter?chapter=1&target=destination',
      );
      expect(content.warnings).toEqual(['epubStylesIgnored']);

      content.dispose?.();
      content.dispose?.();
      expect(revoked).toEqual(['blob:epub-cover']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });
});

describe('parseMobi', () => {
  const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
  const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  /** ASCII 字符串填充到固定长度（其余填零）。 */
  function asciiPadded(s: string, len: number): number[] {
    const out = new Array(len).fill(0);
    for (let i = 0; i < s.length && i < len; i++) {
      out[i] = s.charCodeAt(i) & 0xff;
    }
    return out;
  }
  /** ASCII 字符串字节（无填充）。 */
  function asciiCodes(s: string): number[] {
    return [...s].map((ch) => ch.charCodeAt(0) & 0xff);
  }
  function concat(parts: Array<number[] | Uint8Array>): Uint8Array {
    const flat: number[] = [];
    for (const p of parts) {
      for (const b of p) {
        flat.push(b);
      }
    }
    return new Uint8Array(flat);
  }

  /** 合成最小 PalmDOC MOBI。record 默认为 html 的 UTF-8（compression=1）；可传压缩记录（compression=2）。 */
  function buildMobi(
    html: string,
    opts: {
      encryption?: number;
      compression?: number;
      record?: number[];
      textLength?: number;
      fileVersion?: number;
    } = {},
  ): Uint8Array {
    const encryption = opts.encryption ?? 0;
    const compression = opts.compression ?? 1;
    const record = opts.record ?? [...enc(html)];
    const textLength = opts.textLength ?? record.length;
    const header = asciiPadded('TESTBOOK', 78); // 78 字节 PalmDB 头（name 占 32，其余填零）
    header[76] = u16(2)[0]!; // numRecords = 2（大端）
    header[77] = u16(2)[1]!;
    const index = new Array(18).fill(0); // 2 条记录索引（各 8 字节）+ 2 填充
    const rec0Offset = 78 + 18; // 96
    // PalmDOC 头(16) + MOBI 头标识(MOBI)+headerLength+type+codepage(=65001 UTF-8)。
    const mobi = [
      ...asciiCodes('MOBI'),
      ...u32(232),
      ...u32(2),
      ...u32(65001),
      ...u32(0),
      ...u32(opts.fileVersion ?? 6),
    ];
    const rec0 = [
      ...u16(compression), ...u16(0), ...u32(textLength), ...u16(1), ...u16(4096), ...u16(encryption), ...u16(0),
      ...mobi,
    ];
    const rec1Offset = rec0Offset + rec0.length;
    index[0] = u32(rec0Offset)[0]!; index[1] = u32(rec0Offset)[1]!; index[2] = u32(rec0Offset)[2]!; index[3] = u32(rec0Offset)[3]!;
    index[8] = u32(rec1Offset)[0]!; index[9] = u32(rec1Offset)[1]!; index[10] = u32(rec1Offset)[2]!; index[11] = u32(rec1Offset)[3]!;
    return concat([header, index, rec0, record]);
  }

  it('无压缩 MOBI 提取正文 HTML 为一章', () => {
    const content = parseMobi(buildMobi('<h1>标题</h1><p>正文内容</p>'));
    expect(content.chapters).toHaveLength(1);
    expect(content.chapters[0]!.title).toBe('标题');
    expect(content.chapters[0]!.html).toContain('<p>正文内容</p>');
  });

  it('PalmDOC LZ77 解压回引（compression=2）', () => {
    // "AAAA" 的 PalmDOC LZ77 压缩：0x41(字面 'A') + 0x80,0x00(回引 distance=1,length=3)。
    const content = parseMobi(buildMobi('', { compression: 2, record: [0x41, 0x80, 0x00], textLength: 4 }));
    expect(content.chapters[0]!.html).toContain('AAAA');
  });

  it('PalmDOC LZ77 字面转义（c=0 拷贝下一字节）', () => {
    // 0x00 → 拷贝下一字节 0x42('B')；0x41 → 字面 'A'。
    const content = parseMobi(buildMobi('', { compression: 2, record: [0x00, 0x42, 0x41], textLength: 2 }));
    expect(content.chapters[0]!.html).toContain('BA');
  });

  it('按 <mbp:pagebreak/> 切章', () => {
    const html = '<h1>A</h1><p>a</p><mbp:pagebreak/><h1>B</h1><p>b</p>';
    const content = parseMobi(buildMobi(html));
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.html).toContain('<p>a</p>');
    expect(content.chapters[1]!.html).toContain('<p>b</p>');
  });

  it('DRM 文件抛 ParseError', () => {
    expect(() => parseMobi(buildMobi('<p>x</p>', { encryption: 1 }))).toThrow(
      expect.objectContaining<Partial<ReaderCapabilityError>>({ kind: 'mobiDrm' }),
    );
  });

  it('KF8/MOBI8 与 HUFF/CDIC 返回针对性的能力错误', () => {
    expect(() => parseMobi(buildMobi('<p>x</p>', { fileVersion: 8 }))).toThrow(
      expect.objectContaining<Partial<ReaderCapabilityError>>({ kind: 'mobiKf8' }),
    );
    expect(() => parseMobi(buildMobi('<p>x</p>', { compression: 17480 }))).toThrow(
      expect.objectContaining<Partial<ReaderCapabilityError>>({ kind: 'mobiHuff' }),
    );
  });

  it('损坏记录索引（numRecords 越界）抛 ParseError', () => {
    // 构造一个 numRecords 虚高但文件不足的伪造头。
    const bad = asciiPadded('X', 78);
    bad[76] = 0xff; bad[77] = 0xff; // numRecords = 65535，远超文件长度
    expect(() => parseMobi(new Uint8Array(bad))).toThrow(ParseError);
  });
});
