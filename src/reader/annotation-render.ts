/**
 * `annotation-render` — 标注高亮共享幂等引擎（PDF 文本层 / 流式 iframe 正文）。
 *
 * 宿主差异（PDF 按页定位文本层、流式按章定位 body）由调用方适配注入；引擎只面向
 * 单个 host 工作：
 * - renderAnnotationMarks：幂等渲染。该标注的 mark 已存在则跳过（避免重复嵌套包裹），
 *   anchor 在 host 文本中无法定位（层未就绪 / 文本已变）时跳过，由调用方的观察器重试；
 * - removeAnnotationMarks：按标注 id 解包移除全部对应 mark。
 */

import type { TextQuoteAnchor } from './annotations.js';
import { markTextRange, removeTextRangeMarks, resolveTextQuoteRange } from './annotation-locator.js';

/** 一条待渲染的标注高亮：anchor 为 host 拼接文本坐标系中的文字级锚点。 */
export interface AnnotationMarkSpec {
  id: string;
  kind: string;
  anchor: TextQuoteAnchor;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** 在单个 host 上幂等渲染标注高亮 mark（已渲染跳过，定位失败跳过）。 */
export function renderAnnotationMarks(
  host: ParentNode,
  specs: readonly AnnotationMarkSpec[],
): void {
  for (const spec of specs) {
    if (host.querySelector(`[data-annotation-id="${cssEscape(spec.id)}"]`) !== null) {
      continue; // 已渲染：幂等跳过，避免重复嵌套包裹
    }
    const range = resolveTextQuoteRange(host, spec.anchor);
    if (range !== null && !range.collapsed) {
      markTextRange(host, range, spec.id, spec.kind);
    }
  }
}

/** 移除 host 上指定标注的全部高亮 mark（与 renderAnnotationMarks 成对）。 */
export function removeAnnotationMarks(host: ParentNode, annotationId: string): void {
  removeTextRangeMarks(host, annotationId);
}
