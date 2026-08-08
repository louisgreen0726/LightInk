/**
 * slash-menu 纯逻辑测试（R11）：行首 `/query` 识别与菜单环形选择。
 *
 * 不覆盖（需挂载编辑器/DOM）：Decoration.widget 浮层、键位（Esc/Enter/方向键）、
 * replaceRange 插入、菜单项点击 —— 属编辑器集成面，同既有插件仅断言工厂形态。
 */
import { describe, expect, it } from 'vitest';

import { nextIndex, parseSlashQuery, slashMenuPlugin } from '../slash-menu.js';
import { filterInsertElements } from '../../insert-commands.js';

describe('parseSlashQuery (R11)', () => {
  it('detects a line-start slash with a query', () => {
    expect(parseSlashQuery('/')).toEqual({ query: '' });
    expect(parseSlashQuery('/heading')).toEqual({ query: 'heading' });
    expect(parseSlashQuery('/表')).toEqual({ query: '表' });
  });

  it('returns null when the slash is not at line start', () => {
    expect(parseSlashQuery('text/heading')).toBeNull();
    expect(parseSlashQuery(' /x')).toBeNull();
    expect(parseSlashQuery('foo /x')).toBeNull();
  });

  it('returns null when the query contains whitespace (command ended)', () => {
    expect(parseSlashQuery('/he ading')).toBeNull();
    expect(parseSlashQuery('/x ')).toBeNull();
    expect(parseSlashQuery('/\n')).toBeNull();
  });

  it('returns null for empty or non-slash input', () => {
    expect(parseSlashQuery('')).toBeNull();
    expect(parseSlashQuery('heading')).toBeNull();
    expect(parseSlashQuery('# heading')).toBeNull();
  });
});

describe('nextIndex (R11 menu navigation)', () => {
  it('moves forward and wraps around', () => {
    expect(nextIndex(0, 1, 5)).toBe(1);
    expect(nextIndex(4, 1, 5)).toBe(0); // 末尾→首项
  });

  it('moves backward and wraps around', () => {
    expect(nextIndex(1, -1, 5)).toBe(0);
    expect(nextIndex(0, -1, 5)).toBe(4); // 首项→末项
  });

  it('clamps to 0 for empty lists', () => {
    expect(nextIndex(3, 1, 0)).toBe(0);
    expect(nextIndex(0, -1, 0)).toBe(0);
  });
});

describe('slash-menu filtering uses shared INSERT_ELEMENTS', () => {
  it('empty query returns all elements (same source as insert menu)', () => {
    expect(filterInsertElements('').length).toBeGreaterThanOrEqual(9);
  });

  it('narrows by keyword', () => {
    expect(filterInsertElements('表格').map((e) => e.id)).toContain('table');
    expect(filterInsertElements('code').map((e) => e.id)).toContain('code');
  });
});

describe('slashMenuPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(slashMenuPlugin).toBeDefined();
    expect(typeof slashMenuPlugin).toBe('function');
    const shaped = slashMenuPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    // 未经 Milkdown ctx 运行前，内部 plugin 尚未实例化。
    expect(shaped.plugin()).toBeUndefined();
  });
});
