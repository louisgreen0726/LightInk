# Exploration

```yaml
format: exploration
summary: PDF 文本层（pdfjs-dist 6.2.108 已内置 TextLayer 类）、PDF 搜索（无既有阅读器搜索入口，可参照编辑器 find-replace 模式）、标注组件重做（划选即高亮/`window.prompt` 笔记/纯列表侧栏均确认为现状基线）与 v2 标注向后兼容（Rust 原样读写、前端宽松校验）的证据已由 4 个互斥 sections 覆盖；主要风险为 pdfjs v6 TextLayer 无仓库内使用先例、外层浮层跟随 iframe 内选区坐标无先例代码。
```

## S1 PDF 渲染管线与文本层接入点（R1/R2）

### 证据

- pdfjs-dist 解析版本 **6.2.108**（`package.json:34`；`package-lock.json:4240-4242`）。主入口导出 `TextLayer` 类（`node_modules/pdfjs-dist/types/src/pdf.d.ts:61,69`）；API：`constructor({ textContentSource, images, container, viewport })`、`render()`、`update({ viewport, onBefore })`（缩放后更新）、`cancel()`、`get textDivs()`、`get textContentItemsStr()`（`node_modules/pdfjs-dist/types/src/display/text_layer.d.ts:39-91`）。旧式 `renderTextLayer` 已从主入口移除，仅存 viewer 包。
- `renderPdfInto` 生命周期（`src/reader/formats/pdf.ts`）：初始逐页预取 viewport 建 `.lightink-reader-page-slot`（L202-214）；`renderSlot` 懒栅格化（IntersectionObserver rootMargin 200%，L217-272）；`clearSlot` 离屏回收（L282-285）；`rerender` 缩放重算+清旧画布（L333-362）；`destroy` 释放任务与监听（L374-385）。文本层挂接点：创建→`renderSlot` 成功后同 slot 内 append；缩放→`rerender` 或 `TextLayer.update()`；回收→`clearSlot`/`destroy`。
- worker 懒加载：`pdf.ts:135-138` `import('pdfjs-dist')` + `pdf.worker.min.mjs?url` 独立 chunk；vite 无专门配置（`?url` 内置行为）。
- `page.getTextContent()` 当前未被调用（纯 canvas 栅格化，无文本层）。
- 页数上限 `MAX_PDF_PAGES = 10_000`（`src/reader/formats/page-limits.ts:3`），`enforcePageCount` 在 slot 分配前强制（`pdf.ts:158`）。
- reader.css 约定：只消费 `var(--lightink-*)` 令牌与 `--lightink-font-scale`；`.lightink-reader-pages` 用 `zoom: var(--lightink-font-scale)` 整页缩放；PDF slot 无背景令牌（CBZ slot 有 `--lightink-bg-elevated` 先例，`src/reader/reader.css:53-63`）。

### 测试现状

- `src/reader/__tests__/pdf-render-lifecycle.test.ts`（jsdom pragma）整体 mock pdfjs-dist 与 worker `?url`；覆盖缩放重叠 cancel 与 destroy 清理；真实 canvas/滚动/懒栅格化声明为手工验证（`pdf.ts:6-7,127`）。

### 风险 / Unknowns

- `TextLayer` 运行时行为（`textContentSource` 用法、`update()` 缩放适配细节）仅有类型声明证据，仓库内无使用示例——实现期需按 pdfjs v6 官方示例验证，留手工/集成验证焦点。
- `TextLayerImages` 与 `getTextContent` 完整签名未展开（不影响需求方向，实现期查阅）。

## S2 标注数据模型与持久化兼容（R5/R3）

### 证据

- Rust 侧（`src-tauri/src/annotations.rs`）：`read_annotations`/`write_annotations`/`content_hash`（L55-75），存储 `<app_data_dir>/annotations/<content_hash>.json`（L19-24），原子写复用 `write_file_impl`，读失败返回空串；**Rust 不做 schema 校验、原样读写 JSON**，仅 `validate_content_hash`（16 位小写 hex）防路径注入。content_hash 为 FNV-1a 64-bit。
- 前端校验（`src/reader/annotations.ts`）：`isLocator` pdf 分支只要求 `page>=1` 整数 + `quote` string（L67-88），**不拒绝多余字段**——扩展 PdfLocator（增加文字级字段）旧读取端可透传；若需必填校验须同步 `PdfLocator` 接口（L22-26）与该分支。v2 文件结构 `{ version: 2, annotations: [...] }` 逐条 `isAnnotation` 过滤，扩展字段不破坏必填项即可往返持久化。
- v1→v2 迁移先例（`migrateV1Annotation` L108-191）：按 version 分派、逐条 best-effort、缺上下文补默认值。新字段迁移可复用"v2 内缺字段补默认值"归一化，无需 version 3。
- `AnnotationWriteQueue`（L228-268）：按 contentHash promise 链串行；generation 失效跳过未开始写；切 hash 不清理旧队列，依赖调用方 `invalidate()`。
- 文字定位能力（`src/reader/annotation-locator.ts`）：`captureTextQuoteAnchor`（L69-87）Range→offset+quote+前后 32 字符；`resolveTextQuoteRange`（L142-166）模糊重定位（偏移+上下文评分），**可直接复用于 PDF 文本层**（`getTextContent()` 拼接文本可作等价 root text）；`markTextRange`/`removeTextRangeMarks`（L169-205）依赖 DOM text node——PDF 若用 pdfjs textLayer（DOM span）则可用，canvas 则不可。

### 测试落点

- 数据模型/校验/迁移/序列化 → `src/reader/__tests__/annotations.test.ts`；DOM 定位行为 → `__tests__/annotation-locator.test.ts`（已存在）；Rust 扩展才动 `annotations.rs` 内嵌 tests。

## S3 阅读器交互与标注 UI 组件（R3/R4）

### 证据

- 划选即高亮现状：每章 iframe `load` 后向 `frameDocument` 注册 `mouseup`（`src/reader/reader-view.ts:654-655`）→ `captureFlowSelection`（L534-570）构造 highlight 后立即 `renderHighlights()`+保存+`removeAllRanges()`，**无工具栏确认步骤**。
- 笔记 prompt：`addAnnotation(kind)`（L355-380），note 经 `window.prompt(t('annotation.notePrompt'))`，cancel 即中止；仅 `addBookmark`/`addNote` 实例方法（L970-975）触发。
- 消费链：`src/main.ts:901-913` 回调转发 → reader tab `reader.*`；菜单装配 `src/ui/app-shell.ts:356-385`（reader 态"标注"菜单 `ann-bookmark`/`ann-note`/`ann-sidebar`，内联双语 `ll()` 非 i18n key）。
- sandbox 约束：iframe `sandbox='allow-same-origin'` 无 `allow-scripts`（L592），所有交互经外层 `frame.contentDocument` 注入（可完整读写，含 `<mark>` 插入）；**外层浮层跟随 iframe 内选区坐标无先例代码**（L810 注释为唯一线索）——需 frame 内 rect + frame 自身 rect 叠加换算，属新代码。
- 侧栏现状：`createAnnotationSidebar`（`src/reader/annotation-sidebar.ts`）全量 `replaceChildren` 重绘，item = kind + text + jump + remove，无筛选/分组/定位显示/编辑。
- i18n：`src/i18n/messages.ts` en/zh 双区同 key（`reader.*` L133-170 / L410-445，`annotation.*` 12 个 key）；新增文案 en+zh 各加一条。
- 弹层先例：`src/ui/confirm-dialog.ts` `showConfirmDialog` 主题化模态 + `src/ui/modal-focus.ts`（Esc/焦点圈/Enter 默认）；**自由文本多行输入弹层无现成组件**（`link-dialog.ts` 输入型对话框可作第二参考）。

### 风险

- 划选工具栏定位（iframe 内选区坐标换算到外层浮层）为全新代码路径，需覆盖 flow/txt/PDF 三种宿主。
- 现有 mouseup 直接建标注的行为变更（R3 要求工具栏确认）会改变交互契约，需回归现有 `reader-view.test.ts` 场景。

## S4 搜索模式与测试基建（R2）

### 证据

- 编辑器 find-replace 参照（`src/editor/plugins/find-replace.ts`）：纯 DOM 面板 `createFindReplacePanel`（L592）+ handlers 回调；环形 `nextMatchIndex`（L108）；`aria-live` + data 属性空态；Enter/Shift+Enter/Escape 键位（L690-702）；自定义滚动定位 `scrollActiveMatchIntoView`（L397，不用 `scrollIntoView`）；全命中+当前命中双样式（L114-129）。壳层惰性单例挂非滚动容器（`src/main.ts:1571,1581-1584`），Ctrl+F/菜单打开（L1873-1886）。
- 阅读器**无任何搜索入口或 ReaderState 预留**（`src/reader/types.ts:24-34,43-68`，grep `search|find|match` 零命中）——需扩展 `ReaderState`/`ReaderInstance` 接口。
- vitest 默认 node 环境，jsdom 按文件首行 pragma `// @vitest-environment jsdom` 启用（devDependency jsdom@^30）；DI 模式 `createReaderView(host, deps)` 全可选注入（`reader-view.ts:104-125`），测试传函数字面量（`reader-load-lifecycle.test.ts:36-37`）。
- pdfjs-dist 在 node 测试中整体 `vi.mock`（`pdf-render-lifecycle.test.ts:5-15`），canvas getContext spy 绕过真实渲染；新 `getTextContent()` 调用可沿用同 mock 模式加 page stub。
- 静态检查：`npm run build`（tsc 严格 + vite build）、`npm test`、Rust `cargo test` + `cargo fmt --check`。

## 复用点汇总

- pdfjs `TextLayer` 类（v6.2.108 内置）→ R1 文本层。
- `resolveTextQuoteRange` 模糊重定位 + `TextQuoteAnchor` 结构 → R3/R5 PDF 文字级 locator。
- `AnnotationWriteQueue`/content_hash 存储链路不动，仅前端扩展 locator 形状 → R5。
- `showConfirmDialog`/`modal-focus.ts` 模态模式 → R4 笔记编辑弹层（需新多行输入变体）。
- find-replace 面板分层/环形计数/自定义滚动 → R2 PDF 搜索面板。
- i18n en/zh 双区 + `--lightink-*` 令牌体系 → 所有新 UI。

## Owner / Consumer

- `renderPdfInto`（pdf.ts）owner=文本层+搜索数据源（getTextContent）；consumer=reader-view 标注/搜索。
- `annotations.ts` locator 模型 owner=R5 扩展；consumer=annotation-locator、sidebar、持久化（Rust 原样读写无需改）。
- `reader-view.ts` owner=R3/R4 交互编排；consumer=main.ts/app-shell.ts 菜单接线。
- `types.ts` ReaderState/ReaderInstance owner=R2 搜索接口；consumer=main.ts。

## 验证焦点

- 文本层：mock pdfjs 的 lifecycle 测试扩展 + 真实 PDF 手工验证（对齐、缩放 update、离屏回收）。
- PDF 搜索：page stub `getTextContent` mock 的纯逻辑测试（命中索引/环形导航）。
- 标注：annotations.test.ts 扩展 locator 校验/迁移；annotation-locator.test.ts 扩展 PDF 文本定位。
- UI：reader-view.test.ts 回归划选行为变更；`npm run build` 严格 TS 全过。

## Unknowns（非阻塞）

- pdfjs v6 `TextLayer` 运行时用法细节（仓库无先例）——实现期以官方示例为准。
- 外层浮层跟随 iframe 内选区的坐标换算——全新代码，无先例可抄。
