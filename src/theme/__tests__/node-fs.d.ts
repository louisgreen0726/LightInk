/**
 * 最小 node:fs ambient 声明：项目未安装 @types/node，而 tokens 测试需要
 * 读取 CSS 文件原文（vitest 会把 CSS 的 `?raw` 导入存根为空，不可用）。
 * 只声明测试用到的单个函数签名。
 */
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf-8'): string;
}
