// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  annotationMarkFromEventTarget,
  captureTextQuoteAnchor,
  markTextRange,
  removeTextRangeMarks,
  resolveTextQuoteOffsets,
  resolveTextQuoteRange,
} from '../annotation-locator.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('annotation text quote locators', () => {
  it('captures and resolves a range spanning multiple text nodes', () => {
    document.body.innerHTML = '<p>Alpha <strong>beta</strong> gamma</p>';
    const paragraph = document.querySelector('p')!;
    const first = paragraph.firstChild as Text;
    const last = paragraph.lastChild as Text;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(last, 4);

    const anchor = captureTextQuoteAnchor(paragraph, range)!;
    expect(anchor.quote).toBe('pha beta gam');
    const resolved = resolveTextQuoteRange(paragraph, anchor)!;
    expect(resolved.toString()).toBe('pha beta gam');

    expect(markTextRange(paragraph, resolved, 'cross-node', 'note')).toBe(3);
    expect(paragraph.querySelectorAll('mark')).toHaveLength(3);
    expect(
      paragraph.querySelector('mark')?.getAttribute('data-annotation-kind'),
    ).toBe('note');
    expect(paragraph.querySelector('strong')).not.toBeNull();
    expect(paragraph.textContent).toBe('Alpha beta gamma');

    removeTextRangeMarks(paragraph, 'cross-node');
    expect(paragraph.querySelectorAll('mark')).toHaveLength(0);
    expect(resolveTextQuoteOffsets(paragraph.textContent ?? '', anchor)).toEqual({
      start: anchor.start,
      end: anchor.end,
    });
    expect(paragraph.textContent).toBe('Alpha beta gamma');
  });

  it('uses prefix and suffix to choose between repeated quotes', () => {
    document.body.textContent = 'first target left; second target right';
    const anchor = {
      start: 0,
      end: 6,
      quote: 'target',
      prefix: 'second ',
      suffix: ' right',
    };

    const resolved = resolveTextQuoteRange(document.body, anchor)!;
    expect(resolved.toString()).toBe('target');
    expect(resolved.startOffset).toBe(26);
  });

  it('falls back to quote context after stored offsets shift', () => {
    document.body.textContent = 'before needle after';
    const text = document.body.firstChild as Text;
    const original = document.createRange();
    original.setStart(text, 7);
    original.setEnd(text, 13);
    const anchor = captureTextQuoteAnchor(document.body, original)!;

    text.nodeValue = `inserted ${text.nodeValue ?? ''}`;
    const resolved = resolveTextQuoteRange(document.body, anchor)!;
    expect(resolved.toString()).toBe('needle');
    expect(resolved.startOffset).toBe(16);
  });
});

describe('annotationMarkFromEventTarget', () => {
  it('resolves a mark from both the wrapper and its text node', () => {
    const mark = document.createElement('mark');
    mark.dataset.annotationId = 'n1';
    mark.dataset.annotationKind = 'note';
    mark.textContent = '找其他游戏来玩吧。';
    document.body.appendChild(mark);
    expect(annotationMarkFromEventTarget(mark)?.dataset.annotationId).toBe('n1');
    expect(annotationMarkFromEventTarget(mark.firstChild)?.dataset.annotationId).toBe('n1');
    expect(annotationMarkFromEventTarget(document.body)).toBeNull();
  });
});
