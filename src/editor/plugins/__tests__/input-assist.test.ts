/**
 * input-assist 纯逻辑测试（R4）：planPairInput 的自动配对与选中包裹决策。
 */

import { describe, expect, it } from 'vitest';

import { planPairInput } from '../input-assist.js';

describe('planPairInput 自动配对', () => {
  it('无选区时插入 open+close 并将光标置中', () => {
    expect(planPairInput('(', '')).toEqual({ insert: '()', anchor: 1, head: 1 });
    expect(planPairInput('$', '')).toEqual({ insert: '$$', anchor: 1, head: 1 });
    expect(planPairInput('[', '')).toEqual({ insert: '[]', anchor: 1, head: 1 });
    expect(planPairInput('"', '')).toEqual({ insert: '""', anchor: 1, head: 1 });
  });

  it('非配对字符返回 null', () => {
    expect(planPairInput('a', '')).toBeNull();
    expect(planPairInput('1', '')).toBeNull();
    expect(planPairInput(')', '')).toBeNull();
  });
});

describe('planPairInput 选中包裹', () => {
  it('有选区时 open+selection+close，选区保持内部文本', () => {
    const plan = planPairInput('(', '文本');
    expect(plan).toEqual({ insert: '(文本)', anchor: 1, head: 3 });
  });

  it('引号/反引号同样包裹', () => {
    expect(planPairInput('"', 'ab')).toEqual({ insert: '"ab"', anchor: 1, head: 3 });
    expect(planPairInput('`', 'code')).toEqual({ insert: '`code`', anchor: 1, head: 5 });
  });
});
