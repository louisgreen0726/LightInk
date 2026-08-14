# Task T1

## Attempt History

```yaml
format: task_attempt_history
task_id: T1
history_ref: evidence/history/sha256-24cf341b047d4c091a8004cdcce4fd0c2f99fb70fd598e85956a989d754bdd8d.json
history_count: 1
```

## Execution

```yaml
format: task_run
task_id: T1
execution:
  # allowed: blocked|completed|completed_with_concerns|needs_context
  outcome: completed
  summary: renderSlot 在 canvas 渲染成功后于同 slot 叠加 pdfjs TextLayer 文本层（CSS 尺寸 viewport + --total-scale-factor/--scale-round-x/y 约定），clearSlot/onAbort/destroy 时随 canvas cancel/回收，缩放走现有 rerender 全量重建；渲染失败降级移除容器不阻断阅读；reader.css 新增文本层样式（透明 span 百分比定位、::selection 用 --lightink-annotation 令牌）；lifecycle 测试新增 3 例（CSS-scale viewport 与容器挂载、in-flight cancel on teardown、失败降级保留 canvas），原 2 例不变。真实 PDF 的选区对齐/缩放重建/扫描件行为留手工验证（node 测试无 pdf 样本，01-S1 约定）。
  verification_refs:
    - npm test -- src/reader/__tests__/pdf-render-lifecycle.test.ts (5 passed)
    - npm test -- src/reader (10 files / 77 tests passed)
    - npx tsc --noEmit (clean)
  concerns: []
```
