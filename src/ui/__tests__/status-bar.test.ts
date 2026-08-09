/**
 * status-bar 测试（R3）：显隐偏好（chrome-prefs 模式克隆）、关闭即不渲染、
 * 防抖刷新、重新打开立即按当前文档重绘、口径文案格式。
 * node 环境无 DOM，用最小 fake（同 app-shell.test.ts 模式）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_BAR_VISIBLE_STORAGE_KEY,
  createStatusBar,
  formatWordStats,
  loadStatusBarVisible,
  saveStatusBarVisible,
} from '../status-bar.js';

class FakeEl {
  id = '';
  className = '';
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  style: Record<string, string> = {};
  private ownText = '';
  private readonly attrs = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  appendChild(child: FakeEl): FakeEl {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent !== null) {
      const index = parent.children.indexOf(this);
      if (index >= 0) {
        parent.children.splice(index, 1);
      }
      this.parentNode = null;
    }
  }
}

function fakeDoc(): Pick<Document, 'createElement'> {
  return {
    createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement,
  };
}

function memoryStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  return {
    store: { ...initial },
    getItem(key: string) {
      return this.store[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.store[key] = value;
    },
  };
}

const zhLabels = (): { words: string; characters: string } => ({
  words: '字数',
  characters: '字符',
});

function makeBar(
  host: FakeEl,
  options: {
    storage?: ReturnType<typeof memoryStorage> | null;
    initiallyVisible?: boolean;
    debounceMs?: number;
  } = {},
) {
  return createStatusBar(fakeDoc(), host as unknown as HTMLElement, {
    storage: options.storage === undefined ? null : options.storage,
    labels: zhLabels,
    initiallyVisible: options.initiallyVisible,
    debounceMs: options.debounceMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('显隐偏好（localStorage，chrome-prefs 模式）', () => {
  it('无存储 / 缺键 / 损坏值均回落默认（关闭）', () => {
    expect(loadStatusBarVisible(null)).toBe(false);
    expect(loadStatusBarVisible(memoryStorage())).toBe(false);
    expect(loadStatusBarVisible(memoryStorage({ [STATUS_BAR_VISIBLE_STORAGE_KEY]: 'oops' }))).toBe(
      false,
    );
  });

  it('显式 true/false 按值恢复；save 持久化布尔', () => {
    const storage = memoryStorage();
    saveStatusBarVisible(storage, true);
    expect(loadStatusBarVisible(storage)).toBe(true);
    saveStatusBarVisible(storage, false);
    expect(loadStatusBarVisible(storage)).toBe(false);
    expect(storage.store[STATUS_BAR_VISIBLE_STORAGE_KEY]).toBe('false');
  });

  it('toggle 写入存储，跨「会话」（新建实例）保持', () => {
    const storage = memoryStorage();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage });
    expect(bar.isVisible()).toBe(false);

    bar.toggle();
    expect(storage.store[STATUS_BAR_VISIBLE_STORAGE_KEY]).toBe('true');

    // 模拟重启：同一 storage 新建实例恢复开启。
    const host2 = new FakeEl('div');
    const bar2 = makeBar(host2, { storage });
    expect(bar2.isVisible()).toBe(true);
    expect(host2.children).toHaveLength(1);
  });
});

describe('渲染与显隐', () => {
  it('默认关闭：不挂载（关闭即不渲染）', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null });
    expect(bar.isVisible()).toBe(false);
    expect(host.children).toHaveLength(0);
    // 隐藏时 refresh 不渲染。
    bar.refresh(() => '你好');
    expect(host.children).toHaveLength(0);
  });

  it('开启时挂载并显示口径文案「字数 N · 字符 M」', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    expect(host.children).toHaveLength(1);

    bar.refresh(() => '你好 hello');
    // 字数 = 2(你好) + 1(hello) = 3；字符 = 2 + 5 = 7。
    expect(bar.element.textContent).toBe('字数 3 · 字符 7');
  });

  it('getMarkdown 返回 null / 抛错时按空文档统计（不抛出）', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    bar.refresh(() => null);
    expect(bar.element.textContent).toBe('字数 0 · 字符 0');
    bar.refresh(() => {
      throw new Error('editor gone');
    });
    expect(bar.element.textContent).toBe('字数 0 · 字符 0');
  });

  it('关闭后从 DOM 移除；重新打开立即按当前文档重绘（不等编辑）', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    let doc = '你好';
    bar.refresh(() => doc);
    expect(bar.element.textContent).toBe('字数 2 · 字符 2');

    bar.setVisible(false);
    expect(host.children).toHaveLength(0);

    // 关闭期间文档变化；重开应立即反映当前文档。
    doc = '你好世界 hello';
    bar.setVisible(true);
    expect(host.children).toHaveLength(1);
    expect(bar.element.textContent).toBe('字数 5 · 字符 9');
  });
});

describe('防抖刷新（scheduleUpdate）', () => {
  it('窗口内多次调度只渲染最后一次', () => {
    vi.useFakeTimers();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true, debounceMs: 300 });
    let doc = 'a';
    bar.scheduleUpdate(() => doc);
    doc = 'ab';
    bar.scheduleUpdate(() => doc);
    vi.advanceTimersByTime(299);
    expect(bar.element.textContent).toBe('');
    doc = 'abc';
    bar.scheduleUpdate(() => doc);
    vi.advanceTimersByTime(300);
    // 'abc' = 1 个拉丁词、3 个非空白字符（仅渲染最后一次调度）。
    expect(bar.element.textContent).toBe('字数 1 · 字符 3');
  });

  it('隐藏时调度不启动计时器（不渲染）', () => {
    vi.useFakeTimers();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, debounceMs: 300 });
    bar.scheduleUpdate(() => '你好');
    vi.advanceTimersByTime(1000);
    expect(host.children).toHaveLength(0);
  });

  it('destroy 清计时器并移除元素', () => {
    vi.useFakeTimers();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true, debounceMs: 300 });
    bar.scheduleUpdate(() => '你好');
    bar.destroy();
    vi.advanceTimersByTime(1000);
    expect(host.children).toHaveLength(0);
    expect(bar.element.textContent).toBe('');
  });
});

describe('formatWordStats 文案', () => {
  it('千分位分隔 + 口径标签', () => {
    expect(formatWordStats({ words: 1234, characters: 5678 }, zhLabels())).toBe(
      '字数 1,234 · 字符 5,678',
    );
    expect(
      formatWordStats({ words: 1, characters: 2 }, { words: 'Words', characters: 'Characters' }),
    ).toBe('Words 1 · Characters 2');
  });
});
