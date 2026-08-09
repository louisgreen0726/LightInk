/**
 * Progressive select-all pure helpers (block first → document).
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection, AllSelection } from '@milkdown/prose/state';

import {
  currentTextblockRange,
  isFullDocumentSelection,
  progressiveSelectAll,
  selectionCoversRange,
} from '../progressive-select.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      attrs: { language: { default: '' } },
    },
    text: {},
  },
});

function stateWith(
  blocks: Array<{ type: 'paragraph' | 'code_block'; text: string; language?: string }>,
  selFrom: number,
  selTo: number = selFrom,
): EditorState {
  const nodes = blocks.map((b) => {
    if (b.type === 'code_block') {
      return schema.nodes['code_block']!.create(
        { language: b.language ?? '' },
        b.text ? schema.text(b.text) : undefined,
      );
    }
    return schema.nodes['paragraph']!.create(null, b.text ? schema.text(b.text) : undefined);
  });
  const doc = schema.nodes['doc']!.create(null, nodes);
  return EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, selFrom, selTo),
  });
}

describe('currentTextblockRange', () => {
  it('covers the code_block containing the caret', () => {
    // doc( p("hi"), code_block("graph TD") )
    // positions: 0 doc, 1 p, 2-3 "hi", 4 after p, 5 code, 6.. text
    const state = stateWith(
      [
        { type: 'paragraph', text: 'hi' },
        { type: 'code_block', text: 'graph TD', language: 'mermaid' },
      ],
      7,
    );
    const range = currentTextblockRange(state);
    expect(range).not.toBeNull();
    // code block content should be selected (not the paragraph)
    expect(state.doc.textBetween(range!.from, range!.to)).toBe('graph TD');
  });

  it('covers a paragraph textblock', () => {
    const state = stateWith([{ type: 'paragraph', text: 'hello' }], 2);
    const range = currentTextblockRange(state);
    expect(range).not.toBeNull();
    expect(state.doc.textBetween(range!.from, range!.to)).toBe('hello');
  });
});

describe('progressiveSelectAll', () => {
  it('first press selects current block; second selects whole doc', () => {
    let state = stateWith(
      [
        { type: 'paragraph', text: 'aaa' },
        { type: 'code_block', text: 'bbb', language: 'js' },
      ],
      8,
    );

    // 1st: select code block only
    progressiveSelectAll(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe('bbb');
    expect(isFullDocumentSelection(state)).toBe(false);

    // 2nd: expand to document
    progressiveSelectAll(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.selection instanceof AllSelection || isFullDocumentSelection(state)).toBe(true);
  });

  it('selectionCoversRange detects full block coverage', () => {
    const state = stateWith([{ type: 'paragraph', text: 'xy' }], 1, 3);
    const range = currentTextblockRange(state)!;
    expect(selectionCoversRange(state, range)).toBe(true);
  });
});
