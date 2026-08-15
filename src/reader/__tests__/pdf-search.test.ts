// @vitest-environment jsdom

/**
 * PDF 搜索（T6 / R2）测试：命中索引纯函数（多页/大小写/多命中/空查询）、
 * 环形导航、overlay wrap/unwrap 与 offset→Range 定位。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  canWrapSearchMark,
  createSearchPanel,
  findPdfMatches,
  findTextHits,
  nearestMatchIndex,
  nextMatchIndex,
  preserveMatchIndex,
  sanitizeSearchQuery,
  offsetRangeFrom,
  textLengthOf,
  unwrapSpans,
  wrapTextRangeWithSpan,
} from '../search-panel.js';
import {
  clearSearchMarks,
  renderSearchMarks,
  SEARCH_MARK_CLASS,
  SEARCH_MARK_CURRENT_CLASS,
} from '../search-overlay.js';

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

describe('sanitizeSearchQuery', () => {
  it('takes the first trimmed line and caps long selections', () => {
    expect(sanitizeSearchQuery('  汉字选区\n第二行  ')).toBe('汉字选区');
    expect(sanitizeSearchQuery('   ')).toBe('');
    expect(sanitizeSearchQuery('x'.repeat(240))).toHaveLength(200);
  });
});

describe('nearestMatchIndex', () => {
  it('keeps the first match at or after the current place', () => {
    expect(nearestMatchIndex(4, 2)).toBe(2);
    expect(nearestMatchIndex(4, 0)).toBe(0);
    expect(nearestMatchIndex(4, 4)).toBe(0);
    expect(nearestMatchIndex(0, 0)).toBe(-1);
  });
});

describe('preserveMatchIndex', () => {
  it('keeps the previous hit after a layout rebuild', () => {
    expect(preserveMatchIndex(4, 2, 0)).toBe(2);
    expect(preserveMatchIndex(4, 8, 1)).toBe(1);
    expect(preserveMatchIndex(0, 2, 0)).toBe(-1);
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

  it('key 戳记幂等：已包裹的命中不重复嵌套，textLengthOf 判定层填充度', () => {
    const root = layer('前缀文字', '命中目标', '后缀');
    expect(textLengthOf(root)).toBe(10);
    const range = offsetRangeFrom(root, 4, 8)!;
    wrapTextRangeWithSpan(root, range, 'lightink-reader-search-mark', '1:4:8');
    const marked = root.querySelector<HTMLElement>('[data-search-key="1:4:8"]')!;
    expect(marked.className).toBe('lightink-reader-search-mark');
    // 重复包裹同一 key：调用方经 existing 检查跳过（此处直接验证不再嵌套 span）。
    expect(root.querySelector('[data-search-key="1:4:8"] span')).toBeNull();
  });

  it('canWrapSearchMark：部分填充层跳过、填充完成后可包裹、已包裹后幂等拒绝', () => {
    // pdfjs 异步分批追加：层当前只有 6 个字符，命中 [4,8) 未填充完。
    const root = layer('前缀文字', '命中');
    expect(canWrapSearchMark(root, '1:4:8', 8)).toBe(false);

    // 后续批次到达，层填充完成。
    const span = document.createElement('span');
    span.textContent = '目标';
    root.appendChild(span);
    expect(canWrapSearchMark(root, '1:4:8', 8)).toBe(true);

    // 包裹后同 key 幂等拒绝（observer 重触发不再包裹）。
    const range = offsetRangeFrom(root, 4, 8)!;
    wrapTextRangeWithSpan(root, range, 'lightink-reader-search-mark', '1:4:8');
    expect(canWrapSearchMark(root, '1:4:8', 8)).toBe(false);
  });
});

describe('findTextHits', () => {
  it('单段文本内大小写不敏感多命中，返回拼接文本偏移', () => {
    expect(findTextHits('正文包含 Keyword 一处', 'keyword')).toEqual([
      { start: 5, end: 12 },
    ]);
    expect(findTextHits('keyword 又一处 keyword', 'Keyword')).toEqual([
      { start: 0, end: 7 },
      { start: 12, end: 19 },
    ]);
    expect(findTextHits('任意文本', '  ')).toEqual([]);
  });

  it('小写化改变 UTF-16 长度时退化大小写敏感，偏移保持与 DOM 文本对齐', () => {
    expect(findTextHits('İabc', 'İ')).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('搜索 overlay 共享幂等引擎（PDF 文本层 / 流式正文同引擎）', () => {
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

  it('幂等渲染：已有 key 只校正当前类名不重包裹，切换当前命中不增删 overlay', () => {
    const root = layer('前缀文字命中目标后缀');
    const specs = [
      { key: 'a', start: 0, end: 4 },
      { key: 'b', start: 4, end: 8 },
    ];
    renderSearchMarks(root, specs, 'a');
    expect(root.querySelector('[data-search-key="a"]')!.className).toBe(
      SEARCH_MARK_CURRENT_CLASS,
    );
    expect(root.querySelector('[data-search-key="b"]')!.className).toBe(
      SEARCH_MARK_CLASS,
    );

    // 切换当前命中：只改类名，绝不重包裹（防 observer 自激循环）。
    renderSearchMarks(root, specs, 'b');
    const keyed = root.querySelectorAll('[data-search-key]');
    expect(keyed.length).toBe(2);
    expect(root.querySelector('[data-search-key="a"]')!.className).toBe(SEARCH_MARK_CLASS);
    expect(root.querySelector('[data-search-key="b"]')!.className).toBe(
      SEARCH_MARK_CURRENT_CLASS,
    );
    expect(root.textContent).toBe('前缀文字命中目标后缀');
    expect(root.querySelector('[data-search-key] span')).toBeNull();
  });

  it('陈旧 key 就地解包移除（查询变化），部分填充层跳过等待重试', () => {
    const root = layer('前缀文字', '命中'); // 层当前只有 6 字，命中 [4,8) 未就绪
    renderSearchMarks(root, [{ key: 'a', start: 4, end: 8 }], null);
    expect(root.querySelector('[data-search-key]')).toBeNull();

    const span = document.createElement('span');
    span.textContent = '目标';
    root.appendChild(span);
    renderSearchMarks(root, [{ key: 'a', start: 4, end: 8 }], 'a');
    // [4,8) 跨两个 span：引擎为每个文本片段独立包裹，共享同一 key 戳记。
    const wrapped = root.querySelectorAll<HTMLElement>('[data-search-key="a"]');
    expect(wrapped.length).toBe(2);
    expect(wrapped[0]!.textContent).toBe('命中');
    expect(wrapped[1]!.textContent).toBe('目标');
    expect(wrapped[0]!.className).toBe(SEARCH_MARK_CURRENT_CLASS);

    // 新查询：旧 key 陈旧即解包，无需整层清空重建。
    renderSearchMarks(root, [{ key: 'b', start: 0, end: 4 }], null);
    expect(root.querySelector('[data-search-key="a"]')).toBeNull();
    expect(root.querySelector('[data-search-key="b"]')?.textContent).toBe('前缀文字');

    clearSearchMarks(root);
    expect(root.querySelector('[data-search-key]')).toBeNull();
    expect(root.textContent).toBe('前缀文字命中目标');
  });
});

describe('搜索面板键位（容器级）', () => {
  function mount() {
    const calls: string[] = [];
    const panel = createSearchPanel({
      t: (key) => key,
      onQuery: () => calls.push('query'),
      onNext: () => calls.push('next'),
      onPrev: () => calls.push('prev'),
      onClose: () => calls.push('close'),
    });
    document.body.appendChild(panel.element);
    return { panel, calls };
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('Escape 在面板容器任意焦点位置关闭（含按钮）', () => {
    const { panel, calls } = mount();
    panel.open();
    panel.element
      .querySelector<HTMLButtonElement>('.lightink-reader-search-close')!
      .focus();
    panel.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(calls).toEqual(['close']);
  });

  it('Enter 在输入框派发导航，焦点在按钮时不经容器双触发', () => {
    const { panel, calls } = mount();
    panel.open();
    const input = panel.element.querySelector('input')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(calls).toEqual(['next']);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(calls).toEqual(['next', 'prev']);

    calls.length = 0;
    const next = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-search-next')!;
    next.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(calls).toEqual([]); // 按钮 Enter 交还原生 click（真实浏览器语义）
  });

  it('无命中 setStatus 显示空态并带 data 属性', () => {
    const { panel } = mount();
    panel.setQuery('missing');
    panel.setStatus(0, -1);
    const status = panel.element.querySelector<HTMLElement>('.lightink-reader-search-status')!;
    expect(status.textContent).toBe('reader.search.empty');
    expect(status.dataset.searchEmpty).toBe('true');
    expect(panel.element.classList.contains('is-empty')).toBe(true);
    panel.setStatus(3, 1);
    expect(status.textContent).toBe('2/3');
    expect(status.dataset.searchEmpty).toBe('false');
  });
});
