# Technical Solution

```yaml
format: solution
summary: "Extend existing menu chrome controller to tabs (default collapsed, hover/hotkey reveal), keep local multi-tab single-file shell, polish writing overlays and token-based visuals; no library/sync/AI or block-engine rewrite."
```

## Goals

- 默认沉浸：首屏以编辑区为主；菜单栏与标签栏均不常驻抢注意力。
- 按需完整 chrome：用户可通过约定路径唤出菜单与标签，完成文件/标签/视图操作后收回。
- 写作体验层在沉浸壳下完整可达且细节统一（slash、格式条、源码、大纲、空态、反馈）。
- 视觉语言继续收敛在现有 token + `theme.css`，浅色/深色无明显两套风格。
- 产品边界保持本地纯写作多标签单文件；不引入库/同步/协作/AI。

## Non-goals

- 笔记库、文件夹工作台、库级搜索/标签体系（R6）。
- 云同步、多端协作、账号体系、AI 写作助手（R6）。
- 移动端/Web 托管交付、非 Markdown 主格式（R6）。
- 重做 Milkdown/块模型/解析规则；不接线既有未完成的块级 `data-block-id` 进源范式（R4 明确不改块编辑基本规则）。
- 为导出单独新增快捷键体系（可保留菜单-only；非本方案必达）。
- 跟系统主题自动切换、重做 cool/midnight 与 toggle 语义（保持现有 ThemeService 行为，仅视觉打磨）。

## Requirement coverage

| ID | 方案落点 |
|---|---|
| R1 | 保持启动欢迎页/直接写作；菜单与文案不引导建库；窗口级文档身份补齐以强化「当前在写什么」 |
| R2 | 复用并巩固已有 menu chrome（trigger / hold / Alt+M）；补集成测试与过渡稳定性 |
| R3 | 标签栏纳入 chrome surface，默认折叠；悬停/快捷键/必要时列表路径切换与关闭；dirty 关闭确认不变 |
| R4 | 不改编辑引擎；在沉浸布局下保证 slash/格式条/源码/大纲/插图/导出/主题主路径；修焦点与浮层遮挡类体验问题 |
| R5 | 统一 token 消费、状态反馈、空态与过渡；至少 warm-light + dark 验收 |
| R6 | 不新增排除能力入口；capabilities/菜单保持本地文件面 |

## Architecture decisions

### 1. Chrome 统一状态机，扩展 surface（事实 owner）

**Owner：** `src/ui/chrome-controller.ts`  
**Consumer：** `src/ui/app-shell.ts`（DOM class / 同步）、`src/main.ts`（快捷键）、`src/ui/menus.ts`（hold）

- 将 `ChromeSurface` 从 `'menu'` 扩展为 **`'menu' | 'tabs'`**（或等价联合类型），复用既有 `reveal/dismiss/toggle/setHold/pointerEnter/pointerLeave` 与 leave 迟滞（默认 180ms）。
- **不**新建第二套显隐控制器；菜单与标签共享 hold/hysteresis 语义，避免两套抖动模型。
- DOM 仍由 app-shell 应用 class：
  - 菜单：既有 `is-menu-revealed` on `#lightink-chrome-host` / toolbar 折叠规则。
  - 标签：新增 `is-tabs-revealed`（命名可微调，唯一事实在 shell 同步函数）驱动 `#lightink-tabbar` 折叠/展开。
- 默认 `revealed=false` for both；启动与新会话首屏编辑区主导。

### 2. 标签栏默认收起与唤出路径（R3）

**Owner：** `app-shell` 布局 + tabbar 同步；**状态仍归** `TabManager`（tabs/active/dirty 不变）。

布局调整原则：

- `#lightink-tabbar` 继续由 `renderTabBar` 重绘内容，但**默认视觉折叠**（高度/opacity/pointer-events 与菜单同类过渡，约 120ms，token 色）。
- 提供**稳定触发区**（例如 chrome 带下方或主区顶缘细条 `#lightink-tabs-trigger`），pointer enter → `chrome.reveal('tabs')`；leave 走 controller 迟滞；在 tab 上打开 context menu 期间 `setHold('tabs', true)`。
- **快捷键**（接入 `shortcuts.ts` + `main.ts` handlers，并进入帮助速查）：
  - 切换标签栏显隐：建议 `Alt+T`（与 `Alt+M` 对称；若冲突再在实现中改绑定但保持单一可发现入口）。
  - 标签切换：至少 `Ctrl+Tab` / `Ctrl+Shift+Tab`（或项目既有习惯键）在**不强制常显标签栏**时仍可切换活动文档。
  - 关闭当前标签：保持现有关闭路径（标签内 × 在 reveal 后可用 + 如已有/可补快捷键则一并登记到 cheatsheet）。
- **活动文档身份**（无库级 UI）：
  - 在 `onTabsChanged` / 切换/脏标记变化时同步 **`document.title`** 为 `〔● 〕标题 — 轻墨 LightInk`（或等价）；路径级信息仍可通过右键复制/reveal 获得。
  - 可选极轻量：折叠态顶缘或状态区显示当前标题截断（若实现成本低且不破坏沉浸）；**不以常驻完整标签条**满足身份。
- **未保存关闭**：继续 `TabManager` + confirm dialog 三选一；收起标签栏不得绕过该路径。

不采用：应用内文件夹树、已打开文档库面板作为主方案。若需要「查看全部已打开」，优先 **reveal 标签栏**；仅当 reveal 不足以完成切换时再加轻量 popover（次选，默认不做库 UI）。

### 3. 菜单 chrome 巩固（R2）

**Owner：** 既有 menu surface 路径。

- 保留 trigger 条、toolbar 悬停、菜单 hold、`Alt+M`、`revealMenu()`（文件菜单强制打开，可供引导/帮助）。
- 修稳定性验收点：唤出/收回无持续抖动、hold 期间不误收、收回后可再次唤出、焦点不丢到无法点菜单。
- 补 **app-shell 级集成测试**（trigger / class / toggle / hold 与 DOM 同步），不仅单测 controller。

### 4. 写作体验层（R4）— 外壳可达性 + 细节，不改引擎

**Owner 边界：**

| 能力 | 事实 owner | 本方案动作 |
|---|---|---|
| slash / format toolbar | editor plugins | 保持；验收浮层不长期挡光标行；失焦关闭 |
| 整窗源码 | `SourceView` + main 每标签 map | 保持 `Ctrl+/`；commit 钩子不变 |
| 大纲 | `outline-view` | 保持可折；快捷键/菜单；源码态跳转若不可靠则降级为可理解行为（不重写引擎） |
| 插入/图片/导出/主题 | main actions + 既有 service | 沉浸壳下菜单/快捷键仍可达 |
| 新建焦点 | `TabManager.newTab` / bootstrap | 新建或欢迎页后 **显式聚焦编辑区**（一次 `focus` 到活动 host/editor），消除「看不到光标不知可否输入」 |
| 块级 data-block-id | 未接线 | **明确不做** |

### 5. 视觉统一（R5）

**Owner：** `src/theme/tokens.css`（色板）、`src/ui/theme.css`（组件状态/过渡）、少量 shell class。

- 菜单、标签触发/展开、对话框、大纲、slash/格式浮层继续只消费 `--lightink-*`。
- 将明显硬编码 `rgba` 阴影/遮罩逐步改为 token 或可随主题理解的变量（至少 modal overlay 与主要浮层阴影）。
- dirty：在标签文案 `●` 之外可加 muted/accent 语义类（仍单一 owner 在 `renderTabBar`）。
- 空态文案保持中文可理解；布局不出现空白到无法新建/打开。
- 验收主题：**warm-light + dark** 必过；cool-light/midnight 不引入第二套组件样式即可。

### 6. 产品边界（R1 / R6）

- 不改 Tauri capabilities 扩网；不改菜单信息架构加「库/同步/AI」。
- README/帮助若需一句「沉浸写作 / 按需菜单与标签」，保持本地定位措辞。

## State changes（用户可观察）

| 状态 | 默认 | 变化触发 | 收回 |
|---|---|---|---|
| 菜单 chrome | 隐藏 | 顶缘悬停/点击、Alt+M、revealMenu、菜单 hold | leave 迟滞或 toggle；hold 解除后可收 |
| 标签 chrome | 隐藏 | 标签触发区悬停、Alt+T（或选定键）、切换快捷键可先 reveal、context menu hold | 同上 |
| 活动文档身份 | 标题反映活动 tab | 切换/改名/脏标记 | — |
| 大纲 | 可折（既有） | Ctrl+Shift+L / 菜单 | 既有 |
| 源码模式 | 关 | Ctrl+/ | 再切回 |
| 主题 | 用户存储/默认 warm-light | Ctrl+J / 菜单 | — |

## 关键失败行为

| 场景 | 行为 |
|---|---|
| 指针快速划过触发区 | leave 迟滞避免闪烁；不进入「卡死展开」 |
| 下拉菜单/标签右键打开时 | hold=true，不因 pointer leave 收起 |
| 标签栏隐藏时关闭脏标签 | 仍弹出三选一；取消则保持打开 |
| 快捷键与编辑器抢键 | 捕获策略与现网一致；可编辑区常用输入优先；chrome 切换键避开打印字符 |
| 源码态大纲点击 | 不崩溃；尽量 scroll 或 no-op 且可再切回 WYSIWYG 使用 |
| 主题 token 缺失 | 回退既有 `:root` warm-light 变量 |
| reveal 后无法点击 | 视为缺陷：pointer-events 与 z-index 必须在展开态可点 |

## 删除 / 不做的过渡层

- 不保留「标签栏永久 display:flex 常显」为默认终态。
- 不引入平行 `TabChromeController` 或第二份 leave 定时逻辑。
- 不添加笔记库侧栏「以后再用」的隐藏入口。
- 不实现块级 `data-block-id` 半成品接线作为本需求交付。

## 直接使用点与衔接

- **直接使用点：** 用户打开应用 → 见编辑区为主 → 输入；需要文件操作时唤出菜单；多文档时唤出/快捷键切换标签；写作中用 slash/格式条/大纲/源码/导出。
- **衔接：**
  - `main.ts` 注册新快捷键与 title 同步。
  - `app-shell` 调整 DOM 顺序/触发条与 `syncTabsChrome`（名称示意）。
  - `theme.css` 增加 tabs 折叠规则，与 menu 规则对称。
  - `help-cheatsheet` / `SHORTCUT_LABELS` 暴露新键。
  - 测试：扩展 `chrome-controller` surface；新增 shell 集成测；tab-manager 行为回归；必要 UI 测 renderTabBar 折叠态 class。

## 机械验收（方案级）

1. 新开/打开文档后，默认无常驻重型菜单条与常驻标签条占据主纵向注意力。
2. 至少一种路径稳定唤出菜单并完成 新建/打开/保存/导出之一。
3. 至少打开两个标签后，可用约定路径切换与关闭；脏关闭仍三选一。
4. 沉浸布局下完成：输入、slash 插入一类、格式、源码往返、大纲唤出、主题切换。
5. warm-light 与 dark 下主要 chrome/浮层/对话框视觉同源（token）。
6. 自动化：相关 Vitest 通过；新增 chrome/tabs 显隐与快捷键注册断言。

## 证据依据

- 01-exploration：`docs/sakullla-workflow/2026-08-09-immersive-writing-ux-redesign/01-exploration.md`
- 代码权威：`chrome-controller.ts`、`app-shell.ts`、`theme.css`、`shortcuts.ts`、`main.ts`、`tab-manager.ts`、`theme-service.ts` / `tokens.css`
- 需求：`docs/requirements/2026-08-09-immersive-writing-ux-redesign.md`

## Unknowns resolved by this solution

| 01 unknown | 决定 |
|---|---|
| 标签栏同构 surface 还是独立 UI | **同构扩展 `ChromeSurface` + shell 同步** |
| 窗口标题 | **前端同步 `document.title`**（Tauri 跟随 webview 标题的既有行为；若平台例外再在实现中用 opener/window API 最小补丁） |
| revealMenu 用途 | **保留**作强制打开文件菜单路径；非 first-run 强制引导 |
| 新建焦点 | **显式 focus 活动编辑区** |
| data-block-id | **不做** |
| 第三方 KaTeX 等 | 不纳入本方案主路径；视觉验收以 app chrome/浮层/编辑正文 token 为准 |

## Out-of-scope leftovers（不阻塞本方案）

- 导出专用快捷键、cool-light/midnight 与 toggle 策略重做、块级进源引擎、库级已打开文档浏览器。
