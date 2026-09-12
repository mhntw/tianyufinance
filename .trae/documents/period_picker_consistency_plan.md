# 期间控件口径统一（单期/范围诚实化）实施计划

## 背景与审查结论

期间控件是范围式（弹层左「开始期间」/右「结束期间」，触发器显示「X期 ~ Y期」），但全软件 16 个使用点中 13 个是单期口径（只读结束期间），导致：

1. 改左列（开始期间）数据无反应，触发器却显示新区间，误导用户；
2. 左列选了比右列更晚的月份时，组件会强制把 end 拖到 start，改左列"偶尔又有反应"，更迷惑；
3. 首页「本年/去年」卡片跳总账写入区间（如 01~08 期），总账只取末月，形式与内容不符；
4. 「今年/去年」区间快捷按钮在 13 个单期页点了实际只取 12 月。

### 使用点分类（已逐页核对取数代码）

**真范围（保留双列，3 个）**：凭证汇总表 `sumPeriod`、查凭证 `qPeriod`、费用明细表 `edPeriod`。

**单期（声明 data-single-period，13 个）**：总账 `glPeriod`、明细账 `dlPeriod`、多栏账 `mlPeriod`、科目余额表 `tbPeriod`、资产负债表 `bsPeriod`、利润表 `plPeriod`、现金流量表 `cfPeriod`、应交税金明细表 `txPeriod`、折旧汇总表 `dasPeriod`、折旧明细表 `dadPeriod`、资产变动记录 `aclPeriod`、工资 `salPeriod`、工资统计 `sstPeriod`。

组件文件头注释（PeriodRangePicker.js L5-L16）早已设计好 `data-single-period="1"` 模式，但从未实现、也无容器声明。本次按该既定设计施工。

### 已确认的决策

- 13 个页面全部收成单期（含总账/明细账/多栏账），不做 store 级范围化改造；年度数据由「本年累计」行/列承载。
- 可选期间上限统一收紧到当前自然月（现状可选择到未来约两年；与凭证录入日期上限 [起账月, today] 对齐）。

## 修改文件与步骤

### 1. js/components/PeriodRangePicker.js（核心：实现单期模式）

- `state` 增加 `single: false`；`openPop(wrap)` 时读 `wrap.dataset.singlePeriod === '1'`，并给弹层根节点 `#kdPeriodRangePop` 切换 class `is-single`（弹层为全软件单例，每次打开按当前 wrap 重设；`closePop` 移除该 class）。
- 单期模式行为：
  - `openPop` 初始化时令 `state.start = state.end`（同取结束期间/默认期间），年导航年一致；
  - `onCellClick`：任一可见列点击都写 end，同时 start 强制等于 end（不再有互相拖动逻辑）；
  - `applySelection`：两个 hidden input 写同一值（end），保证任何读 start 的老代码拿到同一期间（落实注释承诺）；
  - `updateTriggerText(wrap)`：单期容器只显示 `fmtPeriod(end)`，不出现「~」。
- 未来上限：`maxAvailablePeriod()` 改为返回 `naturalMonth()`（当前自然月）。`renderPanels` 的禁用态、`applyShortcut` 的 clamp 均已消费 maxP，自动生效；年份导航历史范围维持现状（默认期前后各一年），本次不扩。
- 「今年/去年」按钮：单期模式下由 CSS 隐藏（见步骤 3），逻辑不改；其余 4 个快捷（本期/上期/本月/上月）本就 s=e，单期下语义正确。

### 2. index.html（13 处声明 + 0 处结构改动）

给 13 个单期容器的 `<div class="ty-period-range">` 加属性 `data-single-period="1"`；`sumPeriod` / `qPeriod` / `edPeriod` 三个容器不加。弹层 `#kdPeriodRangePop` 结构不改（开始期间列与快捷按钮保留在 DOM 中，由 CSS 按 class 隐藏）。

### 3. css/style.css（单期外观，约 3 条规则）

- `.ty-period-range-pop.is-single .ty-period-panel[data-side="start"] { display:none; }`（flex 布局下 end 列自动占满）；
- `.ty-period-range-pop.is-single [data-shortcut="current-year"], .ty-period-range-pop.is-single [data-shortcut="last-year"] { display:none; }`。

### 4. js/pages/ledger/Ledger.js（跳转一致性）

`__glJumpTo(codes, month, toMonth)`：总账容器已是单期，写入时 start/end 同值——`sInp.value = eInp.value = toMonth || month`，更新注释（区间入参收敛为末月；首页本年/去年卡片跳来后触发器只显末月，与「本年累计」行口径一致）。

### 5. 不需要改的部分（已核对）

- 各页面 refresh 中的 start/end 回填（periodRangeValue 及各页同构代码）保持不动，组件双写后天然一致；
- `__plJumpToRow` 已是 s=e 同值；app.js `locateVoucherInQuery` 对查凭证写同值（范围页接受）；
- store.js 单月契约、报表/资产/工资取数逻辑零改动；
- 首页期间下拉、结账月份方块、折旧凭证文本期间、工资 month 输入、报表中心下拉等非弹层控件不动。

## 验证

1. 静态核对：grep 确认 16 个容器中 13 个带 `data-single-period="1"`、3 个不带；无残留对「~」的单期断言。
2. `node tools/verify_invariants.js` 全部通过；跑账套审计（full_audit / audit_books）确认取数无变化（本次不改取数，结果应与改前一致）。
3. 跑 `tools/verify_gl_cache.js`、`tools/test_voucher_query_export.js`（范围页回归）。
4. 浏览器实测：
   - 总账等单期页：弹层只一列、表头「期间」、无今年/去年；触发器显单期；选月后查询数据随选随变；左列不存在，无误导；
   - 凭证汇总/查凭证/费用明细：双列区间、今年/去年可用，跨月结果不变；
   - 所有弹层中晚于当前自然月的月份为禁用态；
   - 首页「本年」卡片点金额跳总账：触发器显末月单期，本年累计行数字与卡片一致；
   - 换账套后默认期间、触发器文本正常。

## 风险与处理

- 弹层单例 class 残留导致模式串页：openPop 每次按 wrap 重设、closePop 清除，双保险。
- maxP 收紧影响 3 个范围页：本就不应查无凭证的未来月，费用明细此前已自行 cap 到自然月，行为更统一；结账页不用该弹层，不受影响。
- 历史年份窗口（默认期±1 年）为既有行为，若后续反馈查不到更早期间，再单独扩窗口，不在本次范围。
