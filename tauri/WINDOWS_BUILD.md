# Windows 打包手册（添钰财务管理系统）

> **日常发布请优先使用 GitHub Actions**：推 `v*` 标签即自动出 NSIS 安装包（见根 `README.md`）。
> 本手册是「在一台全新 Windows 电脑上手动打包」的备选路径。
> 早期文案中的「心中有数」为本软件旧名，现统一品牌为**添钰财务管理系统**；
> 数据目录固定名 `心中有数` 与品牌无关、切勿改动（详见 `tauri/README.md`）。
> 前端源在仓库根（`index.html`/`css/`/`js/`），打包壳在 `tauri/`，下文按此结构操作。

> 目标：在一台全新的 Windows 电脑上，一次成功打包出桌面安装包。
> 本手册面向**没有在 Windows 上跑过 Tauri 的开发者**，照此操作即可。

软件本体（前端 + Rust 后端）在 Mac 上写完即可，**无需改任何代码**，把整个
项目目录拷到 Windows 后按本手册执行。打包机制、数据目录、跨平台一致性等说明见
`README.md`。

---

## 一、你需要准备的 4 样东西（缺一不可）

| 序号 | 软件 | 作用 | 安装要点 |
|---|---|---|---|
| 1 | **Rust（MSVC 工具链）** | 编译桌面应用后端 | 装 [rustup](https://rustup.rs)，安装时选默认，工具链应为 `x86_64-pc-windows-msvc` |
| 2 | **Visual Studio Build Tools（C++）** | Rust 的 MSVC 编译器依赖 | 装 [VS Build Tools](https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/)，勾选 **“使用 C++ 的桌面开发”** 工作负载 |
| 3 | **Node.js LTS** | 运行 Tauri CLI 与打包前脚本 | 装 [Node.js LTS](https://nodejs.org/)（≥ 18 即可） |
| 4 | **WebView2 Runtime** | 渲染界面（相当于 Windows 内置的浏览器内核） | **Win10 / Win11 自带**；老系统若无，Tauri 会在首次运行时提示/自动装 |

### 快速自检清单
装完后在 **PowerShell** 里逐条执行，确认全部有版本号返回才算齐：

```powershell
rustc --version                      # 例如 rustc 1.9x.x
cargo --version                      # 例如 cargo 1.9x.x
node --version                       # 例如 v20.x / v22.x
npm --version
```

> ⚠️ 如果 `rustc` 报错“link.exe 找不到”或“MSVC 未安装”，说明 **VS Build Tools 没装好**，
> 重装并确认勾选了“使用 C++ 的桌面开发”。

---

## 二、拷贝项目 + 安装依赖

把整个项目目录（含 `rj/`、`tauri/`，**不含**各平台的 `target`/`node_modules` 大件）拷到
Windows 的某个路径，例如 `D:\心中有数\`。然后在 `tauri/` 目录打开 PowerShell：

```powershell
cd D:\心中有数\tauri
npm install        # 首次：安装 @tauri-apps/cli（会联网）
```

---

## 三、执行打包

**首选命令（只打 exe 安装包，最快最稳，无需 WiX/MSI）：**

```powershell
npm run tauri build -- --bundles nsis
```

产物：`tauri\src-tauri\target\release\bundle\nsis\心中有数_1.0.0_x64-setup.exe`

**若要同时生成 .msi（需联网下 WiX，首次较慢）：**
```powershell
npm run tauri build              # 等效于完整 targets: all
```

> ⚠️ **首次 build 会联网下载 NSIS（以及 MSI 用的 WiX）工具**，请保证网络通畅；
> 之后更新只需正常执行，工具已缓存无需再下。

---

## 四、打包成功的判断与验证

**成功标志：** 终端出现类似 `Finished 2 bundles at: ...` 或 `bundle` 目录下出现
`.exe` 文件，即为成功。常见报错与处置见下表：

| 现象 | 原因 | 处理 |
|---|---|---|
| `'sh' 不是内部或外部命令` / `sh: command not found` | 用了旧版 `build-dist.sh` | 已换成 Node 脚本，确认 `beforeBuildCommand` 为 `node scripts/build-dist.mjs`（本项目已配置，不会出现） |
| 卡在下载 NSIS / WiX | 首次联网下载 | 等它下完即可；或走 `--bundles nsis` 少下 WiX |
| `link.exe` / MSVC 相关报错 | VS Build Tools 缺失 | 重装并勾选“使用 C++ 的桌面开发” |
| 中文名乱码 | 系统区域设置较旧 | Win10/11 中文版/UTF-8 正常；极罕见，可先忽略 |

**安装后验证（应与 Mac 一致）：**
1. 双击安装包 → 安装 → 桌面/开始菜单出现「心中有数」
2. 打开应用 → 首页左上角 logo「心中有数」
3. 新建账套 → 录凭证 → 结转 → 导出 Excel/备份，确认都正常
4. 把 Mac 上导出的账套 `.json` 拷进来导入/打开，确认数据互通

---

## 五、常见担忧（已核实，可放心）

- **中文产品名会影响打包吗？** 不会。Tauri 的 NSIS/WiX 都是 Unicode 版，原生支持「心中有数」。
- **中文会影响数据存储/导出吗？** 不会。数据目录 `%APPDATA%\心中有数\`（`C:\Users\<用户>\AppData\Roaming\心中有数\`）、
  导出文件名含中文，均走系统 Unicode 路径，现代 Windows 原生支持。
- **数据在 `%APPDATA%` 里，用户要手动拷贝账套方便吗？** 软件内「打开数据目录」按钮会直接
  打开该路径（走 Rust 的 `open_in_explorer`），日常无需手动找。少数需要手动翻的场景：
  在资源管理器地址栏输入 `%APPDATA%` 回车，再进 `心中有数` 文件夹。
  > 注意：不要手动把数据目录挪进 OneDrive/网盘——多设备同时读写会产生冲突副本，
  > 看到的账可能不是你以为的那个版本。
- **Mac 和 Windows 打出的软件内容一致吗？** 一致。用同一份前端 + Rust 源（无平台分叉），
  仅二进制与安装包格式不同，属于正常。
