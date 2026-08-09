# Execution Plan

```yaml
format: execution_plan
tasks:
  - id: T1
    goal: "Default immersive shell collapses both menu and tab chrome; tabs share ChromeSurface with hover/hold reveal and CSS parity to menu."
    depends_on: []
    covers: [R2, R3]
    scope:
      - src/ui/chrome-controller.ts
      - src/ui/app-shell.ts
      - src/ui/theme.css
      - src/ui/__tests__/chrome-controller.test.ts
      - src/ui/__tests__/app-shell.test.ts
    outcomes:
      - ChromeSurface includes menu and tabs; both default revealed=false with shared leave delay/hold semantics.
      - App shell renders a tabs trigger and applies is-tabs-revealed (or equivalent single class) so #lightink-tabbar is collapsed by default and expandable without layout thrash.
      - Menu chrome keeps existing trigger/hold/Alt+M paths; tab context-menu open holds tabs surface open.
      - Unit/integration tests cover dual-surface controller behavior and shell class sync for tabs/menu reveal.
    verify:
      - npm test -- src/ui/__tests__/chrome-controller.test.ts src/ui/__tests__/app-shell.test.ts
    test: extend
  - id: T2
    goal: "Users can switch/close tabs and know active document identity without a permanently visible tab bar."
    depends_on: [T1]
    covers: [R1, R3, R6]
    scope:
      - src/ui/shortcuts.ts
      - src/ui/help-cheatsheet.ts
      - src/main.ts
      - src/ui/__tests__/shortcuts.test.ts
      - src/ui/__tests__/help-cheatsheet.test.ts
    outcomes:
      - Shortcut registry exposes toggle-tabs-chrome (Alt+T or chosen non-conflicting binding), next/prev tab chords, and cheatsheet/labels list them.
      - main wires tab chrome toggle and tab cycling; cycling works while tab bar is collapsed.
      - document.title tracks active tab title and dirty marker; optional minimal collapsed identity does not reintroduce a full always-on tab strip.
      - Dirty close still uses existing three-way confirm; no new library/workspace UI.
    verify:
      - npm test -- src/ui/__tests__/shortcuts.test.ts src/ui/__tests__/help-cheatsheet.test.ts src/tabs/__tests__/tab-manager.test.ts
    test: extend
  - id: T3
    goal: "Writing micro-interaction main paths remain reachable and non-blocking under the immersive shell."
    depends_on: [T1]
    covers: [R4]
    scope:
      - src/main.ts
      - src/tabs/tab-manager.ts
      - src/outline/outline-view.ts
      - src/editor/plugins/slash-menu.ts
      - src/editor/plugins/format-toolbar.ts
      - src/ui/theme.css
      - src/editor/plugins/__tests__/slash-menu.test.ts
      - src/editor/plugins/__tests__/format-toolbar.test.ts
      - src/outline/__tests__/outline-view.test.ts
      - src/editor/__tests__/source-mode.test.ts
    outcomes:
      - New/welcome tab path focuses the active editor host so typing can start without hunting for focus.
      - Slash menu, format toolbar, source mode, outline toggle/jump, image insert, export, and theme toggle remain reachable from immersive defaults.
      - Overlays dismiss on blur/empty selection and do not permanently cover the caret line; source-mode outline jump does not crash.
      - No block-engine or data-block-id wiring changes.
    verify:
      - npm test -- src/editor/plugins/__tests__/slash-menu.test.ts src/editor/plugins/__tests__/format-toolbar.test.ts src/outline/__tests__/outline-view.test.ts src/editor/__tests__/source-mode.test.ts src/tabs/__tests__/tab-manager.test.ts
    test: extend
  - id: T4
    goal: "Shell, overlays, and dialogs share token-driven visual language with predictable hover/focus/dirty feedback in light and dark themes."
    depends_on: [T1]
    covers: [R5]
    scope:
      - src/theme/tokens.css
      - src/ui/theme.css
      - src/ui/app-shell.ts
      - src/theme/__tests__/tokens.test.ts
      - src/theme/__tests__/theme-service.test.ts
    outcomes:
      - Menu, tabs chrome, dialogs, outline, slash/format overlays consume --lightink-* without a second palette; major hard-coded rgba overlays/shadows moved to tokens where practical.
      - Dirty/active/hover/focus-visible states are visually distinct on tabs and primary chrome controls.
      - warm-light and dark remain coherent; no new library/sync/AI chrome styling.
    verify:
      - npm test -- src/theme/__tests__/tokens.test.ts src/theme/__tests__/theme-service.test.ts src/ui/__tests__/app-shell.test.ts
    test: extend
delivery_verification:
  unit:
    # Isolated delivery checkout has no node_modules; install from lockfile first.
    # Windows PowerShell lacks && chaining in older hosts — use cmd /c.
    # CI/NO_COLOR avoid ANSI escapes that break YAML report encoding.
    command: cmd /c "set CI=1&& set NO_COLOR=1&& set FORCE_COLOR=0&& npm ci && npm test -- --no-color"
  typecheck_build:
    command: cmd /c "set CI=1&& set NO_COLOR=1&& set FORCE_COLOR=0&& npm ci && npm run build"
```
