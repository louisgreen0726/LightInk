# Exploration

```yaml
format: exploration
summary: "Menu chrome already immersive (reveal/hold/Alt+M); tab bar always-on with no hide path; writing micro-interactions and theme tokens exist; product stays local multi-tab single-file with no library/sync/AI. Gaps: tab collapse, chrome integration tests, block-level data-block-id wiring, window title identity, visual polish consistency."
```

## 范围与锚点

- 需求：`docs/requirements/2026-08-09-immersive-writing-ux-redesign.md`（R1–R6）
- 证据来自 5 个互斥 exploration sections：immersive chrome / tabs collapse / writing experience / theme visual / product bounds

## 现状证据

### 产品定位与边界（R1 / R6）

- 对外定位已是**本地、轻量、极简 Markdown 写作**，非笔记库/协作/AI（`README.md` 能力清单；`package.json` 无协作/AI/云 SDK）。
- UI 菜单仅为 文件/编辑/插入/视图/帮助；无建库、云同步、协作、AI、移动端主路径（`src/ui/app-shell.ts` `buildMenus`；`src/main.ts` 快捷键标签）。
- 文件模型：**多标签 + 单文件打开**（`showOpenDialog` `multiple:false` `directory:false`；`TabManager` 按路径去重），非库级工作台；无 folder browser / vault / file-tree。
- Tauri 能力仅 `core/dialog/event` 默认集；invoke 面为本地读写、快照、assets、导出、opener/reveal；无 http/账号/云同步（`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`、`Cargo.toml`）。
- 启动无参时 `newTab('# 轻墨…开始书写。')`，打开/新建后直接写作路径成立。

### 默认沉浸外壳 / 菜单 chrome（R2）

- **菜单 chrome 默认隐藏（editor-first）**，非常驻。
- 装配：`main.ts` → `createAppShell`；DOM 为 `#lightink-chrome-host`（trigger + toolbar）+ tabbar + main（outline + editor）；root 加 `lightink-immersive`。
- 状态机：`createChromeController`（`src/ui/chrome-controller.ts`），`ChromeSurface = 'menu'`；`reveal/dismiss/toggle/setHold/pointerEnter/pointerLeave`；leave 延迟默认 **180ms**；hold 时不收起。
- 触发路径：顶部 6px `#lightink-menu-trigger` 悬停/点击；toolbar 指针进出；菜单打开 hold；快捷键 **`Alt+M`** → `toggleMenuChrome`；`revealMenu()` 可强制 reveal 并打开文件菜单。
- 显示态：`chromeHost` 的 `is-menu-revealed` + CSS 折叠 toolbar（`max-height/opacity/pointer-events`，约 120ms 过渡，`src/ui/theme.css`）。
- 文件操作：新建/打开/保存/另存为有菜单 + 快捷键；导出 HTML/PDF **仅菜单**（无快捷键）。

### 多标签默认收起（R3）

- 建模 owner：`TabManager`（`tabs: TabState[]` + `activeId`）；每标签独立 editor/host。
- 渲染：`onTabsChanged → shell.renderTabBar`；`.lightink-tab` / `.active`；脏标记为文案 `● title`（无独立 dirty CSS）。
- **标签栏默认且常驻可见**：`#lightink-tabbar` 是 chrome host 的兄弟节点，`display:flex` 始终横排；**不参与** immersive reveal。
- **无** 标签栏 hide/fade class、tab 专用快捷键、已打开列表弹层、tab chrome surface。
- 关闭：`×` / 右键关闭；`dirty` 时应用内三选一确认（保存/不保存/取消）仍可用。
- 活动身份：标签文案（文件名/`未命名-n`）；路径仅右键复制/资源管理器显示；**前端未同步** `document.title` / 原生窗口标题。

### 写作体验层（R4）

| 能力 | Owner / 入口 | 要点 |
|---|---|---|
| 斜杠插入 | `slashMenuPlugin` + `INSERT_ELEMENTS` | 行首 `/` 查询；与插入菜单同源；菜单插入 MVP 为文末追加，光标级插入靠 slash `replaceRange` |
| 选区格式条 | `formatToolbarPlugin` | 非空选区 fixed 浮层；marks：粗/斜/删除线/行内代码/链接 |
| 整窗源码 | `SourceView` + `SourceModeController` | 每标签惰性；`Ctrl+/` / 视图菜单；保存/导出/关闭前 `commitSourceMode` |
| 大纲 | `createOutlineView` + `buildOutline` | 左槽常驻可折；`Ctrl+Shift+L` / 菜单 / 折叠按钮；点击 `scrollIntoView` 到 host 内 h1–h6 |
| 图片 assets | 插入/粘贴/拖图 + `asset-service` | TabManager 注入 saver/resolver |
| 导出 | `export-service` HTML/PDF | 菜单入口；PDF 走隐藏 iframe 打印 |
| 主题切换 | `ThemeService` | `Ctrl+J` / 视图菜单 |

- 块级「进块显源」：`cursor.ts` 状态机 + `dom-events.ts` 监听已装，但全仓 **无 `data-block-id` 生产者**；`MountOptions.cursorToggle` 未消费 → 块级范式**未接到真实 DOM**。需求声明不改块编辑基本规则；此为既有缺口，非本需求必扩引擎。
- 空态：大纲/斜杠/版本历史/最近文件有文案；启动欢迎 markdown 存在；**未见** newTab 后显式 `editor.focus()`。
- 源码态下：格式条/斜杠/大纲 DOM 跳转/右键部分改道或失效（`main.ts` `inSourceMode` 分支）。

### 视觉统一与细节（R5）

- **单一 token 源** `src/theme/tokens.css`：`--lightink-*` + syntax 映射；内置 `warm-light`（默认）/ `cool-light` / `dark` / `midnight`；`ThemeService` 写 `data-theme` + localStorage；自定义主题注入 style 槽。
- **单一 UI 样式表** `src/ui/theme.css`：menu / context / format-toolbar / slash / modal / outline / tabs / chrome 均 `var(--lightink-*)`；注释声明不写死颜色。
- 状态样式：hover → accent-soft；focus-visible 部分控件；活动标签 `.active`；chrome `.is-menu-revealed`；slash/versions 左侧 inset accent；当前主题用菜单项 **disabled** 标记（无勾选图标 CSS）。
- 过渡：chrome 120ms max-height/opacity；浮层 90ms `lightink-context-menu-in`；leave 逻辑 180ms + 200ms sync。
- 小例外：多处 `box-shadow`/`modal-overlay` 使用硬编码 `rgba(0,0,0,…)`，不随 token。
- `toggle()` 仅 `warm-light` ↔ `dark`；cool-light/midnight 只能点预设。

## Owner / Consumer 与复用点

| 区域 | Owner | 主要 consumer | 可复用 |
|---|---|---|---|
| 菜单 chrome 显隐 | `chrome-controller.ts` + `app-shell.syncMenuChrome` | shortcuts `Alt+M`、menus hold、trigger 悬停 | 状态机/hold/hysteresis 可扩展 surface |
| 菜单与文件动作 | `buildMenus` + `main` actions | 用户文件路径 | 现有菜单/快捷键入口 |
| 标签状态 | `TabManager` | `renderTabBar`、outline 刷新、导出/保存 | 关闭确认与 dirty 已完整 |
| 标签 DOM | `app-shell.renderTabBar` + `theme.css` | 用户切换/关闭 | 布局上 tabBar 独立于 chrome host |
| 写作插件 | `mountEditor` 插件链 | 每标签 editor | slash/format/source/outline 能力集合已齐 |
| 主题 | `ThemeService` + tokens + theme.css | 全壳与浮层 | 统一 token 语言，打磨以 theme.css 为主 |
| 产品边界 | README / capabilities / menus | 文档与权限 | 无需新增库/同步面即可对齐 R1/R6 |

## 风险与缺口（相对 R1–R6）

1. **R3 缺口最大**：标签栏常驻，无隐藏/极淡/按需唤出路径；活动文档窗口级身份弱（无 title 同步）。
2. **R2 部分已满足**：菜单 chrome 已默认沉浸 + 多路径唤出；但 chrome **集成测试缺口**（app-shell DOM reveal、`Alt+M` handler、hold 同步）与 `lightink-immersive` 仅 class 标记、样式依赖薄。
3. **R4 能力基本齐**：沉浸壳下主路径仍可达；浮层遮挡/源码态大纲跳转/新建后焦点等体验细节待验收；块级 `data-block-id` 未接线但需求不要求改块编辑基本规则。
4. **R5 基础统一**：单 token + 单 css；细节打磨空间在硬编码阴影、dirty 纯文本、空态/过渡一致性、cool/midnight 与 toggle 语义。
5. **R1/R6 对齐良好**：无范围膨胀入口；交付需保持不引入库/同步/AI 主路径。

## 验证焦点（供后续 plan/execution）

- 默认首屏：编辑区主导；菜单折叠；（目标）标签栏不常驻抢注意力。
- 约定唤出：菜单至少悬停/Alt+M；标签切换/关闭/身份感知在收起模型下仍可达。
- 文件主路径：新建/打开/保存/导出在沉浸布局下可完成；未保存关闭三选一仍可用。
- 写作层：连续输入、slash 一类元素、格式条、源码往返、大纲跳转、插图、导出、主题切换。
- 视觉：至少 warm-light + dark 下 chrome/浮层/标签/对话框无两套风格；hover/focus/危险确认可预期；无布局跳动/焦点陷阱级问题。
- 回归：`chrome-controller`、`tab-manager`、slash/format/source/outline、theme-service 既有单测；补 chrome/tab 布局集成与收起路径测试。

## Unknowns（交 plan，不阻塞探索关闭）

- `revealMenu()` 是否用于 first-run/引导（定义存在，`main` 未调用）。
- 标签栏是否与 menu 同构扩展 `ChromeSurface`，或独立 tab reveal/list UI（实现选型属 solution）。
- 原生窗口标题是否在 Tauri 配置层固定；前端未写动态 `setTitle`。
- 生产 WebView 新建后是否隐式聚焦编辑区。
- KaTeX 等第三方 CSS 对视觉一致性的影响（未深读 math/export 全链）。
- 块级 `data-block-id` 是否存在运行时非 `src/` 注入（静态检索无生产者）。

## Covered sections

- `sec-immersive-chrome`
- `sec-tabs-collapse`
- `sec-writing-experience`
- `sec-theme-visual`
- `sec-product-bounds`

## Evidence refs（精选）

- `src/ui/app-shell.ts` — shell 装配、`buildMenus`、`renderTabBar`、`syncMenuChrome`/`revealMenu`/`toggleMenuChrome`
- `src/ui/chrome-controller.ts` — menu surface 状态机
- `src/ui/theme.css` — chrome 折叠、tabs、浮层、outline、modal
- `src/ui/shortcuts.ts` — `Alt+M`、`Ctrl+/`、`Ctrl+Shift+L`、`Ctrl+J` 等
- `src/main.ts` — 装配、文件/导出/主题/源码/大纲接线、bootstrap 欢迎页
- `src/tabs/tab-manager.ts` + `src/tabs/types.ts` — 多标签 owner
- `src/editor/index.ts` + `plugins/slash-menu.ts` + `plugins/format-toolbar.ts` + `source-view.ts` + `cursor.ts`/`dom-events.ts`
- `src/outline/outline-view.ts` + `outline-model.ts`
- `src/theme/tokens.css` + `theme-service.ts`
- `src/file/file-dialog.ts` + `src/export/export-service.ts` + `src/asset/asset-service.ts`
- `src-tauri/capabilities/default.json` + `src-tauri/src/lib.rs`
- `README.md` + `docs/requirements/2026-08-09-immersive-writing-ux-redesign.md`
- 测试：`src/ui/__tests__/chrome-controller.test.ts`、`app-shell.test.ts`、`shortcuts.test.ts`；`src/tabs/__tests__/tab-manager.test.ts`；editor/outline/theme 相关 `__tests__`
