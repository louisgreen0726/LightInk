// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  bindTextLayerSelection,
  isEndOfContentNode,
  isModifyingSelectionStart,
  placeEndOfContent,
  usesLegacyEndOfContentPlacement,
} from '../text-layer-selection.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('bindTextLayerSelection', () => {
  it('inserts endOfContent and marks the layer selecting on mousedown', () => {
    const layer = document.createElement('div');
    layer.className = 'lightink-reader-text-layer';
    const span = document.createElement('span');
    span.textContent = 'abc';
    layer.appendChild(span);
    document.body.appendChild(layer);

    const unbind = bindTextLayerSelection(layer);
    const end = layer.querySelector('.endOfContent');
    expect(end).not.toBeNull();
    expect(isEndOfContentNode(end!)).toBe(true);

    layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(layer.classList.contains('selecting')).toBe(true);

    unbind();
    expect(layer.querySelector('.endOfContent')).toBeNull();
    expect(layer.classList.contains('selecting')).toBe(false);
  });

  it('places the filler after the end when extending right, before the start when extending left', () => {
    const layer = document.createElement('div');
    layer.className = 'lightink-reader-text-layer';
    const left = document.createElement('span');
    left.textContent = 'left';
    const right = document.createElement('span');
    right.textContent = 'right';
    layer.append(left, right);
    document.body.appendChild(layer);
    const end = document.createElement('div');
    end.className = 'endOfContent';
    layer.appendChild(end);

    const first = document.createRange();
    first.setStart(right.firstChild!, 2);
    first.setEnd(right.firstChild!, 5);
    placeEndOfContent(layer, end, first, null);
    expect(end.previousSibling).toBe(right);

    const rtl = document.createRange();
    rtl.setStart(left.firstChild!, 0);
    rtl.setEnd(right.firstChild!, 5);
    expect(isModifyingSelectionStart(first, rtl)).toBe(true);
    placeEndOfContent(layer, end, rtl, first);
    expect(end.nextSibling).toBe(left);
  });

  it('treats current WebView2 / unknown UA as modern (no live DOM move)', () => {
    expect(usesLegacyEndOfContentPlacement(null)).toBe(false);
    expect(usesLegacyEndOfContentPlacement({ userAgent: 'LightInk' })).toBe(false);
    expect(usesLegacyEndOfContentPlacement({ userAgent: 'Chrome/149.0.0.0' })).toBe(false);
    expect(usesLegacyEndOfContentPlacement({ userAgent: 'Chrome/120.0.0.0' })).toBe(true);
  });
});
