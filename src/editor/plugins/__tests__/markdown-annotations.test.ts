import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';

import type { Annotation } from '../../../reader/annotations.js';
import {
  collectPmText,
  decorationsForAnnotations,
  locatorFromPmSelection,
  pmOffsetAtPos,
  pmPosAtOffset,
} from '../markdown-annotations.js';
import { fnv1a64Hex, markdownAnnotationKey } from '../../../reader/document-hash.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { group: 'inline' },
  },
});

function docFrom(text: string): EditorState {
  const paragraph = schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [paragraph]),
  });
}

describe('markdown annotation locators', () => {
  it('round-trips a selected quote through PM offsets', () => {
    const state = docFrom('Alpha beta gamma');
    const locator = locatorFromPmSelection(state.doc, 3, 8);
    expect(locator).toMatchObject({ format: 'text', quote: 'pha b' });
    const { text, spans } = collectPmText(state.doc);
    expect(text).toBe('Alpha beta gamma');
    expect(pmOffsetAtPos(spans, 1)).toBe(0);
    expect(pmPosAtOffset(spans, 0, true)).toBe(1);
  });

  it('builds highlight decorations for text locators', () => {
    const state = docFrom('Alpha beta gamma');
    const annotations: Annotation[] = [
      {
        id: 'h1',
        kind: 'highlight',
        locator: {
          format: 'text',
          start: 6,
          end: 10,
          quote: 'beta',
          prefix: 'Alpha ',
          suffix: ' gamm',
        },
        createdAt: 1,
      },
    ];
    const decorations = decorationsForAnnotations(state.doc, annotations);
    expect(decorations.find()).toHaveLength(1);
  });
});

describe('markdownAnnotationKey', () => {
  it('hashes path keys with the Rust FNV-1a 64 algorithm', () => {
    expect(fnv1a64Hex('path:C:/notes/a.md')).toHaveLength(16);
    expect(markdownAnnotationKey('C:/notes/a.md', 'untitled-1')).not.toBe(
      markdownAnnotationKey(null, 'untitled-1'),
    );
  });
});
