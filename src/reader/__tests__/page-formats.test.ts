/**
 * 页格式解析测试（ebook-reader T5）。
 *
 * 纯逻辑单测：CBZ 图片条目过滤 + 自然序排序（listImageEntries/naturalCompare）、
 * PDF 页码/缩放状态机（createPdfPageController：next/prev/setPage/zoom/clamp）。
 * 真实 canvas/zip 渲染（renderPdfInto/renderCbzInto）留手工验证。
 */
import { describe, expect, it } from 'vitest';

import { listImageEntries, naturalCompare } from '../formats/cbz.js';
import {
  enforcePageCount,
  MAX_CBZ_PAGES,
  MAX_PDF_PAGES,
} from '../formats/page-limits.js';
import {
  createPdfPageController,
  PDF_SCALE_STEPS,
  pdfScrollToKeepAnchor,
  pdfViewportAnchor,
} from '../formats/pdf.js';
import { ReaderLimitError } from '../formats/types.js';

describe('CBZ listImageEntries', () => {
  it('只保留图片扩展名，过滤目录项与非图片', () => {
    const names = ['comic/', 'page1.jpg', 'notes.txt', 'page2.png', 'thumbs.db', 'sub/page3.gif'];
    expect(listImageEntries(names)).toEqual(['page1.jpg', 'page2.png', 'sub/page3.gif']);
  });

  it('按自然序排序（page2 < page10）', () => {
    const names = ['page10.jpg', 'page2.jpg', 'page1.jpg'];
    expect(listImageEntries(names)).toEqual(['page1.jpg', 'page2.jpg', 'page10.jpg']);
  });

  it('空或全非图片返回空数组', () => {
    expect(listImageEntries(['a.txt', 'b/'])).toEqual([]);
    expect(listImageEntries([])).toEqual([]);
  });
});

describe('naturalCompare', () => {
  it('数字段按数值比较', () => {
    expect(naturalCompare('p2', 'p10')).toBeLessThan(0);
    expect(naturalCompare('p10', 'p2')).toBeGreaterThan(0);
    expect(naturalCompare('p2', 'p2')).toBe(0);
  });

  it('非数字段按字典序', () => {
    expect(naturalCompare('abc', 'abd')).toBeLessThan(0);
  });
});

describe('createPdfPageController', () => {
  it('初始在第 1 页、缩放 1.0', () => {
    const c = createPdfPageController(5);
    expect(c.page).toBe(1);
    expect(c.scale).toBe(1);
    expect(c.totalPages).toBe(5);
    expect(c.canPrev).toBe(false);
    expect(c.canNext).toBe(true);
  });

  it('next/prev 翻页并钳制边界', () => {
    const c = createPdfPageController(3);
    expect(c.next()).toBe(true);
    expect(c.page).toBe(2);
    expect(c.next()).toBe(true);
    expect(c.page).toBe(3);
    expect(c.canNext).toBe(false);
    expect(c.next()).toBe(false); // 末页不再前进
    expect(c.page).toBe(3);
    expect(c.prev()).toBe(true);
    expect(c.page).toBe(2);
  });

  it('setPage 钳制到有效范围', () => {
    const c = createPdfPageController(4);
    expect(c.setPage(10)).toBe(true); // 钳制到 4
    expect(c.page).toBe(4);
    expect(c.setPage(0)).toBe(true); // 钳制到 1
    expect(c.page).toBe(1);
    expect(c.setPage(1)).toBe(false); // 未变化
  });

  it('zoomIn/Out/reset 在档位间移动并钳制', () => {
    const c = createPdfPageController(2);
    const max = PDF_SCALE_STEPS[PDF_SCALE_STEPS.length - 1]!;
    c.zoomIn();
    expect(c.scale).toBeGreaterThan(1);
    // 一直放大到最大档。
    for (let i = 0; i < PDF_SCALE_STEPS.length; i++) {
      c.zoomIn();
    }
    expect(c.scale).toBe(max);
    expect(c.zoomIn()).toBe(false); // 已到最大
    c.resetScale();
    expect(c.scale).toBe(1);
    c.zoomOut();
    expect(c.scale).toBeLessThan(1);
  });

  it('totalPages 至少为 1', () => {
    expect(createPdfPageController(0).totalPages).toBe(1);
    expect(createPdfPageController(-3).totalPages).toBe(1);
  });
});

describe('pdf viewport-centered zoom', () => {
  it('anchors on the slot under the viewport center', () => {
    const viewport = { left: 0, top: 100, width: 800, height: 600 };
    const slots = [
      { left: 200, top: 0, width: 400, height: 200 },
      { left: 200, top: 220, width: 400, height: 400 },
      { left: 200, top: 640, width: 400, height: 400 },
    ];
    expect(pdfViewportAnchor(viewport, slots)).toEqual({
      index: 1,
      xRatio: 0.5,
      yRatio: 0.45,
    });
  });

  it('keeps the captured point under the viewport center after a zoom', () => {
    const next = pdfScrollToKeepAnchor(
      { scrollLeft: 0, scrollTop: 400, clientWidth: 800, clientHeight: 600 },
      { left: 100, top: 50, width: 600, height: 800 },
      { xRatio: 0.5, yRatio: 0.25 },
    );
    expect(next.scrollLeft).toBe(0);
    expect(next.scrollTop).toBe(350);
  });
});

describe('reader page limits', () => {
  it('accepts PDF and CBZ counts exactly at their limits', () => {
    expect(() => enforcePageCount('pdf', MAX_PDF_PAGES)).not.toThrow();
    expect(() => enforcePageCount('cbz', MAX_CBZ_PAGES)).not.toThrow();
  });

  it('rejects one page over each limit with structured details', () => {
    for (const [format, limit, kind] of [
      ['pdf', MAX_PDF_PAGES, 'pdfPages'],
      ['cbz', MAX_CBZ_PAGES, 'cbzPages'],
    ] as const) {
      try {
        enforcePageCount(format, limit + 1);
        throw new Error('expected page validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ReaderLimitError);
        expect(error).toMatchObject({ kind, actual: limit + 1, limit });
      }
    }
  });
});
