/**
 * expandToTextblockRange — pure range math for structured inserts.
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';

import { expandToTextblockRange } from '../insert-markdown.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
});

function docWithParagraph(text: string) {
  const p = schema.nodes.paragraph!.create(
    null,
    text === '' ? undefined : schema.text(text),
  );
  return schema.nodes.doc!.create(null, p);
}

describe('expandToTextblockRange', () => {
  it('expands line-start range to whole paragraph', () => {
    const doc = docWithParagraph('/表格');
    // pos 1 is start of paragraph content
    const range = expandToTextblockRange(doc, 1, 4);
    expect(range.from).toBe(0);
    expect(range.to).toBe(doc.content.size);
  });

  it('keeps mid-line range unexpanded', () => {
    const doc = docWithParagraph('hello');
    // content starts at 1; mid at 3
    const range = expandToTextblockRange(doc, 3, 5);
    expect(range.from).toBe(3);
    expect(range.to).toBe(5);
  });
});
