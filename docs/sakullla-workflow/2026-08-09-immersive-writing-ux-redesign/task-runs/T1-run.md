# Task T1

## Attempt History

```yaml
format: task_attempt_history
task_id: T1
attempts:
  - attempt_id: T1-A1-3a944d223170b602
    baseline_ref: 2e122891ba7e135d276ec6d4f9bf529bcef16ec4
    checkpoint_ref: 3939601a7da07f4a9879e75646f8fb7aa49c73ae
    execution:
      outcome: completed
      summary: Extended ChromeSurface to menu|tabs; shell collapses both by default with tabs trigger/hold/class sync; CSS parity; controller and app-shell tests pass.
      verification_refs:
        - npm test -- src/ui/__tests__/chrome-controller.test.ts src/ui/__tests__/app-shell.test.ts (19 passed)
      concerns: []
    review:
      decision: changes_requested
      summary: Task review completed with 1 finding(s)
      findings:
        - "P1: src/ui/app-shell.ts tabBar contextmenu hold is set true but not released when the tab context menu closes via item click (or Esc while event target remains inside #lightink-tabbar); createContextMenu closes independently, so chrome.setHold('tabs') stays true, dismiss/toggle cannot hide tabs, and immersive collapse regresses after one right-click action. Wire hold release to the context-menu close lifecycle (e.g. main/shell setTabsHold(false) from createContextMenu close, or observe menu removal) and drop the target-in-tabBar early-return on Escape release."
      review_base_ref: 2e122891ba7e135d276ec6d4f9bf529bcef16ec4
      checkpoint_ref: 3939601a7da07f4a9879e75646f8fb7aa49c73ae
  - attempt_id: T1-A2-2b55354e37ca27c5
    baseline_ref: 3939601a7da07f4a9879e75646f8fb7aa49c73ae
    checkpoint_ref: 9415074bd49200b9fb06b5188aebd3d0380defff
    execution:
      outcome: completed
      summary: "Fixed P1: createContextMenu onClose releases tabs hold from main; removed unreliable app-shell contextmenu hold listeners; onClose once-only test added."
      verification_refs:
        - npm test -- src/ui/__tests__/chrome-controller.test.ts src/ui/__tests__/app-shell.test.ts src/ui/__tests__/context-menu.test.ts (29 passed)
      concerns: []
    review:
      decision: changes_requested
      summary: Task review completed with 1 finding(s)
      findings:
        - "P1: src/ui/app-shell.ts hold-release does not schedule delayed DOM resync after chrome-controller leave hysteresis. setTabsHold(false) (and menu onOpenChange → setHold(false)) only syncs immediately while state.revealed is still true; setHold(false) then scheduleLeave flips revealed=false ~180ms later with no syncTabsChrome/syncMenuChrome. After tab context-menu onClose (main showTabContextMenu) or menu close while pointer already left the surface, is-tabs-revealed / is-menu-revealed can stick so immersive collapse fails. Mirror the pointerleave path: on hold release schedule afterLeaveSync(sync) (or equivalent) so class state follows the leave timer."
      review_base_ref: 2e122891ba7e135d276ec6d4f9bf529bcef16ec4
      checkpoint_ref: 9415074bd49200b9fb06b5188aebd3d0380defff
  - attempt_id: T1-A3-344eefd8f8f754e9
    baseline_ref: 9415074bd49200b9fb06b5188aebd3d0380defff
    checkpoint_ref: b587777607b2845fd4d26741c04e65c03db2e2f9
    execution:
      outcome: completed
      summary: On hold release (menu onOpenChange false and setTabsHold false), schedule afterLeaveSync so is-*-revealed clears after chrome leave hysteresis.
      verification_refs:
        - npm test -- src/ui/__tests__/chrome-controller.test.ts src/ui/__tests__/app-shell.test.ts src/ui/__tests__/context-menu.test.ts (29 passed)
      concerns: []
    review:
      decision: passed
      summary: Task review completed with 0 finding(s)
      findings: []
      review_base_ref: 2e122891ba7e135d276ec6d4f9bf529bcef16ec4
      checkpoint_ref: b587777607b2845fd4d26741c04e65c03db2e2f9
```

## Execution

```yaml
format: task_run
task_id: T1
execution:
  # allowed: blocked|completed|completed_with_concerns|needs_context
  outcome: completed
  summary: On hold release (menu onOpenChange false and setTabsHold false), schedule afterLeaveSync so is-*-revealed clears after chrome leave hysteresis.
  verification_refs:
    - npm test -- src/ui/__tests__/chrome-controller.test.ts src/ui/__tests__/app-shell.test.ts src/ui/__tests__/context-menu.test.ts (29 passed)
  concerns: []
```
