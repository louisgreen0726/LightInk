# Technical Solution

```yaml
format: solution
summary: 以 pdfjs-dist 6.2.108 内置 TextLayer 为核心扩展 renderPdfInto（R1），在其文本数据上建 PDF 搜索面板（R2，参照编辑器 find-replace 分层模式）；标注侧以统一划选工具栏替换"划选即高亮"（R3）、多行笔记弹层替换 window.prompt（R4，基于 confirm-dialog/modal-focus 先例）、侧栏扩展筛选/定位/编辑（R4）；PdfLocator 在 v2 内可选扩展文字级锚点保证向后兼容（R5，Rust 原样读写零改动）；不做 reflow/多色/导出/CBZ 文字标注（R6）。
```

## 目标

1. PDF 文字可选中/复制（文本层叠加，版式保真）（R1）。
2. PDF 内关键词搜索：命中列表导航 + 跳转定位（R2）。
3. flow/txt/PDF 统一划选工具栏：高亮/笔记/取消高亮经确认产生（R3）。
4. 笔记多行编辑弹层 + 侧栏筛选/定位/编辑（R4）。
5. v2 标注数据向后兼容，历史标注不丢（R5）。

## Non-goals（R6）

- 不做 PDF 重排版（reflow）模式；不引入高亮多色/自定义样式；不做标注导出；CBZ 不出现划选工具栏（维持页级书签）。

## 设计（证据支持）

### R1 文本层（owner: `src/reader/formats/pdf.ts`）

- `renderSlot` 成功渲染 canvas 后，同 slot 内绝对定位 append `.lightink-reader-text-layer` 容器，用 pdfjs `TextLayer`（`node_modules/pdfjs-dist/types/src/display/text_layer.d.ts:39-91`）以 `page.getTextContent()` + 当前 viewport 渲染 DOM span。生命周期与 canvas 同步：`clearSlot`/`rerender`/`destroy` 时 `TextLayer.cancel()` 并随 `slot.replaceChildren()` 回收；缩放走 `rerender` 全量重建（复用现有 generation/cancel 机制，不引入增量 update 的复杂度）。
- 文本层 CSS 进 `reader.css`：透明文字色 + `::selection` 高亮 + pdfjs 规范要求的 span 定位修正；只消费 `--lightink-*` 令牌（`src/reader/reader.css:1-7` 约定）。
- 扫描件：`getTextContent()` 返回空 → 无 span → 自然无可选文字，无需特判。

### R2 PDF 搜索（owner: 新 `src/reader/search-panel.ts` + `pdf.ts` 文本缓存）

- `renderPdfInto` 缓存每页 `getTextContent()` 拼接文本（文本层已需要同数据），handle 暴露 `searchDocument(query)` 与按命中页跳转能力。
- 搜索面板 `createSearchPanel` 参照 `src/editor/plugins/find-replace.ts` 模式：纯 DOM 面板 + handlers 回调、环形 active/total 计数、`aria-live` 空态、Enter/Shift+Enter/Escape 键位、挂非滚动容器。跳转复用 `scrollToPage` + 命中处文本层 overlay 高亮（全部命中/当前命中双样式，同 find-replace L114-129）。
- 接口：`ReaderInstance` 增加 `openSearch()`；`src/main.ts` 在 reader 态接 Ctrl+F 与菜单（参照 `src/main.ts:1873-1886` 编辑器接线）。

### R3 统一划选工具栏（owner: 新 `src/reader/selection-toolbar.ts`，编排于 `reader-view.ts`）

- flow/txt：iframe 内 `mouseup` 取选区 rect（`range.getBoundingClientRect()` 为 frame 内坐标）叠加 frame 自身 rect 换算为外层坐标（01-S3 确认此为全新代码路径）。PDF：文本层选区直接取 rect。
- 行为变更：`captureFlowSelection` 不再直接建标注（删除 `reader-view.ts:558-569` 直接路径），改为唤起工具栏；工具栏动作（高亮/笔记/取消高亮）才产生标注。选中已高亮文字时工具栏提供"取消高亮"。
- 取消：点击外部/Escape/清空选区即消失，不产生标注。

### R4 笔记弹层与侧栏（owner: 新 `src/reader/note-dialog.ts`；`annotation-sidebar.ts` 扩展）

- 笔记弹层：基于 `showConfirmDialog`（`src/ui/confirm-dialog.ts`）+ `mountModalFocus`（`src/ui/modal-focus.ts`）新增多行 textarea 变体，`Promise<string | null>`；新建与编辑共用。
- 侧栏：`createAnnotationSidebar` 扩展类型筛选（高亮/书签/笔记）、定位显示（pdf→页码、flow/text→章节，来自 locator）、编辑备注（唤起笔记弹层）。保持全量重绘与现有类名体系。
- i18n：`src/i18n/messages.ts` en/zh 双区新增 toolbar/搜索/筛选 key（S4-S5 证据模式）。

### R5 数据兼容（owner: `src/reader/annotations.ts`）

- `PdfLocator` 可选增加文字级锚点字段（`anchor?: TextQuoteAnchor` 形状），`isLocator` pdf 分支对存在的 anchor 做结构校验、缺失时按现状通过——旧 v2 文件零改动加载（S2 证据：现有校验本就透传多余字段）。
- PDF 文字高亮渲染：`resolveTextQuoteRange`（`annotation-locator.ts:142-166` 模糊重定位）作用于文本层拼接文本；页码级书签/笔记定位行为不变。
- Rust 侧零改动（原样读写，S2 证据）。

## 失败行为

- TextLayer 渲染异常：降级为纯 canvas（无文字选择），不阻断阅读，console 记录。
- 搜索无命中/扫描件：面板显示无结果，不报错。
- 笔记弹层取消：不创建/不修改标注。
- 旧标注文件解析失败条目：沿用现有逐条过滤丢弃策略，不整文件失败。

## 删除面

- 删除"划选即直接高亮"路径（`reader-view.ts` captureFlowSelection 直接建标注分支）。
- 删除 `addAnnotation` 中 `window.prompt` 笔记输入。
- 删除旧侧栏纯列表渲染结构（由扩展版替换）；`annotation.*` 中被替换的 i18n key（如 `notePrompt`）随之移除。
- 不删除：v2 schema、`AnnotationWriteQueue`、Rust annotations 命令、`resolveTextQuoteRange`/`markTextRange`（继续服务 flow/txt 与 PDF 文本层）。

## 机械验收（对齐需求验收）

- `npm test -- src/reader`：文本层生命周期（mock pdfjs 扩展 getTextContent/TextLayer）、搜索纯逻辑（命中索引/环形导航）、annotations locator 扩展校验/迁移、侧栏筛选/定位、划选工具栏行为变更回归。
- `npm run build` 严格 TS 全过。
- 手工验证（无 jsdom/pdf 样本，01-S1 约定）：真实 PDF 选中/复制/缩放对齐、搜索跳转定位、三格式工具栏交互、旧标注文件加载。

## Requirement coverage

- R1→文本层设计；R2→搜索面板+文本缓存；R3→工具栏+行为变更；R4→笔记弹层+侧栏扩展；R5→locator 可选锚点+零迁移兼容；R6→non-goals 与删除面。
