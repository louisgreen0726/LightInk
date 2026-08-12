import type { FlowLocator, TextLocator, TextQuoteAnchor } from './annotations.js';

const CONTEXT_LENGTH = 32;

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

function documentOf(root: Node): Document {
  return root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
}

function textSpans(root: Node): { text: string; spans: TextSpan[] } {
  const ownerDocument = documentOf(root);
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  const spans: TextSpan[] = [];
  let text = '';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null) !== null) {
    const value = node.nodeValue ?? '';
    spans.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, spans };
}

function boundaryAt(
  spans: readonly TextSpan[],
  offset: number,
  preferNext: boolean,
): { node: Text; offset: number } | null {
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    if (offset < span.end || (!preferNext && offset === span.end)) {
      return { node: span.node, offset: Math.max(0, offset - span.start) };
    }
  }
  const last = spans[spans.length - 1];
  return last === undefined
    ? null
    : { node: last.node, offset: last.node.nodeValue?.length ?? 0 };
}

function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  const { spans } = textSpans(root);
  const from = boundaryAt(spans, start, true);
  if (from === null) {
    return null;
  }
  const range = documentOf(root).createRange();
  range.setStart(from.node, from.offset);
  if (start === end) {
    range.collapse(true);
    return range;
  }
  const to = boundaryAt(spans, end, false);
  if (to === null) {
    return null;
  }
  range.setEnd(to.node, to.offset);
  return range;
}

export function captureTextQuoteAnchor(root: Node, range: Range): TextQuoteAnchor | null {
  if (!root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const { text } = textSpans(root);
  const prefixRange = documentOf(root).createRange();
  prefixRange.selectNodeContents(root);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const start = prefixRange.toString().length;
  const quote = range.toString();
  const end = start + quote.length;
  return {
    start,
    end,
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
  };
}

function contextScore(text: string, start: number, anchor: TextQuoteAnchor): number {
  const prefix = text.slice(Math.max(0, start - anchor.prefix.length), start);
  const suffix = text.slice(
    start + anchor.quote.length,
    start + anchor.quote.length + anchor.suffix.length,
  );
  let score = 0;
  if (anchor.prefix !== '' && prefix === anchor.prefix) score += 2;
  if (anchor.suffix !== '' && suffix === anchor.suffix) score += 2;
  score -= Math.min(1, Math.abs(start - anchor.start) / Math.max(1, text.length));
  return score;
}

function contextMatches(text: string, start: number, anchor: TextQuoteAnchor): boolean {
  const prefixMatches =
    anchor.prefix === '' ||
    text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix;
  const quoteMatches =
    text.slice(start, start + anchor.quote.length) === anchor.quote;
  const suffixMatches =
    anchor.suffix === '' ||
    text.slice(
      start + anchor.quote.length,
      start + anchor.quote.length + anchor.suffix.length,
    ) === anchor.suffix;
  return prefixMatches && quoteMatches && suffixMatches;
}

function candidateOffsets(text: string, anchor: TextQuoteAnchor): number[] {
  const candidates = new Set<number>();
  const collect = (needle: string, offsetAfterMatch: number): void => {
    let index = text.indexOf(needle);
    while (index >= 0) {
      candidates.add(index + offsetAfterMatch);
      index = text.indexOf(needle, index + 1);
    }
  };

  if (anchor.quote !== '') {
    collect(anchor.quote, 0);
  } else {
    if (anchor.prefix !== '') {
      collect(anchor.prefix, anchor.prefix.length);
    }
    if (anchor.suffix !== '') {
      collect(anchor.suffix, 0);
    }
  }
  return [...candidates].filter(
    (candidate) => candidate >= 0 && candidate <= text.length,
  );
}

export function resolveTextQuoteRange(root: Node, anchor: TextQuoteAnchor): Range | null {
  const { text } = textSpans(root);
  let start = anchor.start;
  const storedOffsetsMatch =
    start >= 0 &&
    anchor.end === start + anchor.quote.length &&
    anchor.end <= text.length &&
    contextMatches(text, start, anchor);
  if (!storedOffsetsMatch) {
    const candidates = candidateOffsets(text, anchor);
    if (candidates.length === 0) {
      if (anchor.quote !== '' || start < 0 || start > text.length) {
        return null;
      }
      start = Math.min(start, text.length);
    } else {
      start = candidates.reduce((best, candidate) =>
        contextScore(text, candidate, anchor) > contextScore(text, best, anchor)
          ? candidate
          : best,
      );
    }
  }
  return rangeFromOffsets(root, start, start + anchor.quote.length);
}

/** Wrap each selected text fragment independently so highlighting preserves element structure. */
export function markTextRange(root: Node, range: Range, annotationId: string): number {
  const { spans } = textSpans(root);
  const selected = spans.flatMap(({ node }) => {
    if (!range.intersectsNode(node)) {
      return [];
    }
    const length = node.nodeValue?.length ?? 0;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : length;
    return start < end ? [{ node, start, end }] : [];
  });

  for (const { node, start, end } of selected.reverse()) {
    const selectedNode = start === 0 ? node : node.splitText(start);
    const selectedLength = end - start;
    if (selectedLength < selectedNode.length) {
      selectedNode.splitText(selectedLength);
    }
    const mark = documentOf(root).createElement('mark');
    mark.className = 'lightink-reader-highlight';
    mark.dataset.annotationId = annotationId;
    selectedNode.replaceWith(mark);
    mark.appendChild(selectedNode);
  }
  return selected.length;
}

export function removeTextRangeMarks(root: ParentNode, annotationId: string): void {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>('.lightink-reader-highlight[data-annotation-id]'),
  ).filter((mark) => mark.dataset.annotationId === annotationId);
  for (const mark of marks) {
    const parent = mark.parentNode;
    mark.replaceWith(...Array.from(mark.childNodes));
    parent?.normalize();
  }
}

export function flowLocatorFromRange(
  root: Node,
  range: Range,
  chapter: number,
  format: 'flow' | 'text',
): FlowLocator | TextLocator | null {
  const anchor = captureTextQuoteAnchor(root, range);
  if (anchor === null) {
    return null;
  }
  return format === 'text' ? { format, ...anchor } : { format, chapter, ...anchor };
}
