/**
 * `cbz` — Comic Book ZIP 解析（ebook-reader T5）。
 *
 * CBZ 是图片 zip：按自然序（page2 < page10）取出图片条目，逐页作为 <img> 渲染。
 * `listImageEntries` 是纯函数（过滤图片 + 自然排序），node 可测；`renderCbzInto`
 * 懒加载 jszip 并把图片以 data URL 插入容器（DOM，真实渲染留手工验证）。
 */

import { ParseError } from './types.js';

const CBZ_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

/** 把字符串拆为「非数字段 / 数字段」序列，供自然序比较。 */
function splitNatural(s: string): Array<string | number> {
  const out: Array<string | number> = [];
  s.replace(/(\d+)|(\D+)/g, (_m, d, nd) => {
    out.push(d ? Number.parseInt(d, 10) : nd);
    return '';
  });
  return out;
}

/** 自然序比较：page2 < page10。 */
export function naturalCompare(a: string, b: string): number {
  const ax = splitNatural(a);
  const bx = splitNatural(b);
  const n = Math.max(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const an = ax[i];
    const bn = bx[i];
    if (an === undefined) {
      return -1;
    }
    if (bn === undefined) {
      return 1;
    }
    if (typeof an === 'number' && typeof bn === 'number') {
      if (an !== bn) {
        return an < bn ? -1 : 1;
      }
    } else {
      const c = String(an).localeCompare(String(bn));
      if (c !== 0) {
        return c < 0 ? -1 : 1;
      }
    }
  }
  return 0;
}

/**
 * 从 zip 条目名中筛出图片并按自然序排序。过滤目录项（以 `/` 结尾）与非图片。
 * 纯逻辑，headless 可测。
 */
export function listImageEntries(names: readonly string[]): string[] {
  const images = names.filter((n) => !n.endsWith('/') && CBZ_IMAGE_EXTS.has(extOf(n)));
  return images.sort(naturalCompare);
}

/**
 * 把 CBZ 字节渲染为容器内的逐页 <img>（jszip 懒加载）。图片以 base64 data URL 内联。
 * 空图片集抛 ParseError。DOM 渲染为手工验证（无 jsdom/canvas）。
 */
export async function renderCbzInto(bytes: Uint8Array, container: HTMLElement): Promise<void> {
  const JSZip = (await import('jszip')).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ParseError('CBZ 文件损坏或不是有效的 zip 容器');
  }
  const images = listImageEntries(Object.keys(zip.files));
  if (images.length === 0) {
    throw new ParseError('CBZ 未找到图片页');
  }
  container.replaceChildren();
  for (const name of images) {
    const file = zip.file(name);
    if (file === null) {
      continue;
    }
    const data = await file.async('base64');
    const ext = extOf(name);
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const img = document.createElement('img');
    img.className = 'lightink-reader-page';
    img.alt = name;
    img.src = `data:image/${mime};base64,${data}`;
    container.appendChild(img);
  }
}
