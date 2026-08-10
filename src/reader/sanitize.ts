/**
 * `sanitize` — 阅读内容 HTML 消毒（ebook-reader T4）。
 *
 * 外来电子书 HTML（EPUB XHTML / MOBI HTML / FB2 转换结果）在插入 DOM 前必须消毒：
 * 移除脚本/样式、事件处理器属性、危险协议与危险容器标签。对齐 mermaid
 * securityLevel strict 的安全先例。本消毒器面向阅读场景的已知攻击面，配合各格式
 * 解析器的白名单标签映射使用；纯字符串实现，node 环境可测（无 DOMParser 依赖）。
 */

/** 危险容器标签：成对整块（含内容）移除。 */
const DANGEROUS_BLOCK =
  /<(script|style|iframe|object|embed|applet|noscript|template|svg|math|form|button|input|textarea|select|option|link|meta|base|frame|frameset)\b[\s\S]*?<\/\1\s*>/gi;

/** 危险容器标签名（用于移除残留的自闭合/未配对标签）。 */
const DANGEROUS_NAMES =
  'script|style|iframe|object|embed|applet|noscript|template|svg|math|form|button|input|textarea|select|option|link|meta|base|frame|frameset';

/** 事件处理器属性：on*="..." / on*='...' / on*=裸值。 */
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * 消毒 HTML：移除注释/CDATA、脚本与样式、危险容器标签（含与不含内容）、
 * 事件处理器属性，并把 URL 属性中的 javascript:/vbscript: 协议中和掉。
 * 保留阅读所需的格式标签（p/h/ul/ol/li/blockquote/pre/code/a/img/table 等）。
 */
export function sanitizeHtml(input: string): string {
  let s = input.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  // 成对危险容器（含内容）。
  s = s.replace(DANGEROUS_BLOCK, '');
  // 残留的危险标签（自闭合或未成对）。
  s = s.replace(new RegExp(`</?(?:${DANGEROUS_NAMES})\\b[^>]*>`, 'gi'), '');
  // 事件处理器属性。
  s = s.replace(EVENT_ATTR, '');
  // 危险 URL 协议中和：把 href/src 中的 javascript:/vbscript:/data:text-html 值替换为 #。
  s = s.replace(
    /((?:href|src)\s*=\s*["'])(?:javascript|vbscript|data:text\/html)[^"']*?(["'])/gi,
    '$1#$2',
  );
  return s;
}
