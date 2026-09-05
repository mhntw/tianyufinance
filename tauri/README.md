# 心中有数 —— Tauri 桌面打包壳

本目录是 Tauri 桌面版打包壳，把 `rj/`（纯静态前端）打包成可安装的桌面应用。

> 📘 **要在 Windows 上打包？** 请直接看 **[`WINDOWS_BUILD.md`](WINDOWS_BUILD.md)**（准备清单、打包命令、报错处理一页通）。

## 打包机制

- **前端真源**：`rj/` 根目录（`index.html` + `css/` + `js/`），日常开发只改这里。
- **打包源 `dist/`**：每次 `tauri build` 前，由 `scripts/build-dist.mjs` 自动把最新的
  `index.html` + `css/style.css` + `js/`（排除 `.codebuddy` / `.workbuddy` / `.DS_Store`
  等残留）同步到 `dist/`。该脚本用 Node.js 实现，**跨平台通用**（Windows / macOS / Linux
  均直接可用，不依赖 `sh`/Git Bash）。
  Tauri 的 `frontendDist` 指向 `../dist`，因此安装包只包含干净的运行时文件，
  不会混入 `tools/`、`backups_*`、`src-tauri/target` 等开发/备份内容。
- **数据目录**：账套数据运行时落在**系统应用数据目录**（不是「文档」），不随安装包分发，
  安装后为全新空账套（新建账套会自动预置标准会计科目）：

  | 系统 | 路径 |
  |---|---|
  | macOS | `~/Library/Application Support/心中有数/` |
  | Windows | `%APPDATA%\心中有数\`（`C:\Users\<用户>\AppData\Roaming\心中有数\`） |
  | Linux | `~/.local/share/心中有数/` |

  目录结构：`books/`（账套）、`backups/`（自动备份 + 恢复前快照）、`trash/`（删除的账套，保留 7 天）、
  `exports/`（手动导出）、`attachments/`（凭证附件）、`changelog.json`、`meta.json`。

  > **为什么不用「文档」目录**：macOS「桌面与文档文件夹」同步、Windows OneDrive「已知文件夹移动」
  > 都会把整个 Documents 搬到云端，且从软件界面看不出来。除隐私外，更严重的是多设备同时读写
  > 会产生冲突副本——看到的账可能来自未知版本。改动集中在 `src/lib.rs` 的 `data_root()`，
  > 已有单测 `data_root_is_outside_document_dir` 守住这条线。

## 如何打包

```bash
cd tauri
npm install        # 首次：安装 @tauri-apps/cli
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`（macOS：`.app` + `.dmg`；Windows：`.exe`/`.msi` 等）。

## 注意事项

- **不要手动改 `dist/`**——它由脚本每次重建，手动改会在下次打包时被覆盖。
- 开发期验证可直接用 `npm run tauri dev`（会起本地静态服务 + 打开调试窗口）。
- 打包 Windows 安装包需在 Windows 环境（或用 CI 交叉编译）执行 `tauri build`，详见
  [`WINDOWS_BUILD.md`](WINDOWS_BUILD.md)。

