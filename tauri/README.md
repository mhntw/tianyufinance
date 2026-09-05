# 添钰财务管理系统 —— Tauri 桌面打包壳

本目录是桌面版打包壳（Tauri 2），把仓库根的前端（`index.html` + `css/` + `js/`）打包成可安装的桌面应用。

> **日常 Windows 打包请直接用 GitHub Actions**（推 `v*` 标签自动出 NSIS 包，见仓库根 `README.md`）。
> 需要在 Windows 本机手动打包时，参考 **[`WINDOWS_BUILD.md`](WINDOWS_BUILD.md)**。

## 打包机制

- **前端真源**：仓库根目录的 `index.html` / `css/` / `js/`，日常开发只改这里。
- **打包源 `dist/`**：每次 `tauri build` 前，由 `scripts/build-dist.mjs` 自动把最新
  `index.html` + `css/` + `js/`（排除 `.codebuddy` / `.workbuddy` / `.DS_Store` 等残留）
  同步到 `dist/`。脚本用 Node.js 实现，**跨平台通用**，不依赖 `sh`。
  Tauri 的 `frontendDist` 指向 `../dist`，安装包只包含干净的运行时文件。
- **数据目录**：账套运行时落在**系统应用数据目录**，不随安装包分发，安装后为全新空账套
  （新建账套自动预置标准会计科目）：

  | 系统 | 路径 |
  |---|---|
  | macOS | `~/Library/Application Support/添钰财务/` |
  | Windows | `%APPDATA%\添钰财务\`（`C:\Users\<用户>\AppData\Roaming\添钰财务\`） |
  | Linux | `~/.local/share/添钰财务/` |

  目录结构：`books/`（账套）、`backups/`（自动备份 + 恢复前快照）、`trash/`（删除账套，保留 7 天）、
  `exports/`（手动导出）、`attachments/`（凭证附件）、`changelog.json`、`meta.json`。

  > ⚠️ 目录名「添钰财务」是**固定定位锚点**：后端 `data_root()` 硬编码它，刻意不随
  > identifier/productName 变化，改名会让已有账套"全部消失"（有守门单测）。
  > 也绝不使用「文档」目录（云同步会制造冲突副本）。实现集中在 `src-tauri/src/lib.rs`。

## 如何打包（macOS 本机）

```bash
cd tauri
npm install        # 首次：安装 @tauri-apps/cli
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`（macOS：`.app` + `.dmg`）。

## 注意事项

- **不要手动改 `dist/`**——它每次由脚本重建，手动改会被覆盖。
- 开发期验证：`npm run tauri dev`（起本地服务 + 打开调试窗口）。
- Windows 安装包：日常由 GitHub Actions 自动构建（仓库根 `.github/workflows/windows-build.yml`，
  手动触发或推 `v*` 标签）；无需本机 Windows 环境。
