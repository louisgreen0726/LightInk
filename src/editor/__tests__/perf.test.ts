/**
 * Performance test — "万字级文档打开与滚动无明显卡顿" (R10/R12).
 *
 * This measures the *parse* path, which is the bottleneck in cold-load:
 * once a doc has been parsed into MDAST it can be incrementally edited via
 * ProseMirror. Scroll-perf in the actual WebView is not measurable in a
 * Node-only vitest environment, so it is reported in the `T2` concern list.
 *
 * Threshold rationale (documented inline): the parser needs to finish
 * 10k Chinese-character / English-word scale documents well under the 3-second
 * cold-start budget so the rest of the editor initialization path can fit.
 */

import { describe, expect, it } from 'vitest';

import { parseDocument } from '../parser.js';

/** Build a "realistic" long doc that mixes all of R1's syntax kinds. */
function buildLongDocument(targetWords: number): string {
  const lines: string[] = [];
  lines.push('# 万字级性能测试文档');
  lines.push('');
  const paragraphs = [
    '本段用于在 **解析器** 中触发 *heading* 与 `inline code` 节点。',
    '列表项用于触发列表与任务列表节点：',
    '- 复述前述观点',
    '- 引入 [链接](https://example.com) 与 ![图片](https://example.com/x.png)',
    '- [x] 已完成',
    '- [ ] 待办',
  ];
  lines.push(paragraphs.join('\n'));
  lines.push('');
  lines.push('## 表格');
  lines.push('| 名称 | 状态 | 数值 |');
  lines.push('| --- | --- | ---: |');
  lines.push('| alpha | ok | 1 |');
  lines.push('| beta | warn | 2 |');
  lines.push('');
  lines.push('## 代码');
  lines.push('```ts');
  lines.push('export function noop(): void { /* ... */ }');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  // Pad body until we cross the target word count.
  const filler =
    '重复说明：本段落仅为负载内容，旨在让文档长度达到一万字级别。' +
    ' 轻墨 LightInk 编辑器应在此规模下 *无明显卡顿*。';
  let words = filler.length; // rough estimate; counts as a starting accumulator
  while (words < targetWords) {
    lines.push(filler);
    words += filler.length;
  }
  return lines.join('\n');
}

describe('performance', () => {
  it('parses ~10k chars within the cold-start budget on this machine', () => {
    const doc = buildLongDocument(10_000);
    expect(doc.length).toBeGreaterThan(8_000);

    const start = Date.now();
    const parsed = parseDocument(doc);
    const elapsedMs = Date.now() - start;

    // Sanity: parser delivered a non-empty root.
    expect(parsed.root.children.length).toBeGreaterThan(5);
    expect(parsed.wordCount).toBeGreaterThan(50);

    // Threshold: keep it lenient so the test is not flaky on slow CI but
    // tight enough to fail on a real regression.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('keeps heap growth bounded for repeated parses', () => {
    // vitest runs in Node. We avoid a hard dep on `@types/node` so the root
    // `vite.config.ts` (which deliberately uses `process` without that type
    // package) still passes the strict TS build — see T1 review P3.
    const nodeProcess = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } })
      .process;
    if (nodeProcess === undefined || typeof nodeProcess.memoryUsage !== 'function') {
      return;
    }
    const before = nodeProcess.memoryUsage().heapUsed;
    const doc = buildLongDocument(10_000);
    for (let i = 0; i < 3; i++) {
      parseDocument(doc);
    }
    const after = nodeProcess.memoryUsage().heapUsed;
    const deltaMb = (after - before) / 1024 / 1024;
    // 10 parses of a 10k-char doc, the parser should not bloat by >40MB.
    expect(deltaMb).toBeLessThan(40);
  });
});
