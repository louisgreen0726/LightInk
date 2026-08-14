# Execution Plan

```yaml
format: execution_plan
tasks:
  - id: T1
    goal: PDF 每页渲染出与 canvas 同生命周期的 pdfjs TextLayer 文本层，文字可选中/复制，缩放重建、离屏回收、扫描件自然无可选文字
    depends_on: []
    covers: [R1]
    scope:
      - src/reader/formats/pdf.ts
      - src/reader/reader.css
      - src/reader/__tests__/pdf-render-lifecycle.test.ts
    outcomes:
      - renderSlot 渲染 canvas 后同 slot 内创建 .lightink-reader-text-layer（page.getTextContent + 当前 viewport），TextLayer 渲染异常时降级纯 canvas 不阻断
      - clearSlot/rerender/destroy 随 canvas 一起回收文本层（TextLayer.cancel），缩放经现有 generation 机制全量重建
      - reader.css 新增文本层样式（透明文字、::selection 高亮、span 定位修正），只消费 --lightink-* 令牌
      - 扫描件 getTextContent 为空时不产生 span、不报错
    verify:
      - npm test -- src/reader/__tests__/pdf-render-lifecycle.test.ts
    test: extend
  - id: T2
    goal: PdfLocator 可选文字级锚点在 v2 内往返兼容：旧文件零改动加载，新 anchor 结构被校验
    depends_on: []
    covers: [R5]
    scope:
      - src/reader/annotations.ts
      - src/reader/__tests__/annotations.test.ts
    outcomes:
      - PdfLocator 增加可选 anchor（TextQuoteAnchor 形状），isLocator pdf 分支对存在的 anchor 做结构校验、缺失时照旧通过
      - 含 anchor 与不含 anchor 的 v2 JSON 均可 serialize/parse 往返；v1 迁移行为不变
      - Rust 侧零改动（现有 annotations.rs 内嵌测试继续通过）
    verify:
      - npm test -- src/reader/__tests__/annotations.test.ts
    test: extend
  - id: T3
    goal: flow/txt 划选文字弹出统一工具栏，高亮/笔记经确认产生，替换"划选即高亮"，取消高亮可用
    depends_on: [T1]
    covers: [R3]
    scope:
      - src/reader/selection-toolbar.ts
      - src/reader/reader-view.ts
      - src/reader/reader.css
      - src/i18n/messages.ts
      - src/reader/__tests__/reader-view.test.ts
    outcomes:
      - 新 selection-toolbar 组件：外层浮层定位（iframe 内选区 rect 叠加 frame rect 换算），点击外部/Escape/清空选区消失且不产生标注
      - captureFlowSelection 不再直接建标注，改唤起工具栏；工具栏动作才创建高亮/唤起笔记流程
      - 选中已高亮文字时工具栏提供取消高亮并移除对应标注
      - i18n en/zh 双区新增工具栏文案 key
    verify:
      - npm test -- src/reader/__tests__/reader-view.test.ts
    test: extend
  - id: T4
    goal: 笔记经多行弹层输入（新建+编辑），标注侧栏支持类型筛选、定位显示与备注编辑
    depends_on: [T3]
    covers: [R4]
    scope:
      - src/reader/note-dialog.ts
      - src/reader/annotation-sidebar.ts
      - src/reader/reader-view.ts
      - src/i18n/messages.ts
      - src/reader/__tests__/annotation-sidebar.test.ts
    outcomes:
      - note-dialog 基于 modal-focus 模式提供多行输入，Promise<string|null>，取消不创建/不修改；window.prompt 路径与 notePrompt key 删除
      - 侧栏按高亮/书签/笔记筛选，每条显示页码或章节定位（来自 locator），编辑备注唤起弹层并保存
      - 侧栏与正文标注双向同步（新增/删除/编辑后一致）
    verify:
      - npm test -- src/reader/__tests__/annotation-sidebar.test.ts
    test: extend
  - id: T5
    goal: PDF 文本层划选经工具栏生成文字级高亮并持久化，历史页码级标注定位行为不变
    depends_on: [T1, T2, T4]
    covers: [R3, R5]
    scope:
      - src/reader/reader-view.ts
      - src/reader/annotation-locator.ts
      - src/reader/__tests__/pdf-annotations.test.ts
    outcomes:
      - PDF 文本层选区唤起工具栏，高亮动作生成含 anchor 的 PdfLocator（resolveTextQuoteRange 模糊重定位作用于文本层拼接文本）
      - 已有 PDF 高亮在重新打开文档后于文本层重渲染（markTextRange 于 textLayer DOM span）
      - 历史页码级书签/笔记跳转行为不变，新旧标注可共存持久化
    verify:
      - npm test -- src/reader/__tests__/pdf-annotations.test.ts
    test: new
  - id: T6
    goal: PDF 内关键词搜索：命中环形导航、跳转定位与命中高亮，无结果有空态提示
    depends_on: [T5]
    covers: [R2]
    scope:
      - src/reader/search-panel.ts
      - src/reader/formats/pdf.ts
      - src/reader/types.ts
      - src/reader/reader-view.ts
      - src/main.ts
      - src/reader/reader.css
      - src/i18n/messages.ts
      - src/reader/__tests__/pdf-search.test.ts
    outcomes:
      - renderPdfInto 缓存每页拼接文本并暴露搜索能力；命中按 (页, 偏移) 索引
      - 搜索面板（handlers 回调 + aria-live 空态 + Enter/Shift+Enter/Escape）环形导航，全部命中/当前命中双样式 overlay 于文本层
      - ReaderInstance.openSearch 暴露，main.ts 在 reader 态接 Ctrl+F/菜单；关闭后阅读状态不受影响
    verify:
      - npm test -- src/reader/__tests__/pdf-search.test.ts
    test: new
delivery_verification:
  frontend_tests:
    command: npm test
  frontend_build:
    command: npm run build
```
