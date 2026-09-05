# Windows 打包手册（添钰财务管理系统）

> **日常发布请优先使用 GitHub Actions**：推 `v*` 标签即自动在云端构建 Windows
> NSIS 安装包并生成 Release（见仓库根 `README.md` 与 `.github/workflows/windows-build.yml`）。
> 本手册是「在一台全新 Windows 电脑上手动打包」的备选路径，仅供本地排查 / 离线场景使用。

## 一、前置条件（4 样缺一不可）

| 软件 | 用途 | 安装要点 |
|---|---|---|
| Rust（MSVC） | 编译桌面后端 | rustup 默认 `x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | Rust 的 MSVC 依赖 | 勾选「使用 C++ 的桌面开发」 |
| Node.js LTS | 运行 Tauri CLI 与打包前脚本 | ≥ 18 |
| WebView2 Runtime | 界面渲染 | Win10/11 自带 |

自检：`rustc --version` / `cargo --version` / `node --version` 均有版本号即可。
`link.exe 找不到` = VS Build Tools 未装好。

## 二、拷贝项目 + 安装依赖

把整个项目目录（仓库根，含 `index.html` / `css/` / `js/` 与 `tauri/`，不含 `target` /
`node_modules` 大件）拷到 Windows，例如 `D:\tianyufinance\`。然后在 `tauri/` 下执行：

```powershell
cd D:\tianyufinance\tauri
npm install        # 首次安装 @tauri-apps/cli（需联网）
```

## 三、打包

```powershell
npm run tauri build -- --bundles nsis    # 只打 NSIS(.exe)，最快最稳，无需 WiX
# 需要 .msi 时去掉 --bundles 参数（首次会联网下载 WiX，较慢）
```

产物：`tauri\src-tauri\target\release\bundle\nsis\添钰财务管理系统_<版本>_x64-setup.exe`

## 四、验证

安装后确认：桌面/开始菜单出现「添钰财务管理系统」；打开应用能新建账套、录凭证、
结转、导出；把 Mac 端导出的账套 `.json` 拷入导入，确认数据互通。

## 五、常见问题

- **中文名会不会影响打包？** 不会，Tauri NSIS/WiX 均 Unicode 原生支持。
- **数据存在哪？** 系统应用数据目录：`%APPDATA%\添钰财务\`
  （`C:\Users\<用户>\AppData\Roaming\添钰财务\`），内含 `books/`（账套）、`backups/`（自动备份）、
  `trash/`、`exports/`、`attachments/` 等。软件内「打开数据目录」可直接定位。
  该目录名是固定锚点，请勿手动改名（否则软件找不到账套）。
- **不要放进云同步盘**：别把数据目录挪进 OneDrive/网盘，多设备同时读写会产生冲突副本。
- **Mac 与 Windows 包内容一致吗？** 同一份源码，功能一致；账套文件格式互通。
