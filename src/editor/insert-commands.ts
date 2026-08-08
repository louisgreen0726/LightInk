/**
 * `insert-commands` — 插入元素目录与 Markdown 插入逻辑（R2 插入菜单 / R11 斜杠命令同源）。
 *
 * 仅纯数据与纯函数：提供共享的元素目录（标题/列表/任务/表格/代码/公式/流程图/图片/链接）
 * 与可 headless 测试的 Markdown 生成。R2 的「插入」菜单与 R11 的斜杠命令共用本目录，
 * 保证元素集合一致。
 *
 * 光标级精确插入由编辑器插件（斜杠菜单 T6/R11）负责；本模块的 `insertElementMarkdown`
 * 以块间空行分隔追加元素，作为菜单/快捷键的 MVP 插入路径，T6 在其上叠加光标精度。
 */

export type InsertElementId =
  | 'heading'
  | 'list'
  | 'task-list'
  | 'table'
  | 'code'
  | 'formula'
  | 'flowchart'
  | 'image'
  | 'link';

export interface InsertElement {
  id: InsertElementId;
  label: string;
  /** 斜杠菜单过滤关键词（含中英文）。 */
  keywords: string[];
  /** 生成该元素的 Markdown 片段。 */
  snippet(): string;
}

/** 元素目录（插入菜单与斜杠命令的唯一同源集合）。 */
export const INSERT_ELEMENTS: readonly InsertElement[] = [
  { id: 'heading', label: '标题', keywords: ['标题', 'heading', 'h1', 'h2'], snippet: () => '## 标题' },
  { id: 'list', label: '列表', keywords: ['列表', 'list', '无序'], snippet: () => '- 列表项' },
  { id: 'task-list', label: '任务列表', keywords: ['任务', 'task', '待办', '清单'], snippet: () => '- [ ] 任务' },
  {
    id: 'table',
    label: '表格',
    keywords: ['表格', 'table'],
    snippet: () => '| 列1 | 列2 |\n| --- | --- |\n|  |  |',
  },
  { id: 'code', label: '代码块', keywords: ['代码', 'code', '代码块'], snippet: () => '```ts\n\n```' },
  { id: 'formula', label: '公式', keywords: ['公式', 'formula', '数学', 'math'], snippet: () => '$$\nE = mc^2\n$$' },
  {
    id: 'flowchart',
    label: '流程图',
    keywords: ['流程图', 'flowchart', 'mermaid', '图'],
    snippet: () => '```mermaid\ngraph TD\n  A --> B\n```',
  },
  { id: 'image', label: '图片', keywords: ['图片', 'image', '图像'], snippet: () => '![描述](assets/image.png)' },
  { id: 'link', label: '链接', keywords: ['链接', 'link', '超链接'], snippet: () => '[文本](https://)' },
];

const ELEMENT_BY_ID: ReadonlyMap<InsertElementId, InsertElement> = new Map(
  INSERT_ELEMENTS.map((element) => [element.id, element]),
);

export function getInsertElement(id: InsertElementId): InsertElement | undefined {
  return ELEMENT_BY_ID.get(id);
}

/** 按关键词过滤元素目录（斜杠菜单用）；空查询返回全部。 */
export function filterInsertElements(query: string): InsertElement[] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return [...INSERT_ELEMENTS];
  }
  return INSERT_ELEMENTS.filter((element) =>
    [element.label, element.id, ...element.keywords].some((text) => text.toLowerCase().includes(q)),
  );
}

/**
 * 将元素追加到当前 Markdown 末尾，保证块间以空行分隔。
 * 纯函数：不接触编辑器内部，便于 headless 测试。
 */
export function insertElementMarkdown(currentMarkdown: string, id: InsertElementId): string {
  const element = getInsertElement(id);
  if (element === undefined) {
    return currentMarkdown;
  }
  const snippet = element.snippet();
  const base = currentMarkdown.trimEnd();
  if (base === '') {
    return snippet;
  }
  return `${base}\n\n${snippet}`;
}
