/**
 * `annotation-sidebar` — 标注侧栏（ebook-reader T6 / R4）。
 *
 * 列出当前文档的全部标注（高亮/书签/笔记），点击跳转到对应位置；可移除。
 * 纯 DOM 装配（真实交互留手工验证）；数据模型与持久化在 annotations.ts / Rust。
 */

import type { Annotation } from './annotations.js';

export interface AnnotationSidebarDeps {
  t: (key: string, vars?: Readonly<Record<string, string>>) => string;
  /** 点击某条标注时跳转到其位置（由 reader-view 实现滚动/翻页）。 */
  onJump: (annotation: Annotation) => void;
  /** 可选：移除标注（由 reader-view 实现删除+保存）。 */
  onRemove?: (annotation: Annotation) => void;
}

export interface AnnotationSidebar {
  readonly element: HTMLElement;
  render(annotations: readonly Annotation[]): void;
  destroy(): void;
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
  header.textContent = deps.t('annotation.sidebar');

  const list = document.createElement('ul');
  list.className = 'lightink-reader-sidebar-list';
  root.append(header, list);

  const renderItem = (annotation: Annotation): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'lightink-reader-sidebar-item';
    li.dataset.annotationId = annotation.id;

    const kind = document.createElement('span');
    kind.className = `lightink-reader-sidebar-kind lightink-reader-sidebar-kind--${annotation.kind}`;
    kind.textContent = deps.t(`annotation.kind.${annotation.kind}`);

    const text = document.createElement('span');
    text.className = 'lightink-reader-sidebar-text';
    text.textContent = annotation.quote ?? annotation.note ?? deps.t(`annotation.kind.${annotation.kind}`);

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'lightink-reader-sidebar-jump';
    jump.textContent = deps.t('annotation.jump');
    jump.addEventListener('click', () => deps.onJump(annotation));

    li.append(kind, text, jump);

    if (deps.onRemove !== undefined) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lightink-reader-sidebar-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', deps.t('annotation.remove'));
      remove.addEventListener('click', () => deps.onRemove?.(annotation));
      li.appendChild(remove);
    }
    return li;
  };

  return {
    element: root,
    render(annotations) {
      list.replaceChildren();
      if (annotations.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'lightink-reader-sidebar-empty';
        empty.textContent = deps.t('annotation.empty');
        list.appendChild(empty);
        return;
      }
      for (const annotation of annotations) {
        list.appendChild(renderItem(annotation));
      }
    },
    destroy() {
      root.remove();
    },
  };
}
