/**
 * `html-export` — 独立 HTML 文档装配与图片内嵌（T10, R5）。纯逻辑层，
 * 不触达 DOM / Tauri IPC，全部依赖以参数注入，vitest 在 node 环境直测。
 *
 * 保真策略：导出的 body HTML 来自活动编辑器渲染后的 DOM 序列化
 * （`.ProseMirror` 的 innerHTML，由 export-service 提取），而非用 markdown
 * 重新渲染 —— 代码高亮（hljs 类）、KaTeX 公式、mermaid SVG 等 widget
 * 装饰原样携带，「与编辑器内渲染一致」由构造保证。样式由
 * export-css.ts 装配并整体内嵌进 `<style>`。
 *
 * 图片内嵌：编辑器内的图片引用是相对路径 `assets/<name>.<ext>`，独立
 * HTML 离开文档目录后即失效，因此导出时把相对 src 的图片读为 base64
 * 并改写为 data URI（读取由注入的 resolver 完成，生产走 Rust
 * `read_image_base64`）。已是绝对 URL（http(s):/data:/blob: 等）的图片
 * 保留原 src 不动。读取失败的图片：保留原 src 并列入 `missing`（导出
 * 继续，调用方负责提示），不静默丢弃也不中断整个导出。
 */

export interface HtmlExportOptions {
  /** 文档标题（写入 <title>，会做 HTML 转义）。 */
  readonly title: string;
  /** 当前主题 id（写入 <html data-theme>）；空串回退 'warm-light'。 */
  readonly theme: string;
  /** 序列化后的编辑器内容 HTML（原样放入 <body>，不做消毒/改写）。 */
  readonly bodyHtml: string;
  /** 内嵌样式文本（生产为 buildExportCss 的产物）。 */
  readonly cssText: string;
}

const STYLE_END_BOUNDARY = /<\/style/i;

export class UnsafeCssBoundaryError extends Error {
  constructor() {
    super('CSS contains the reserved </style sequence');
    this.name = 'UnsafeCssBoundaryError';
  }
}

/** CSS is embedded in an HTML raw-text element and must not contain its end boundary. */
export function assertSafeCssBoundary(cssText: string): void {
  if (STYLE_END_BOUNDARY.test(cssText)) {
    throw new UnsafeCssBoundaryError();
  }
}

/** 文本节点转义（<title> 用）。 */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性值转义（data-theme 用）。 */
export function escapeHtmlAttr(text: string): string {
  return escapeHtmlText(text).replace(/"/g, '&quot;');
}

/**
 * 装配独立 HTML 文档：doctype + `<html data-theme>` + charset utf-8 +
 * 内嵌 `<style>` + 内容。charset 必须在文档前 1024 字节内才可靠，
 * 故 `<meta charset>` 放在 head 第一位。
 */
export function buildHtmlDocument(opts: HtmlExportOptions): string {
  assertSafeCssBoundary(opts.cssText);
  const theme = opts.theme.trim() === '' ? 'warm-light' : opts.theme;
  return [
    '<!DOCTYPE html>',
    `<html lang="zh-CN" data-theme="${escapeHtmlAttr(theme)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="LightInk 轻墨">',
    `<title>${escapeHtmlText(opts.title)}</title>`,
    `<style>${opts.cssText}</style>`,
    '</head>',
    '<body>',
    opts.bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 文件扩展名 → 图片 MIME（data URI 用）；未知扩展回退 octet-stream。 */
export function mimeFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 该 src 是否需要/可以内嵌：仅相对路径（`assets/x.png`、`./x.png`）。
 * 带 scheme 的（http:/https:/data:/blob:/file: 等）与协议相对（//host/x）
 * 一律保留原样。
 */
export function isEmbeddableImageSrc(src: string): boolean {
  if (src.startsWith('//')) {
    return false;
  }
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src);
}

/** 匹配 <img> 标签内的双引号 src（innerHTML 序列化产物恒为双引号）。 */
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi;

/**
 * innerHTML 序列化会把属性值里的 `&` 等字符实体编码（如 `a&amp;b.png`）。
 * 解析文件路径前需还原，否则含这些字符的文件名会被误判 missing。
 * 单趟替换避免链式二次解码（`&amp;lt;` 只解一层为 `&lt;`，不再变 `<`）。
 */
const ATTR_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
};

function decodeAttrEntities(src: string): string {
  return src.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_whole, name: string) => ATTR_ENTITY_MAP[name] ?? _whole,
  );
}

export interface EmbedImagesResult {
  /** 相对图片已改写为 data URI 后的 HTML。 */
  readonly html: string;
  /** 成功内嵌的相对 src 列表（去重）。 */
  readonly embedded: readonly string[];
  /** 读取失败、保留原 src 的相对 src 列表（去重）。 */
  readonly missing: readonly string[];
}

/**
 * 把 HTML 中相对路径的 <img> src 内嵌为 data URI。resolver 返回 base64
 * 字符串；返回 null 或抛错均视为读取失败（保留原 src 并记入 missing）。
 * 同一 src 只解析一次（缓存），所有出现处一起改写。
 */
export async function embedImages(
  html: string,
  resolve: (relPath: string) => Promise<string | null>,
): Promise<EmbedImagesResult> {
  const srcs = [...html.matchAll(IMG_SRC_RE)].map((m) => m[2]);
  const uniqueRelSrcs = [...new Set(srcs)].filter(isEmbeddableImageSrc);

  const cache = new Map<string, string | null>();
  for (const src of uniqueRelSrcs) {
    let base64: string | null = null;
    try {
      // resolver 需要真实文件路径：先还原 innerHTML 序列化时的实体编码。
      base64 = await resolve(decodeAttrEntities(src));
    } catch {
      base64 = null;
    }
    cache.set(src, base64 === '' ? null : base64);
  }

  const embedded: string[] = [];
  const missing: string[] = [];
  for (const [src, base64] of cache) {
    // 对外展示用解码后的真实文件名（encoded 形式仅用于 HTML 替换定位）。
    (base64 === null ? missing : embedded).push(decodeAttrEntities(src));
  }

  const out = html.replace(
    IMG_SRC_RE,
    (whole: string, pre: string, src: string, post: string) => {
      const base64 = cache.get(src);
      if (base64 === undefined || base64 === null) {
        return whole;
      }
      return `${pre}data:${mimeFromPath(src)};base64,${base64}${post}`;
    },
  );
  return { html: out, embedded, missing };
}
