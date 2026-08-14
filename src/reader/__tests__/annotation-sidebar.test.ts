// @vitest-environment jsdom

/**
 * 标注侧栏重做（R4）测试：类型筛选、定位显示、编辑备注入口、跳转/移除派发；
 * 附笔记弹层 Promise 语义（保存/取消）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createAnnotationSidebar } from '../annotation-sidebar.js';
import { showNoteDialog } from '../note-dialog.js';
import type { Annotation } from '../annotations.js';

const t = (key: string, vars?: Readonly<Record<string, string>>): string => {
  let text = key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(v);
    }
  }
  return text;
};

const annotations: Annotation[] = [
  {
    id: 'h1',
    kind: 'highlight',
    locator: {
      format: 'pdf',
      page: 3,
      quote: 'pdf 文字',
      anchor: { start: 0, end: 5, quote: 'pdf 文字', prefix: '', suffix: '' },
    },
    quote: 'pdf 文字',
    createdAt: 1,
  },
  {
    id: 'b1',
    kind: 'bookmark',
    locator: {
      format: 'flow',
      chapter: 2,
      start: 0,
      end: 0,
      quote: '',
      prefix: '',
      suffix: '',
    },
    createdAt: 2,
  },
  {
    id: 'n1',
    kind: 'note',
    locator: {
      format: 'text',
      start: 4,
      end: 9,
      quote: 'txt 片段',
      prefix: '',
      suffix: '',
    },
    quote: 'txt 片段',
    note: '旧备注',
    createdAt: 3,
  },
];

function mount() {
  const jumps: string[] = [];
  const removals: string[] = [];
  const edits: string[] = [];
  const sidebar = createAnnotationSidebar({
    t: t as never,
    onJump: (a) => jumps.push(a.id),
    onRemove: (a) => removals.push(a.id),
    onEditNote: (a) => edits.push(a.id),
  });
  document.body.appendChild(sidebar.element);
  sidebar.render(annotations);
  return { sidebar, jumps, removals, edits };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('annotation-sidebar 重做', () => {
  it('默认列出全部标注并显示定位信息；笔记优先显示备注', () => {
    const { sidebar } = mount();
    const items = sidebar.element.querySelectorAll('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(3);

    const textOf = (id: string) =>
      sidebar.element
        .querySelector(`[data-annotation-id="${id}"] .lightink-reader-sidebar-text`)
        ?.textContent;
    expect(textOf('h1')).toBe('pdf 文字'); // highlight 显示 quote
    expect(textOf('n1')).toBe('旧备注'); // note 优先显示 note（不被 quote 遮蔽）

    const locations = Array.from(
      sidebar.element.querySelectorAll('.lightink-reader-sidebar-location'),
    ).map((el) => el.textContent);
    expect(locations[0]).toBe(t('annotation.location.page', { page: '3' }));
    expect(locations[1]).toBe(t('reader.chapter', { n: '3' }));
    // txt 无章节定位：不显示 location
    expect(locations).toHaveLength(2);
  });

  it('按类型筛选只显示对应标注', () => {
    const { sidebar } = mount();
    const filterButton = (key: string) =>
      Array.from(sidebar.element.querySelectorAll<HTMLButtonElement>('.lightink-reader-sidebar-filter')).find(
        (b) => b.textContent === key,
      )!;

    filterButton('annotation.kind.highlight').click();
    let items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h1');

    filterButton('annotation.kind.bookmark').click();
    items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('b1');

    filterButton('annotation.filter.all').click();
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);
  });

  it('筛选后无匹配显示筛选空态（区别于文档空态）', () => {
    const { sidebar } = mount();
    const noteFilter = Array.from(
      sidebar.element.querySelectorAll<HTMLButtonElement>('.lightink-reader-sidebar-filter'),
    ).find((b) => b.textContent === 'annotation.kind.bookmark')!;
    noteFilter.click();
    sidebar.render([annotations[0]!]);
    expect(
      sidebar.element.querySelector('.lightink-reader-sidebar-empty')?.textContent,
    ).toBe('annotation.filter.empty');
    // 文档本身无任何标注时仍是通用空态
    sidebar.render([]);
    expect(
      sidebar.element.querySelector('.lightink-reader-sidebar-empty')?.textContent,
    ).toBe('annotation.empty');
  });

  it('笔记条目有编辑入口，其他类型没有；按钮派发回调', () => {
    const { sidebar, jumps, removals, edits } = mount();
    const byId = (id: string) =>
      sidebar.element.querySelector(`[data-annotation-id="${id}"]`)!;

    expect(byId('n1').querySelector('.lightink-reader-sidebar-edit')).not.toBeNull();
    expect(byId('h1').querySelector('.lightink-reader-sidebar-edit')).toBeNull();
    expect(byId('b1').querySelector('.lightink-reader-sidebar-edit')).toBeNull();

    (byId('n1').querySelector('.lightink-reader-sidebar-edit') as HTMLElement).click();
    (byId('h1').querySelector('.lightink-reader-sidebar-jump') as HTMLElement).click();
    (byId('h1').querySelector('.lightink-reader-sidebar-remove') as HTMLElement).click();
    expect(edits).toEqual(['n1']);
    expect(jumps).toEqual(['h1']);
    expect(removals).toEqual(['h1']);
  });
});

describe('note-dialog', () => {
  const dialogTextarea = (): HTMLTextAreaElement =>
    document.querySelector<HTMLTextAreaElement>('.lightink-note-textarea')!;

  it('保存解析为输入文本（可空串），取消/Esc 解析 null', async () => {
    const saved = showNoteDialog(document, '初始', { t: t as never });
    const textarea = dialogTextarea();
    expect(textarea.value).toBe('初始');
    textarea.value = '新备注';
    (
      document.querySelector<HTMLButtonElement>('.lightink-modal-btn--primary')!
    ).click();
    await expect(saved).resolves.toBe('新备注');
    expect(document.querySelector('.lightink-note-dialog')).toBeNull();

    const cancelled = showNoteDialog(document, '', { t: t as never });
    (
      document.querySelector<HTMLButtonElement>('.lightink-modal-btn--plain')!
    ).click();
    await expect(cancelled).resolves.toBeNull();

    const escaped = showNoteDialog(document, '', { t: t as never });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(escaped).resolves.toBeNull();
  });
});
