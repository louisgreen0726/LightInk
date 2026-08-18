/**
 * `annotation-render` — 标注高亮共享幂等引擎（PDF 文本层 / 流式 iframe 正文）。
 *
 * 宿主差异（PDF 按页定位文本层、流式按章定位 body）由调用方适配注入；引擎只面向
 * 单个 host 工作：
 * - renderAnnotationMarks：幂等渲染。该标注的 mark 已存在则只同步 kind/颜色，
 *   避免重复嵌套包裹；anchor 在 host 文本中无法定位时跳过，由调用方观察器重试；
 * - syncAnnotationMarks：先清掉不在当前集合里的 mark，再渲染/同步剩余项
 *   （删除后书内标记与侧栏一致）；
 * - removeAnnotationMarks：按标注 id 解包移除全部对应 mark。
 *
 * 颜色与 `annotations.ts` 共用同一关闭色板与默认黄；缺省/非法视为默认，不改 CSS。
 */

import { DEFAULT_ANNOTATION_COLOR, resolveAnnotationColor } from './annotations.js';
import type { TextQuoteAnchor } from './annotations.js';
import { markTextRange, removeTextRangeMarks, resolveTextQuoteRange } from './annotation-locator.js';

/** 一条待渲染的标注高亮：anchor 为 host 拼接文本坐标系中的文字级锚点。 */
export interface AnnotationMarkSpec {
  id: string;
  kind: string;
  anchor: TextQuoteAnchor;
  /** Optional palette color; missing/illegal values resolve to the default yellow. */
  color?: string;
}

/** Build a mark spec, including any stored highlight color. */
export function annotationMarkSpec(
  annotation: { id: string; kind: string; color?: string },
  anchor: TextQuoteAnchor,
): AnnotationMarkSpec {
  return {
    id: annotation.id,
    kind: annotation.kind,
    anchor,
    color: annotation.color,
  };
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function marksForId(host: ParentNode, annotationId: string): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>(`[data-annotation-id="${cssEscape(annotationId)}"]`),
  );
}

function isTextLayerHost(host: ParentNode): boolean {
  return host instanceof Element && host.classList.contains('lightink-reader-text-layer');
}

/** Paint kind/color onto an existing mark without re-wrapping text. */
function applyMarkAppearance(
  host: ParentNode,
  mark: HTMLElement,
  spec: AnnotationMarkSpec,
): void {
  const color = resolveAnnotationColor(spec.color);
  if (spec.kind !== '') {
    mark.dataset.annotationKind = spec.kind;
  }
  mark.dataset.annotationColor = color;
  mark.style.setProperty('--lightink-annotation-color', color);
  if (color === DEFAULT_ANNOTATION_COLOR) {
    mark.style.removeProperty('background');
    return;
  }
  // PDF 文本层字形在 canvas 上，mark 必须半透明；流式正文可用实色。
  mark.style.background = isTextLayerHost(host)
    ? `color-mix(in srgb, ${color} 32%, transparent)`
    : color;
}

/** 在单个 host 上幂等渲染标注高亮 mark（已渲染则同步外观，定位失败跳过）。 */
export function renderAnnotationMarks(
  host: ParentNode,
  specs: readonly AnnotationMarkSpec[],
): void {
  for (const spec of specs) {
    const existing = marksForId(host, spec.id);
    if (existing.length > 0) {
      for (const mark of existing) {
        applyMarkAppearance(host, mark, spec);
      }
      continue; // 已渲染：同步 kind/颜色，避免重复嵌套包裹
    }
    const range = resolveTextQuoteRange(host, spec.anchor);
    if (range !== null && !range.collapsed) {
      markTextRange(host, range, spec.id, spec.kind);
      for (const mark of marksForId(host, spec.id)) {
        applyMarkAppearance(host, mark, spec);
      }
    }
  }
}

/**
 * 将 host 上的 mark 对齐到当前标注集合：删除已不存在的 id，再渲染/同步剩余项。
 */
export function syncAnnotationMarks(
  host: ParentNode,
  specs: readonly AnnotationMarkSpec[],
): void {
  const keep = new Set(specs.map((spec) => spec.id));
  const present = new Set(
    Array.from(host.querySelectorAll<HTMLElement>('[data-annotation-id]'))
      .map((mark) => mark.dataset.annotationId ?? '')
      .filter((id) => id !== ''),
  );
  for (const id of present) {
    if (!keep.has(id)) {
      removeAnnotationMarks(host, id);
    }
  }
  renderAnnotationMarks(host, specs);
}

/** 移除 host 上指定标注的全部高亮 mark（与 renderAnnotationMarks 成对）。 */
export function removeAnnotationMarks(host: ParentNode, annotationId: string): void {
  removeTextRangeMarks(host, annotationId);
}
