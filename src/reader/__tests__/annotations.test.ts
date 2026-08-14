/**
 * 标注数据模型与序列化往返测试（ebook-reader T6 / R4）。
 * 覆盖各格式定位器、损坏 JSON 视为空、版本化结构。
 */
import { describe, expect, it } from 'vitest';

import {
  AnnotationWriteQueue,
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
} from '../annotations.js';

const sample: Annotation[] = [
  {
    id: 'h1',
    kind: 'highlight',
    locator: {
      format: 'flow',
      chapter: 0,
      start: 10,
      end: 20,
      quote: '原文片段',
      prefix: '前文',
      suffix: '后文',
    },
    quote: '原文片段',
    createdAt: 1700000000000,
  },
  {
    id: 'b1',
    kind: 'bookmark',
    locator: { format: 'pdf', page: 5, quote: '页脚' },
    createdAt: 1700000000001,
  },
  {
    id: 'n1',
    kind: 'note',
    locator: {
      format: 'text',
      start: 100,
      end: 150,
      quote: '',
      prefix: '',
      suffix: '',
    },
    note: '一段笔记',
    createdAt: 1700000000002,
  },
  {
    id: 'c1',
    kind: 'bookmark',
    locator: { format: 'cbz', page: 12 },
    createdAt: 1700000000003,
  },
];

describe('serialize/parse 往返', () => {
  it('序列化后解析等价（各格式定位器保留）', () => {
    const json = serializeAnnotations(sample);
    expect(JSON.parse(json)).toMatchObject({ version: 2 });
    const back = parseAnnotations(json);
    expect(back).toHaveLength(sample.length);
    expect(back.map((a) => a.id)).toEqual(['h1', 'b1', 'n1', 'c1']);
    expect(back[0]!.locator).toEqual({
      format: 'flow',
      chapter: 0,
      start: 10,
      end: 20,
      quote: '原文片段',
      prefix: '前文',
      suffix: '后文',
    });
    expect(back[1]!.locator).toEqual({ format: 'pdf', page: 5, quote: '页脚' });
    expect(back[2]!.locator).toEqual({
      format: 'text',
      start: 100,
      end: 150,
      quote: '',
      prefix: '',
      suffix: '',
    });
    expect(back[3]!.locator).toEqual({ format: 'cbz', page: 12 });
    expect(back[0]!.quote).toBe('原文片段');
    expect(back[2]!.note).toBe('一段笔记');
  });

  it('标注 id/kind/createdAt 保留', () => {
    const back = parseAnnotations(serializeAnnotations(sample));
    expect(back[0]).toMatchObject({ id: 'h1', kind: 'highlight', createdAt: 1700000000000 });
  });
});

describe('PdfLocator 文字级锚点（向后兼容）', () => {
  const anchored: Annotation = {
    id: 'ph1',
    kind: 'highlight',
    locator: {
      format: 'pdf',
      page: 3,
      quote: '页内文字',
      anchor: { start: 12, end: 16, quote: '页内文字', prefix: '前', suffix: '后' },
    },
    quote: '页内文字',
    createdAt: 1700000000010,
  };

  it('含 anchor 的 pdf 定位器序列化/解析往返保留 anchor', () => {
    const back = parseAnnotations(serializeAnnotations([anchored]));
    expect(back).toEqual([anchored]);
    expect(back[0]!.locator).toMatchObject({
      format: 'pdf',
      page: 3,
      anchor: { start: 12, end: 16, quote: '页内文字', prefix: '前', suffix: '后' },
    });
  });

  it('旧 v2 数据（pdf 定位器无 anchor）照旧解析', () => {
    const legacy = {
      version: 2,
      annotations: [sample[1]], // b1: { format: 'pdf', page: 5, quote: '页脚' }
    };
    const back = parseAnnotations(JSON.stringify(legacy));
    expect(back.map((a) => a.id)).toEqual(['b1']);
    expect(back[0]!.locator).toEqual({ format: 'pdf', page: 5, quote: '页脚' });
  });

  it('结构不合规的 anchor 使该条目被过滤', () => {
    const broken = {
      version: 2,
      annotations: [
        anchored,
        {
          ...anchored,
          id: 'bad-anchor',
          locator: {
            format: 'pdf',
            page: 3,
            quote: '页内文字',
            anchor: { start: 20, end: 10 }, // end < start 且缺 quote/prefix/suffix
          },
        },
      ],
    };
    const back = parseAnnotations(JSON.stringify(broken));
    expect(back.map((a) => a.id)).toEqual(['ph1']);
  });

  it('v1 迁移不产生 anchor（页码级定位保持原样）', () => {
    const back = parseAnnotations(JSON.stringify({
      version: 1,
      annotations: [{
        id: 'legacy-pdf',
        kind: 'bookmark',
        locator: { format: 'pdf', page: 2 },
        quote: '旧书签',
        createdAt: 1,
      }],
    }));
    expect(back).toEqual([{
      id: 'legacy-pdf',
      kind: 'bookmark',
      locator: { format: 'pdf', page: 2, quote: '旧书签' },
      quote: '旧书签',
      note: undefined,
      createdAt: 1,
    }]);
  });
});

describe('parseAnnotations 损坏/空处理', () => {
  it('空串返回空数组', () => {
    expect(parseAnnotations('')).toEqual([]);
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseAnnotations('{not json')).toEqual([]);
    expect(parseAnnotations('null')).toEqual([]);
  });

  it('annotations 非数组返回空数组', () => {
    expect(parseAnnotations(JSON.stringify({ version: 1, annotations: 'nope' }))).toEqual([]);
  });

  it('过滤掉结构不合规的条目，保留合规的', () => {
    const mixed = {
      version: 2,
      annotations: [
        sample[0],
        { id: 'bad', kind: 'highlight' }, // 缺 locator/createdAt
        { id: 'bad2', kind: 'unknown', locator: { format: 'flow', chapter: 0, domPath: '', start: 0, end: 0 }, createdAt: 1 },
        sample[1],
      ],
    };
    const back = parseAnnotations(JSON.stringify(mixed));
    expect(back.map((a) => a.id)).toEqual(['h1', 'b1']);
  });

  it('best-effort migrates valid v1 flow locators', () => {
    const back = parseAnnotations(JSON.stringify({
      version: 1,
      annotations: [{
        id: 'legacy',
        kind: 'highlight',
        locator: { format: 'flow', chapter: 2, domPath: 'p:nth-child(1)', start: 4, end: 10 },
        quote: 'legacy',
        createdAt: 1,
      }],
    }));

    expect(back).toEqual([{
      id: 'legacy',
      kind: 'highlight',
      locator: {
        format: 'flow',
        chapter: 2,
        start: 4,
        end: 10,
        quote: 'legacy',
        prefix: '',
        suffix: '',
      },
      quote: 'legacy',
      note: undefined,
      createdAt: 1,
    }]);
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AnnotationWriteQueue', () => {
  it('serializes rapid writes for the same content hash', async () => {
    const queue = new AnnotationWriteQueue();
    const first = deferred();
    const firstStarted = deferred();
    const writes: string[] = [];
    const write = async (_hash: string, json: string): Promise<void> => {
      writes.push(json);
      if (json === 'first') {
        firstStarted.resolve();
        await first.promise;
      }
    };

    const saveFirst = queue.enqueue('aaaaaaaaaaaaaaaa', 'first', write);
    const saveSecond = queue.enqueue('aaaaaaaaaaaaaaaa', 'second', write);
    await firstStarted.promise;
    expect(writes).toEqual(['first']);
    first.resolve();

    await expect(Promise.all([saveFirst, saveSecond])).resolves.toEqual([true, true]);
    expect(writes).toEqual(['first', 'second']);
  });

  it('skips queued writes invalidated before they start', async () => {
    const queue = new AnnotationWriteQueue();
    const first = deferred();
    const firstStarted = deferred();
    const writes: string[] = [];
    const write = async (_hash: string, json: string): Promise<void> => {
      writes.push(json);
      if (json === 'first') {
        firstStarted.resolve();
        await first.promise;
      }
    };

    const saveFirst = queue.enqueue('aaaaaaaaaaaaaaaa', 'first', write);
    const saveSecond = queue.enqueue('aaaaaaaaaaaaaaaa', 'stale', write);
    await firstStarted.promise;
    queue.invalidate();
    first.resolve();

    await expect(saveFirst).resolves.toBe(false);
    await expect(saveSecond).resolves.toBe(false);
    expect(writes).toEqual(['first']);
  });

  it('continues after a failed write', async () => {
    const queue = new AnnotationWriteQueue();
    const errors: string[] = [];
    const writes: string[] = [];
    const write = async (_hash: string, json: string): Promise<void> => {
      writes.push(json);
      if (json === 'bad') throw new Error('disk full');
    };

    const failed = queue.enqueue('aaaaaaaaaaaaaaaa', 'bad', write, () => errors.push('bad'));
    const recovered = queue.enqueue('aaaaaaaaaaaaaaaa', 'good', write);

    await expect(failed).resolves.toBe(false);
    await expect(recovered).resolves.toBe(true);
    expect(writes).toEqual(['bad', 'good']);
    expect(errors).toEqual(['bad']);
  });
});
