# Task T5

## Attempt History

```yaml
format: task_attempt_history
task_id: T5
history_ref: evidence/history/sha256-93c23486949cfec7f4d185253b37704f4f9ce0b6e67b22801b94a6a2f8db8a05.json
history_count: 2
```

## Execution

```yaml
format: task_run
task_id: T5
execution:
  # allowed: blocked|completed|completed_with_concerns|needs_context
  outcome: completed
  summary: A2 修复 A1 审查 findings：P1 观察器时序——isTextLayerMutation 提取为模块级导出谓词，层容器插入与层内部 childList 变更（pdfjs TextLayer.render 微任务链异步追加 span）都触发重渲染，queueMicrotask 防抖合并多批记录（幂等检查防重复 mark，收敛无循环）；P2 回归锁——新增时序测试（MutationObserver 真实记录：空容器插入判定 true、层内 span 追加判定 true、无关变更 false）。A1 其余实现不变（pdfTextLocatorFromRange、pageHost mouseup 划选、renderPdfHighlights、弹层 Escape 清理）。
  verification_refs:
    - npm test -- src/reader/__tests__/pdf-annotations.test.ts (4 passed)
    - npm test -- src/reader (11 files / 94 tests passed)
    - npm test (84 files / 926 tests passed)
    - npx tsc --noEmit (clean)
  concerns: []
```
