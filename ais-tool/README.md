# 金蝶 .ais 账套转换工具（浏览器版）

把金蝶「账套文件 (.ais)」转换成本软件使用的账套 (.json)。**纯前端、离线可用**：
.ais 只在你的浏览器内存里解析，结果经浏览器下载到本地，**不上传任何服务器、不发任何网络请求**。

本目录既是转换器的**唯一真源**，也是它的**部署根**——改完转换器，在同目录 `bash deploy.sh`
即可上线，没有第二个文件夹需要同步。

## 怎么用

1. 双击 `index.html`（或本地调试用 `启动.command` 起一个静态服务器后访问）；
2. 选 `.ais` 文件（选多个同店不同年份的文件可合并为一个连续多年账套）；
3. 先看预览（借贷不平几张、科目去重几个、跨年校验等），有问题先核对源账套；
4. 点「下载账套 .json」，得到一个 `.json` 文件；
5. 打开财务软件 →「设置」→「账套管理」→「导入账套」，选这个文件。

## 这跟桌面软件的关系

桌面软件（`ty/`）**不再内置** .ais 导入：拆分后它只导入 `.json`。本目录就是那个被拆出来的
转换器。仓库内 `tools/` 下有一整套 `verify_import_*` 测试守护它的解析契约（见下）。

## 本地调试

```bash
python3 serve.py          # 或双击 启动.command
# 浏览器打开 http://localhost:8765
```

或直接双击 `index.html`（`file://` 也能用，无需服务器）。

## 部署到 CloudBase 静态托管

```bash
bash deploy.sh            # 需先 npm install -g @cloudbase/cli 并 tcb login
```

`deploy.sh` 做了什么：把本目录拷到临时副本 → 给静态资源加 `?v=<时间戳>`（破除 CloudBase 的
一年强缓存）→ 用 `.gitignore` 排除本地专用文件后 `tcb hosting deploy` 上传 → 清理云端旧
云应用残留。**源文件保持无 `?v=`，所以 `file://` 双击不受影响。**

> 缓存说明：CloudBase 对 js/css 下发 `max-age=31536000`（一年强缓存），靠 `?v=` 变 URL 来
> 失效。任何漏写 `?v=` 的引用会被钉死在旧版（曾因此整页空白）。`tools/bump_asset_versions.py`
> 负责统一补齐，根级脚本（如 `convert.js`）也在覆盖范围内。

## 解析契约守护（在仓库根 `tools/` 下，需 Node）

```bash
node tools/verify_import_contract.js     # 主契约：导入链路不被破坏、冻结模块只减不增
node tools/run-all.js                    # 全量回归
```

## 目录结构

```
ais-tool/
├── index.html                    # 转换器入口（file:// 可双击）
├── convert.js                    # 转换主逻辑
├── js/                          # 解析链路（buffer / mdb-reader / standards / kis-import）
├── deploy.sh                    # 部署到 CloudBase（暂存自身 → 加 ?v= → 上传，不改源）
├── serve.py                     # 本地静态调试服务器（无后端）
├── tools/
│   ├── bump_asset_versions.py     # 部署前统一补 ?v= 缓存戳
│   └── cleanup_hosting.py         # 部署后清理云端旧残留
├── .gitignore                   # 部署排除规则（tools/、*.md、.codebuddy/ 等不上传）
├── README.md
└── 启动.command                 # 双击起本地服务器
```

注：旧版完整云记账应用已退役，其代码不在此处；本目录只承载"转换器在线版"这一件事。
