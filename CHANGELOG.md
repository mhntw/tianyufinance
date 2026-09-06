# 变更记录（Changelog）

本文件记录历次功能优化与缺陷修复，按时间倒序排列。

---

## 2026-09-06 — 备份体系重构：分层的「有意义备份」，收敛散落副本

### 设计：备份按「每一层有唯一用途」重建
- **每日快照（新增）**：每账套每天自动留 1 份（按本地日期分天），保留 31 份——
  唯一承担"退回昨天/上周"的跨天回滚通道；
- **关键节点快照**：结账 / 反结账 / 结转损益 / 年结 / 结转成本 / 计提折旧 / 恢复前 / 导入前
  统一留存，独立配额 10——原来混在高频自动备份里，会被随后几笔录入挤掉，找不到"结账前"；
- **自动备份**：20 → 10 份，定位仅为「刚改乱几笔立刻撤回」，不承担历史职责；
- **回收站**：删除账套保留 7 天（不变）。

### 清理与修复
- **移除写前 .bak1~5 滚动**：与原子写（.tmp→rename）及自动备份重复、每次保存高 I/O，
  机制废弃，存量 .bak 一次清空；
- **孤儿备份全局收敛**：启动与删除账套时执行——现役账套按各自配额不动，
  已删/换 id 账套只留最新 1 份兜底。backups/ 由 103 份收敛至 24 份并保持有界；
- **备份列表 UI 分类**：自动备份 / 关键节点快照 / 每日快照分列标注；
  修复「关键节点/每日快照无法从列表恢复」的旧缺陷（恢复改为按完整文件名取回）；
- 前端按本地日期传参，每日快照分天不再因 UTC 偏差错一天。

---

## 2026-09-05（第三轮）— 投产前审查：出纳残留清理 + 审计口径修正 + 阻塞清单落盘

投产前全局审查（目标平台 Windows + macOS）的第一轮落地，含 Phase 1「历史风险清单对账」。

### 产品决策
- **出纳板块整体下线**：UI/数据层此前已基本清理，本次清除残余——空目录 `js/pages/cashier/`、CSS 孤儿选择器 `#baGrid`。
  注意：`cashAccounts`（store.js，资金类科目 1001/1002/1012 口径）**在用于现金流量表/赤字检查，非出纳残留，未删**。
- H1 税金测算 / closedPeriods：对账确认无需删除——H1 提示文案已带「仅供提醒」；空结账期仅来自金蝶导入映射。

### 修复与修正
- `tools/_deep_audit.js`：结账期间「空结账期/跳期」仅可能来自金蝶导入闭账映射、软件自身 closePeriod 不会产生，
  第 5 段改为「导入映射特性说明」不再计 FAIL（添钰 43 PASS / 0 FAIL）。
- `tools/verify_idempotent.js` / `tools/verify_e2e_snapshot.js`：删除引用已下线 `exchangeAdjust` / `ensureBankAccounts` /
  `bankAccountsAll` / `adjustTable` 的过期断言（原运行必抛 TypeError）；e2e 脚本补 persist/addLog/backupNow no-op 杜绝写盘风险。
- `js/pages/report/Report.js`：加注释说明现金流量表「净增加额/期初/期末」行本年累计列口径——**勿单点误改**（详见 blockers M7）。

### 审查结论（详见 docs/go-live-blockers.md）
- 历史 H/L/M 逐条对账：H2/H3/M4 已修复；M1 为设计使然；M6 取数正确缺引导；M5 防呆缺失（P2）；
  **M2「本年累计缺期初累计」经产品确认不会遇上，记为已知限制（不修）**；
  绅蓝之星未分配利润勾稽 2 处差异（4719.87/2381.50）经逐月逐凭证定位（`tools/_diag_undist.js`）确认为金蝶
  「以前年度损益调整 6901 结转留存收益 + 损益跨期结转（所得税 5801）」业务特征，非引擎缺陷、非数据不平
  （借贷平衡/试算/明细账/资产负债表全 PASS）。`_deep_audit.js` 第 3 段相应改为可解释口径（差异 → 透明 WARN），
  三账套现均 0 FAIL。

### 补充（同日）：macOS 打包后「点关闭报 ACL 红字」修复
- 现象：打包版点窗口关闭报红字 `系统异常: Command plugin:window|destroy not allowed by ACL`（首页即可复现）。
- 根因：Tauri v2 capability 未授权 window 关闭/销毁命令（`core:default` 不含 `allow-destroy`）。
- 修复：`tauri/src-tauri/capabilities/default.json` 补 `core:window:allow-close`、`core:window:allow-destroy`；
  另 `js/app.js` 关闭守卫整链加异常保护（未保存询问任一环节失败即放行关闭，宁可不提示不可报错卡死）。
- 验证：mac 打包后首页直接关闭、凭证页未保存确认均正常（用户实测通过）。

### 补充（同日）：M5 防呆 + 兼容/性能验证 + M7 处置
- **M5 已修**：`updateSubject` 禁改「已有凭证/期初余额」科目的类别（新增 `_subjectUsed`，含子科目判定）。
  验证 `tools/_verify_m5.js`：未用可改、在用禁改但可改名，合成 + 添钰/绅蓝 真实账套全通过。
  `index.html` store.js 版本升至 `?v=2026090504`。
- **旧版兼容**：`tools/_verify_backcompat.js` 确认改造前无 `v.kind` 的账套/备份加载、`restoreFromData`
  恢复后均自动回填且识别分布与现版一致、不变量保持。
- **性能**：`tools/_perf_stress.js` 合成 2 万凭证，最重入口 generalLedger 217ms、其余报表/结账 <30ms；
  真实在用账套仅 1~2.5 千凭证，余量 10 倍以上。
- **M7 处置决定**：现金流量表净增加额「本年累计」列口径两难——投产前**挂起不改**（不影响数据正确性，
  已加注释防单点误改，见 blockers）。
- **运行态静态检查**：`test_stale_dom_refs`、`check_no_native_download` 通过；
  `check_no_native_dialog` 报的 `file-save-bridge.js` 2 处 `alert` 为导出结果提示的降级兜底（非业务
  确认/输入弹窗），记录不修。
- 新增工具：`_verify_m5.js` / `_verify_backcompat.js` / `_perf_stress.js` / `_diag_undist.js`（勾稽定位）。
- **`tools/import_check.js`（金蝶导入兼容性自检）**：一条命令输出 红/黄/绿 报告，覆盖借贷平衡/幽灵科目/
  科目类别vs准则模板/期初与逐月勾稽/明细账连续性/结账检查/结转识别/凭证字号。
  定位：金蝶正常账套应红灯恒 0——红=软件导入/引擎兼容缺口（报开发修复后重导，使用者零操作）；
  黄=金蝶映射说明或旧版导入器遗留。三账套试跑均红灯 0。
- **`js/kis-import.js` classify**：以前年度损益调整（6000/6901 及变体）由兜底 asset 改归 **equity**
  （权益调整科目，避免将来产生余额时污染资产负债表资产侧）——此类映射由导入器消化，不要求使用者在科目页改。
- **`tools/_verify_newbook.js`（场景 2「新建公司账套」全流程验证）**：新建→期初→7 月连续录凭证→
  逐期结转+结账→报表勾稽/反结账约束，16/16 通过。数据层两场景（导入/新建）均已自动验证。

---

## 2026-09-05（第二轮）— 系统性根治：期末业务凭证改用类型标记 `v.kind`，废弃摘要正则判定

### 背景：上一版修复只治了单点，底层是系统性缺陷
经全量勘察确认，全工程 **共 14 处**「某类期末凭证是否已存在」的判定，全部依赖凭证摘要正则
（`/结转.*损益/`、`/年度本年利润/`、`/计提.*折旧/`、`/(计提|发放).*工资/` …）。
而金蝶 KIS / Excel 导入的凭证**根本没有凭证级 `summary` 字段**（摘要只落在分录级
`entries[].summary`，见 `kis-import.js:192`），故 `re.test(v.summary || '')` 对导入凭证**恒为 false**。
除已修的结转损益外，还遗留：

| 位置 | 后果 | 等级 |
|---|---|---|
| `carryYearEnd` 幂等（纯摘要，无兜底） | 12 月可重复生成年结凭证 → 错账 | P0 |
| `Settle.js` `genOnceVoucher` 查重（纯摘要） | 附加税/所得税/增值税可重复生成 → 错账 | P0 |
| `settleChecklist` 12 月 `yearend` 项（纯摘要） | 12 月恒判「未年结」→ 结账阻塞 | P0 |
| `btnReCarryForward` 定位旧凭证（纯摘要） | 金蝶账套「重新结转」完全不可用 | P1 |
| `hasPayrollVoucher` | 双重失效（无摘要 + `v.period` 类型错误），保护从未生效 | P1 |
| 结账页/期末处理页 6 类统计与凭证号 | 恒显示「未生成 / 待结转」 | P2 |

### 更正上一版的根因描述
上一版称「3103 是 revenue cls，会被计入 totalRev，导致重复结转」——**该描述有误**。
实据：`standards.js:58/116` 与 `kis-import.js:43` 均将 3103 归为 **equity**，
`s.cls === 'revenue'` 永不命中，物理上不可能污染 totalRev。
真正的死锁成因是**两套取数口径打架**：`profitStatement` 取发生额（收入取 cr、费用取 dr，不轧差）、
`carryForwardProfit` 取轧差净额，已结转月份一个≠0、一个=0，互斥成死锁。

### 方案：以 `v.kind` 为单一事实源（禁止再新增摘要正则判定）
- **数据层**：`addVoucher` 原样保存传入对象（`store.js:1141`），故 `v.kind` 天然持久化，无需改存储。
- **生成端打标**：结转损益 / 年结 / 折旧 / 计提工资 / 发放工资 / 结转成本 / 转出增值税 / 计提附加税 / 计提所得税。
- **存量回填**：`normalizeState()` 中调用 `ensureVoucherKinds()`。选此钩点是因它是所有账套入口
  （本地加载 / 服务端加载 / 金蝶导入 / 备份恢复）的公共路径，一处覆盖全部。
- **结构识别**：按「科目角色组合」判定（经 `subjectRole()` 解析，**不硬编码费用类科目码**，两准则自动适配）。
  识别不出一律返回 `undefined`（按普通凭证处理）——宁可漏标，绝不错标。
- **同口径根治**：新增 `periodProfitNet()` 作为「是否需要结转」的唯一取数，
  `carryForwardProfit` 与 `settleChecklist` 共用，二者条件严格等价，死锁不可能再现。

### 改动文件
- `js/store.js`：新增 `VOUCHER_KINDS` / `_detectVoucherKind` / `voucherKind` / `periodVouchersOfKind` /
  `ensureVoucherKinds` / `periodProfitNet` / `carryForwardState`；改造 `carryForwardProfit`、`carryYearEnd`、
  `settleChecklist`（8 项）、`hasPayrollVoucher`、`_voucherRefs`；生成端打标 4 处。
- `js/pages/settle/Settle.js`：查重/重做/统计/凭证号全部改用 kind（`genOnceVoucher` 签名由正则改为 kind）。
- `js/pages/asset/Asset.js`：折旧凭证筛选改用 `periodVouchersOfKind`。
- 顺带修复：净额为零（收入=费用）时不再生成 0 金额的「结转本年利润」空分录。

### 验证（真实账套，只读 / 内存副本，磁盘账套未改动）
- `tools/_verify_kinds.js`（新增）：逐类型对比「结构识别 vs 旧摘要正则」——
  **漏识别 = 0（无回归）**，新增识别 **82 张**金蝶结转凭证（添钰 30 / 绅蓝 52，此前完全找不到）。
- `tools/_verify_scenarios.js`（新增）：**40 项全通过**，含此前失效的关键路径——
  金蝶已结转月「重新结转」可用（可定位并删除旧凭证后重做）、幂等拒绝提示能给出具体凭证号、
  真实未结转月（2026-08）正常结转、12 月可成功结账。
- `tools/_stability_test.js`：添钰 / 绅蓝 **各 24 PASS / 0 FAIL**。
- `tools/_diag_carryfix.js`：死锁场景全通，2025-12 提示已带凭证号（记-594、记-595）。
- `tools/_deep_audit.js`：**43 PASS / 2 FAIL**，2 个 FAIL 为既有历史数据问题
  （空结账期 2025-01/02、跳期 2025-11→2026-01），与本次改造无关，详见下一节。

### 已知行为变化
- 在金蝶账套上执行「重新结转损益」，会把金蝶原本拆分的**多张**结转凭证（如转收入、转费用各一张）
  合并生成为**本软件口径的 1 张**。净效果一致（净额归零、借贷平衡、试算平衡均已验证），符合软件既有设计。

---

## 2026-09-05 — P0 修复：金蝶导入账套「结转损益」判定误判导致结账死锁

> 注：本轮为应急止血，已于同日被上方「系统性根治」条目取代。
> 其根因描述有误已被更正（见上），其中 `hasCarryForward()` 的「净额轧平即视为已结转」判定
> 因会误锁「重新结转」入口，已由 `v.kind` 结构化判定取代。

### 问题（真实投产前审查发现）
- **根因**：金蝶 KIS 结转账凭证的**分录级摘要 FExp 为空**（金蝶只记凭证头摘要），导入后 `v.summary=''`。
  而引擎的「结转损益」判定与幂等保护均用摘要正则 `/结转.*损益/` 匹配：
  - `settleChecklist`（结账检查-结转损益）把已结转月份误判为「本期损益未结转，请先结转损益」→ 结账被硬性拦截；
  - `carryForwardProfit`（点「结转损益」按钮）因摘要空而**不触发幂等拦截**，金蝶已结转月份会被重复结转（潜在错账）。
  - 组合后果：**结账说「请先结转损益」、点结转又说「无需结转/重复结转」→ 该月永远无法结账（死锁）**。
- **影响面**：所有从金蝶 KIS 导入、且结转损益摘要为空的账套（添钰来客/绅蓝之星 2025、2026 历史月全部命中）。

### 修复（js/store.js）
- 新增 `hasCarryForward(month)`：统一「本期损益是否已结转」判定，双口径：
  1. **摘要命中**（本软件生成的「结转YYYY-MM损益」凭证）；
  2. **结构化判定**（兼容金蝶）：本期损益科目（revenue/expense，排除 3103/3104 结转科目）的
     借/贷净发生额均≈0 即视为已结转（金蝶结转凭证把损益科目结平，净额归零）。
- `carryForwardProfit()` 幂等检查改用 `hasCarryForward()`；`settleChecklist` 的「结转损益」检查同口径。
- 效果：摘要为空的已结转月 → 结账检查显示「损益已结转」，点结转被正确拦截；
  真实未结转月（如 2026-08）→ 仍正常要求先结转损益（不误放行）。

### 验证（真实账套，只读/内存副本，不改磁盘）
- `tools/verify_invariants.js`：添钰/绅蓝/鲁海丰 3 账套 I1-I10 全 PASS（修复无副作用）。
- `tools/_diag_carryfix.js`：2026-08 首次结转成功、二次幂等拦截；2025-12（金蝶已结转）正确拦截不重复；
  反结账 2026-07 后重新结账全链路走通（原死锁场景解除）。
- `tools/_stability_test.js`：T1-T10 全套高风险操作（结账/反结账/结转/凭证保护/高频循环/借贷平衡强制）
  在添钰/绅蓝内存副本上 **24 PASS / 0 FAIL**。
- 深度审计：逐月试算平衡、货币资金勾稽（现金流期末=货币资金1001/1002/1012）、
  已结账月末未分配利润勾稽、明细账余额连续、凭证无同号 全 PASS。

### 遗留（数据层说明，非本次修复范围）
- 已导入历史账套的 `closedPeriods` 存在金蝶映射的「空结账期」（期初 1-2 月无凭证却标记已结账）与
  「12 月未标记结账」现象——属导入时闭账状态映射口径，不影响报表正确性（报表全由凭证动态生成，
  已核验资产=负债+权益、货币资金勾稽、未分配利润勾稽逐月成立）。
- 两店历史账套含「以前年度损益调整 6901/6000」科目（金蝶结转至 3104 未分配利润）与负数红冲，
  未分配利润勾稽差额精确等于该科目结转额（4156.42）等业务处理，非引擎计算错误。
- 期末调汇功能已下线，`tools/verify_idempotent.js` 中调用 `exchangeAdjust` 的断言为历史遗留，
  与现版引擎无关（CHANGELOG 2026-09-01「期末调汇下线」已有记载）。

---

## 2026-09-05 — 审计复核：I10 科目类别错标 + Windows 打包就绪 + 关闭守卫

### Ⅰ. I10 恒等式复核（延续 H2，防漏网记录）
- **复核结论**：此前 H2 修复覆盖不全。实测 4 个真实账套中，导入科目类别与准则模板不一致共 13 处——
  4001 生产成本及子目 → `equity`（应 `expense`）、2401 递延收益 → `asset`（应 `liability`）、
  5301 营业外收入及子目 → `expense`（应 `revenue`）、4101 制造费用 → `equity`（应 `expense`）。
  表现：利润表「页面行合计 ≠ 数据层 netProfit」差额=错标科目当月发生额×2，仅在有发生额的月份出现，
  而借贷平衡/资产负债表恒等式全部正常，故此前只查勾稽与平衡的多次审查未发现。
- **代码修复**：`kis-import.js` `classify` 优先取 `standards.js` 权威一级科目类别（子目按编码前缀继承），
  模板未覆盖的自定义编码才回退 FDC/前缀启发式。
- **审计防漏**：`tools/verify_invariants.js` 的 I10 失败时自动输出「科目类别与准则模板核对」清单；
  复核结论已补记 `docs/audit-2026-09.md` H2 小节。
- **处置**：已导入的旧账套需重新导入（或手工修正科目类别）；详见 `docs/audit-2026-09.md`。

### Ⅱ. 单实例 + 退出确认（对应 Windows 分析清单 2.x）
- `Cargo.toml` 增加 `tauri-plugin-single-instance`；`lib.rs` 注册单实例插件，重复启动时唤出已有主窗口并退出新进程，杜绝双进程同时写同一账套。
- `js/app.js` 新增未保存编辑守卫：点窗口 X 时仅当凭证录入/期初余额存在「改动未保存」才弹确认，否则直接退出不打扰。
- `index.html`：`vEditView`、`page-opening` 增加 `data-unsaved-scope`；`app.js` 版本号升至 `2026090501`。
- `js/pages/settings/Opening.js`：期初余额保存前增加借贷平衡校验（不平衡即阻断并提示差额）。

### Ⅲ. Windows 打包脚本
- 重建 `tauri/run-build.ps1`：后台执行 `npm run tauri build -- --bundles nsis`，成功后将 `*-setup.exe` 复制到项目根。

---

## 2026-09-02 — 顶栏 + 应用图标：替换为紫色月牙叶 logo（原 TY 蓝渐变方块）

照用户提供的紫色月牙叶 logo 替换两处品牌图标，统一品牌视觉：
- **设计**：两片饱满紫色月牙/叶（右上+左下对角分布），紫色对角渐变（#a78bfa→#8b5cf6→#4f6ef7），透明背景
- **`tauri/src-tauri/icons/icon.png`**：用 image_gen 生成 1024 PNG 并去白底透明化；`npx tauri icon` 重新生成全套 .icns/.ico/各尺寸（iOS/Android/macOS/Windows）—— 应用图标与原图视觉一致
- **`css/leaf-icon.png`**：保存 1024 透明版供顶栏引用
- **顶栏品牌**（`index.html`）：原内联 TY 蓝渐变方块 SVG 替换为 `<img src="css/leaf-icon.png" width=30 height=30>`，与桌面 logo 同一张图、品牌三处一致（顶栏 / 桌面 / 应用）
- **`~/Desktop/添钰logo.png`**：复制一份供查看

**验证**：lint 无新增错误（8 个 warning 均原有）；图标透明度正确（月牙外透明、白顶栏上自然透出）。

---

## 2026-09-02 — 彻底清理侧栏 logo（含设置弹窗残留）

布局重构时侧栏 logo 仅用 CSS 隐藏（保留 DOM，因 app.js 的 logoEnd 切分依赖「首个 </div> 即 nav-logo 块结束」）。现彻底移除：
- `js/app.js`（renderSideNav）：删除 nav-logo 的 HTML 拼接；改写 logoEnd 切分逻辑——html 现即为纯菜单，直接包进 `.nav-menu-scroll`（不再依赖「首个 div 即 logo」）
- `js/app.js`（openQuickSettings）：**顺带发现并清除**常用功能设置弹窗 body 顶部误注入的 nav-logo 残留（本属复制粘贴错误，弹窗顶部多出个 TY logo 已被清理）
- 顶栏品牌返回首页逻辑：选择器由 `.nav-logo,#topbarBrand` 简化为 `#topbarBrand`（侧栏 logo 已不存在）
- CSS：nav-logo 相关规则已无残留（DOM 删除后成死代码）

**效果**：侧栏顶部不再有 logo（含 DOM），菜单从顶部开始；常用功能设置弹窗也不再有多余的 TY logo 残留。品牌仅保留在顶栏一处。

**验证**：app.js 0 lint 错误，CSS 8 个 warning 均原有。

---

## 2026-09-02 — 常用功能设置弹窗新增「恢复默认」按钮

「常用功能设置」弹窗（齿轮图标进入）的确定/取消旁新增「恢复默认」按钮：
- `index.html`：qs-footer 加 `<button id="qsReset">恢复默认</button>`（置于「确定」与「取消」之间）
- `js/app.js`：绑定 qsReset 点击——遍历 qsBody 全部 checkbox，按 `DEFAULT_QUICK_KEYS`（系统默认 10 项）勾选/取消；仅重置**当前弹窗勾选**，不立即保存（点「确定」才写入 localStorage 的 `quick_menu_keys`，点「取消」可放弃）
- 说明：常用功能配置存于浏览器 `localStorage`（非账套数据），恢复默认不触碰任何账套数据

**验证**：app.js / index.html lint 0 错误。

---

## 2026-09-02 — 首页「常用功能」：整行删除标题栏，设置图标下移

（承接上一条"删除常用功能标题文字"）将首页「常用功能」区块原本的标题栏**整行删除**，并把右上角「自定义」设置图标**下移**到内容区右上角：
- `index.html`：删除整个 `titleWrapper` 标题栏行（不再单独占一行）；设置图标 `homeQuickEdit` 移到 `.home-quick`（新增凭证卡+图标网格所在内容行）内部作为首元素
- `css/style.css`：`.home-quick` 加 `position:relative`（作为定位参考）；新增 `.home-quick .home-quick-edit{position:absolute;top:0;right:0;z-index:5;margin-left:0}` 使设置图标悬浮于内容区右上角、不再独占一行；清理无用的 `.home-quick-title` 规则与注释

**效果**：首页常用功能区不再有独立标题行，「自定义」齿轮图标下沉到新增凭证卡 / 图标网格那一行的右上角（悬浮），界面更紧凑。

**验证**：lint 无新增错误（8 个 warning 均原有）。

---

## 2026-09-02 — 删除暗色模式功能

移除侧栏底部的「月亮/太阳」主题切换按钮及深色主题应用逻辑：
- **CSS**（`css/style.css`）：删除 `.kd-theme-dark` 全部规则（深色侧栏变量、深色阴影、深色菜单文字、深色 logo 图样式）、删除 `.nav-theme-sun/.nav-theme-moon` 图标显隐规则
- **JS**（`js/app.js`）：删除侧栏底部 `navThemeBtn`（月亮/太阳按钮）DOM；删除 `applyTheme` + `savedTheme` + 主题按钮点击逻辑；新增启动清理——`localStorage.removeItem('kdThemeDark')` + `document.documentElement.classList.remove('kd-theme-dark')`，防止历史残留旧数据导致侧栏深色样式残留在浅色界面
- 侧栏底部仅保留「收起导航」按钮 + 作者信息

**验证**：CSS/JS 均无残留引用（除清理代码中的键名字符串），app.js 语法通过、lint 无新增错误。

---

## 2026-09-02 — 删除首页「常用功能」区块标题

首页「常用功能」区块（`contentItemWrapper--1cQtp`）原本有标题栏（左"常用功能"文字 + 右"自定义"编辑按钮）。删除标题文字，图标网格自明、更简洁：
- 删除 `<span>常用功能</span>` 标题文字（`index.html`）
- 保留右上角「自定义常用功能」编辑按钮（`homeQuickEdit`，是进入常用功能设置的唯一入口，不可删）
- 新增 `.titleWrapper--2yike.home-quick-title` 类：无标题文字时去掉原大下距（margin-bottom:14px→2px）、紧凑布局，让编辑按钮悬浮于图标网格右上角；`pull-right` 仍自动右推
- 用 CSS 类而非内联样式，符合项目规范

**验证**：lint 无新增错误（残留 8 个 warning 均原有）。

---

## 2026-09-02 — 清理侧栏与内容区交界的圆角与阴影过渡

布局已改为通栏直角平铺后，内容区左缘残留的「金蝶卡片式分层」视觉（内容区左缘 20px 圆角 + 柔和阴影、侧栏同色实心向右延伸的 box-shadow）显得多余/突兀。清理：
- `.content`：删除 `border-radius: 20px 0 0 20px` 与左缘 `box-shadow: -12px 0 15px rgba(198,209,239,.5)`
- `.sidenav`：删除主规则与 collapsed 态的 `box-shadow: 12px 0 0 0 var(--kd-nav-bg)`（同色实心延伸），改为干净的直角左列
- 侧栏与内容区现在**直角通栏相邻**，无圆角无阴影分层

**验证**：lint 无新增错误（残留的 8 个 warning 均为原有空规则集/未知属性），`.sidenav.collapsed` 的宽度收窄与文字/图标/操作区规则均保留（未被误删，仅移除了它里面原只有 box-shadow 的空块）。

---

## 2026-09-02 — 首页布局重构：顶栏上移横贯全宽 + 品牌统一（消除割裂）

**问题**：原布局为「方案 C」——侧栏占左列全高（顶部带 TY logo），顶栏在 content（右侧主区域）内部顶部，导致侧栏 TY 图标与顶栏「添钰财务记账系统」文字**不在同一行、视觉割裂**。

**改动**：
- **HTML 结构**（`index.html`）：`header.topbar` 从 `.content` 内移到 `.layout` 顶层（横贯全宽）；新增 `.layout-body` 包裹 `nav.sidenav` + `main.content`，置于顶栏下方
- **CSS**（`css/style.css`）：`.layout` 由 flex-row 改为 `flex-direction:column`；新增 `.layout-body{display:flex;flex:1;min-height:0}`（`min-height:0` 必需，否则内部滚动失效）；`.topbar` 取消左上圆角（原与侧栏相接设计）、改为全宽通栏 + 底部浅分隔线
- **品牌统一**：顶栏品牌 = **TY 图标 + 「添钰财务记账系统」**（恢复 `.topbar-brand-ico` 显示与图文间距 gap:10）；**侧栏 logo 用 CSS 隐藏**（`.nav-logo{display:none}`）——品牌只保留顶栏一处，消除两个品牌源

**关键注意（勿违）**：侧栏 logo 仅用 CSS 隐藏、**DOM 必须保留**——`js/app.js` 的 `logoEnd` 切分逻辑依赖「html 中首个 `</div>` 即 `.nav-logo` 块结束」来分离 logo 与菜单（`html.indexOf('</div>')+6`），若从 DOM 移除会导致侧栏菜单渲染错位。

**验证**：HTML 标签全部配对（div 881/881、header/main/nav 各 1/1）、结构顺序正确（layout→topbar→layout-body→sidenav→content）、页面 HTTP 200 可加载、CSS 规则确认生效、`logoEnd` 逻辑未被破坏。

**备份**：改动前已备份 `backups_layout_20260902-223604/`（index.html + style.css）。

---

## 2026-09-02 — 侧栏 logo 替换为 TY 字母图标（添钰首字母）

将侧栏顶部 logo 从原来的「心形 + 1+1=2」SVG（36×32px，深蓝描边，Comic Sans 文字，画风与财务软件不搭）替换为用添钰首字母 **TY** 设计的简洁专业图标：
- 内联 SVG：渐变圆角方块（蓝 `#3b82f6→#2563eb`）+ 白色 TY 字形（T 横梁竖干 + Y 分叉竖干，线帽圆润）
- 尺寸 34×34（方形适配，`js/app.js` 两处渲染模板均已替换；`css/style.css` `.nav-logo-svg` 由 36×32 改为 34×34）
- 侧栏仍只显示图标（品牌文字统一在顶栏"添钰财务记账系统"，避免重复）；`.nav-logo-text` 保留隐藏

**验证**：app.js 语法通过、SVG XML 结构配对正确（8 开 = 5 自闭合 + 3 闭）、lint 无新增错误。

---

## 2026-09-02 — 原始凭证页精简为附件台账视图

原始凭证页本质是**凭证附件的台账视图**：录凭证上传附件（实体存 `attachments/`）时由 `addOriginalFromAttachment` 登记一条元数据记录。经查，附件台账实际填充的字段有限，表格原 16 列中大量列是**恒定默认值**（金额恒 0、附件小类恒"其他"、凭证模板恒"—"、所属组恒"默认组"、是否发票恒否、上传人恒 admin、查验状态恒"未查验"等），无信息量且显得凌乱。

**精简为只显示附件关键信息**（保留并简化显示，不动数据层）：
- 表格 16 列 → 7 列：全选 / 操作 / **附件名称 / 文件大小 / 关联凭证 / 记账期间 / 上传时间**
- `setRptHead` 标题列数 16→7、空行 colspan 16→7
- 导出同步精简为 5 列（附件名称/文件大小/关联凭证/记账期间/上传时间）
- 筛选（名称/大类/小类/凭证状态/期间树）保留，仍可过滤；数据层字段保留，未来如需"独立原始凭证录入（识别发票/查验）"仍可扩展

**验证**：列数与渲染 td 数一致（7）、colspan 无 16 残留、导出表头 5 列。

---

## 2026-09-02 — 结账暂缓项修复：结转显式幂等 + 逐期结账 + 期末处理跟随选期

处理结账审查留下的暂缓项，发现并修复 1 个严重缺陷（结转损益重复生成）及 2 个规范性问题。

### 🔴 严重：结转损益「隐式幂等」失效 → 可重复生成结转凭证
- 原实现靠「损益科目余额归零」隐式幂等，但结转凭证里「贷 3103 本年利润」（3103 是 revenue cls）会被计入 totalRev，导致**第二次结转时 totalRev ≠ 0 而继续结转**
- 已在真实场景验证：**第 2 次结转未被拦截，生成 2 张结转凭证**（重复结转）
- 修复：① 显式幂等——本期已存在结转凭证（`/结转.*损益/`）则拦截，删旧凭证后可重做（与期末调汇/税费类一致）② 统计损益发生额时排除结转科目 3103/3104（与 profitStatement 修复同源）
- 验证：第 2 次结转被拦截、仅 1 张结转凭证、结转金额正确（收入8000-费用2000=净利6000）

### 一般：closePeriod 缺「上期必须已结账」校验（跳期结账）
- 原实现可直接结 2026-04 而不必先结 2026-03（跳期结账），导致中间期间数据可随意修改、账簿断档
- 修复：新增 `_prevPeriod()` 辅助 + `closePeriod` 校验「上一有凭证期间必须已结账」，否则拦截并提示先结上期
- 验证：跳期结账被拦截、顺序结账（3→4 月）成功、仅 1 期账套首期可直接结账、反结账后仍保持顺序约束

### 一般：期末处理按钮期间与结账 tab 选期不一致
- 原实现期末处理（结转损益/折旧/调汇/税费等）固定用 `currentPeriod()`，而结账按钮用 `selMonth`（结账 tab 跨期选期），导致「选 A 期却操作 B 期」的误解
- 修复：8 个期末处理按钮（`btnDepVoucher`/`btnFxVoucher`/`btnCarryCost`/`btnCarryVat`/`btnAccrueSurTax`/`btnAccrueIncTax`/`btnReCarryForward`/`btnCarryYearEnd`）统一用 `selMonth`（跟随结账 tab 选期）；`refreshSettle` 中 `curMonth` 同步跟随；store 侧各方法均有 `isPeriodClosed` 拦截，对已结账历史期安全

**验证**：`tools/verify_settle_done.js` —— 结转幂等/逐期结账/期末处理跟随选期全通过；既有 14 个脚本回归全通过。

---

## 2026-09-02 — 报表板块审查：修复结转损益后利润表翻倍虚增（严重）

审查「账簿/报表」板块（按会计准则逐项核对）发现并修复严重缺陷，并确认账簿/资产负债表/现金流量表逻辑正确。

### 🔴 严重：结转损益后利润表收入/净利润翻倍虚增
- 缺陷：`profitStatement` 按 `cls==='revenue'/'expense'` 统计损益类科目发生额，但「本年利润 3103」在科目模板中被归为 `revenue`，且「结转损益」凭证里 `贷 3103 本年利润 N` 会被误计入收入
- 后果：**结转损益后**利润表 `totalRevenue` 从 8000 虚增到 14000、`netProfit` 从 6000 虚增到 12000（翻倍）→ 结账页税费测算、利润表全错
- 根因：3103 是「权益/结转类」科目而非损益类，结转凭证不应计入利润表
- 修复：`profitStatement` 取数显式排除 `3103 本年利润` / `3104 利润分配`（符合会计准则：利润表只统计各损益类科目发生额）
- 验证：结转损益前后利润表均为收入8000/费用2000/净利6000，不再翻倍

### 审查结论（无缺陷，已核实正确）
- **账簿**：期初（`openingOf` 含子目上卷+期前凭证）、借贷方向（按 normal dr/cr）、总账明细账勾稽正确；科目余额表页面按末级科目合计，真实账套（371张凭证）末级借贷完全平衡（本期/期末均平衡）
- **资产负债表**：`balanceSheet` 按标准《小企业会计准则》项目取数；规范账套（正确结转损益）恒等式平衡（资产=负债+权益）；不平账套由页面 `bsWip` 诊断提示「结转损益未完整执行」，软件如实呈现不掩盖
- **利润表**：收入贷方/费用借方发生额口径（已结转损益账套取发生额而非净额），净利润正确
- **现金流量表**：`cashFlow` 三大活动分类 + 期初/期末现金 + 净增加勾稽正确；真实账套「期末现金=期初+净增加」平衡，且期末现金 = 1001/1002/1012 科目余额（与总账勾稽一致）

### 说明
- `S.trialBalance()` 是死方法（无人调用，返回 generalLedger 含父级），但页面 `TrialBalance.js` 直接用 `S.generalLedger` 且自己做了末级判定（isLeaf），合计正确，不影响功能

**验证**：`tools/verify_reports.js` —— 资产负债表恒等/利润表口径/现金流量表勾稽全通过；真实账套账簿/报表勾稽验证通过。

---

## 2026-09-02 — 凭证板块审查修复：工资正则失效 + 状态流转单向性 + 结账拦截一致性

审查「凭证」板块（按会计规范逐项核对）发现并修复以下问题：

### 严重：工资凭证识别正则失效（幂等/删除保护形同虚设）
- 缺陷：工资计提凭证摘要是「计提2026-03工资」（**月份在中间**），而 `hasPayrollVoucher`（L3351）与 `_voucherRefs`（L1127）用的是 `/工资(计提|发放)/`，要求"工资"紧跟"计提/发放"，**匹配不上**「计提…工资」
- 后果：① `hasPayrollVoucher` 恒 false → 工资计提凭证已生成却认为"未生成" → **可重复生成工资凭证**（此前"已修复工资幂等"实际因正则错误根本没生效）② `_voucherRefs` 不识别 → **工资凭证可被随意删除**
- 修复：改为 `/(计提|发放).*工资/`（两处）

### 一般：状态流转单向性
- `auditVoucher` 未检查「已出纳复核」：已复核（reviewed）凭证可被再次审核，状态从 reviewed 降回 audited，破坏"审核→复核"单向性。修复：已复核凭证不可再审核。

### 一般：出纳复核/撤销复核缺已结账拦截
- `cashierReview`/`unCashierReview` 未检查 `isPeriodClosed`，而已结账期间的审核/反审核/修改/删除都有拦截。已结账凭证复核状态仍可被改，违反"已结账期间凭证全程锁定"。修复：两处补 `isPeriodClosed` 拦截，与审核/修改/删除一致。

### 边界核对（结论：无缺陷）
- `S.subjects()` 返回全量（含停用）是合理的（报表/账簿需要）；录凭证 UI 用的 `SubjectCombo.subjects()` 已排除停用科目（`enabled !== false`），`pick()` 用全量保留历史停用值回显
- `num()` 对非数字返回 0（`isNaN(n)?0:n`），不产生 NaN；`addVoucher` 有借贷平衡强校验（任何路径写入都必须平衡）

**验证**：`tools/verify_voucher_flow.js` —— 状态流转完整、出纳复核结账拦截、引用校验含工资/出纳流水、不平衡凭证在 addVoucher 层即拦截。

---

## 2026-09-02 — 凭证 id 稳定性与引用完整性（严重，影响出纳两条线闭环）

审查「凭证」板块时发现严重缺陷：**凭证 id 在账套重新加载后会变化，导致所有按 `voucherId` 记录的引用失效**。

- 根因：`addVoucher` 用「V+时间戳」生成 id，而 `ensureVoucherIds()`（账套加载时执行）把 id 强制改写为 `word-no`，两套口径不一致
- 后果：出纳流水「生成凭证」后记录的 `voucherId`，在刷新/重启后指向不存在的 id →「已生成凭证」保护失效、流水可被随意删改 → **出纳账与总账脱节**；同样影响报销单/原始凭证/固定资产的引用
- 次要根因：原 id 仅按 `word-no` 判重，**未区分月份**。而凭证号按月编号（每月从 1 起），3月的「记-1」与4月的「记-1」是不同凭证却被判为重号加 `-N` 后缀，且每次重载重排 → id 反复变化。真实账套（添钰来客 371 张）存在 **58 个跨月重复的 word-no**，印证问题真实存在

**修复**：
- 新增 `_calcVoucherId(word, no, month)`，id 格式 `word-no@YYYY-MM`（含月份，跨月唯一）
- `addVoucher` 与 `ensureVoucherIds` 统一调用该函数，口径严格一致（两处必须同步，否则 id 又会在重载后变化）
- 真实账套首次加载做**一次性 id 规范化**（371 张老 id → 新格式），之后永久稳定；因真实账套无任何凭证引用数据，迁移无损失

**关于凭证断号**（已查证《会计基础工作规范》与金蝶行为）：规范要求记账凭证连续编号；金蝶做法是删除凭证后产生断号、**不自动回填补号**，由会计人员用「凭证整理」手动补齐（不可撤销）。本软件 `nextVoucherNo` 取现存最大号+1，删中间凭证后新凭证继续往后编（如 1,2,4,5 后新增为 6），**不复用已删号**，符合金蝶规范与可追溯性要求（已加验证固化此行为）。

**验证**：`tools/verify_voucher_id.js` —— 跨月同号 id 唯一、重载后 id 不变、出纳流水引用不失效且保护仍生效、断号不复用、真实账套 371 张 id 全唯一且稳定。

---

## 2026-09-02 — 总账缓存按账套隔离（修复切换账套/恢复备份显示旧数据，严重）

审查「凭证/账簿」板块时发现严重缺陷：`generalLedger` 的记忆化缓存 `_glCache` **仅以 month 为键**，而凭证增删改只在 `addVoucher`/`updateVoucher`/`removeVoucher` 三处清缓存。切换账套、恢复备份这些「整体替换 state」的路径均未清缓存，导致：

- **切换账套后**查询同月份 → 命中上一个账套的缓存，**账簿/报表显示旧账套数据**
- **恢复备份后**查询同月份 → 命中恢复前的缓存，**显示恢复前的旧数据**

这是财务软件最严重的一类缺陷（显示错误数据且用户难以察觉）。

**修复（双保险）**：
- 缓存键改为 `bookId + '|' + month`：切换账套自然失效，覆盖所有未预期的 state 替换路径（根治，不需记忆每个替换点）
- `switchBook`（临时空账套顶屏 + 加载成功后）、`restoreFromData`（恢复后）显式清空 `_glCache`

**验证**：`tools/verify_gl_cache.js` —— 账套 A(1000)/B(555) 同月份互不串数据、切回 A 仍为 1000、恢复备份后正确变为新值、缓存仍正常命中（性能未破坏）、凭证增删改仍使缓存失效。

---

## 2026-09-02 — 结账板块全面审查修复（幂等性 + 跨年结转 + 硬性检查可见化）

对「结账」板块做了财务逻辑审查，修复 9 处问题，重点是「重复操作导致重复记账」这类财务大忌。

### 严重缺陷修复
- **期末调汇可无限重复生成同额凭证**（`exchangeAdjust`）：调汇分录不带 qty、不会改变外币数量余额，原逻辑连点 N 次生成 N 张同额凭证。现加幂等拦截：本期已存在调汇凭证则拒绝重复，返回旧凭证供删除后重做。
- **结转损益摘要正则不匹配**：store 生成摘要为「结转2026-03损益」，Settle.js 四处用 `/结转损益/` 匹配不上 →「重新结转」功能失效、结账页恒显未结转。全部改为 `/结转.*损益/`。
- **反结账用错期间变量**：`btnReopenPeriod` 误用 `selMonth`（结账 tab 选期），反结账页自己用 `selReopenMonth`，导致选 A 月反 B 月。改用 `selReopenMonth`。
- **折旧同月重复计提**（`depreciateMonth`）：加 `if (fa.deprMonth === month) return;`，同月重复调用不再生成同额折旧凭证。

### 一般缺陷修复
- **#5 四个「生成凭证」按钮无查重**（结转成本/转出未交增值税/计提附加税/计提所得税）：新增 `genOnceVoucher(month, summaryRe, ...)` 统一查重入口，本期已生成同类凭证则拦截，须删旧凭证再重做。
- **#8 carryYearEnd 死代码接入**：年末结转本年利润（3103→3104）原已实现但全工程零调用，导致跨年 3103 未清零、未分配利润失真。现接入：
  - `settleChecklist` 12 月硬性检查：本年利润未结转为 fail（硬性拦截跨年失真）；无 3104 科目则跳过（兼容）
  - 结账页「结转本年利润」按钮（仅 12 月显示）
  - 补幂等保护：已生成年度结转凭证则拒绝重复
- **#9 结账页未调用 `S.settleChecklist()`**：结账硬性条件（凭证未审核/借贷不平/幽灵科目/损益未结转）此前只在 closePeriod 内部拦截、UI 不可见。现结账页检查清单追加展示 fail/warn 项。
- **#10 renderCashChecklist null 兜底**：`S.detailLedger(...).rows` 直接取会 TypeError，加 `|| {}` 兜底并合并两次调用。

### 验证
- `tools/verify_idempotent.js`：期末调汇/折旧幂等、结转损益摘要可匹配、反结账期间变量正确
- `tools/verify_settle_fixes.js`：#5查重/#8年末结转接入/#9硬性检查展示/#10空值兜底
- 既有 7 个脚本（含真实账套）回归全通过

---



## 2026-08-31 — 出纳「两条线」落地：账户独立核算 + 日记账录入 + 流水生成凭证 + 备份恢复修复

**背景**：本项目长期目标是逐步对齐金蝶精斗云「出纳两条线」——①出纳线（账户独立编码/期初/流水）②账务线（凭证按科目）。此前账户档案已建好，但 `openingBalance` 是「死字段」无任何取数消费，且全系统没有出纳流水这一数据主体，所谓「现金日记账」实为科目明细账换皮。本次补齐流水模型、报表账户口径、流水→凭证闭环，并修复备份恢复缺陷。

**关键设计原则（勿违）**：只改软件、不碰账套。凡是能从现有数据推导的（历史出纳流水源于凭证），一律动态推导、不落盘；只落盘「推导不出来的」手工流水（凭证里没有的新信息）。老账套报表数字零变化（由工具脚本回归保障）。

### 1. 出纳流水数据模型（`js/store.js`，版本 bump → `?v=2026083129`）
- `state.cashJournals` 新增：仅存手工流水；字段 `{id, accountId, date, period, summary, direction, amount, oppositeSubjects, oppositeSubject, settleType, settleNo, voucherId, voucherNo, source('manual'|'voucher'), status}`
- 推导层 `derivedJournals(accountId, month)`：由凭证派生账户流水，取数口径与 `detailLedger` 完全一致（含子科目上卷），自动带出对方科目（一借多贷保留全部、内部转账两侧互指）
- 合并层 `journalsOf()` / `accountBalance()`：期初关键规则「账户显式设非 0 期初才用账户值，否则回退科目期初」——老账套账户余额 ≡ 科目余额，报表零变化
- 手工流水 CRUD：`addCashJournal` / `updateCashJournal` / `removeCashJournal` / `genJournalVoucher`（流水→凭证），防护：已生成凭证的流水禁删禁改、重复生成拦截、已结账期间禁删
- `ensureBankAccounts` 已存在；账户 `openingBalance` 死字段被 `accountBalance` 接活

### 2. 报表切到账户口径（`js/pages/cashier/CashierExtra.js`，bump → `?v=2026083116`）
- 抽单一取数源 `cashierRows(month)`：账户余额表 / 收支汇总屏幕 / 收支汇总导出 三处共用，杜绝「屏幕走账户、导出走科目」的口径打架（此前 `exportIes` 走科目清单、屏幕走账户档案，两边行数金额不一致）
- 收支汇总表原 `sum` 对账户行直接累加，一科目多账户会虚增，随切账户口径一并修复
- 核对总账：左=账户余额（出纳线）、右=总账科目余额（账务线），改造前两侧同源自比恒相符、无核对价值，现在才有真实勾稽意义
- 重复计算告警：同科目挂多个未设独立期初的账户时，在表上方明确告警并给处理指引（不静默隐藏数据）

### 3. 日记账按账户取数 + 录入流水 UI（`js/pages/cashier/CashJournal.js`，bump → `?v=2026083117`）
- 下拉 value 由科目编码改为账户 id（此前同科目多账户选哪个结果都一样）；取数走 `journalsOf`/`accountBalance`/`accountYtd`
- 新增「新增流水」按钮 + 录入弹窗（账户/日期/收付方向/金额/对方科目联想/结算方式/票号/摘要），对方科目排除资金类科目自身
- 未生成凭证的手工流水显示「生成凭证」入口，生成后回写凭证号、不再显示

### 4. 银行对账单按账户区分（`js/store.js` + `js/pages/cashier/Cashier.js`，bump → `?v=2026083123`）
- 出纳结账对齐金蝶「结转未达账 + 结账」语义（`js/store.js` `carryUnreconciled` + `js/pages/settle/Settle.js`，bump → `?v=2026083113`）：
  - 结账前自动调用 `carryUnreconciled(per)`：本期未勾对的流水/对账单标记 `carriedFrom`（结转下期），已达账项 `settled=true`
  - `reconcile` 下期自动纳入结转未达项（跨期匹配放宽为「金额+摘要」），持续跟踪直到勾销结清
  - 已生成凭证的手工流水不结转（已入总账，非未达账项）
  - 结账检查项做实：该期未生成凭证的手工流水数、未勾对未达账项数（提示性）；修正历史误导注释「→生成凭证」为真实语义（金蝶日记账生成凭证是日常独立功能，非结账自动批量）
- 对账/余额调节表企业侧改走账户出纳流水（`reconcile`/`adjustTable` 传 accountId 时）：
  - 企业账侧 = `accountBalance` 账户流水（含凭证推导流水 + 手工流水），bookEnd = 账户期末余额
  - 手工录入的出纳流水因此能参与对账/勾稽，两条线真正打通
  - 不传 accountId 时仍走科目口径，老账套零影响（由 `verify_recon_account.js` 回归保障）
- `bankStatements` 新增 `accountId` 字段；新增 `statementsByAccount`/`statementOpeningByAccount`；`reconcile`/`adjustTable` 增加可选 `accountId` 参数
- 对账单/对账/余额调节表下拉 value 改账户 id；新增 `acctToCode()` 供对账取企业账
- 多账户下对账单/对账/余额调节表可区分归属；老记录无 accountId 自动回退按科目（一科目一账户等价），老账套零影响

### 5. 修复 `restoreFromData`（备份恢复，`js/store.js`）
- 关键 bug：原写 `this.emptyState()`，但 `emptyState` 是模块私有函数未挂 S 上 → 必抛 `TypeError`，备份恢复整体不可用
- 改为直接调用私有 `emptyState()`，并补「加载账套」一致的兜底链路（normalizeState 缺字段补全 + ensureVoucherIds 凭证 id 唯一 + ensureCashFlowFields + schemaVersion 对齐）

### 验证（`tools/` 下新增 3 个回归脚本）
- `verify_cashier_journals.js`：真实账套 66 组（账户×期间）账户余额 ≡ 科目余额 + 17 项合成用例（推导逻辑/对方科目/内部转账/手工流水/流水保护）
- `verify_cashier_report.js`：报表切账户口径后数字零变化、屏幕/导出同源、核对总账账户≡总账
- `verify_journal_voucher.js`：流水→凭证闭环、备份恢复修复、流水保护
- `verify_bank_stmt_account.js`：银行对账单按账户区分、老记录回退兼容

**验证结论**：全部通过，老账套报表数字零变化。

---

## 2026-08-28 — 报表导出/打印全面补齐与修复（Tauri 桌面版）

**背景**：软件从浏览器迁移到 Tauri v2 桌面版后，多项「导出/打印/打开文件夹」功能出现
「无反应」；同时报表域普遍存在导出按钮缺失、部分报表列错位、打印带出交互标记等问题。
本次一次性补齐导出能力并修复全部相关缺陷。

**改动文件与要点**：

### 1. 导出链路根治（`js/file-save-bridge.js`、`tauri/src-tauri/src/lib.rs`、`Cargo.toml`）
- **二进制传参改 base64（关键 bug）**：原前端用 `Array.from(u8)` 把二进制转普通数组传给
  Rust `Vec<u8>` 参数，Tauri v2 对 `Vec<u8>` 的 IPC 序列化有特殊要求，导致 `invoke` 在参数
  解析阶段被拒、静默失败（导出"无反应"）。改为 JS 端 `btoa` 编码 base64 字符串、Rust 端
  `base64` crate 解码还原写盘（`Cargo.toml` 加 `base64 = "0.22"`，`use base64::Engine`）。
- **导出结果提示可见化**：`toastExported` 改为弹出带「打开文件夹」按钮的结果浮层（替代
  纯文本 toast），用户可一键在系统文件管理器中打开导出目录；`failToast` 加 `alert` 兜底，
  任何失败都显式可见，杜绝"静默无反应"。
- **`showToast` 挂全局**：`app.js` 增加 `globalThis.showToast = showToast`，修复外部脚本
  （file-save-bridge 等）检查 `typeof showToast === 'function'` 时因作用域问题判 false、
  导出成功也不提示的缺陷。

### 2. 打印功能修复（`js/app.js`、`css/style.css`）
- **`kdPrint` 二进制参数 base64 化**：打印生成 HTML 走 `save_export_file` 时也改为 base64
  参数，与 Rust 端新签名一致（修复打印报错）。
- **打印隐藏交互标记**：`buildPrintHtml` 内联样式与主 CSS `@media print` 均增加
  `.bs-editformula`、`.btn`/`.kd-btn`/`button` 隐藏规则，打印/预览时不显示编辑态 UI。

### 3. 报表导出按钮全面补齐（`js/pages/report/Report.js`、`ProjectProfit.js`、`Original.js`、`TrialBalance.js`、`index.html`、`app.js`）
- **四大标准报表新增导出**：资产负债表（`exportBs`，双栏对照 Excel）、利润表（`exportPl`）、
  现金流量表（`exportCf`）、应交税金明细表（`exportTx`），各加「导出」按钮（`btnBsExport` 等）。
- **项目利润表修复**：查询按钮绑定 id 由错误的 `btnPpRefresh` 修正为 `btnPpQuery`；补缺失的
  `btnPpExport` 导出按钮；加固 `exportPP`（`ppBody` 判空）。
- **原始凭证**：导出由「演示环境暂未接入」占位改为 `exportOrig`（按当前筛选导出 Excel）；
  修复 `btnOrigPrint` 因 `data-print` + JS `onclick` 双重绑定导致的打印双触发。
- **科目余额表新增导出**：`exportTb`（含合计行）+ `btnTbExport` 按钮。

### 4. 报表列对齐修复（`js/pages/report/Report.js`、`index.html`、`js/pages/cashier/CashierExtra.js`、`css/style.css`）
- **四大报表移除 rpt-fill 占位列**：删除表头 `<th class="rpt-fill">`、数据行/合计行补的
  `td.rpt-fill`、`setRptHead` colspan 恢复业务列数（8/4），并清理 CSS 死样式，消除
  「右侧多出一列空白/整体多出一列空格」问题。
- **核对总账数据行补列**：表头 6 列（含「方向」「核对结果」），但数据行把两列合并为 1 个 td
  （5 个 td），导致右侧多出空白列；拆为独立两个 td 对齐表头。
- **应交税金空态占位**：`colspan="5"` 修正为 `colspan="4"`（与表头 4 列一致）。

### 5. 移除「编辑公式」fx 悬浮标记（`js/pages/report/Report.js`、`css/style.css`、`js/app.js`）
- **完全移除 `fx` 悬浮标记**：删除 `editFormulaBtn()` 函数定义及 3 处调用（资产负债表左右两列、
  利润表行），删除 `.bs-editformula` 悬浮样式与打印规则。该标记仅为装饰性悬浮提示（hover 显示、
  点击无实际编辑功能），且会被带入打印；现彻底移除，报表数据纯净。

**验证结果**：
- 费用明细表、资产负债表、利润表、现金流量表、应交税金、项目利润表、原始凭证、科目余额表
  导出均可用：点导出弹「导出完成」浮层（含「打开文件夹」按钮），文件写入
  `~/Documents/财务软件/exports/`。
- 打印正常（走生成 HTML + 系统打开），不再报错、不再双触发、不再带出 `fx` 等交互标记。
- 四大报表与核对总账表格右侧不再有多余空白列。

---

## 2026-08-21 — 金蝶 .ais 账套导入完整性审查（跨年 / 多币种 / 平衡校验 / 存储兜底）

**背景**：对导入金蝶 KIS 账套功能做完整导入审查。以真实导入结果（「添钰来客」账套：
398 科目 / 371 凭证 / 88 期初）验证单年账套借贷平衡、余额结构均正确；代码审查发现
跨年账套、多币种账套及大账套存储存在完整性缺陷，本次全部修复并补单元验证。

**改动文件与要点**：

### 1. `js/kis-import.js`（版本 bump → `?v=20260821160`）
- **跨年账套期初余额取错年份（关键 bug）**：原逻辑把 6 位期间号 `YYYYMM` 归一化为
  月份 1~12 后取最小期间，跨年账套中不同年份的同月行会互相覆盖，期初余额最终被
  「最后一年的 1 月」覆盖。现改为「完整期间号」比较：6 位期间号直接用 `YYYYMM`；
  标准版 1~12 用起始年份补全为 `YYYYMM`，且同期间重复行只保留第一条。
- **跨年账套结账进度推导错误**：原 `closedPeriods` 只按起始年份生成 1~(最大期间-1)，
  跨年账套会漏掉中间年份已结账月份，`currentPeriod` 也会错位。现改为按年份分组：
  每个年份的凭证最大期间之前的各月均标记为已结账，`currentPeriod` 取最后年份的最大期间。
- **期初余额币种回退**：原逻辑只认 `FCyID='*'` 综合币行，多币种/外币账套若无综合币
  汇总行则期初余额整体丢失。现回退到出现次数最多的币种行，并在 `stats.currencyFallback`
  中报告所用币种。
- **凭证聚合 key 加入日期**：key 由「年份-期间-字-号」改为「日期-期间-字-号」，
  源数据中同期间同字号重复出现的异常行不再被误合并。
- **借贷平衡校验**：逐张凭证核对借=贷，新增 `stats.unbalancedVouchers` 统计，
  源数据异常时在导入结果中明确提示，避免「导入成功但账不平」无人知晓。
- **完整性统计**：`stats` 增加 `acctRows / vchRows / balRows`（源表行数），
  探针 `_ais_probe.json` 增加 `GLBal_FCyID_dist / GLBal_FPeriod_dist / unbalancedVouchers`。

### 2. `js/pages/settings/Settings.js`
- **localStorage 容量静默失败（关键 bug）**：原 `loadServerBookIntoLocal` 对
  `localStorage.setItem` 异常静默吞掉，大账套（>5MB）会出现「导入成功但刷新后账套
  丢失」的假象。现改为写入失败时回滚容器并抛出明确错误，导入中止并提示大小。
- **导入结果提示增强**：成功提示展示「分录源行数 → 凭证数」「借贷不平凭证数」
  「币种回退」「重复科目去重」等完整性信息。

### 3. `index.html`
- 更新 `kis-import.js` 缓存 bump（`?v=20260821160`）。

### 4. `_diag_kis_import.js`（新增，只读验证脚本）
- 沙箱加载 `kis-import.js`，4 个场景验证：跨年 6 位期间号、标准版 1~12 期间号、
  无综合币行回退、凭证为空年份兜底。运行 `node _diag_kis_import.js` 全部通过。

**验证结果**：
- 单年账套真实数据：371 张凭证全部借贷平衡，借方总额 = 贷方总额 = 12,682,110.33；
  期初 88 科目、结账进度 1~6 月、startMonth=2026-01 均正确。
- 跨年 mock：期初取最早年份余额（10000 而非次年 12000）、closedPeriods 含
  2022-01~11 + 2023-01~02、currentPeriod=2023-03，全部符合预期。

### 5. `_diag_e2e.js`（新增，真实账套端到端验证脚本）
- 用 vm 沙箱加载 `mdb-reader.js` + `kis-import.js`，直接解析真实 `.ais` 文件：
  `node _diag_e2e.js "<账套.ais>"`。
- 验证项：表清单、导入统计（源行数/凭证/期初/结账进度）、凭证借贷平衡、
  凭证/期初科目引用完整性、日期与期间一致性、期初无同科目双向。

**真实账套端到端验证（`添钰来客_2026年_金蝶KIS格式.ais`，12MB，301 张表）**：
- 源分录 3133 行 → 371 张凭证，借贷全部平衡（unbalancedVouchers=0）；
- 源科目 411 行 → 398 科目（去重 13 个重复科目码）；
- GLBal 3244 行（FCyID `*|*` 与 `RMB|*` 各 1622）→ 88 个期初科目，取综合币行；
- 凭证日期与期间完全一致，期间分布 2026-01~07（58/43/58/53/53/58/48 张）；
- currentPeriod=2026-07，closedPeriods=2026-01~06，startMonth=2026-01；
- 与新逻辑输出对比旧导入结果（.bak）：371 凭证/398 科目/88 期初/结账进度/startMonth
  全部一致，**差异 0**——修复未影响单年账套既有正确行为。

---

## 2026-08-21 — 金蝶 .ais 账套导入完整性修复

**背景**：用户导入金蝶 KIS 导出的 `.ais` 账套后，出现「结账进度（currentPeriod）丢失/乱跳」问题。
经排查，根因是导入模块 `js/kis-import.js` 只读取了 `GLAcct / GLVch / GLBal` 三张表，
**丢失了结账历史（closedPeriods）与凭证记账/审核状态**，导致结账进度只能靠「最近凭证月份」兜底而乱跳。

**改动文件与要点**：

### 1. `js/kis-import.js`（版本 bump → `?v=20260821010`）
- **凭证字段补全**：每张凭证补全 `posted / checked / checker / poster` 字段，
  依据 `FPosted / FChecked / FChecker / FPoster` 推导，确保导入后凭证的记账/审核状态完整。
- **FPosted 布尔判断修复（关键 bug）**：
  原逻辑按 `parseInt(FPosted) === 1` 判定记账状态，但金蝶导出该字段为布尔 `true` 而非数字 `1`，
  导致导入后全部凭证被误判为「未记账」。修正为：
  `posted = (FPosted === true || FPosted === 1 || FPosted === 'true')`（同规则用于 `checked`）。
- **closedPeriods 推导**：
  由于 `.ais` 内部的 `GLPeriod`（期间表）为空、`GLOptions / GLBal` 因 mdb-reader.js 解析大表/特殊字段返回 `null`，
  标准结账字段不可直接读取。改为按业务规则推导：取凭证最大期间，其之前各月视为「已结账」。
  ```js
  var maxPeriod = 0;
  vouchers.forEach(function (v) { if (v.period > maxPeriod) maxPeriod = v.period; });
  var closedPeriods = [];
  if (maxPeriod >= 1) {
    for (var cp = 1; cp < maxPeriod; cp++) closedPeriods.push(startYear + '-' + pad(cp));
  }
  ```
  推导结果写入 ledger 的 `closedPeriods`，并为 `stats` 增加 `closedPeriods / currentPeriod` 报告项。
- **诊断探针**：临时加探针块，POST 到 `serve.py` 的 `/api/probe` 落盘 `_ais_probe.json`，用于核查 .ais 内部表结构。

### 2. `serve.py`
- 新增 `POST /api/probe` 端点，将前端探针上报的 .ais 内部结构信息落盘为 `_ais_probe.json`（固定文件名，便于核对）。

### 3. `js/pages/voucher/Voucher.js`（版本 bump → `?v=20260821003`，C 方案）
- 「录凭证」页默认日期逻辑优化（currentPeriod 驱动）：
  - 当前期间 == 当前自然月 → 默认今天；
  - 当前期间 != 当前自然月 → 默认期间末日（避免录入日期超出已结账/未结账闸门）。
  ```js
  var curP = currentPeriod();
  var natM = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
  dt.value = (curP === natM) ? (H.todayStr ? H.todayStr() : todayStr()) : U.lastDay(curP);
  ```

### 4. `index.html` / `js/main.js`
- 同步更新 `kis-import.js`（`?v=20260821010`）与 `Voucher.js`（`?v=20260821003`）的缓存 bump，强制浏览器刷新新逻辑。

**验证结果**（以账套「添钰来客」为例）：
- `startMonth = 2026-01`
- `closedPeriods = ['2026-01' … '2026-06']`（1~6 月推导为已结账）
- 共导入 371 张凭证，`posted` 全部为 `true`，无 8 月脏数据
- `currentPeriod` 正确落到推导的下一期

**遗留说明（重要）**：
结账进度为基于金蝶业务规则的**推断值**，而非从 `.ais` 原始字段直接读出（标准字段不可读）。
如需 100% 钉死，请在金蝶软件内查看「当前会计期间（第几期）」与导入结果比对。
若金蝶实际期数与推断不符，再微调 `closedPeriods` 推导规则。

---

## 备注：本软件定位
纯本地单机版财务软件（复刻金蝶精斗云云会计风格），纯前端 + `serve.py` 本地文件服务，
零云端依赖、零登录、数据落盘在 `data/books/<id>.json`。详见 `README.md`。
