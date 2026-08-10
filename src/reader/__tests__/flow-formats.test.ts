/**
 * 流式格式解析测试（ebook-reader T4）。
 *
 * 纯函数单测：sanitize、TXT（UTF-8/GBK 回退）、FB2（XML→HTML）、EPUB（jszip 合成
 * 最小 epub）、MOBI（合成最小 PalmDOC，含 DRM 报错）。无 DOMParser 依赖。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { sanitizeHtml } from '../sanitize.js';
import { parseEpub } from '../formats/epub.js';
import { parseFb2 } from '../formats/fb2.js';
import { parseMobi } from '../formats/mobi.js';
import { parseTxt } from '../formats/txt.js';
import { ParseError } from '../formats/types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sanitizeHtml', () => {
  it('移除 script/style 与注释', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
    expect(sanitizeHtml('<style>x{}</style><b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeHtml('a<!-- secret -->b')).toBe('ab');
  });

  it('移除事件处理器属性并中和危险 URL 协议', () => {
    const out = sanitizeHtml('<a onclick="evil()" href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="#"');
    expect(out).not.toContain('javascript');
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
});

describe('parseEpub', () => {
  async function buildEpub(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      '<?xml version="1.0"?><container><rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
        '</rootfiles></container>',
    );
    zip.file(
      'OEBPS/content.opf',
      '<?xml version="1.0"?><package>' +
        '<metadata><dc:title>EPUB 书名</dc:title></metadata>' +
        '<manifest>' +
        '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '</manifest>' +
        '<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>' +
        '</package>',
    );
    zip.file(
      'OEBPS/ch1.xhtml',
      '<html><head><title>第一章</title></head><body><h1>一</h1><p>甲</p></body></html>',
    );
    zip.file(
      'OEBPS/ch2.xhtml',
      '<html><head><title>第二章</title></head><body><h1>二</h1><p>乙</p></body></html>',
    );
    return zip.generateAsync({ type: 'uint8array' });
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

  /** 合成最小 PalmDOC MOBI（compression=1 无压缩）。 */
  function buildMobi(html: string, opts: { encryption?: number } = {}): Uint8Array {
    const encryption = opts.encryption ?? 0;
    const text = enc(html);
    const header = asciiPadded('TESTBOOK', 78); // 78 字节 PalmDB 头（name 占 32，其余填零）
    header[76] = u16(2)[0]!; // numRecords = 2（大端）
    header[77] = u16(2)[1]!;
    const index = new Array(18).fill(0); // 2 条记录索引（各 8 字节）+ 2 填充
    const rec0Offset = 78 + 18; // 96
    // PalmDOC 头(16) + MOBI 头标识(MOBI)+headerLength+type+codepage(=65001 UTF-8)。
    const mobi = [...asciiCodes('MOBI'), ...u32(232), ...u32(2), ...u32(65001)];
    const rec0 = [
      ...u16(1), ...u16(0), ...u32(text.length), ...u16(1), ...u16(4096), ...u16(encryption), ...u16(0),
      ...mobi,
    ];
    const rec1Offset = rec0Offset + rec0.length;
    index[0] = u32(rec0Offset)[0]!; index[1] = u32(rec0Offset)[1]!; index[2] = u32(rec0Offset)[2]!; index[3] = u32(rec0Offset)[3]!;
    index[8] = u32(rec1Offset)[0]!; index[9] = u32(rec1Offset)[1]!; index[10] = u32(rec1Offset)[2]!; index[11] = u32(rec1Offset)[3]!;
    return concat([header, index, rec0, [...text]]);
  }

  it('无压缩 MOBI 提取正文 HTML 为一章', () => {
    const content = parseMobi(buildMobi('<h1>标题</h1><p>正文内容</p>'));
    expect(content.chapters).toHaveLength(1);
    expect(content.chapters[0]!.title).toBe('标题');
    expect(content.chapters[0]!.html).toContain('<p>正文内容</p>');
  });

  it('按 <mbp:pagebreak/> 切章', () => {
    const html = '<h1>A</h1><p>a</p><mbp:pagebreak/><h1>B</h1><p>b</p>';
    const content = parseMobi(buildMobi(html));
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.html).toContain('<p>a</p>');
    expect(content.chapters[1]!.html).toContain('<p>b</p>');
  });

  it('DRM 文件抛 ParseError', () => {
    expect(() => parseMobi(buildMobi('<p>x</p>', { encryption: 1 }))).toThrow(ParseError);
  });
});
