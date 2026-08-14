// @vitest-environment jsdom

/**
 * PDF 搜索（T6 / R2）测试：命中索引纯函数（多页/大小写/多命中/空查询）、
 * 环形导航、overlay wrap/unwrap 与 offset→Range 定位。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  findPdfMatches,
  nextMatchIndex,
  offsetRangeFrom,
  unwrapSpans,
  wrapTextRangeWithSpan,
} from '../search-panel.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('findPdfMatches', () => {
  const pages = ['第一章 开端', '正文包含 Keyword 一处', 'keyword 又一处 keyword'];

  it('跨页大小写不敏感查找全部命中，按页序返回', () => {
    const matches = findPdfMatches(pages, 'Keyword');
    expect(matches).toEqual([
      { page: 2, start: 5, end: 12 },
      { page: 3, start: 0, end: 7 },
      { page: 3, start: 12, end: 19 },
    ]);
  });

  it('空查询或全空白返回空数组', () => {
    expect(findPdfMatches(pages, '')).toEqual([]);
    expect(findPdfMatches(pages, '   ')).toEqual([]);
  });

  it('无命中返回空数组', () => {
    expect(findPdfMatches(pages, '不存在')).toEqual([]);
  });
});

describe('nextMatchIndex', () => {
  it('环形步进：末尾回开头、开头向上走末尾', () => {
    expect(nextMatchIndex(3, 0, 1)).toBe(1);
    expect(nextMatchIndex(3, 2, 1)).toBe(0);
    expect(nextMatchIndex(3, 0, -1)).toBe(2);
    expect(nextMatchIndex(3, 1, -1)).toBe(0);
  });

  it('空集返回 -1，负 active 归零', () => {
    expect(nextMatchIndex(0, 0, 1)).toBe(-1);
    expect(nextMatchIndex(2, -1, 1)).toBe(0);
  });
});

describe('搜索命中 overlay', () => {
  function layer(...texts: string[]): HTMLElement {
    const root = document.createElement('div');
    root.className = 'lightink-reader-text-layer';
    for (const text of texts) {
      const span = document.createElement('span');
      span.textContent = text;
      root.appendChild(span);
    }
    document.body.appendChild(root);
    return root;
  }

  it('offsetRangeFrom + wrapTextRangeWithSpan 定位命中并高亮，unwrap 还原文本', () => {
    const root = layer('前缀文字', '命中目标', '后缀');
    const range = offsetRangeFrom(root, 4, 8);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('命中目标');

    expect(wrapTextRangeWithSpan(root, range!, 'lightink-reader-search-mark')).toBeGreaterThan(0);
    const marked = root.querySelector('.lightink-reader-search-mark');
    expect(marked?.textContent).toBe('命中目标');

    unwrapSpans(root, 'lightink-reader-search-mark');
    expect(root.querySelector('.lightink-reader-search-mark')).toBeNull();
    expect(root.textContent).toBe('前缀文字命中目标后缀');
  });

  it('越界偏移夹到层文本末尾（与 anchor clamp 语义一致）', () => {
    const root = layer('abc');
    expect(offsetRangeFrom(root, 10, 12)!.toString()).toBe('');
    expect(offsetRangeFrom(root, 0, 3)!.toString()).toBe('abc');
  });
});
