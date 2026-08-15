/**
 * `path-ext` — 路径扩展名的唯一事实来源。
 *
 * 语义：取最后一个路径段（同时接受 `/` 与 `\` 分隔符）的小写扩展名；
 * 无扩展名、点文件（如 `.gitignore`）或以点结尾的文件名返回 `''`。
 * file 域与 reader 侧的路径扩展名判断都必须从这里导入，禁止再本地定义。
 */
export function extOfPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}
