# Task T6

## Attempt History

```yaml
format: task_attempt_history
task_id: T6
history_ref: evidence/history/sha256-ee73738533a3b8049f95e7cc7371c4c6e1f5227a06c3b88feaaa990cd5299bb5.json
history_count: 3
```

## Execution

```yaml
format: task_run
task_id: T6
execution:
  # allowed: blocked|completed|completed_with_concerns|needs_context
  outcome: completed
  summary: A3 修复 A2 审查全部 4 条 findings：P1 回吸——renderPdfSearchMarks 增加 scrollToCurrent 参数（runPdfSearch/jumpToPdfMatch 激活时 true，observer 驱动路径默认 false 不滚动）；P2 截断定格——包裹前 textLengthOf(layer) 小于 match.end 则 continue（等 observer 后续批次重试，避免部分包裹被 key 戳记定格）；P2 测试缺口——新增 4 例（key 戳记幂等不嵌套 + textLengthOf、容器级 Escape 含按钮焦点、输入框 Enter 派发导航/按钮 Enter 不双触发、setStatus 空态与计数）；P3 代际——runPdfSearch 入口即 ++searchGeneration，定时器内复用该代际。
  verification_refs:
    - npm test -- src/reader/__tests__/pdf-search.test.ts (11 passed)
    - npm test -- src/reader (12 files / 105 tests passed)
    - npm test (85 files / 937 tests passed)
    - npx tsc --noEmit (clean)
    - npm run build (生产构建通过)
  concerns: []
```
