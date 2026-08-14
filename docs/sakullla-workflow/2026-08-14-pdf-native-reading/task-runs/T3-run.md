# Task T3

## Attempt History

```yaml
format: task_attempt_history
task_id: T3
history_ref: evidence/history/sha256-311d30cd9d8ec358d154f2d15cf8af6dd52694b6db87ccc7bb27e20d38176ad3.json
history_count: 2
```

## Execution

```yaml
format: task_run
task_id: T3
execution:
  # allowed: blocked|completed|completed_with_concerns|needs_context
  outcome: completed
  summary: A2 修复 A1 审查的全部 5 条 findings：P1 reader.css 增加 .lightink-reader-selection-toolbar[hidden] display:none（对齐 theme.css 同类前例，hide 真实生效）；P2 frame onLoad 向 frameDocument 注册 keydown 转发 Escape（与 click/mouseup 同批注册注销，iframe 内焦点可达）；P3 flowLocatorFromRange null 时改走 hideSelectionToolbar；P3 scrollHost/pageHost 滚动时隐藏 fixed 定位工具栏；P3 pendingSelection 记录来源 frame，动作确认后 removeAllRanges 清空选区。A1 其余实现不变（selection-toolbar 组件、pendingSelection 编排、removeAnnotationById 复用、i18n 三 key、jsdom 测试 4 例新增）。
  verification_refs:
    - npm test -- src/reader/__tests__/reader-view.test.ts (8 passed)
    - npm test -- src/reader (10 files / 85 tests passed)
    - npx tsc --noEmit (clean)
  concerns: []
```
