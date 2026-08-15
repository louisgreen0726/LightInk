/**
 * `annotation-sidebar` — 标注侧栏（R4 重做）。
 *
 * 列出当前文档的全部标注（高亮/书签/笔记）并支持：按类型筛选、显示定位信息
 * （pdf/cbz 页码、flow 章节）、点击跳转、编辑备注（经 onEditNote 弹层）、移除。
 * 纯 DOM 装配；数据模型与持久化在 annotations.ts / Rust。render 全量重绘，
 * 筛选状态在闭包内跨 render 保留。
 */

import type { Annotation, AnnotationKind } from './annotations.js';
import type { MessageKey } from '../i18n/messages.js';

type AnnotationFilter = 'all' | AnnotationKind;

const FILTERS: readonly AnnotationFilter[] = ['all', 'highlight', 'bookmark', 'note'];

function filterLabelKey(filter: AnnotationFilter): MessageKey {
  return filter === 'all' ? 'annotation.filter.all' : `annotation.kind.${filter}`;
}

export interface AnnotationSidebarDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 点击某条标注时跳转到其位置（由 reader-view 实现滚动/翻页）。 */
  onJump: (annotation: Annotation) => void;
  /** 可选：移除标注（由 reader-view 实现删除+保存）。 */
  onRemove?: (annotation: Annotation) => void;
  /** 可选：编辑备注（由 reader-view 唤起笔记弹层并保存）。 */
  onEditNote?: (annotation: Annotation) => void;
  /** Close the sidebar from its narrow-window drawer control. */
  onClose?: () => void;
}

export interface AnnotationSidebar {
  readonly element: HTMLElement;
  render(annotations: readonly Annotation[]): void;
  destroy(): void;
}

/** 每条标注的定位描述（侧栏显示用；cbz 无章节概念只给页码）。 */
function locationText(
  annotation: Annotation,
  t: AnnotationSidebarDeps['t'],
): string | null {
  const locator = annotation.locator;
  switch (locator.format) {
    case 'pdf':
      return t('annotation.location.page', { page: String(locator.page) });
    case 'cbz':
      return t('annotation.location.page', { page: String(locator.page) });
    case 'flow':
      return t('reader.chapter', { n: String(locator.chapter + 1) });
    default:
      return null;
  }
}

/**
 * 创建标注侧栏。element 挂到 reader 视图；render 用当前标注集合重绘列表。
 */
export function createAnnotationSidebar(deps: AnnotationSidebarDeps): AnnotationSidebar {
  const root = document.createElement('aside');
  root.className = 'lightink-reader-sidebar';
  root.setAttribute('aria-label', deps.t('annotation.sidebar'));

  const header = document.createElement('div');
  header.className = 'lightink-reader-sidebar-header';
  const title = document.createElement('span');
  title.textContent = deps.t('annotation.sidebar');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-sidebar-close';
  close.textContent = '×';
  close.setAttribute('aria-label', deps.t('annotation.closeSidebar'));
  close.setAttribute('title', deps.t('annotation.closeSidebar'));
  close.addEventListener('click', () => deps.onClose?.());
  header.append(title, close);

  // 类型筛选：all + 三种 kind，aria-pressed 表达当前筛选。
  const filters = document.createElement('div');
  filters.className = 'lightink-reader-sidebar-filters';
  filters.setAttribute('role', 'group');
  const filterButtons = new Map<AnnotationFilter, HTMLButtonElement>();
  let currentFilter: AnnotationFilter = 'all';

  const list = document.createElement('ul');
  list.className = 'lightink-reader-sidebar-list';

  const applyFilter = (): void => {
    for (const [filter, button] of filterButtons) {
      button.setAttribute('aria-pressed', filter === currentFilter ? 'true' : 'false');
      button.classList.toggle(
        'lightink-reader-sidebar-filter--active',
        filter === currentFilter,
      );
    }
  };

  for (const filter of FILTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightink-reader-sidebar-filter';
    button.textContent = deps.t(filterLabelKey(filter));
    button.addEventListener('click', () => {
      currentFilter = filter;
      applyFilter();
      renderList(lastAnnotations);
    });
    filterButtons.set(filter, button);
    filters.appendChild(button);
  }

  root.append(header, filters, list);

  const renderItem = (annotation: Annotation): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'lightink-reader-sidebar-item';
    li.dataset.annotationId = annotation.id;

    const kind = document.createElement('span');
    kind.className = `lightink-reader-sidebar-kind lightink-reader-sidebar-kind--${annotation.kind}`;
    kind.textContent = deps.t(`annotation.kind.${annotation.kind}`);

    const meta = document.createElement('div');
    meta.className = 'lightink-reader-sidebar-item-meta';
    meta.appendChild(kind);
    const location = locationText(annotation, deps.t);
    if (location !== null) {
      const where = document.createElement('span');
      where.className = 'lightink-reader-sidebar-location';
      where.textContent = location;
      meta.appendChild(where);
    }
    li.appendChild(meta);

    const text = document.createElement('span');
    text.className = 'lightink-reader-sidebar-text';
    // 笔记优先显示备注（fallback quote），避免 quote 遮蔽备注（R4 编辑结果可见）。
    const body =
      annotation.kind === 'note'
        ? annotation.note ?? annotation.quote
        : annotation.quote ?? annotation.note;
    text.textContent = body ?? deps.t(`annotation.kind.${annotation.kind}`);
    li.appendChild(text);

    if (
      annotation.kind === 'note' &&
      annotation.quote !== undefined &&
      annotation.quote !== '' &&
      annotation.note !== undefined &&
      annotation.note !== '' &&
      annotation.note !== annotation.quote
    ) {
      const quote = document.createElement('span');
      quote.className = 'lightink-reader-sidebar-quote';
      quote.textContent = annotation.quote;
      li.appendChild(quote);
    }

    const actions = document.createElement('div');
    actions.className = 'lightink-reader-sidebar-actions';

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'lightink-reader-sidebar-jump';
    jump.textContent = deps.t('annotation.jump');
    jump.addEventListener('click', () => deps.onJump(annotation));
    actions.appendChild(jump);

    if (annotation.kind === 'note' && deps.onEditNote !== undefined) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'lightink-reader-sidebar-edit';
      edit.textContent = deps.t('annotation.edit');
      edit.addEventListener('click', () => deps.onEditNote?.(annotation));
      actions.appendChild(edit);
    }

    if (deps.onRemove !== undefined) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lightink-reader-sidebar-remove';
      remove.textContent = deps.t('annotation.remove');
      remove.setAttribute('aria-label', deps.t('annotation.remove'));
      remove.addEventListener('click', () => deps.onRemove?.(annotation));
      actions.appendChild(remove);
    }
    li.appendChild(actions);
    li.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('button') !== null) {
        return;
      }
      deps.onJump(annotation);
    });
    return li;
  };

  let lastAnnotations: readonly Annotation[] = [];
  applyFilter();

  const renderList = (annotations: readonly Annotation[]): void => {
    lastAnnotations = annotations;
    list.replaceChildren();
    const visible =
      currentFilter === 'all'
        ? annotations
        : annotations.filter((a) => a.kind === currentFilter);
    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'lightink-reader-sidebar-empty';
      // 区分"文档无任何标注"与"当前筛选无匹配"（跨文档保留的筛选不再误报空文档）。
      empty.textContent =
        annotations.length === 0
          ? deps.t('annotation.empty')
          : deps.t('annotation.filter.empty');
      list.appendChild(empty);
      return;
    }
    for (const annotation of visible) {
      list.appendChild(renderItem(annotation));
    }
  };

  return {
    element: root,
    render: renderList,
    destroy() {
      root.remove();
    },
  };
}
