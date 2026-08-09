/**
 * Progressive select-all pure helpers (block first → document; table middle step).
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection, AllSelection } from '@milkdown/prose/state';
import { CellSelection, tableNodes } from '@milkdown/prose/tables';

import {
  currentTextblockRange,
  isFullDocumentSelection,
  isWholeTableSelected,
  progressiveSelectAll,
  selectionCoversRange,
} from '../progressive-select.js';

const tableNodeSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph+',
  cellAttributes: {},
});

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
    ...tableNodeSpecs,
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

function makeTableState(): EditorState {
  // 2x2 table: header row A B / body 1 2, plus a trailing paragraph.
  const cell = (text: string, header = false) => {
    const type = header ? schema.nodes['table_header']! : schema.nodes['table_cell']!;
    return type.create(
      { colspan: 1, rowspan: 1, colwidth: null },
      schema.nodes['paragraph']!.create(null, schema.text(text)),
    );
  };
  const headerRow = schema.nodes['table_row']!.create(null, [cell('A', true), cell('B', true)]);
  const bodyRow = schema.nodes['table_row']!.create(null, [cell('1'), cell('2')]);
  const table = schema.nodes['table']!.create(null, [headerRow, bodyRow]);
  const para = schema.nodes['paragraph']!.create(null, schema.text('after'));
  const doc = schema.nodes['doc']!.create(null, [table, para]);
  // Caret inside first body cell text ("1").
  // Walk to find a text position inside the table.
  let caret = 1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === '1') {
      caret = pos;
      return false;
    }
    return undefined;
  });
  return EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, caret, caret),
  });
}

describe('progressiveSelectAll in tables', () => {
  it('cell text → whole table → document (never skips table)', () => {
    let state = makeTableState();

    // 1st: select cell text "1"
    progressiveSelectAll(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe('1');
    expect(state.selection instanceof CellSelection).toBe(false);
    expect(isWholeTableSelected(state)).toBe(false);

    // 2nd: whole table CellSelection
    progressiveSelectAll(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.selection instanceof CellSelection).toBe(true);
    expect(isWholeTableSelected(state)).toBe(true);
    expect(isFullDocumentSelection(state)).toBe(false);

    // 3rd: whole document (includes trailing paragraph)
    progressiveSelectAll(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.selection instanceof AllSelection || isFullDocumentSelection(state)).toBe(true);
  });
});
