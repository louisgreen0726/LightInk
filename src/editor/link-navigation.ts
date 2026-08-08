/**
 * `link-navigation` — 文档链接点击跳转（R14）。
 *
 * 纯逻辑 [`classifyLink`] 按链接把目标分为 external（http(s)/其他 scheme，走系统
 * 浏览器）/ localMd（相对或绝对 .md，应用内新标签）/ localFile（其他本地文件，
 * 系统默认程序）/ invalid，可单测。`currentDocDir` 为当前文档所在目录，用于
 * 解析相对 .md 链接。
 *
 * [`linkNavigationPlugin`] 是 ProseMirror `$prose` 插件：单击链接 mark 时调用
 * 注入的 `onLinkNavigate(href)`（由 main.ts 经 classifyLink 分类后分派到 opener
 * 命令 / openFile），并 `return true` 阻止默认光标定位——满足「可点击跳转」。
 */

import { $prose } from '@milkdown/utils';
import { Plugin } from '@milkdown/prose/state';

export type LinkKind = 'external' | 'localMd' | 'localFile' | 'invalid';

export interface ClassifiedLink {
  kind: LinkKind;
  /** external: 原始 url；local*: 解析后的（尽量绝对）路径；invalid: 空串。 */
  target: string;
}

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;
/**
 * 外部 scheme：至少两字符的 scheme（排除 Windows 单字母盘符 `C:`），
 * 及协议相对 `//host`。
 */
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const PROTOCOL_RELATIVE = /^\/\//;
const WINDOWS_DRIVE_ABS = /^[a-z]:[\\/]/i;

/** 纯逻辑：分类链接 href。`currentDocDir` 为当前文档目录绝对路径（无则 ''）。 */
export function classifyLink(href: string, currentDocDir: string): ClassifiedLink {
  const h = typeof href === 'string' ? href.trim() : '';
  if (h === '') {
    return { kind: 'invalid', target: '' };
  }
  if (EXTERNAL_SCHEME.test(h) || PROTOCOL_RELATIVE.test(h)) {
    return { kind: 'external', target: h };
  }
  // 本地：剥锚点/查询取路径部分。
  const pathPart = h.split(/[#?]/)[0] ?? '';
  if (pathPart === '') {
    return { kind: 'invalid', target: '' };
  }
  const resolved = resolveLocalPath(pathPart, currentDocDir);
  return MARKDOWN_EXT.test(pathPart)
    ? { kind: 'localMd', target: resolved }
    : { kind: 'localFile', target: resolved };
}

/** 解析本地路径：绝对原样返回，相对按当前文档目录拼接。 */
export function resolveLocalPath(pathPart: string, currentDocDir: string): string {
  if (pathPart === '') {
    return '';
  }
  if (pathPart.startsWith('/') || WINDOWS_DRIVE_ABS.test(pathPart)) {
    return pathPart;
  }
  const base = currentDocDir.replace(/[\\/]+$/, '');
  if (base === '') {
    return pathPart;
  }
  return `${base}/${pathPart}`;
}

export interface LinkNavigationOptions {
  onLinkNavigate: (href: string) => void;
}

/** ProseMirror 插件：单击链接 mark 时跳转（阻止默认光标定位）。 */
export function linkNavigationPlugin(opts: LinkNavigationOptions) {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleClick(view, pos) {
            const link = view.state.doc
              .resolve(pos)
              .marks()
              .find((m) => m.type.name === 'link');
            if (link !== undefined) {
              const href =
                typeof link.attrs['href'] === 'string'
                  ? (link.attrs['href'] as string)
                  : '';
              if (href !== '') {
                opts.onLinkNavigate(href);
              }
              return true; // 阻止默认光标定位（点击即跳转）
            }
            return false;
          },
        },
      }),
  );
}
