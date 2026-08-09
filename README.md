# 轻墨 LightInk

一款轻量、极简的本地 Markdown 编辑器 —— Typora 式单栏所见即所得，基于 Tauri v2 + Milkdown 构建。

## 特性

- **所见即所得**：单栏渲染态编辑，光标进入元素才显示源码
- **完整语法**：标题 / 列表 / 任务列表 / 引用 / 代码块（14 种语言高亮）/ 表格 / 链接 / 图片 / 粗斜体 / 删除线 / 分隔线
- **公式与图形**：行内与块级 LaTeX（KaTeX）、mermaid 流程图/时序图，语法错误隔离显示源码
- **图片管理**：剪贴板粘贴与拖入图片自动落盘到 `assets/`，相对路径引用可随文档迁移
- **文件管理**：新建 / 打开 / 保存 / 另存为 / 多标签页 / 未保存关闭提示 / 崩溃恢复
- **导出**：独立 HTML（内嵌样式与图片）、PDF（打印管线），中文无乱码
- **主题**：默认暖色护眼浅色、深色一键切换（Ctrl+J）、自定义主题 CSS 热替换
- **大纲侧栏**：按标题层级实时生成、点击跳转、可折叠
- **轻量**：Windows 安装包约 4–5 MB（NSIS/MSI），冷启动 < 1s，KaTeX/mermaid 按需加载

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri v2（Rust + WebView2） |
| 前端 | Vite + TypeScript（严格模式，无框架） |
| 编辑器 | Milkdown v7（ProseMirror）+ commonmark/gfm 预设 |
| 高亮 | highlight.js（全量语言注册） |
| 公式 | KaTeX（懒加载 chunk） |
| 图形 | mermaid（懒加载 chunk，securityLevel: strict） |
| 测试 | Vitest（前端）+ cargo test（Rust） |

## 开发

```bash
npm install          # 安装依赖
npm run tauri:dev    # 启动开发模式（Vite dev server + 热重载）
```

> **Windows + Git Bash 用户**：npm 默认用 cmd.exe 转发脚本参数，会把 shell 路径拼进
> `npm test -- <path>` 之类的过滤参数。如遇此问题，在用户级 npmrc 固定 bash：
> `npm config set script-shell "C:\Program Files\Git\bin\bash.exe" --location=user`
> （此配置不能提交到仓库 `.npmrc`，否则 macOS/Linux 环境会因找不到该 Windows 路径而构建失败）。

常用命令：

```bash
npm run dev          # 仅前端 dev server（:1420）
npm run build        # tsc 严格检查 + vite 构建
npm test             # 前端全部测试（Vitest）
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 测试
```

## 构建与发布

### Windows（本机已验证）

```bash
npm run tauri:build
```

产物：

- `src-tauri/target/release/lightink.exe` — 免安装可执行文件
- `src-tauri/target/release/bundle/nsis/LightInk_<version>_x64-setup.exe` — NSIS 安装包（约 4.3 MB）
- `src-tauri/target/release/bundle/msi/LightInk_<version>_x64_en-US.msi` — MSI 安装包（约 5.1 MB）

### macOS / Linux

`src-tauri/tauri.conf.json` 已包含 `bundle.macOS`（minimumSystemVersion 10.15）与 `bundle.linux`（deb/appimage 依赖声明）配置，`bundle.targets` 为 `all`。推送 tag 后 GitHub Actions 会在三平台并行构建；本地手动构建需在对应平台执行 `npm run tauri:build`（Rust 不支持交叉编译 GUI 应用）。

macOS 包使用 Tauri 的显式 ad-hoc 签名（`bundle.macOS.signingIdentity: "-"`），无需 Apple 证书。CI 会用 `codesign` 校验整个 `.app` 的签名完整性，避免只依赖 Apple Silicon 链接器为单个可执行文件生成的临时签名。

ad-hoc 签名不等于 Apple 公证。从浏览器下载后，Gatekeeper 仍可能要求用户在 Finder 中右键 `LightInk.app` 选择“打开”，或前往“系统设置 → 隐私与安全性”选择“仍要打开”。只有 `Developer ID Application` 证书加 Apple 公证才能消除这一步；详见 [Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)。

### 发布流程

推送 `v*` tag 即触发 GitHub Actions 自动编译并发布三平台安装包（见 `.github/workflows/release.yml`），Release 说明从上个 tag 以来的提交记录自动提取（按 feat/fix/其他分组，基于 conventional commits）：

```bash
# 1. 升版本号（package.json 与 src-tauri/tauri.conf.json 的 version 保持一致）
# 2. 全量验证
npm test && cargo test --manifest-path src-tauri/Cargo.toml
# 3. 打 tag 并推送 —— CI 自动构建 Windows(NSIS/MSI) + macOS(DMG, Apple Silicon) + Linux(deb/AppImage)，产出草稿 Release
git tag v0.1.0 && git push origin main v0.1.0
# 4. 在 GitHub Releases 页面检查草稿，确认后发布
```

也可手动发布：本机 `npm run tauri:build` 后在 GitHub Releases 页面上传 `src-tauri/target/release/bundle/` 下的安装包。

## 项目结构

```
src/                  前端
  editor/             Milkdown 编辑器内核与插件（高亮/公式/图形/图片）
  tabs/               多标签页状态管理
  file/               文件读写与对话框流程
  asset/              图片资源服务
  outline/            大纲侧栏
  theme/              主题系统（令牌 + 服务）
  ui/                 极简外壳与快捷键
  export/             HTML/PDF 导出管线
src-tauri/            Rust 后端
  src/file.rs         原子写文件
  src/snapshot.rs     崩溃恢复快照
  src/asset.rs        图片落盘与迁移
  src/export.rs       导出图片读取
docs/sakullla-workflow/  开发过程文档（需求/方案/计划/各任务记录）
```

## 已知限制

- macOS/Linux 安装包由 GitHub Actions 在对应平台编译；macOS 包采用 ad-hoc 签名，未经过 Apple 公证，首次启动可能需要用户手动允许
- 崩溃恢复经单元测试验证逻辑（过期检测/索引/恢复流程），未做真实进程强杀的端到端验证

## License

[GPL-3.0](LICENSE)
