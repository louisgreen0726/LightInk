/**
 * insert-commands 纯函数测试（R2/R11 同源元素目录与 Markdown 插入）。
 */

import { describe, expect, it } from 'vitest';

import {
  filterInsertElements,
  getInsertElement,
  INSERT_ELEMENTS,
  insertElementMarkdown,
  type InsertElementId,
} from '../insert-commands.js';

describe('元素目录', () => {
  it('包含 9 个元素且 id 唯一', () => {
    const ids = INSERT_ELEMENTS.map((e) => e.id);
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
  });

  it('getInsertElement 按 id 取元素', () => {
    expect(getInsertElement('table')?.label).toBe('表格');
    expect(getInsertElement('heading')?.snippet()).toBe('## 标题');
  });
});

describe('filterInsertElements', () => {
  it('空查询返回全部', () => {
    expect(filterInsertElements('')).toHaveLength(9);
  });

  it('中文「表格」精确命中表格', () => {
    const result = filterInsertElements('表格');
    expect(result.map((e) => e.id)).toEqual(['table']);
  });

  it('单字「表」命中所有含「表」的元素（列表/任务列表/表格）', () => {
    const result = filterInsertElements('表');
    expect(result.map((e) => e.id)).toEqual(['list', 'task-list', 'table']);
  });

  it('英文 code 命中代码块', () => {
    const result = filterInsertElements('code');
    expect(result.map((e) => e.id)).toEqual(['code']);
  });
});

describe('insertElementMarkdown', () => {
  it('空文档直接返回片段', () => {
    expect(insertElementMarkdown('', 'heading')).toBe('## 标题');
    expect(insertElementMarkdown('   \n  ', 'heading')).toBe('## 标题');
  });

  it('非空文档以空行分隔追加', () => {
    expect(insertElementMarkdown('# 文档', 'list')).toBe('# 文档\n\n- 列表项');
  });

  it('表格片段多行保留', () => {
    const result = insertElementMarkdown('正文', 'table');
    expect(result).toBe('正文\n\n| 列1 | 列2 |\n| --- | --- |\n|  |  |');
  });

  it('未知 id 原样返回（防御分支）', () => {
    expect(getInsertElement('nonexistent' as InsertElementId)).toBeUndefined();
    expect(insertElementMarkdown('# 文档', 'nonexistent' as InsertElementId)).toBe('# 文档');
  });
});
