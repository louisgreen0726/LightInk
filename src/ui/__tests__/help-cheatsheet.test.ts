/**
 * help-cheatsheet 渲染测试（R5，node 环境，fake doc 注入）。
 */

import { describe, expect, it } from 'vitest';

import { renderCheatsheet, type CheatBinding } from '../help-cheatsheet.js';

class FakeEl {
  readonly tagName: string;
  textContent = '';
  className = '';
  children: FakeEl[] = [];
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
  appendChild<T extends FakeEl>(child: T): T {
    this.children.push(child);
    return child;
  }
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
}

function fakeDoc(): Document {
  return { createElement: (tag: string) => new FakeEl(tag) } as unknown as Document;
}

describe('renderCheatsheet', () => {
  it('渲染绑定列表，每项含标签与快捷键', () => {
    const bindings: CheatBinding[] = [
      { label: '新建', shortcut: 'Ctrl+N' },
      { label: '保存', shortcut: 'Ctrl+S' },
    ];
    const list = renderCheatsheet(bindings, fakeDoc()) as unknown as FakeEl;
    expect(list.tagName).toBe('UL');
    expect(list.classList.contains('lightink-cheatsheet')).toBe(true);
    expect(list.children).toHaveLength(2);
    const first = list.children[0];
    expect(first.children[0].textContent).toBe('新建');
    expect(first.children[1].textContent).toBe('Ctrl+N');
  });

  it('空绑定返回空列表', () => {
    const list = renderCheatsheet([], fakeDoc()) as unknown as FakeEl;
    expect(list.children).toHaveLength(0);
  });
});
