/* 【两个刻意保留的架构选择 —— 曾评估过重构，结论是不做，勿轻改】
 *
 * 1) 本文件不拆分（当前约 4800 行）。
 *    拆分收益有限：真正该拆的大函数（periodVouchers ~390 行）是纯查询逻辑，拆出去也不改行为；
 *    而成本明确：要改 require 路径、处理循环依赖、确保所有引用方同步更新。
 *    单文件反而有「全局可搜索、依赖一目了然」的实际好处。
 *    触发条件：超过 6000 行，或多模块同时修改本文件产生合并冲突时再考虑。
 *
 * 2) 跨文件通信用 globalThis.__xxx 而非事件总线（全项目约 167 处）。
 *    页面打开时挂载 globalThis.__renderXxx、离开时清除 —— 这本身已是隐式订阅。
 *    换成事件总线会引入「页面还没订阅就 emit」的静默丢事件问题，时序更难调试；
 *    而当前 `if (globalThis.__renderXxx) globalThis.__renderXxx()` 虽土，但检查即安全。
 */

/* 【金额精度约定 —— 现状、已知局限与改造方向】
 *
 * 现状：金额以**浮点**存储，逻辑精度为「分」（靠 round2 收敛），
 *       相等判断用容差 EPS（见下方注释「为什么必须是半分」）。
 *
 * 已知局限（都是实际发生过的，不是理论担忧）：
 *   1. 正确性依赖纪律 —— 需要每处都记得调 round2。曾漏掉一处
 *      （openingBalanceCheck），导致「差 0」因浮点残留被误判成不相等。
 *   2. EPS 容易被改错 —— 曾有人（及一份方案文档）认为 0.005 元 = 5 分，
 *      要改成 0.01，实际是把容差**放大**、放行真实的 1 分不平。
 *      一个需要靠人理解「为什么是半分」的机制，本身就是风险。
 *   3. **导入即丢精度** —— 导入源原始金额是 4 位定点（见下），
 *      本项目只保留 2 位，导入时 0.0020 这类精度由**我们自己**舍掉。
 *   4. 多币种会放大误差 —— 外币 × 汇率 × 汇率 的浮点累积，
 *      而导入源保留 4 位正是为这个场景。
 *
 * 改造方向（若做，应一次做完，避免「半浮点半定点」的中间态）：
 *   · 金额字段 → 定点整数，单位 **×10000（万分之一元）**，与导入源精度对齐
 *     （不用 ×100：那会在导入 4 位精度数据时自己引入舍入误差）
 *   · **只需改金额字段** —— 汇率/单价/数量保持浮点即可，导入源也是如此
 *   · 相等判断改为整数直接比较，EPS 可退休
 *   · 除法场景（折旧摊销、汇率换算）需定义明确的「余数分配」规则
 *
 * 前置条件：**先做测试架构改造**（把「算数据」从「写 DOM」里剥出来）。
 *   否则改完 store 的计算路径后，现有那批「正则抠函数」式的测试会静默失效，
 *   等于在没有安全网的情况下重写核心计算。
 *
 * 导入源侧的事实依据见 tools/read_ais.js 头部（可复现：跑该脚本读 .ais 表结构）。
 */

/* ============================================================
 * js/store.js — 数据层与计算引擎（全局单例 S）
 *
 * 业务模型：
 *   - 多账套：books/<id>.json 一店一套，账套间独立核算
 *   - 标准小企业会计准则(2013)科目表
 *   - 复式记账：凭证 -> 账簿 -> 报表 全部由凭证+期初余额动态生成
 *   - 支持：凭证、账簿、报表、固定资产、工资、期末结账、设置
 *
 * 依赖：无。所有计算纯函数，挂在全局 S。
 * 持久化：磁盘为唯一真相源——persist() 经 Storage 引擎（Rust）写
 *         <应用数据目录>/添钰财务/books/<id>.json；localStorage 仅存当前账套指针。
 * ============================================================ */

/* ----------【功能索引】（按职责分组；**只列函数名，不写行号**）----------
 *
 * 【为什么不再写行号】原索引形如「addLog L3715」，但行号随每次编辑漂移 ——
 *   曾整体偏离 80~100 行，结果「按索引跳过去是别的东西」，比没有索引更坏。
 *   自 2026-09-20 起取消行号：请用编辑器的「转到符号」或全局搜索函数名定位
 *   （项目内所有函数名唯一），一次改完永远不会失效。
 *
 * 初始化 / 持久化
 *   init, persist, normalizeState, saveSettings
 *   _initStorageEngine, _migrateOldData, _loadCurrentBook
 *
 * 账套管理
 *   newBook, switchBook, removeBook, listBooks
 *   refreshBookIndex, isBookEnabled
 *
 * 科目表
 *   subjects, subject, subjectName, cashAccounts
 *   addSubject, updateSubject, subjectRole
 *   childCodesOf, rollCodes
 *
 * 期初余额
 *   opening, setOpening, openingBalanceCheck
 *   openingOf
 *
 * 凭证（增删改查 / 模板）
 *   addVoucher, updateVoucher, removeVoucher
 *   getVoucher, deletedVouchers, restoreVoucher
 *   nextVoucherNo, periodVouchers, vouchersBefore
 *   vchTemplates, saveVchTemplate, removeVchTemplate
 *
 * 账簿取数（核心：generalLedger 是所有报表的唯一底层）
 *   generalLedger                ← 总账缓存（_glCache memoization）
 *   trialBalance                 ← 科目余额表（前端 TrialBalance.js 调）
 *   subjectEndBalance            ← 某科目期末余额
 *   subjectPeriodAmount          ← 某科目本期发生额
 *   subjectPeriod                ← 某科目本期余额（含期初期末）
 *   cashBalance                  ← 资金余额（首页资金卡）
 *   detailLedger                 ← 明细账（前端 Ledger.js 调）
 *
 * 利润表 / 损益类
 *   incomeStatement              ← 完整利润表行（含 reportRules 规则计算）
 *   profitStatement              ← 旧版兼容调用 incomeStatement
 *   plSummary                    ← 首页专用：revenue/cost/expense/netProfit + formula 明细
 *   unclosedProfit               ← 未结转的本期净利润（结账用）
 *
 * 资产负债表
 *   balanceSheet                 ← 完整资产负债表行
 *   yearStart                    ← 年初辅助函数
 *
 * 现金流量表
 *   cashFlow                     ← 完整现金流量表
 *   getSubjectCashFlowMap        ← 科目→现金流量项目映射
 *   suggestCashFlowMap           ← 自动建议映射
 *   ensureCashFlowFields         ← 老账套补 cashFlow 字段
 *
 * 期末结账
 *   closePeriod                  ← 执行结账（结转损益 + 记 closing 凭证）
 *   reopenPeriod                 ← 反结账
 *   settleChecklist              ← 结账前自检清单
 *   carryForwardProfit           ← 损益结转（收入/费用→本年利润）
 *   carryYearEnd                 ← 年末结转（本年利润→未分配利润）
 *   isPeriodClosed
 *
 * 固定资产
 *   addFixedAsset, updateFixedAsset, removeFixedAsset
 *   depreciateMonth, assetMonthlyDepr, genCleanVoucher
 *   资产类别 assetCats / normalizeAssetCategory（默认档案 + 「编码↔名称」归一的唯一事实源）
 *   新增资产凭证 = 关联已有凭证 linkAssetAcquisitions / unlinkAssetAcquisitions（**绝不生成凭证**）
 *
 * 工资 / 薪酬
 *   addPayroll, removePayroll, payrollSummary
 *   genPayrollVoucher
 *   salaryVchTpls, addSalaryVchTpl, resetSalaryVchTpls
 *
 * 工具 / 自检 / 健康
 *   runSelfTest                  ← 期初/凭证/报表恒等式自检（首页横幅）
 *   financialHealthCheck         ← 深度健康体检
 *   backupNow                    ← 立即手动备份（Rust Storage）
 *   vatEditGet / vatEditSet      ← 增值税附列资料（小规模/一般纳税人）
 *   log 系统：addLog, getLogs
 *   getParam / setParam          ← 全局参数（bookHideZero / thousand 等）
 *
 * 内部工具函数（IIFE 私有，不暴露到 global S）
 *   pad2, fmtDate, monthOf, voucherMonth, voucherOrderCmp
 *   prevMonth, round2, monthsBetween, monthList, normMonth
 *   num, money, lastDay, EPS（金额容差半分）
 *   emptyState, detectStandardBySubjects, backfillIncomeRowIds
 * ======================================================================= */
(function (global) {
  'use strict';

  // 准则模板懒加载：node 测试环境直接 require store.js 时自动加载 standards.js
  // （浏览器由 index.html 在 store.js 之前加载 standards.js，require 未定义即跳过）
  if (!global.STANDARDS && typeof require === 'function') {
    try { require('./standards.js'); } catch (e) { /* 浏览器忽略 */ }
  }

  var SCHEMA_VERSION = 5; // v5：新增凭证审核状态、账套启用停用、屏保密码、新手引导

  /* ---------- 科目类别定义（默认 5 类） ---------- */
  // normal: 余额正常方向；side: 借/贷
  var ACCOUNT_CLASSES = {
    asset:     { name: '资产',   normal: 'dr', side: '借' },
    liability: { name: '负债',   normal: 'cr', side: '贷' },
    equity:    { name: '权益',   normal: 'cr', side: '贷' },
    revenue:   { name: '收入',   normal: 'cr', side: '贷' },
    expense:   { name: '费用',   normal: 'dr', side: '借' },
    cost:      { name: '成本',   normal: 'dr', side: '借' }
  };

  /* ============================================================
   * 备份策略（Tauri 桌面版）：
   *   主账本与自动备份均落真实文件（<应用数据目录>/添钰财务/books、/backups），
   *   由 Rust 端 Storage 引擎负责，无需浏览器 IndexedDB 兜底。
   * ============================================================ */

  /* ---------- 默认科目表（小企业准则 2013 模板） ----------
   * 以 js/standards.js 中 STANDARDS.small2013.subjects 为单一事实源；
   * 所有新建账套、导入账套统一对齐小企业准则。
   */
  var DEFAULT_SUBJECTS = (global.STANDARDS && global.STANDARDS.small2013 && global.STANDARDS.small2013.subjects) || [];

  // 结转损益专用：收入/费用 映射到 本年利润（本年利润科目，默认 3103）
  var PROFIT_CODE = '3103';

  /* ---------- 工具函数 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDateTime(d) { return fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function monthOf(dateStr) { return dateStr.slice(0, 7); } // YYYY-MM
  // 凭证归属期间（YYYY-MM）：优先用 date；账套缺失 date 时按 period 序号 + 启用月反推。
  // 兼容两种 period： 标准 1~12；6 位期间号 YYYYMM（如 202201 -> '2022-01'）。
  // 归期不再强依赖 date，无 date 的账套也能正确按月归集。
  function voucherMonth(v) {
    // 回退到原始逻辑：优先用 FDate（凭证日期）算期间。
    // 标准版账套绝大多数凭证 FDate=FPeriod（不跨期），此口径正确。
    // 跨期凭证（FDate 月份 ≠ FPeriod）暂由用户通过重新导入+GLSetup 正确识别启用期来避免。
    if (v.date) return monthOf(v.date);
    // 无 FDate 时，用 FPeriod 回退（新导入老数据可能没有 date）
    var p = parseInt(v.period, 10);
    if (!p) return '';
    if (p > 999) {
      var ym = String(p);
      return ym.slice(0, 4) + '-' + ym.slice(4, 6);
    }
    var gS = globalThis.S;
    var sm = (gS && gS.state && gS.state.company && gS.state.company.startMonth) || '2026-01';
    var sp = sm.split('-'); var sy = +sp[0] || 2026, smm = +sp[1] || 1;
    var total = (sy * 12 + (smm - 1)) + (p - 1);
    var y = Math.floor(total / 12), m = (total % 12) + 1;
    return y + '-' + ('0' + m).slice(-2);
  }
  // 凭证排序：月份 → 凭证字 → 字号数值（避免字符串字典序把 记-19 排在 记-2 之前）
  function voucherOrderCmp(a, b) {
    var ma = voucherMonth(a), mb = voucherMonth(b);
    if (ma !== mb) return ma < mb ? -1 : 1;
    var wa = a.word || '记', wb = b.word || '记';
    if (wa !== wb) return wa < wb ? -1 : 1;
    return (parseInt(a.no, 10) || 0) - (parseInt(b.no, 10) || 0);
  }
  function lastDay(month) { // month: 'YYYY-MM' -> 该月最后一天 'YYYY-MM-DD'
    var p = month.split('-');
    var y = +p[0], m = +p[1];
    var d = new Date(y, m, 0);
    return y + '-' + pad2(m) + '-' + pad2(d.getDate());
  }
  function prevMonth(month) {
    var p = month.split('-'); var y = +p[0], m = +p[1];
    if (m === 1) { y--; m = 12; } else { m--; }
    return y + '-' + pad2(m);
  }
  // 金额分位精度归一（会计金额精确到分）。消除二进制浮点累加误差（如 0.1+0.2），
  // 金额统一按 decimal 分位精度处理。用于新生成金额（调汇/结转）及对外输出金额。
  function round2(n) { var v = Number(n); if (isNaN(v)) v = 0; return Math.round(v * 100) / 100; }
  /* 金额相等容差（半分 = 0.005 元），用于借贷平衡 / 结转阈值 / 零值判定，全局统一避免散落硬编码。
   *
   * 【为什么必须是半分而不能是 1 分】金额一律精确到「分」，两笔金额之差必然是 0.01 的整数倍。
   *   · EPS = 0.005 → 只有差 0 才判「相等」（差 1 分即 0.01 > 0.005，判为不等）；✓ 严格
   *   · EPS = 0.01  → 差 1 分（0.01 <= 0.01）也会被判「相等」；✗ 放行真实的 1 分不平
   * 后者会让「借贷差 1 分」「期初差 1 分」的凭证与账套悄悄通过校验，误差逐月累积到年末变成数元。
   * 财务软件的平衡校验必须严格，容差只用来吸收「二进制浮点」的表示误差 —— 而那种误差由
   * 比较前的 round2 消除（见 voucherBalance / openingBalanceCheck），不需要靠放大 EPS 兜底。 */
  var EPS = 0.005;
  // 相差整月数（b - a），a/b 均为 'YYYY-MM' → 返回 number。
  // 注意与紧随其后的 monthList 区分：那个返回「月份列表」(array)。
  // 此前两者同名 monthsBetween 却有三种语义并存（本文件差月数 / report._shared.js 列表 /
  // Voucher.renderSum 内联列表），属最易踩的坑；现统一为「差月数=monthsBetween、列表=monthList」。
  function monthsBetween(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    return (pb[0] - pa[0]) * 12 + (pb[1] - pa[1]);
  }
  // 月份区间展开为月份列表（含首尾）：'2026-01' + '2026-03' → ['2026-01','2026-02','2026-03']。
  // start === end 时返回单元素数组 —— 区间与单期是同一实现，调用方无需分情况处理。
  // 非法/空输入返回空数组（不抛错），与 normMonth 的「空值不炸页面」口径一致。
  // 月份范围刻意校验到 01~12：被收敛掉的三份旧实现都放行 '2026-13' 这类值（会原样返回，
  // 再喂给 periodVouchers 得到一个不存在的月份），现收紧为直接返回空数组。全部真实调用方
  // （Voucher.renderSum / ExpenseDetail）传的都是 currentPeriod() 或控件值，不涉及该边界。
  function monthList(start, end) {
    var out = [];
    var s = String(start == null ? '' : start), e = String(end == null ? '' : end);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(e)) return out;
    var y = +s.slice(0, 4), m = +s.slice(5, 7);
    var ey = +e.slice(0, 4), em = +e.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) {
      out.push(y + '-' + pad2(m));
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  // 期间归一化：非法/空期间统一为 '0000-00'（早于任何真实期间 ⇒ 命中「只有期初、无发生额」空快照）。
  // 用途：新账套尚未录入凭证、或用户清空了期间选择器时，报表/账簿接口若直接对 undefined
  // 做 split/slice 会抛异常并导致页面白屏。归一化后返回空数据，页面可正常渲染。
  function normMonth(m) {
    var s = String(m == null ? '' : m).trim();
    return /^\d{4}-\d{2}$/.test(s) ? s : '0000-00';
  }
  function num(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return v;
    var s = String(v).replace(/[,\uFF0C\u3001]/g, '').replace(/\uFF0E/g, '.').replace(/[¥￥\s]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  // 金额显示：固定加千分位。
  // 原「凭证录入偏好设置」里的千分位开关已移除（该弹窗连同赤字检查一并删除），千分位改为默认行为。
  // 注意：导出 Excel 不受影响 —— 导出走原始数值（XLSX.utils.aoa_to_sheet 直接吃数字），不经过本函数；
  //       粘贴回输入框也没问题（num() 会先剥离千分位逗号）。
  function money(n) {
    return num(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }


  /* ---------- 现金流量主表项目（对照：标准现金流量表 36 行：经营1-10/投资11-22/筹资23-32/汇率33/净增加34/期初35/期末36） ---------- */
  // rowNum 为明细项目行次（小计/净额/净增加/期初/期末为计算行，不在此列）；分类标题行 rowNum 为空。
  var CASH_FLOW_ITEMS = [
    { id: 'cf_op',      name: '经营活动产生的现金流量', rowNum: '' },
    { id: 'cf_sale',    name: '销售商品、提供劳务收到的现金', rowNum: '1' },
    { id: 'cf_taxret',  name: '收到的税费返还', rowNum: '2' },
    { id: 'cf_opother', name: '收到其他与经营活动有关的现金', rowNum: '3' },
    { id: 'cf_buy',     name: '购买商品、接受劳务支付的现金', rowNum: '5' },
    { id: 'cf_payemp',  name: '支付给职工以及为职工支付的现金', rowNum: '6' },
    { id: 'cf_taxpay',  name: '支付的各项税费', rowNum: '7' },
    { id: 'cf_opothp',  name: '支付其他与经营活动有关的现金', rowNum: '8' },
    { id: 'cf_inv',     name: '投资活动产生的现金流量', rowNum: '' },
    { id: 'cf_invgain', name: '收回投资收到的现金', rowNum: '11' },
    { id: 'cf_invother',name: '取得投资收益收到的现金', rowNum: '12' },
    { id: 'cf_fixgain', name: '处置固定资产、无形资产和其他长期资产收回的现金净额', rowNum: '13' },
    { id: 'cf_dissub',  name: '处置子公司及其他营业单位收到的现金净额', rowNum: '14' },
    { id: 'cf_invothin',name: '收到其他与投资活动有关的现金', rowNum: '15' },
    { id: 'cf_invpay',  name: '购建固定资产、无形资产和其他长期资产支付的现金', rowNum: '17' },
    { id: 'cf_investpay', name: '投资支付的现金', rowNum: '18' },
    { id: 'cf_dissubpay', name: '取得子公司及其他营业单位支付的现金净额', rowNum: '19' },
    { id: 'cf_invothp', name: '支付其他与投资活动有关的现金', rowNum: '20' },
    { id: 'cf_fin',     name: '筹资活动产生的现金流量', rowNum: '' },
    { id: 'cf_absinv',  name: '吸收投资收到的现金', rowNum: '23' },
    { id: 'cf_finloan', name: '取得借款收到的现金', rowNum: '24' },
    { id: 'cf_finother',name: '收到其他与筹资活动有关的现金', rowNum: '25' },
    { id: 'cf_finrepay',name: '偿还债务支付的现金', rowNum: '27' },
    { id: 'cf_paydiv',  name: '分配股利、利润或偿付利息支付的现金', rowNum: '28' },
    { id: 'cf_finothp', name: '支付其他与筹资活动有关的现金', rowNum: '29' },
    { id: 'cf_exchg',   name: '汇率变动对现金的影响额', rowNum: '33' },
    { id: 'cf_cash',    name: '现金及现金等价物', rowNum: '' }
  ];

  /* ---------- 默认部门（酒店三部门，与工资模块 Salary.js 同源） ---------- */
  // 仅作空状态种子；用户可在「部门职员」中增删。浅拷贝避免账套间共享同一数组引用。
  var DEFAULT_DEPTS = [
    { code: '001', name: '前台', type: '部门', parent: '' },
    { code: '002', name: '客房', type: '部门', parent: '' },
    { code: '003', name: '餐厅', type: '部门', parent: '' }
  ];

  /* ---------- 默认资产类别（6 类，平均年限法） ----------
   * 【为什么从 Asset.js 搬到这里】这份预置原先只写在前端 Asset.js 的 assetCats() 里（懒创建），
   * 而「category 存类别**编码**」这条契约只写在 addFixedAsset 的注释里。结果是：Excel/外部账套导入
   * 把「类别**名称**」直接写进了 category 字段 —— 显示看不出问题（_catName 查不到编码就原样返回），
   * 但按类别筛选筛不到、编辑卡片时下拉选不中（保存后类别被清空）。
   * 归一（编码↔名称）与老账套回填都必须在**数据层**做，故把默认档案移到 store，前端只引用。
   * 浅拷贝避免账套间共享同一数组引用。 */
  var DEFAULT_ASSET_CATS = [
    { code: '001', name: '房屋、建筑物',     method: '平均年限法', life: 30, salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
    { code: '002', name: '机器机械生产设备', method: '平均年限法', life: 10, salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
    { code: '003', name: '器具、工具、家具', method: '平均年限法', life: 5,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
    { code: '004', name: '运输工具',         method: '平均年限法', life: 4,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
    { code: '005', name: '电子设备',         method: '平均年限法', life: 3,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
    { code: '006', name: '其他固定资产',     method: '平均年限法', life: 5,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true }
  ];

  /* ---------- 空状态（单一账套） ----------
   * standard: 会计准则机器键。当前仅 'small2013'（小企业会计准则 2013）一套，建账时由 newBook(key) 传入
   * reportRules: 该账套的报表规则快照（balanceSheet + incomeStatement），深拷贝自
   *              STANDARDS[key].reportRules，拷入后即与准则模板解耦，可逐账套独立编辑
   */
  function emptyState(standardKey) {
    var stdKey = standardKey && global.STANDARDS && global.STANDARDS[standardKey] ? standardKey : 'small2013';
    var snap = global.cloneStandard ? global.cloneStandard(stdKey) : null;
    var stdMeta = (global.STANDARDS && global.STANDARDS[stdKey]) || { label: '小企业会计准则' };
    return {
      schemaVersion: SCHEMA_VERSION,
      standard: stdKey,
      reportRules: snap ? snap.reportRules : {},
      company: { name: '演示账套', currency: '人民币', bookkeeper: '会计', startMonth: fmtDate(new Date()).slice(0, 7) },
      subjects: (snap ? snap.subjects : DEFAULT_SUBJECTS).map(function (s) { return Object.assign({}, s); }),
      openingBalances: {},   // { code: { dr:0, cr:0 } }
      vouchers: [],          // 凭证（全账套）
      fixedAssets: [],       // 固定资产卡片
      payrolls: [],          // 工资记录
      salaryVchTpls: [],     // 工资凭证模板（计提/发放）
      vchTemplates: [],      // 日常凭证模板（常用业务结构，按账套保存）
      settleTemplates: [],   // 期末处理自定义模板（外部账套导入 / 用户自建）
      depts: DEFAULT_DEPTS.map(function (s) { return Object.assign({}, s); }), // 部门职员种子（酒店三部门）
      assetCats: DEFAULT_ASSET_CATS.map(function (c) { return Object.assign({}, c); }), // 资产类别档案（默认 6 类）
      cashFlowItems: CASH_FLOW_ITEMS.map(function (it) { return Object.assign({}, it); }),
      subjectCashFlowMap: {}, // 科目→现金流量主表项目映射 { code: { credit:'项目id', debit:'项目id' } }
      operationLogs: [],      // 操作日志 [{ time, user, action, detail }]
      closedPeriods: [],     // 已结账月份列表 ['YYYY-MM', ...]
      voucherWords: [
        { name: '记', title: '记账凭证', enabled: true },
        { name: '收', title: '收款凭证', enabled: true },
        { name: '付', title: '付款凭证', enabled: true },
        { name: '转', title: '转账凭证', enabled: true }
      ],
      param: {
        standard: stdMeta.label,
        voucherWord: '记',
        // 账簿开关（仅保留已接真的两项；其余开关本项目无消费方，已移除）
        bookHideZero: false,           // 无发生额且余额为0不显示
        bookExpandAll: true            // 展开所有级次（默认✓）
      }
    };
  }

  /* ---------- 多账套索引（磁盘为真） ----------
   * 设计原则（/用友等桌面财务软件）：
   *   1. 账套列表与「账套是否存在」一律以磁盘（Storage.listBooks）为真相源，
   *      不再依赖易失的 localStorage 缓存（kis_books 已废弃）。
   *   2. 当前账套指针（上次关闭的店）与停用标记这类轻量 meta 落磁盘 meta.json，
   *      由 Storage.readMeta/writeMeta 读写，可靠且不随清缓存丢失。
   *   3. 内存 _bookList 仅作首屏/列表渲染的快取；失效时主动从磁盘重建，
   *      绝不拿它当「账套是否存在」的真理来源。
   */
  function setCurBookId(id) {
    try { localStorage.setItem('kis_cur', id); } catch (e) {}
  }
  // 读取磁盘 meta（当前指针 + 停用标记）；异步，返回 Promise<{last_book, disabled:{}}>
  function readBookMeta() {
    if (typeof window.Storage !== 'undefined' && window.Storage.readMeta) {
      return window.Storage.readMeta();
    }
    return Promise.resolve({ last_book: null, disabled: {} });
  }
  // 写入磁盘 meta；metaObj = { last_book, disabled }
  function writeBookMeta(metaObj) {
    if (typeof window.Storage !== 'undefined' && window.Storage.writeMeta) {
      return window.Storage.writeMeta(metaObj);
    }
    return Promise.resolve({ ok: false });
  }

  /* ---------- 自动识别准则 ----------
   * 已统一为小企业会计准则（2013），所有账套一律 small2013。
   * 保留函数签名兼容现有 normalizeState 调用链。
   */
  function detectStandardBySubjects(subjects) {
    return 'small2013';
  }

  /* ---------- 利润表规则行 id 回填（老账套迁移，幂等） ----------
   * 背景：state.reportRules 是准则模板的【深拷贝快照】，模板后续新增的字段不会自动进入老账套。
   * 而语义 id 是「首页与利润表同源取数」的枢纽（首页按 id 从利润表行取值，见 S.plSummary），
   * 老账套缺 id 会导致首页对应指标取不到数（显示 0），故按【codes 签名】从模板回填。
   *
   * 设计要点：
   *   ① 签名 = codes 排序后 join(',') —— 对用户调整科目顺序免疫；
   *   ② codes 为空的行不参与 —— 模板内多行空 codes 同签名，无法唯一匹配（其 id 仅作占位）；
   *   ③ 汇总【所有】准则模板建索引，而不只是本账套 standard —— 账套准则可能被
   *      detectStandardBySubjects 重判定，而两套模板签名互斥（5xxx / 6xxx），合并索引无冲突；
   *   ④ 已有 id 的行一律不动（幂等，绝不覆盖历史值）；
   *   ⑤ 只改内存，随下一次正常写盘落库（与 normalizeState 的只读语义一致）。
   * 返回值：本次回填的行数（供自检/回归脚本用）。
   */
  function rowSigOfCodes(codes) {
    return (codes || []).map(String).slice().sort().join(',');
  }
  function backfillIncomeRowIds(rules) {
    if (!rules || !Array.isArray(rules.incomeStatement)) return 0;
    var stds = (global.STANDARDS || {});
    var bySig = {};
    Object.keys(stds).forEach(function (k) {
      var tpl = stds[k] && stds[k].reportRules && stds[k].reportRules.incomeStatement;
      if (!Array.isArray(tpl)) return;
      tpl.forEach(function (r) {
        if (!r || r.type === 'subtotal' || !r.id) return;
        var sig = rowSigOfCodes(r.codes);
        if (!sig || bySig[sig]) return;
        bySig[sig] = r.id;
      });
    });
    var n = 0;
    rules.incomeStatement.forEach(function (r) {
      if (!r || r.type === 'subtotal' || r.id) return;
      var id = bySig[rowSigOfCodes(r.codes)];
      if (id) { r.id = id; n++; }
    });
    return n;
  }

  /* ---------- Store 单例 ---------- */
  var S = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    state: null,
    bookId: '',
    // 说明：
    // screenLockPassword —— 屏保锁屏密码（当前无设置入口，保留字段兼容旧数据）。
    // opPassword —— 高危操作密码（导入数据 / 本地备份恢复等会覆盖账本的操作），
    // 在设置页单独设置；留空清除；opOverridden=true 表示用户已单独设置。
    settings: {
      screenLockEnabled: false,
      screenLockTimeout: '5',
      screenLockPassword: '',
      screenLockOverridden: false,
      opPassword: '',
      opOverridden: false,
      guideDone: false
    },

    // 初始化：账套列表与完整 state 一律以磁盘（Storage）为真相源。
    // 首屏先用空账套占位，避免 null 引用；随后从磁盘读取「上次关闭的店」并加载其完整 state。
    init: function () {
      // 清空总账记忆化缓存（账套/凭证可能变化）
      this._glCache = {};
      this._bookList = []; // 账套列表内存快取（由 refreshBookIndex 从磁盘填充，不作真理源）
      // 全局设置（屏保密码、新手引导）从独立 localStorage 读取
      try {
        var s = localStorage.getItem('kis_settings');
        if (s) this.settings = Object.assign({
          screenLockEnabled: false, screenLockTimeout: '5',
          screenLockPassword: '', screenLockOverridden: false,
          opPassword: '', opOverridden: false, guideDone: false
        }, JSON.parse(s));
      } catch (e) {}
      // 旧单账套数据迁移：若用户文档下还没有任何账套，但有旧 localStorage 单账套，则落盘为首账套。
      // 仅做一次，避免每次启动重复迁移。
      var self = this;
      this.state = emptyState();
      this.bookId = '';
      this.normalizeState();
      this.ensureCashFlowFields();
      this.ensureVoucherIds();
      this._writeLocalBookSafe();
      // 页面关闭/刷新前的最终落盘保险：见 _bindExitFlush 注释
      this._bindExitFlush();
      // 异步初始化 Storage 引擎：迁移旧数据 → 刷新账套列表 → 读取上次店 → 加载完整 state
      this._initStorageEngine();
      return this;
    },

    // 异步初始化 Storage 引擎（不阻塞首屏）
    _initStorageEngine: function () {
      var self = this;
      if (typeof window.Storage === 'undefined') { self._setServerStatus(false); return; }
      window.Storage.init()
        .then(function () { return self._migrateOldData(); })        // 迁移旧 localStorage 单账套
        .then(function () { return self.refreshBookIndex(); })       // 从磁盘刷新账套列表
        .then(function () { return self._migrateEmptyIdBook(); })    // 修复：空 id 垃圾账套 → 有效 id
        .then(function () { return readBookMeta(); })                // 读「上次关闭的店」
        .then(function (meta) {
          var last = meta.last_book;
          var ids = self._bookList.map(function (b) { return b.id; });
          // 打开软件默认进入上次关闭时的店；若上次店已不存在，则退回 default（主账套），
          // 再否则退回列表中第一个；都没则留在空账套。
          if (last && ids.indexOf(last) >= 0) {
            self.bookId = last;
          } else if (ids.indexOf('default') >= 0) {
            self.bookId = 'default';
          } else if (ids.length) {
            self.bookId = ids[0];
          } else {
            self.bookId = '';
          }
          // 兜底：当前指针为空但有账套时，强制回退到 default / 第一个（绝不让 bookId 悬空，
          // 否则手动备份会因空指针直接失败）。
          if (!self.bookId) {
            var fb = (self._bookList || []).map(function (b) { return b && b.id; }).filter(function (x) { return !!x; });
            self.bookId = fb.indexOf('default') >= 0 ? 'default' : (fb[0] || '');
          }
          setCurBookId(self.bookId || '');
          self._lastMeta = meta; // 缓存停用标记等，供 isBookEnabled 同步使用
          // 加载当前账套完整 state（磁盘权威）
          return self._loadCurrentBook();
        })
        .then(function () {
          // Tauri 桌面版：Storage 恒为真实文件模式（数据落在应用数据目录/添钰财务/），
          // 不再需要浏览器端「探测授权 / 选择目录」流程，直接标记为已就绪。
          self._setServerStatus(true);
        })
        .catch(function (e) {
          console.warn('[Store] Storage 引擎初始化异常：' + (e && e.message || e));
          self._setServerStatus(false);
        });
    },

    // 修复历史脏数据：若磁盘存在「空 id」账套文件（books/.json，由早期空 bookId bug 产生），
    // 将其迁移为有效 id（'B'+时间戳）的账套并重建索引，避免空指针导致账套被隐藏/备份失败。
    _migrateEmptyIdBook: function () {
      var self = this;
      if (typeof window.Storage === 'undefined') return Promise.resolve();
      return window.Storage.listBooks().then(function (ids) {
        var hasEmpty = (ids || []).some(function (id) { return !id || !String(id).trim(); });
        if (!hasEmpty) return Promise.resolve();
        return window.Storage.loadBook('').then(function (txt) {
          if (!txt) return Promise.resolve();
          var newId = 'B' + Date.now();
          return window.Storage.saveBook(newId, txt).then(function () {
            return window.Storage.deleteBook('').catch(function () {});
          }).then(function () {
            console.warn('[Store] 已将空 id 垃圾账套迁移为有效账套：' + newId);
            return self.refreshBookIndex();
          });
        });
      }).catch(function () { return Promise.resolve(); });
    },

    // 从磁盘加载当前 bookId 的完整 state（权威数据），失败则回滚到空账套并上报
    _loadCurrentBook: function () {
      var self = this;
      if (!self.bookId) { self.state = emptyState(); self.normalizeState(); self.ensureCashFlowFields(); return Promise.resolve(); }
      return window.Storage.loadBook(self.bookId).then(function (txt) {
        if (!txt) { self.state = emptyState(); self.normalizeState(); self.ensureCashFlowFields(); return; }
        var res;
        try { res = JSON.parse(txt); } catch (e) { throw new Error('parse_fail'); }
        if (res && res.empty) { self.state = emptyState(); self.normalizeState(); self.ensureCashFlowFields(); return; }
        if (res && res.subjects && res.vouchers) {
          if (res.schemaVersion == null) res.schemaVersion = SCHEMA_VERSION;
          self.state = res;
          self.normalizeState();
          self.ensureVoucherIds();
          self.ensureCashFlowFields();
          if (window.__refreshAll) window.__refreshAll();
        } else {
          self.state = emptyState(); self.normalizeState(); self.ensureCashFlowFields();
        }
      }).catch(function (err) {
        console.error('[Store] 加载账套「' + self.bookId + '」失败：' + ((err && err.message) || err));
        self.state = emptyState(); self.normalizeState();
      });
    },

    // 旧单账套数据迁移：仅当磁盘尚无任何账套、且存在旧 localStorage 单账套时，落盘为首账套 default
    _migrateOldData: function () {
      var self = this;
      if (typeof window.Storage === 'undefined') return Promise.resolve();
      return window.Storage.listBooks().then(function (ids) {
        if (ids && ids.length) return; // 已有账套，无需迁移
        var old = null;
        try { old = localStorage.getItem('kis_state'); } catch (e) {}
        if (!old) return;
        var parsed;
        try { parsed = JSON.parse(old); } catch (e) { return; }
        if (!parsed || !parsed.subjects || !parsed.vouchers) return;
        return window.Storage.saveBook('default', JSON.stringify(parsed)).then(function () {
          setCurBookId('default');
        }).catch(function () {});
      }).catch(function () { return; });
    },

    // 探测本地存储引擎状态：是否已获文件写权限（真实文件落盘）。
    // 未获权限时页面顶部横幅提醒「数据仅存浏览器，清缓存即丢；请在设置中导出备份」，
    // 避免用户误以为已落盘。persist 时也会同步更新横幅。
    _setServerStatus: function (ok) {
      this._serverOk = !!ok;
      if (typeof window.__setServerStatus === 'function') window.__setServerStatus(ok);
    },

    // —— 页面关闭/刷新前的最终落盘保险 ——
    // 页面关闭/刷新前的最终落盘保险：若用户在防抖窗口（3 秒）内或写入在途时直接关闭窗口，
    // 此处绑定 pagehide/beforeunload 兜底再落一次真实文件（Storage 引擎），保证数据最终落盘。
    _bindExitFlush: function () {
      if (typeof window.addEventListener !== 'function') return;
      var self = this;
      var flushed = false; // 同一次关闭流程（beforeunload + pagehide 双触发）只发一次
      function onExit() {
        if (flushed) return;
        flushed = true;
        self._flushOnExit();
      }
      window.addEventListener('pagehide', onExit);
      window.addEventListener('beforeunload', onExit);
      // bfcache 恢复（前进/后退回来）时重置标志，避免页面复活后再次关闭时漏发
      window.addEventListener('pageshow', function () { flushed = false; });
    },
    _flushOnExit: function () {
      var bid = this.bookId;
      if (!bid || !this.state) return;
      // 仅当确有未完成的写入（主账本在途/堆积，或自动备份防抖未收尾/在途）时才兜底，
      // 避免每次关闭页面都重复全量发送。
      var needBook = this._persistBusy === bid || !!this._persistPending;
      var needBk = this._bkInFlight || !!this._bkTimer || !!this._bkDirty;
      if (this._bkTimer) { clearTimeout(this._bkTimer); this._bkTimer = null; this._bkWindow = false; this._bkDirty = false; }
      if (!needBook && !needBk) return;
      var payload = JSON.stringify(this.state);
      // 兜底落真实文件（Storage 引擎：Rust 写 <应用数据目录>/添钰财务/）
      if (typeof window.Storage !== 'undefined') {
        /* 页面关闭兜底：此刻无法再给用户任何 UI 提示（窗口正在销毁），静默是合理的；
           但仍留一条日志 —— 否则「关页面时最后几笔没落盘」将完全无迹可查。
           正常路径的失败告警由 _persist 的 __onPersistError 机制承担（见上）。 */
        if (needBook) window.Storage.saveBook(bid, payload).catch(function (e) {
          console.warn('[exit-flush] 关闭时主账本兜底写入失败：' + (e && e.message || e));
        });
        if (needBk) window.Storage.saveBackup(bid, this.state).catch(function (e) {
          console.warn('[exit-flush] 关闭时备份兜底写入失败：' + (e && e.message || e));
        });
      }
      // 数据真相源在磁盘，无需再写 localStorage 缓存；仅持久化当前账套指针即可。
      setCurBookId(bid);
    },

    // 保存全局设置
    saveSettings: function () {
      try { localStorage.setItem('kis_settings', JSON.stringify(this.settings)); } catch (e) {}
    },

    // 轻量持久化：仅更新当前账套指针（kis_cur），不再写 kis_books 混乱缓存。
    // 真实账本以磁盘为准（Storage.saveBook）。此函数无副作用风险，可随时调用。
    _writeLocalBookSafe: function () {
      if (this.bookId) setCurBookId(this.bookId);
    },

    // 给凭证强制统一【稳定】id（word + '-' + no），保证 localStorage 缓存与服务端数据 id 始终一致，避免查凭证点击定位失败
    ensureVoucherIds: function () {
      if (this.state && this.state.vouchers && this.state.vouchers.length) {
        // 口径必须与 addVoucher 使用的 _calcVoucherId 严格一致（含月份），
        // 否则凭证 id 会在每次重载时被改写，导致原始凭证/固定资产等按 voucherId 的引用失效。
        var self = this;
        var seen = {};
        this.state.vouchers.forEach(function (v) {
          var base = (v.word || '记') + '-' + (v.no != null ? v.no : '') + '@' + voucherMonth(v);
          seen[base] = (seen[base] || 0) + 1;
          v.id = seen[base] > 1 ? (base + '-' + seen[base]) : base;
        });
      }
    },
    // 从磁盘真实文件（<应用数据目录>/添钰财务/books/<id>.json，由 Rust Storage 引擎管理）拉取权威账本。
    // 复用 _loadCurrentBook（已含 normalize / 币种对齐 / ensureVoucherIds / ensureCashFlowFields）。
    // 版本冲突仍交由 __onSchemaMismatch 钩子决策，避免静默丢数据。
    loadCurrentBookFromDisk: function () {
      var self = this;
      if (typeof window.Storage === 'undefined') {
        // 引擎未就绪：保留内存数据，不切换
        console.warn('[Store] Storage 引擎未加载，跳过从磁盘加载');
        return;
      }
      window.Storage.loadBook(this.bookId)
        .then(function (txt) {
          if (!txt) return; // 本地账套文件尚无该账套
          var res;
          try { res = JSON.parse(txt); } catch (e) { throw new Error('parse_fail'); }
          if (res && res.empty) return; // 本地账套文件尚无该账套
          if (res && res.subjects && res.vouchers) {
            if (res.schemaVersion != null && res.schemaVersion !== SCHEMA_VERSION) {
              // 版本不一致：不再静默忽略（会悄悄丢数据），改为交由 UI 决策
              console.warn('[Store] 本地账套文件版本(' + res.schemaVersion + ') 与程序(' + SCHEMA_VERSION + ') 不一致');
              if (typeof window.__onSchemaMismatch === 'function') {
                self._pendingServerState = res;
                window.__onSchemaMismatch(res.schemaVersion, SCHEMA_VERSION, function applyServer() {
                  if (!self._pendingServerState) return;
                  self.state = self._pendingServerState;
                  self._pendingServerState = null;
                  self.ensureVoucherIds();
                  if (window.__refreshAll) window.__refreshAll();
                });
              } else {
                console.warn('[Store] 未挂载版本冲突处理钩子，已保留本地账本');
              }
              return;
            }
            self.state = res;
            self.normalizeState();
            self.ensureVoucherIds();
            self.ensureCashFlowFields();
            if (window.__refreshAll) window.__refreshAll();
          }
        })
        .catch(function (err) {
          var emsg = (err && err.message) || '';
          console.error('[Store] 读取本地账套文件「' + self.bookId + '」失败：' + emsg);
          self._reportBookBroken(self.bookId);
        });
    },

    // 当前激活账套服务端不可读：标记损坏状态并提示，维持在本地兜底数据，不做任何自动切换/导入。
    _reportBookBroken: function (id) {
      this._bookBroken = true;
      this._bookBrokenId = id;
      // 顶部醒目提示（不静默）
      if (typeof window.__showBookBroken === 'function') {
        window.__showBookBroken(id);
      } else {
        console.error('[Store] 当前账套「' + id + '」服务端读取失败（可能文件已损坏），请用「数据恢复」或重新导入账套');
      }
      // 仍刷新一次界面，让页面渲染出"账套异常"提示而非空白
      if (window.__refreshAll) window.__refreshAll();
    },

    // 写盘失败告警（数据安全）：财务软件最危险的故障是"静默保存失败"——
    // 用户以为已记账，实际未落盘，退出后数据全丢。故必须在 UI 上显性告警。
    _onSaveFail: function (err) {
      this._saveFailCount = (this._saveFailCount || 0) + 1;
      console.error('[persist] 主账本保存失败（第 ' + this._saveFailCount + ' 次）：' + err);
      if (typeof window.__onPersistError === 'function') {
        try { window.__onPersistError(err, this._saveFailCount); } catch (e) {}
      }
    },
    _onSaveOk: function () {
      if (this._saveFailCount) { this._saveFailCount = 0; if (typeof window.__onPersistOk === 'function') window.__onPersistOk(); }
    },
    persist: function () {
      // 轻量持久化当前账套指针（真实数据由下方 Storage.saveBook 落盘）
      this._writeLocalBookSafe();
      var self = this;
      var bid = this.bookId;
      // bookId 为空（启动/刷新初期尚未选定账套）时直接跳过落盘：
      // 空 id 提交给 Rust 会被拒绝而误触「保存失败」告警；账套数据由
      // load 完成后首次业务动作才需要持久化，此处绝不落空盘。
      if (!bid) return;
      var payload;
      try {
        payload = JSON.stringify(this.state);
      } catch (e) {
        // 序列化失败（如状态里混入循环引用）→ 直接告警，绝不静默
        this._onSaveFail('账套序列化失败：' + (e && e.message || e));
        return;
      }
      // 真实文件落盘（Storage.js → Rust 写 <应用数据目录>/添钰财务/books/<id>.json）
      if (typeof window.Storage !== 'undefined') {
        window.Storage.saveBook(bid, payload).then(function (r) {
          // Storage.saveBook 内部已 catch，恒为 resolved：必须判 r.ok，
          // 否则写盘失败也会被当成成功（原实现的致命缺陷）。
          if (r && r.ok === false) {
            self._setServerStatus(false);
            self._onSaveFail((r && r.error) || '未知原因');
            return;
          }
          self._setServerStatus(true); // 桌面版恒为文件模式
          self._onSaveOk();
        }).catch(function (e) {
          self._setServerStatus(false);
          self._onSaveFail(e && e.message || e);
        });
      }
      // 自动备份（防抖节流，常开不可关）：落 Rust 备份目录（<应用数据目录>/添钰财务/backups，环形保留）。
      // 桌面版数据即文件，无需浏览器缓存兜底。
      // 备份失败连续 ≥3 次时，复用主账本保存失败的 UI 横幅告警——磁盘满/权限等问题
      // 若长期静默，用户以为有备份实际没有，丢失数据后才发现为时已晚。
      try {
        var doAutoBk = function (st) {
          self._bkInFlight = true; // 在途标记：供页面关闭兜底（_flushOnExit）识别尾发尚未完成
          if (typeof window.Storage !== 'undefined') {
            return window.Storage.saveBackup(bid, st).then(function () {
              self._bkInFlight = false;
              if (self._bkFailCount) { self._bkFailCount = 0; } // 成功则清零失败计数
            }).catch(function (e) {
              self._bkInFlight = false;
              self._bkFailCount = (self._bkFailCount || 0) + 1;
              console.warn('[persist] 自动备份失败（第 ' + self._bkFailCount + ' 次）：' + (e && e.message || e));
              if (self._bkFailCount >= 3 && typeof window.__onPersistError === 'function') {
                try { window.__onPersistError('自动备份连续失败 ' + self._bkFailCount + ' 次，请检查磁盘空间/权限', self._bkFailCount); } catch (_) {}
              }
            });
          }
          self._bkInFlight = false;
          return Promise.resolve();
        };
        if (!self._bkWindow) {
          self._bkWindow = true;
          doAutoBk(self.state); // 首发：立即落一份
          self._bkTimer = setTimeout(function () {
            self._bkWindow = false;
            self._bkTimer = null;
            if (self._bkDirty) { self._bkDirty = false; doAutoBk(self.state); } // 尾发：窗口内最新 state
          }, 3000);
        } else {
          self._bkDirty = true; // 窗口期内只标记，由尾发统一携带最新 state
        }
      } catch (e) {
        console.warn('[persist] 自动备份异常：' + (e && e.message || e));
      }
    },

    // 当前账套 id
    currentBookId: function () { return this.bookId; },

    // 全部可选期间（启用月→当前月含已结账月），供顶部期间切换
    allMonths: function () {
      var startRaw = (this.state.company && this.state.company.startMonth) || '2026-01';
      // 规范化启用月：空账套常见 startMonth='202600'（月份00），必须回退到同年01月，
      // 否则会生成非法月 '2026-00'，导致折线图/趋势图数据全 0、显示异常。
      var sp = startRaw.split('-');
      var sy = +sp[0] || 2026, sm = +sp[1];
      if (!sm || sm < 1 || sm > 12) sm = 1;
      var start = sy + '-' + ('0' + sm).slice(-2);
      var cur = (function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); })();
      var end = this.period && this.period > cur ? this.period : cur;
      // 截断到数据实际最后一个月：未来月份（无凭证）不应出现在账期内，
      // 否则折线图/趋势图末尾会多出一个全 0 的平直点（如系统月2026-08但数据只到2026-07）。
      var lastV = this.lastVoucherMonth();
      if (lastV && lastV < end) end = lastV;
      // 月份区间展开统一走 monthList（此前此处内联展开了一份，属重复实现）
      return monthList(start, end);
    },
    // 账套中最后一笔凭证的月份（数据实际边界）。无凭证返回 ''。
    lastVoucherMonth: function () {
      var last = '';
      (this.state.vouchers || []).forEach(function (v) {
        var m = voucherMonth(v);
        if (m && m > last) last = m;
      });
      return last;
    },

    // 列出所有账套（以磁盘 Storage.listBooks 为真相源）。
    // 返回的内存数组为渲染快取；「账套是否存在」以磁盘为准，调用方不可将其当作真理源。
    listBooks: function () {
      return (this._bookList || []).map(function (b) {
        return { id: b.id, name: b.name, period: b.period, vouchers: b.vouchers || 0 };
      });
    },

    // 从磁盘刷新账套列表（唯一权威来源）。返回 Promise<list>。
    // 同步视图 this._bookList 仅用于首屏/列表渲染速度，任何「账套是否存在」判定
    // 都应先调用本函数刷新，或直接基于 Storage.listBooks 的结果。
    refreshBookIndex: function () {
      var self = this;
      if (typeof window.Storage === 'undefined') return Promise.resolve(self._bookList || []);
      return window.Storage.listBooks().then(function (ids) {
        var chain = Promise.resolve([]);
        // 逐个读取账套元信息（name/期间/凭证数）以填充列表；读取失败不阻塞其余账套
        var results = [];
        (ids || []).forEach(function (id) {
          // 跳过空 id 的垃圾账套（历史错误产物，如 books/.json），避免把空指针当账套
          if (!id || !String(id).trim()) return;
          chain = chain.then(function () {
            return window.Storage.loadBook(id).then(function (txt) {
              var meta = { id: id, name: id, period: '', vouchers: 0 };
              if (txt) {
                try {
                  var st = JSON.parse(txt);
                  meta.name = (st.company && st.company.name) || id;
                  meta.period = (st.company && st.company.startMonth) || '';
                  meta.vouchers = (st.vouchers || []).length;
                } catch (e) {}
              }
              results.push(meta);
            }).catch(function () { results.push({ id: id, name: id, period: '', vouchers: 0 }); });
          });
        });
        return chain.then(function () {
          self._bookList = results;
          return results;
        });
      }).catch(function () {
        return self._bookList || [];
      });
    },


    // 新建账套（可建多个核算主体）。standardKey 当前仅 'small2013' 可用，默认 'small2013'。
    // （原注释写作「默认 'old'」，与下方 emptyState(standardKey || 'small2013') 不符，已更正）
    // startMonth: 启用期间（'YYYY-MM'），建账时定稿；缺省/非法时回落 emptyState 的建账当月
    newBook: function (name, standardKey, startMonth) {
      var id = 'B' + Date.now();
      var st = emptyState(standardKey || 'small2013');
      st.company.name = name && name.trim() ? name.trim() : '新建账套';
      if (typeof startMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth)) {
        st.company.startMonth = startMonth;
      }
      this.state = st;
      this.bookId = id;
      setCurBookId(id);
      var self = this;
      // 立即写入真实文件（<应用数据目录>/添钰财务/books/<id>.json），不依赖防抖，
      // 防止快速切换时账套只存在于内存、刷新后丢失。
      this.ensureCashFlowMap();
      this.addLog('新建账套', '新建账套「' + (st.company.name || name || '') + '」', '账套');
      this.persist();
      // 落盘完成后（而非立即）再刷新账套列表，确保新建账套一定会出现在列表里
      // （避免 saveBook 异步写盘与 refreshBookIndex 读盘竞态导致刚建的账套短暂缺失）。
      if (typeof window.Storage !== 'undefined') {
        window.Storage.saveBook(id, JSON.stringify(st))
          .then(function () { return self.refreshBookIndex(); })
          .catch(function (e) {
            console.warn('[newBook] 账套落盘失败：' + (e && e.message || e));
            return self.refreshBookIndex();
          });
      } else {
        this.refreshBookIndex();
      }
      return id;
    },

    isBookEnabled: function (id) {
      var m = this._lastMeta && this._lastMeta.disabled;
      if (m && m[id] === true) return false;
      return true; // 默认启用
    },
    setBookEnabled: function (id, enabled) {
      var self = this;
      var meta = this._lastMeta || { last_book: this.bookId || null, disabled: {} };
      meta.disabled = meta.disabled || {};
      if (enabled) { delete meta.disabled[id]; } else { meta.disabled[id] = true; }
      this._lastMeta = meta;
      writeBookMeta(meta).then(function () {});
      return true;
    },
    // 记录「当前账套指针」到磁盘 meta（关闭软件后重开默认进入此账套）。
    // 供导入账套 / 切换账套 / 恢复备份后调用，保证指针可靠（不赖易失缓存）。
    setCurrentBookMeta: function (id) {
      var meta = this._lastMeta || { last_book: null, disabled: {} };
      meta.last_book = id;
      this._lastMeta = meta;
      writeBookMeta(meta).then(function () {});
      setCurBookId(id || '');
    },

    // 从备份（本地快照/备份文件）恢复账套状态，覆盖当前账本并刷新界面。
    // 立即落真实文件（不依赖防抖），确保恢复结果同步到磁盘，刷新页面不会被旧数据覆盖。
    restoreBookState: function (st) {
      if (!st || !st.company) { console.warn('[restoreBookState] 无效备份数据'); return false; }
      this.state = st;
      // 【必须作废总账缓存】恢复的是**同一账套**（bookId 不变），而缓存键是 bookId|month ——
      // 不作废的话，恢复后查询同月份会命中「恢复前」的旧缓存，账簿/报表继续显示旧数。
      // （switchBook 因换了 bookId 天然隔绝，故此前未暴露；restoreFromData 已显式清理，此处曾遗漏。）
      this._glCache = {};
      this.normalizeState();
      this.ensureVoucherIds();
      this._writeLocalBookSafe();
      this.addLog('恢复备份', '从备份恢复账套状态', '账套');
      // 立即落真实文件（<应用数据目录>/添钰财务/books/<id>.json）
      if (typeof window.Storage !== 'undefined') {
        window.Storage.saveBook(this.bookId, JSON.stringify(this.state)).catch(function (e) {
          console.warn('[restoreBookState] 账套落盘失败：' + (e && e.message || e));
        });
      }
      this.persist(); // 防抖再确认一次（含变更日志）
      // 纯本地单机版：数据已落本地，无需同步云端
      if (window.__refreshAll) window.__refreshAll();
      this.refreshBookIndex(); // 同步列表索引
      return true;
    },

    // 切换账套（账套间独立核算）
    // 财务软件铁律：先保存当前账套 → 再从磁盘读取目标账套权威完整 state → 成功才切换，失败回滚报错。
    // 账套是否存在以磁盘 Storage.listBooks 为准（先刷新一次内存列表再判定），绝不以 localStorage 缓存判定。
    switchBook: function (id) {
      var self = this;
      if (!id) return { ok: false, msg: '账套不存在' };
      // 目标即当前：无需切换
      if (id === this.bookId) return { ok: true };
      // 先确保当前账套改动已落盘（防快速切换丢数据）
      if (this.state && typeof window.Storage !== 'undefined') {
        try { window.Storage.saveBook(this.bookId, JSON.stringify(this.state)).catch(function () {}); } catch (e) {}
      }
      // 以磁盘为准判定账套是否存在：刷新列表后再查，仍不存在则拒绝
      var proceed = function () {
        var ids = (self._bookList || []).map(function (b) { return b.id; });
        if (ids.indexOf(id) < 0) return { ok: false, msg: '账套不存在' };
        if (!self.isBookEnabled(id)) return { ok: false, msg: '该账套已停用，请先启用' };
        var prevId = self.bookId, prevState = self.state;
        self.bookId = id;
        setCurBookId(id);
        // 记录「上次关闭的店」到磁盘 meta（关闭软件后重开默认进入此店）
        var meta = self._lastMeta || { last_book: null, disabled: {} };
        meta.last_book = id; self._lastMeta = meta; writeBookMeta(meta).then(function () {});
        // 用临时空账套顶屏，避免旧账套数据显示；随后从磁盘加载权威数据
        self.state = emptyState();
        self.normalizeState();
        // 关键：切换账套必须作废总账记忆化缓存。否则查询「同月份」时会命中上一个账套的
        // 缓存结果，导致新账套的账簿/报表显示旧账套数据（错误数据且难以察觉）。
        self._glCache = {};
        window.Storage.loadBook(id).then(function (txt) {
          if (!txt) { self.state = prevState; self.bookId = prevId; setCurBookId(prevId); return; }
          var res;
          try { res = JSON.parse(txt); } catch (e) { self.state = prevState; self.bookId = prevId; setCurBookId(prevId); return; }
          if (res && res.subjects && res.vouchers) {
            if (res.schemaVersion == null) res.schemaVersion = SCHEMA_VERSION;
            self.state = res;
            self.normalizeState();
            self.ensureVoucherIds();
            self.ensureCashFlowFields();
            self._glCache = {}; // 新账套数据，作废总账缓存
            if (window.__refreshAll) window.__refreshAll();
          } else {
            // 目标账套数据异常：回滚到原账套
            self.state = prevState; self.bookId = prevId; setCurBookId(prevId);
          }
        }).catch(function () {
          // 加载失败：回滚
          self.state = prevState; self.bookId = prevId; setCurBookId(prevId);
        });
        return { ok: true };
      };
      // 若内存列表尚未含目标（可能首屏未刷新全），先刷新再判定
      if ((this._bookList || []).map(function (b) { return b.id; }).indexOf(id) < 0) {
        return this.refreshBookIndex().then(function () { return proceed(); });
      }
      return proceed();
    },

    // 删除账套（异步：必须先等真实文件删除完成、再重建索引，否则列表会因读盘竞态仍显示该账套）
    // 注意：此操作不再是"直接删除"，而是移入回收站 trash/，保留 7 天可还原。
    // 账套是一整个店的账，删除改为移入回收站（保留 7 天可还原），避免一次手滑造成不可逆损失。
    removeBook: function (id) {
      var self = this;
      if (this.bookId === id) return Promise.resolve({ ok: false, msg: '不能删除当前账套' });
      // 以磁盘为准判定账套是否存在
      var ids = (this._bookList || []).map(function (b) { return b.id; });
      if (ids.indexOf(id) < 0) return Promise.resolve({ ok: false, msg: '账套不存在' });
      var name = '';
      (this._bookList || []).forEach(function (b) { if (b.id === id) name = b.name; });

      // 1) 移入回收站（trash/<id>__<ts>.json）
      var doDelete = function () {
        if (typeof window.Storage !== 'undefined' && window.Storage.trashBook) {
          return window.Storage.trashBook(id).catch(function (e) {
            console.warn('[removeBook] 移入回收站失败：' + (e && e.message || e));
            throw e; // 移入失败必须中断，否则用户以为删了、文件还在，列表会"复活"
          });
        }
        // 旧引擎无回收站能力时退回真删，保持向后兼容
        if (typeof window.Storage !== 'undefined') {
          return window.Storage.deleteBook(id).catch(function (e) {
            console.warn('[removeBook] 删除磁盘账套失败：' + (e && e.message || e));
          });
        }
        return Promise.resolve();
      };

      return doDelete().then(function () {
        // 2) 增量变更日志（审计追溯）：删除账套是跨账套生命周期事件，记入全局 changelog
        // （不写账套内 operationLogs——账套已移入回收站，写了也随文件消失；kis_audit 历史层冗余已废弃）。
        // 带 user（当前记账员），供「系统事件」视图展示操作人。
        try {
          if (typeof window.Storage !== 'undefined') {
            window.Storage.appendChangeLog({
              bookId: id, action: '删除账套', module: '账套', detail: '删除账套「' + name + '」',
              user: (self.state.company && self.state.company.bookkeeper) || '会计'
            }).catch(function () {});
          }
        } catch (e) {}
        // 3) 清理跟随该账套的结账自定义/预置模板（全局 localStorage，按 bookId 归属标记），
        //    避免删除账套后这些模板仍残留在全局、下次进入其它账套时串台显示
        try {
          var TMPL_KEY = 'settle_templates_v1';
          var list = JSON.parse(localStorage.getItem(TMPL_KEY) || '[]');
          if (Array.isArray(list)) {
            // 仅按 bookId 清理：系统默认模板（dep/cost/vat/surTax/incTax/profit）永远不带 bookId，不会被误删；
            // 其余跟随账套的自定义/预置模板带上 bookId，删除账套时随之清除
            var kept = list.filter(function (t) { return !(t && t.bookId === id); });
            if (kept.length !== list.length) localStorage.setItem(TMPL_KEY, JSON.stringify(kept));
          }
        } catch (e) {}
        // 4) 待主账本真正删完后重建索引，确保列表与磁盘一致
        return self.refreshBookIndex().then(function () {
          return { ok: true, name: name };
        });
      });
    },


    /* ===================== 科目 ===================== */
    subjects: function () {
      // 父/level 实算用的全量编码集（状态内的原始科目，不做自身递归）
      var rawList = this.state.subjects;
      var allBy = {};
      rawList.forEach(function (x) { allBy[String(x.code)] = 1; });
      function longestParent(code) {
        var c = String(code || ''), best = '';
        for (var L = c.length - 1; L > 0; L--) {
          var pre = c.slice(0, L);
          if (allBy[pre]) { best = pre; break; }
        }
        return best;
      }
      return this.state.subjects.slice().sort(function (a, b) {
        return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0);
      }).map(function (s) {
        // level/parent 缺失时兜底：以「表内最长真前缀」实算，1 基（一级=1）。
        // 与 normalizeState 的存量校正同口径，任何奇数位/混长账套结果一致。
        if (typeof s.level !== 'number') {
          var p = longestParent(s.code);
          var cur = p, lvl = 1, guard = 0;
          while (cur && guard++ < 40) {
            lvl++;
            var pp = '';
            for (var L2 = cur.length - 1; L2 > 0; L2--) {
              var pre2 = cur.slice(0, L2);
              if (allBy[pre2]) { pp = pre2; break; }
            }
            cur = pp;
          }
          s.level = lvl;
        }
        if (typeof s.parent !== 'string') s.parent = longestParent(s.code);
        return s;
      });
    },
    subject: function (code) {
      return this.state.subjects.filter(function (s) { return s.code === code; })[0] || null;
    },
    // 科目层级缩进：所有科目相关页面（总账/余额表/科目设置/费用明细表）统一用这个函数。
    // 缩进单位 14px/level，只缩进名称列（编码列锚定不动）。
    // 用法：S.subjectIndentHTML(level) 返回 <span> 缩进占位 HTML，拼到名称前面。
    subjectIndentHTML: function (level) {
      var lv = Math.max(0, Math.floor(level) || 0);
      return '<span style="display:inline-block;width:' + (lv * 14) + 'px"></span>';
    },
    // 导出 XLSX 时的空格缩进（HTML  span 在 Excel 里无效，用空格模拟层级）。
    subjectIndentSpaces: function (level) {
      var lv = Math.max(0, Math.floor(level) || 0);
      var s = '';
      for (var i = 0; i < lv; i++) s += '  ';
      return s;
    },

    /* =========================
     * 树形折叠公共工具（科目设置/余额表/费用明细表/总账共用）
     * 状态语义统一：expanded = Set() — 存"已展开"的科目编码
     *   - 空 Set → 默认全收起（只露一级父科目）
     *   - Set.has(code) = true → 该科目已展开（可见其直接子级）
     *   - 祖先级联：祖先链上任一不在 expanded 中 → 子级隐藏
     * ========================= */

    // 直接父科目映射：在给定集合内取该编码的「最长真前缀」作为父。
    // 真实账套编码层级不规整（4 位、4+2=6 位、4+3=7 位、更深混合），
    // 不能用「固定去尾 2 位」推导（会把 1002001 的父错算成 10020）。
    subjectParentMap: function (subjects) {
      var subs = subjects || this.state.subjects || [];
      var byCode = {};
      subs.forEach(function (s) { byCode[String(s.code)] = 1; });
      var pm = {};
      subs.forEach(function (s) {
        var c = String(s.code), best = '';
        for (var L = c.length - 1; L > 0; L--) {
          var pre = c.slice(0, L);
          if (byCode[pre]) { best = pre; break; }
        }
        pm[c] = best;
      });
      return pm;
    },

    // 某编码是否可见：在展开 Set 中 OR 所有祖先都在展开 Set 中。
    // 祖先级联隐藏规则：父级不在 expanded 中 → 子级递归隐藏。
    subjectVisible: function (code, expanded, parentMap, expandAll) {
      if (expandAll) return true;
      if (expanded && expanded.has && expanded.has(code)) return true;
      var cur = String(code);
      var guard = 0;
      while (cur && guard++ < 40) {
        var p = parentMap[cur];
        if (!p) return true; // 一级科目，父为空，始终可见
        if (!expanded || !expanded.has(p)) return false; // 祖先没展开 → 隐藏
        cur = p;
      }
      return true;
    },

    // 某编码是否有子科目（有子节点 → 可展开）
    subjectHasChildren: function (code, parentMap) {
      // parentMap 的每个 value 是直接父 → 统计 parentMap[child] === code 的 child 数
      var count = 0;
      for (var c in parentMap) {
        if (parentMap[c] === String(code)) count++;
      }
      return count > 0;
    },

    // 展开/折叠箭头 HTML（统一用文字 ▶▼，打印友好）—— 全站树形三角的唯一出口
    // hasKids: 是否有子科目；isOpen: 当前展开态（true=▼展开 / false=▶收起）
    // 返回：<span> 可点击三角 HTML，或占位 span（叶节点）
    // 注：data-code 与 data-c 同时输出且同值 —— 各页点击委托读的属性名不统一
    // （科目表/科目余额表读 data-code，费用明细表读 data-c），只输出一个会导致
    // 另一处取不到 code（费用明细表点三角展不开）。二者同值，取哪个都对。
    subjectArrowHTML: function (code, hasKids, isOpen, extraCls) {
      if (!hasKids) return '<span class="subj-arrow-leaf"></span>';
      var cls = extraCls ? extraCls : 'subj-arrow';
      cls += isOpen ? '' : ' collapsed';
      var title = isOpen ? '收起下级科目' : '展开下级科目';
      return '<span class="' + cls + '" data-code="' + code + '" data-c="' + code + '" title="' + title + '">' +
        (isOpen ? '▼' : '▶') + '</span>';
    },
    // 科目编码 → 当前名称（显示层唯一入口）。
    // 口径：凭证/报表显示科目表实时名称，科目改名后历史单据显示同步更新；分录里存的 name 仅作兜底（科目已不存在时使用）。
    subjectName: function (code) {
      var s = this.subject(code);
      return s ? (s.name || '') : '';
    },
    // 一次性构建 code→name 映射：表格成百上千行时用 map 查名，
    // 避免逐行调用 subject()（线性 filter）造成渲染变慢。
    subjectNameMap: function () {
      var map = {};
      (this.state.subjects || []).forEach(function (s) { map[String(s.code)] = s.name || ''; });
      return map;
    },
    // 资金类科目（现金/银行）：库存现金1001、银行存款1002、其他货币资金1012 及其下级
    cashAccounts: function () {
      var prefix = ['1001', '1002', '1012'];
      return this.subjects().filter(function (s) {
        return prefix.some(function (p) { return s.code === p || s.code.indexOf(p) === 0; });
      });
    },
    addSubject: function (code, name, cls, extra) {
      code = String(code).trim();
      // 编码：前缀树体系（兼容 4 位、4+2、4+3/7 位、更深等真实账套）——
      // 一级 = 4 位（表内无父）；子科目 = 父编码 + 若干位数字，父取「表内存在的最长真前缀」。
      // 不再强制偶数位 / 固定每级 +2（旧式会把 7 位兄弟账的父子关系判断、新科目无法同长新增）。
      if (!/^\d{4,16}$/.test(code)) return { ok: false, msg: '科目编码须为 4-16 位数字' };
      if (this.subject(code)) return { ok: false, msg: '科目编码已存在' };
      var parentCode = '';
      for (var _L = code.length - 1; _L > 0; _L--) {
        var _pre = code.slice(0, _L);
        if (this.subject(_pre)) { parentCode = _pre; break; }
      }
      var parent = parentCode ? this.subject(parentCode) : null;
      if (code.length > 4 && !parent) {
        return { ok: false, msg: '父科目不存在：' + (parentCode || '编码前缀未在科目表内') };
      }
      var parentLv = parent && typeof parent.level === 'number' && parent.level > 0 ? parent.level : 1;
      var level = parent ? parentLv + 1 : 1;
      var cls2 = cls || (parent ? parent.cls : '');
      if (!ACCOUNT_CLASSES[cls2]) return { ok: false, msg: '科目类别无效' };
      var s = {
        code: code, name: name.trim(), cls: cls2, normal: ACCOUNT_CLASSES[cls2].normal,
        level: level, parent: parent ? parent.code : '',
        qty: false, unit: ''
      };
      if (extra) {
        if (extra.qty) { s.qty = true; s.unit = String(extra.unit || '').trim(); }
      }
      this.state.subjects.push(s);
      // 科目表变化会改变 rollCodes 上卷口径（新增子目会被父科目汇总），须作废总账缓存
      this._glCache = {};
      this.persist();
      return { ok: true };
    },
    // 科目是否已被使用（含全部子科目）：存在期初余额 或 任一凭证分录引用，即视为已使用。
    // 用途：updateSubject 禁改已使用科目的类别/方向（同款限制，防呆 M5）。
    _subjectUsed: function (code) {
      var self = this;
      var prefix = String(code);
      var ob = this.state.openingBalances || {};
      if (Object.keys(ob).some(function (k) { return k === prefix || k.indexOf(prefix) === 0; })) return true;
      var codes = this.rollCodes(prefix); // 自身 + 全部末级子科目
      return (this.state.vouchers || []).some(function (v) {
        if (v.deleted === 'y') return false;
        return (v.entries || []).some(function (e) { return codes.indexOf(e.code) >= 0; });
      });
    },
    updateSubject: function (code, name, cls, extra) {
      var s = this.subject(code);
      if (!s) return { ok: false, msg: '科目不存在' };
      if (cls && cls !== s.cls && ACCOUNT_CLASSES[cls]) {
        // 防呆 M5：科目类别/方向是历史报表归类的依据，已使用后改动会使利润表归类、
        // 余额正常方向整体漂移（曾审计发现的隐性错账模式）。同款限制：禁改。
        if (this._subjectUsed(code)) {
          return { ok: false, msg: '科目「' + s.code + ' ' + (s.name || '') + '」已有凭证或期初余额，不允许修改科目类别（类别决定报表归类与余额方向）；如需调整请新增科目后将凭证改挂新科目，或先清理该科目期初与凭证' };
        }
        s.cls = cls; s.normal = ACCOUNT_CLASSES[cls].normal;
      }
      s.name = name.trim();
      if (extra) {
        s.qty = !!extra.qty;
        if (extra.unit !== undefined) s.unit = String(extra.unit || '').trim();
      }
      // 科目类别(cls)变更会改变报表归类与余额方向，须作废总账缓存
      this._glCache = {};
      this.persist();
      return { ok: true };
    },

    // 删除科目（**仅限未使用**：无凭证引用、无期初余额）。
    // 【为什么不给「已使用」的科目删除】删除会让历史凭证的分录指向一个不存在的科目，账就断了，
    //   故一律拒绝 —— 这类科目必须留在账上（要退出使用时另作处理，不在本函数职责内）。
    // 【为什么连带下级是安全的】_subjectUsed 按编码前缀涵盖整棵子树（凭证与期初余额都查前缀），
    //   故「本科目未使用」⇒ 其全部下级必然也未使用，一并删除不会误删有效数据。
    removeSubject: function (code) {
      code = String(code || '').trim();
      var s = this.subject(code);
      if (!s) return { ok: false, msg: '科目不存在' };
      if (this._subjectUsed(code)) {
        return {
          ok: false,
          msg: '科目「' + s.code + ' ' + (s.name || '') + '」已有凭证或期初余额（含其下级科目），不允许删除 —— 删除会使历史凭证指向不存在的科目。'
        };
      }
      var self = this;
      // 自身 + 全部下级（indexOf === 0 已包含自身）
      var delCodes = {};
      this.state.subjects.forEach(function (x) {
        if (x && x.code.indexOf(code) === 0) delCodes[x.code] = 1;
      });
      var n = Object.keys(delCodes).length;
      this.state.subjects = this.state.subjects.filter(function (x) { return x && !delCodes[x.code]; });
      // 清理期初余额的残留键（全 0 键正常会被 setOpening 删除，导入账套可能带入）
      Object.keys(delCodes).forEach(function (c) { delete self.state.openingBalances[c]; });
      // 科目表变化会改变 rollCodes 上卷口径，须作废总账缓存
      this._glCache = {};
      this.persist();
      return { ok: true, removed: n, code: code, name: s.name || '' };
    },

    /* ===================== 期初余额 =====================
     * 「财务初始余额」：科目表（编码/名称/方向/币别/年初余额/本年累计借/本年累计贷/期初余额/数量）。
     * 覆盖核心列：年初余额(yb)、本年累计借(ytdDr)、本年累计贷(ytdCr)、期初余额(dr/cr)。
     */
    opening: function (code) {
      var o = this.state.openingBalances[code];
      return o ? { dr: num(o.dr), cr: num(o.cr), yb: num(o.yb), ytdDr: num(o.ytdDr), ytdCr: num(o.ytdCr) }
               : { dr: 0, cr: 0, yb: 0, ytdDr: 0, ytdCr: 0 };
    },
    setOpening: function (code, dr, cr, yb, ytdDr, ytdCr) {
      dr = num(dr); cr = num(cr); yb = num(yb); ytdDr = num(ytdDr); ytdCr = num(ytdCr);
      // 期初口径：科目有下级（子目）时，父级期初=自身+子目合计（rollCodes 上卷）。
      // 若父科目自身也录期初，会被重复计入，故「有子目的科目」禁止录入自身期初，期初须放末级子目。
      // 返回 { ok:false, msg } 让前端提示；等于全 0 清空不受此限制（清空是安全的）。
      var hasChild = this.childCodesOf(code).length > 0;
      if (hasChild && (dr !== 0 || cr !== 0 || yb !== 0 || ytdDr !== 0 || ytdCr !== 0)) {
        return { ok: false, msg: '科目「' + code + '」已有下级科目，期初须录入到末级明细科目（父科目余额自动汇总子目）' };
      }
      if (dr === 0 && cr === 0 && yb === 0 && ytdDr === 0 && ytdCr === 0) { delete this.state.openingBalances[code]; }
      else { this.state.openingBalances[code] = { dr: dr, cr: cr, yb: yb, ytdDr: ytdDr, ytdCr: ytdCr }; }
      // 期初是所有账簿/报表取数的基数，改动后必须作废总账记忆化缓存：
      // 否则同一次会话内「先看过报表、再改期初」会一直命中旧缓存，
      // 页面显示修改前的旧余额（数据已改但界面不变，且退出前不落盘则看似丢失）。
      this._glCache = {};
      return { ok: true };
    },
    // 期初借贷平衡校验（按科目正常方向汇总）
    openingBalanceCheck: function () {
      var self = this, totalDr = 0, totalCr = 0;
      this.state.subjects.forEach(function (s) {
        var o = self.state.openingBalances[s.code];
        if (!o) return;
        if (s.normal === 'dr') totalDr += num(o.dr) - num(o.cr);
        else totalCr += num(o.cr) - num(o.dr);
      });
      // 与 voucherBalance 同口径：先 round2 消除累加浮点误差，再比 EPS。
      // 不加 round2 时，0.1+0.2 这类累加会留下 0.30000000000000004，使「差 0」被误判成不相等。
      var drR = round2(totalDr), crR = round2(totalCr);
      return { dr: drR, cr: crR, balanced: round2(Math.abs(drR - crR)) <= EPS };
    },

    /* ===================== 凭证 ===================== */
    nextVoucherNo: function (word, month) {
      word = word || this.state.param.voucherWord || '记';
      var max = 0;
      this.state.vouchers.forEach(function (v) {
        if (v.word === word && (!month || voucherMonth(v) === month)) {
          var n = parseInt(v.no, 10); if (!isNaN(n) && n > max) max = n;
        }
      });
      return max + 1;
    },
    // 计算凭证的稳定 id（word-no）。同一 word+no 出现多次时加 -N 后缀去重，
    // 与 ensureVoucherIds() 口径严格一致（两处必须同步，否则 id 会在重载后变化、引用失效）。
    // excludeId：计算「新凭证」id 时传入自身占位（此时该凭证尚未入数组，无需排除）。
    _calcVoucherId: function (word, no, month) {
      // 凭证号按「月」编号（每月从 1 起），因此 word-no 仅在同月内唯一：
      // 3月的「记-1」与4月的「记-1」是两张不同凭证，不可判为重号。
      // 故 id 必须含月份（word-no@YYYY-MM），否则跨月同号会被误加 -N 后缀，
      // 且 ensureVoucherIds 每次重载都会重排，id 反复变化导致引用失效。
      // 真实账套（添钰来客 371 张）存在 58 个跨月重复的 word-no，印证此问题真实存在。
      var base = (word || '记') + '-' + (no != null ? no : '') + '@' + (month || '');
      var count = 0;
      (this.state.vouchers || []).forEach(function (x) {
        var xb = (x.word || '记') + '-' + (x.no != null ? x.no : '') + '@' + voucherMonth(x);
        if (xb === base) count++;
      });
      return count > 0 ? (base + '-' + (count + 1)) : base;
    },
    addVoucher: function (v) {
      // v: { word, no, date, attach, summary, entries:[{code,name,summary,dr,cr,cashActivity?}] }
      // 借贷平衡校验：任何路径（导入/接口/脚本）写入的凭证都必须平衡，避免脏数据入总账
      var bal = this.voucherBalance(v.entries);
      if (!bal.balanced) {
        return { ok: false, msg: '借贷不平衡，无法保存（借 ' + round2(bal.dr) + ' / 贷 ' + bal.cr + '）' };
      }
      // 期间三道闸门：已结账 / 启用月前 / 未来月
      var _month = voucherMonth(v);
      var _sm = (this.state.company && this.state.company.startMonth) || '';
      var _cur = fmtDate(new Date()).slice(0, 7);
      if (this.isPeriodClosed(_month))
        return { ok: false, msg: '该凭证所在月份（' + _month + '）已结账，不可新增' };
      if (_sm && _month < _sm)
        return { ok: false, msg: '凭证日期（' + _month + '）早于账套启用期间（' + _sm + '），请改录期初余额' };
      if (_month > _cur)
        return { ok: false, msg: '凭证日期（' + _month + '）不能晚于当前月份（' + _cur + '）' };

      v.word = v.word || this.state.param.voucherWord || '记';
      // 凭证号自动生成：若用户未显式指定 no，则用 nextVoucherNo 取最大号+1；
      // 若唯一性校验失败（并发/导入批量场景），自动重试最多 3 次再报错，
      // 避免用户已填好的分录数据因撞号被整批作废。用户显式指定 no 时不自动重试。
      var _userSpecifiedNo = (v.no != null);
      if (!_userSpecifiedNo) v.no = this.nextVoucherNo(v.word, _month);
      var _retryCount = 0;
      while (true) {
        var _dup = (this.state.vouchers || []).filter(function (x) {
          return (x.word || '记') === v.word
            && String(x.no) === String(v.no) && voucherMonth(x) === _month;
        });
        if (!_dup.length) break;
        if (_userSpecifiedNo || _retryCount >= 3) {
          return { ok: false, msg: '同月同凭证字下已存在字号 ' + v.word + '-' + v.no + ' 的凭证，请修改凭证号' };
        }
        _retryCount++;
        v.no = this.nextVoucherNo(v.word, _month); // 撞号后重新取下一个
      }
      // 凭证 id 必须与 ensureVoucherIds() 的口径完全一致（word-no，重复则加 -N 后缀），
      // 否则「新增时用 V+时间戳、账套重新加载时被改成 word-no」会让 id 变化，
      // 导致原始凭证/固定资产等按 voucherId 记录的引用全部失效
      // （体现为：刷新后引用对不上号，对应业务单据保护失效）。
      v.id = this._calcVoucherId(v.word, v.no, voucherMonth(v));
      // 记录制单人
      if (!v.maker) v.maker = (this.state.company && this.state.company.bookkeeper) || '会计';
      v.entries.forEach(function (e) { e.dr = num(e.dr); e.cr = num(e.cr); });
      this.state.vouchers.push(v);
      this._glCache = {}; // 凭证变化，作废总账记忆化缓存（否则后续查询会命中旧值）
      this.persist();
      this.addLog('新增凭证', v.word + '-' + v.no + ' ' + (v.summary || ''), '凭证',
        null, null, v.word + '-' + v.no + (v.summary ? ' ' + v.summary : ''),
        { id: v.id, action_type: 'create', target_name: v.word + '-' + v.no, result: 'success' });
      return v;
    },
    // ============ 日常凭证模板（按账套，常用业务结构） ============
    // 模板只存科目/摘要/方向（不含金额——套用后现场填），entries: [{code,name,summary,side}]
    vchTemplates: function () {
      return this.state.vchTemplates || [];
    },
    saveVchTemplate: function (name, entries) {
      var list = entries || [];
      if (!list.length) return { ok: false, msg: '当前没有可保存的分录' };
      var tpl = {
        id: 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: (String(name || '').trim() || '常用业务'),
        entries: list.map(function (e) {
          var item = { code: e.code || '', name: e.name || '', summary: e.summary || '' };
          var dr = Number(e.dr) || 0, cr = Number(e.cr) || 0;
          if (dr > 0) item.dr = dr; else if (cr > 0) item.cr = cr;
          return item;
        }),
        createdAt: new Date().toISOString()
      };
      if (!tpl.entries.some(function (e) { return e.code; })) return { ok: false, msg: '模板至少需要一条带科目的分录' };
      this.state.vchTemplates = this.state.vchTemplates || [];
      this.state.vchTemplates.push(tpl);
      // 同步到结账凭证模板（localStorage），让录凭证保存的模板也能在期末处理中使用
      // （"保存为模板 → 自动出现在结账凭证模板"行为）
      try {
        var STL_KEY = 'settle_templates_v1';
        var _stl = JSON.parse(localStorage.getItem(STL_KEY) || '[]');
        if (!Array.isArray(_stl)) _stl = [];
        // 已存在的同名模板先移除（避免重复 push）
        _stl = _stl.filter(function (s) { return !(s.fromVchTpl && s.vchTplId === tpl.id); });
        var _settleEntry = {
          id: 'vch_' + tpl.id,          // 前缀区分系统模板（profit/dep/vat...）
          name: tpl.name,
          enabled: false,
          custom: true,
          summary: tpl.summary || '',
          word: this.state.param && this.state.param.voucherWord || '记',
          template: tpl.entries.map(function (e) {
            return {
              summary: e.summary || '',
              code: e.code || '',
              name: e.name || '',
              dc: Number(e.dr) > 0 ? 'D' : (Number(e.cr) > 0 ? 'C' : 'D'),
              dr: Number(e.dr) || 0,
              cr: Number(e.cr) || 0,
              amount: Number(e.dr) || Number(e.cr) || 0,
              ruleType: 'none'        // 固定金额（录凭证模板不涉及取数规则）
            };
          }),
          hasEntries: tpl.entries.length > 0,
          ruleType: 'none',
          fromVchTpl: true,
          vchTplId: tpl.id,
          bookId: this.bookId   // 跟随当前账套：金额模板绝不能跨账套串台
        };
        _stl.push(_settleEntry);
        localStorage.setItem(STL_KEY, JSON.stringify(_stl));
        // 同时写入 store.state.settleTemplates，让 settleTplEnabled 能读到 enabled=true
        this.state.settleTemplates = this.state.settleTemplates || [];
        var existing = this.state.settleTemplates.filter(function(s){ return !(s.fromVchTpl && s.vchTplId === tpl.id); });
        existing.push(_settleEntry);
        this.state.settleTemplates = existing;
      } catch (_) { /* localStorage 失败不阻断主流程 */ }
      this.persist();
      return { ok: true, tpl: tpl };
    },
    removeVchTemplate: function (id) {
      var arr = this.state.vchTemplates || [];
      var idx = -1;
      arr.forEach(function (t, i) { if (t.id === id) idx = i; });
      if (idx < 0) return { ok: false, msg: '模板不存在' };
      arr.splice(idx, 1);
      // 同步删除结账凭证模板里对应的条目（vchTplId 匹配）
      // 【必须同时清 state.settleTemplates】saveVchTemplate 是「localStorage + state」双写，
      // 此处若只清 localStorage：state 里的残留项（带 custom:true + 完整 template）会在下次
      // loadSettleTemplates 时被重新合并回模板列表，形成「凭证模板已删、期末模板还在」的死卡，
      // 而且 persistSettleTemplates 又会把它写回 localStorage —— 删了会自我复活。
      if (Array.isArray(this.state.settleTemplates)) {
        this.state.settleTemplates = this.state.settleTemplates.filter(function (s) {
          return !(s.fromVchTpl && s.vchTplId === id);
        });
      }
      try {
        var STL_KEY2 = 'settle_templates_v1';
        var _stl2 = JSON.parse(localStorage.getItem(STL_KEY2) || '[]');
        if (Array.isArray(_stl2)) {
          _stl2 = _stl2.filter(function (s) { return !(s.fromVchTpl && s.vchTplId === id); });
          localStorage.setItem(STL_KEY2, JSON.stringify(_stl2));
        }
      } catch (_) {}
      this.persist();
      return { ok: true };
    },
    updateVoucher: function (id, v) {
      var idx = -1;
      this.state.vouchers.forEach(function (x, i) { if (x.id === id) idx = i; });
      if (idx < 0) return { ok: false, msg: '凭证不存在' };
      if (this.state.vouchers[idx].deleted === 'y') return { ok: false, msg: '凭证已删除，请先还原再修改' };
      // 借贷平衡校验（与 addVoucher 口径完全一致）：修改也不能改成不平衡
      var bal = this.voucherBalance(v.entries);
      if (!bal.balanced) {
        return { ok: false, msg: '借贷不平衡，无法保存（借 ' + round2(bal.dr) + ' / 贷 ' + round2(bal.cr) + '）' };
      }
      if (this.isPeriodClosed(voucherMonth(this.state.vouchers[idx])))
        return { ok: false, msg: '该凭证所在月份已结账，不可修改' };
      // 凭证字号唯一性校验（编辑场景）：仅当用户实际改变了字/号/月份时才校验，
      // 避免历史遗留重复凭证编辑自身不改号时被误拦截。
      var _old = this.state.vouchers[idx];
      var _oWord = _old.word || '记';
      var _oNo = _old.no;
      var _oMonth = voucherMonth(_old);
      var _tWord = v.word || _oWord;
      var _tNo = v.no != null ? v.no : _oNo;
      var _tMonth = voucherMonth({ date: v.date || _old.date });
      // 编辑场景下目标月份也要过三道闸门：结账 / 启用月前 / 未来月
      var _sm = (this.state.company && this.state.company.startMonth) || '';
      var _cur = fmtDate(new Date()).slice(0, 7);
      if (this.isPeriodClosed(_tMonth))
        return { ok: false, msg: '凭证目标月份（' + _tMonth + '）已结账，不可修改' };
      if (_sm && _tMonth < _sm)
        return { ok: false, msg: '凭证日期（' + _tMonth + '）早于账套启用期间（' + _sm + '）' };
      if (_tMonth > _cur)
        return { ok: false, msg: '凭证日期（' + _tMonth + '）不能晚于当前月份（' + _cur + '）' };

      var _selfId = _old.id;
      // 凭证归属月份不可修改（会计通用规则）：如需调整期间，请删除后在正确月份重新录入。
      // 原因：凭证号、id（含月份后缀）、引用关系（固定资产/工资/原始凭证）都跟月份绑定，改月份会断审计链条。
      if (_tMonth !== _oMonth) return { ok: false, msg: '凭证归属月份不可修改。如需调整期间，请删除后在正确月份重新录入。' };
      var _changed = (_tWord !== _oWord) || (String(_tNo) !== String(_oNo));
      if (_changed) {
        var _dupEdit = (this.state.vouchers || []).filter(function (x) {
          return x.id !== _selfId
            && (x.word || '记') === _tWord && String(x.no) === String(_tNo)
            && voucherMonth(x) === _tMonth;
        });
        if (_dupEdit.length) {
          return { ok: false, msg: '同月同凭证字下已存在字号 ' + _tWord + '-' + _tNo + ' 的凭证，请修改凭证号' };
        }
      }
      // 审计留痕：先快照修改前值，再应用修改
      var _oldVoucher = this.state.vouchers[idx];
      var before = _oldVoucher.word + '-' + _oldVoucher.no + ' ' + (_oldVoucher.summary || '');
      // 分录级快照：记录修改前后借贷合计，便于审计追查"改了多少"
      var oldDr = round2(_oldVoucher.entries.reduce(function (s, e) { return s + num(e.dr); }, 0));
      var oldCr = round2(_oldVoucher.entries.reduce(function (s, e) { return s + num(e.cr); }, 0));
      v.entries.forEach(function (e) { e.dr = num(e.dr); e.cr = num(e.cr); });
      var newDr = round2(v.entries.reduce(function (s, e) { return s + num(e.dr); }, 0));
      var newCr = round2(v.entries.reduce(function (s, e) { return s + num(e.cr); }, 0));
      this.state.vouchers[idx] = Object.assign(this.state.vouchers[idx], v, { id: id });
      this._glCache = {}; // 凭证变化，作废总账记忆化缓存
      this.persist();
      var after = this.state.vouchers[idx].word + '-' + this.state.vouchers[idx].no + ' ' + (this.state.vouchers[idx].summary || '');
      this.addLog('修改凭证', after, '凭证',
        null, before, after,
        { id: id, action_type: 'update', target_name: this.state.vouchers[idx].word + '-' + this.state.vouchers[idx].no, result: 'success',
          beforeDr: oldDr, beforeCr: oldCr, afterDr: newDr, afterCr: newCr,
          beforeEntries: _oldVoucher.entries.length, afterEntries: v.entries.length });
      return { ok: true };
    },
    getVoucher: function (id) {
      // 软删除过滤：默认排除 deleted==='y'；UI 回收站入口通过 getVoucherIncludeDeleted 显式查
      return this.state.vouchers.filter(function (x) { return x.id === id && x.deleted !== 'y'; })[0] || null;
    },
    // 显式查已软删凭证（回收站 UI 用），不对外公开
    getVoucherIncludeDeleted: function (id) {
      return this.state.vouchers.filter(function (x) { return x.id === id; })[0] || null;
    },
    // 凭证被哪些业务单据引用（按 id 或凭证号匹配），返回引用来源名称数组；无引用返回空数组
    /* ---------- 折旧凭证 ⇄ 固定资产卡片 联动回滚（2026-09-18） ----------
     * 背景（实测事故）：计提折旧会更新卡片（accumDepr += 本期、periodUsed++、deprMonth = 本月），
     * 但删除折旧凭证原先只把凭证软删，卡片累计折旧**没有回滚** —— 于是卡片比总账永久多一期折旧
     * （实测：卡片 130,520.13 vs 总账 119,653.50，差额 10,866.63 恰好一期），
     * 固定资产页随即弹出「卡片与总账不符」告警。
     * 现改为：删除折旧凭证前，把引用它的卡片按「本期折旧额」回滚，并把快照挂到凭证上
     *      （v.deprReverted）；还原凭证时按快照精确加回 —— 删除/还原双向可逆。
     * 定位依据：fa.deprVoucher === 凭证号（计提时单点写入，不依赖凭证 kind，外部导入凭证同样适用）。
     * 金额校验：回滚总额与凭证内「累计折旧贷方合计」不符时，差额并入最后一张卡片，保证账实严格一致。 */
    _revertAssetDepr: function (v) {
      var self = this;
      var vno = (v.word || '') + '-' + (v.no != null ? v.no : '');
      var month = voucherMonth(v);
      var depSubj = this.subjectRole('ACC_DEPR');
      var depCode = depSubj ? String(depSubj.code) : '';
      var vchTotal = 0;
      (v.entries || []).forEach(function (e) {
        if (num(e.cr) > 0 && depCode && String(e.code) === depCode) vchTotal += num(e.cr);
      });
      var lines = [];
      (this.state.fixedAssets || []).forEach(function (fa) {
        if (!fa.deprVoucher || fa.deprVoucher !== vno) return;
        var amt = round2(self.assetMonthlyDepr(fa));
        if (amt <= 0) return;
        lines.push({ fa: fa, amt: amt });
      });
      if (!lines.length) return null;
      var sum = 0;
      lines.forEach(function (l) { sum += l.amt; });
      sum = round2(sum);
      // 末尾月补足、历史脏数据会让单卡月折旧额与凭证金额差几分钱 —— 差额并入最后一张卡片对齐
      if (vchTotal > 0 && Math.abs(sum - vchTotal) > EPS) {
        var last = lines[lines.length - 1];
        var fixed = round2(last.amt + (vchTotal - sum));
        last.amt = fixed > 0 ? fixed : 0;
      }
      var snaps = [];
      lines.forEach(function (l) {
        if (l.amt <= 0) return;
        var fa = l.fa;
        snaps.push({ id: fa.id, code: fa.code, name: fa.name, amt: l.amt,
          anchor: fa.deprMonth || '', vno: vno });
        fa.accumDepr = Math.max(0, round2(num(fa.accumDepr) - l.amt));
        fa.accumDeprBegin = fa.accumDepr;
        fa.periodUsed = Math.max(0, num(fa.periodUsed || 0) - 1);
        fa.yearDepr = Math.max(0, round2(num(fa.yearDepr || 0) - l.amt));
        fa.netValueEnd = Math.max(0, round2(num(fa.original) - num(fa.accumDepr) - num(fa.impairment)));
        fa.netValueBegin = fa.netValueEnd;
        delete fa.deprVoucher;
        // 锚点回退：清除显式锚点，交回「购置月 + 已折旧期间数」推导（periodUsed 已在上方减 1，
        // 推导结果天然落在上一期）。切勿硬写 prevMonth(month)：外部导入卡本来就
        // 不带 deprMonth，靠推导定位锚点；硬塞一个显式值会与推导打架，实测让卡片与总账差一期
        // （2026-09-18 告警的收尾残留正是此因）。无购置日的卡推导不出，才退回显式回退一月。
        if (month && fa.deprMonth && String(fa.deprMonth) === String(month)) {
          if (fa.acqDate) delete fa.deprMonth;
          else fa.deprMonth = prevMonth(month);
        }
      });
      return snaps.length ? snaps : null;
    },
    // 还原凭证时按删除时留下的快照把卡片折旧加回（与 _revertAssetDepr 严格对称）
    _restoreAssetDepr: function (snaps) {
      if (!snaps || !snaps.length) return;
      var self = this;
      snaps.forEach(function (s) {
        var fa = (self.state.fixedAssets || []).filter(function (x) { return x.id === s.id; })[0];
        if (!fa) return;
        fa.accumDepr = round2(num(fa.accumDepr) + num(s.amt));
        fa.accumDeprBegin = fa.accumDepr;
        fa.periodUsed = num(fa.periodUsed || 0) + 1;
        fa.yearDepr = round2(num(fa.yearDepr || 0) + num(s.amt));
        fa.netValueEnd = Math.max(0, round2(num(fa.original) - num(fa.accumDepr) - num(fa.impairment)));
        fa.netValueBegin = fa.netValueEnd;
        if (s.anchor) fa.deprMonth = s.anchor;
        if (s.vno) fa.deprVoucher = s.vno;
      });
    },
    /* ---------- 清理凭证 ⇄ 固定资产卡片 联动回退（2026-09-18） ----------
     * 与折旧凭证同一套设计（见 _revertAssetDepr），规范依据同为「账实相符」：
     * 删除清理凭证 = 撤销该资产的处置业务 → 卡片必须回到「正常」状态、恢复可计提，
     * 否则卡片显示已处置、账上固定资产却还在，账实不符。
     * 同时解开原有死锁：
     *   删清理凭证 → 提示「请先解除关联」；取消清理 → 提示「请先删除清理凭证」—— 互相锁死无解。
     * 只回退 status / cleanPeriod / cleanVoucher 三个字段：
     *   - periodUsed（已折旧期间数）不动：清理本身不改变已折旧期间数；
     *   - 清理期间及之后漏提的折旧**不自动补提**：是否补提属会计政策判断，软件不擅自替会计决定。 */
    _revertAssetClean: function (v) {
      var vno = (v.word || '') + '-' + (v.no != null ? v.no : '');
      var snaps = [];
      (this.state.fixedAssets || []).forEach(function (fa) {
        if (!fa.cleanVoucher || fa.cleanVoucher !== vno) return;
        snaps.push({ id: fa.id, code: fa.code, name: fa.name,
          status: fa.status || '\u6b63\u5e38', cleanPeriod: fa.cleanPeriod || '', vno: vno });
        fa.status = '\u6b63\u5e38';
        fa.cleanPeriod = '';
        delete fa.cleanVoucher;
      });
      return snaps.length ? snaps : null;
    },
    // 还原凭证时按快照把卡片清理状态加回（与 _revertAssetClean 严格对称）
    _restoreAssetClean: function (snaps) {
      if (!snaps || !snaps.length) return;
      var self = this;
      snaps.forEach(function (s) {
        var fa = (self.state.fixedAssets || []).filter(function (x) { return x.id === s.id; })[0];
        if (!fa) return;
        if (s.status) fa.status = s.status;
        if (s.cleanPeriod) fa.cleanPeriod = s.cleanPeriod;
        if (s.vno) fa.cleanVoucher = s.vno;
      });
    },
    _voucherRefs: function (id) {
      var v = this.state.vouchers.filter(function (x) { return x.id === id; })[0];
      var hits = [];
      var self = this;
      function any(arr, cond) { return (arr || []).some(cond); }
      // 固定资产：折旧凭证与清理凭证**均不拦**，改为删除时自动回退卡片的业务状态
      // （见 _revertAssetDepr / _revertAssetClean），账账、账实保持一致。
      // 这里若继续拦，用户得先手工解锁，而界面上并没有能解锁这两个字段的入口
      // （「解除购入凭证关联」清的是 addVoucher，管不到 deprVoucher / cleanVoucher）。
      // 清理凭证那条尤其严重：删凭证要求先取消清理、取消清理要求先删凭证 —— 互相锁死无解。
      // 工资：工资模块按凭证类型（v.kind）+ 同期间识别凭证（工资记录无 voucherId 字段）。
      // 删掉工资凭证后工资数据仍在，会造成「工资已发但总账无凭证」的账实不符，故拦截提示先处理工资记录。
      // 原实现按摘要正则匹配，对导入凭证（无 v.summary）恒不命中，该保护从未生效。
      // 仅拦截工资模块显式生成的凭证（v.payroll 标记）；纯手工录入、仅科目结构像工资的凭证不锁
      if (v && v.payroll) hits.push('工资');
      return hits;
    },
    // reason：删除原因（审计留痕）。
    // 【为什么是可选参数、且本层不强制】本方法有三类调用方，其中两类是【系统调用】，不该被要求填原因：
    //   · 人工删除（凭证页单张 / 批量）→ UI 层强制必填后传入；
    //   · 结账流程重算结转凭证（Settle.js）→ 系统行为，不传；
    //   · 取消资产清理的业务回退（本文件 _cancelClean 链路）→ 不传。
    // 若在此处强制校验，结账会直接失败。故「是否强制」放在 UI 层，
    // 本层只负责留痕：调用方没传就记为「(未填写)」，便于事后识别谁绕过了入口。
    // 凭证制单人（唯一取值点，页面一律调用本方法，不要各自读字段）。
    // 【为什么必须兼容两个字段】制单人有两套来源，只读任何一个都会漏：
    //   · v.maker    —— ty 新录的凭证（addVoucher 写入，值为当时的 company.bookkeeper）
    //   · v.preparer —— 金蝶导入的凭证（kis-import 取 FPreparer，如 "Manager"）
    // 实测（添钰来客 2026）：1047 张导入凭证只有 preparer、没有 maker；
    // 若只读 v.maker，这些凭证「没有制单人」，导出 Excel 与操作日志都会显示空白。
    // 2026-09-21 统一：两处来源都认，谁有值用谁。
    voucherMaker: function (v) {
      if (!v) return '';
      return String(v.maker || v.preparer || '').trim();
    },

    removeVoucher: function (id, reason) {
      var v = this.state.vouchers.filter(function (x) { return x.id === id; })[0];
      if (!v) return { ok: false, msg: '凭证不存在' };
      if (v.deleted === 'y') return { ok: false, msg: '凭证已删除' };
      if (this.isPeriodClosed(voucherMonth(v)))
        return { ok: false, msg: '该凭证所在月份已结账，不可删除' };
      // 财务严谨：校验凭证是否被业务单据引用（固定资产/工资等），有引用则禁删
      var ref = this._voucherRefs(id);
      if (ref && ref.length) {
        // 按引用类型给具体指引：原实现一律说「请先解除关联后再删除」，而固定资产类引用
        // 根本不是靠「解除关联」解的（那按钮清的是购入凭证字段），会把人带进死胡同。
        var REF_TIPS = {
          '工资': '请先在工资模块删除对应工资记录'
        };
        var tips = ref.map(function (r) { return REF_TIPS[r] || ('请先处理「' + r + '」后再删除'); });
        return { ok: false, msg: '该凭证已被' + ref.join('、') + '引用。' + tips.join('；') };
      }
      // 引用校验通过后才动卡片：回滚放在校验之后，避免「卡片回滚了、凭证却删不掉」把数据改坏。
      // 折旧凭证软删前，先把引用它的卡片累计折旧回滚一期，快照挂在凭证上供还原时加回。
      var deprReverted = this._revertAssetDepr(v);
      // 清理凭证同理：撤销处置业务 → 卡片回到「正常」并可继续计提（见 _revertAssetClean）
      var cleanReverted = this._revertAssetClean(v);
      var curUser = (this.state.company && this.state.company.bookkeeper) || '会计';
      // 软删除：打 deleted='y' 标记，凭证留在账套可还原（参考 jinbooks jbx_voucher.deleted 设计）
      // 所有凭证查询入口（periodVouchers/getVoucher 等）已过滤 deleted，账簿/报表不再计入
      v.deleted = 'y';
      v.deletedAt = fmtDateTime(new Date());
      v.deletedBy = curUser;
      // 删除原因随凭证留存，供「凭证回收站」直接展示。
      // 与日志的 reason 字段互为补充：回收站解答「这张为什么被删」（就地可见），
      // 日志是全局审计流水（跨凭证、可按时间追溯）。两者场景不同，故都落。
      v.deleteReason = (reason == null ? '' : String(reason)).trim();
      if (deprReverted) v.deprReverted = deprReverted;
      if (cleanReverted) v.cleanReverted = cleanReverted;
      this._glCache = {}; // 凭证变化，作废总账记忆化缓存
      this.persist();
      this.addLog('删除凭证', (v.word || '') + '-' + (v.no != null ? v.no : '') + ' ' + (v.summary || ''), '凭证',
        v.deleteReason || '(未填写)', (v.word || '') + '-' + (v.no != null ? v.no : '') + (v.summary ? ' ' + v.summary : ''), null,
        { id: id, action_type: 'delete', target_name: (v.word || '') + '-' + (v.no != null ? v.no : ''), result: 'success' });
      return { ok: true };
    },
    // 还原已软删的凭证（撤销删除）
    restoreVoucher: function (id) {
      var v = this.state.vouchers.filter(function (x) { return x.id === id; })[0];
      if (!v) return { ok: false, msg: '凭证不存在' };
      if (v.deleted !== 'y') return { ok: false, msg: '该凭证未被删除，无需还原' };
      // 还原前检查所在期间是否已结账（结账期间内不应有活动凭证）
      if (this.isPeriodClosed(voucherMonth(v)))
        return { ok: false, msg: '该凭证所在月份已结账，请先反结账再还原' };
      v.deleted = 'n';
      delete v.deletedAt;
      delete v.deletedBy;
      delete v.deleteReason;   // 与 deletedAt/deletedBy 同步清理：还原后该凭证视为「未删除」，不留删除痕迹
      // 与 removeVoucher 严格对称：还原凭证时，按删除时留存的快照把卡片业务状态加回
      if (v.deprReverted && v.deprReverted.length) {
        this._restoreAssetDepr(v.deprReverted);
        delete v.deprReverted;
      }
      if (v.cleanReverted && v.cleanReverted.length) {
        this._restoreAssetClean(v.cleanReverted);
        delete v.cleanReverted;
      }
      this._glCache = {};
      this.persist();
      var curUser = (this.state.company && this.state.company.bookkeeper) || '会计';
      this.addLog('还原凭证', (v.word || '') + '-' + (v.no != null ? v.no : '') + ' ' + (v.summary || ''), '凭证',
        null, null, (v.word || '') + '-' + (v.no != null ? v.no : '') + (v.summary ? ' ' + v.summary : ''),
        { id: id, action_type: 'restore', target_name: (v.word || '') + '-' + (v.no != null ? v.no : ''), result: 'success' });
      return { ok: true };
    },

    /* ---------- 红字冲销（已结账期间的常规更正手段） ----------
     * 【会计依据】《会计基础工作规范》第五十一条：已登记入账的记账凭证发生错误，
     *   科目、金额等有错的，可另填一张「红字」记账凭证冲销原错误记录。
     *
     * 【与「反结账」的分工】反结账是把历史期间重新打开、直接改历史凭证 —— 会抹掉痕迹，
     *   这正是它「违反会计法规」的根源；红字冲销不动历史期间，只在当前工作期间生成一张红字
     *   反向凭证 —— 错误凭证与冲销凭证都留在账上、因果清晰，是审计要求的形态。
     *   代价：被冲月份的报表不再事后修正（月报非法定口径，年报仍正确）。
     *
     * 【红字口径】沿用本软件统一的「负数同方向」（账套 meta.redStyle === 'native'）：
     *   借贷方向【不变】、金额【取负】。刻意不用「借贷对调」—— 那会把冲销变成一笔新业务，
     *   既改变发生额方向，也让「冲销」与「更正」在账上无法区分。
     *
     * 【为什么 month 必须由调用方传入】期间口径的【唯一实现】是 app.js 的 currentPeriod()
     *   （最近已结账月 + 1；从未结账则取最近有凭证月；上限当前自然月）。
     *   本方法刻意不自己算一遍，避免出现第二套口径 —— 页面请传 H.currentPeriod()。
     *
     * @param {string} id   被冲销凭证的 id
     * @param {object} opts { month: 'YYYY-MM'（必填，目标期间，须未结账）
     *                        reason: string（红字冲销原因，审计留痕；UI 层强制必填） }
     * @returns {object} 成功 → { ok:true, voucher:<新生成的红字凭证>, hint:<给 UI 的提示，可能为 null> }
     *                   失败 → { ok:false, msg }
     *   注：成功时【不】直接返回凭证对象 —— 凭证会被原样持久化进账套，
     *       往它身上挂 hint 之类的临时字段会污染账套数据。故另起一层包住。
     */
    reverseVoucher: function (id, opts) {
      opts = opts || {};
      var self = this;
      var orig = (this.state.vouchers || []).filter(function (x) { return x.id === id; })[0];
      if (!orig) return { ok: false, msg: '凭证不存在' };
      if (orig.deleted === 'y') return { ok: false, msg: '该凭证已删除，请先在回收站还原后再红字冲销' };
      if (!orig.entries || !orig.entries.length) return { ok: false, msg: '该凭证没有分录，无法红字冲销' };

      var month = String(opts.month || '').trim();
      if (!/^\d{4}-\d{2}$/.test(month))
        return { ok: false, msg: '缺少目标期间（须由调用方传入当前工作期间 currentPeriod()）' };
      if (this.isPeriodClosed(month))
        return { ok: false, msg: '目标期间（' + month + '）已结账，无法录入红字冲销凭证。'
          + '请先在「结账 → 反结账」打开该期间，或等进入下一期间后再红字冲销' };

      // ---------- 凭什么凭证不能手工红字冲销：按【来源】逐类判定，不能只看 kind ----------
      // 本软件里「凭证由哪个业务模块生成」有多套标记，只认一套必漏（同类教训见 _voucherRefs 注释）：
      //   ① 期末处理类 —— v.kind（结转损益/本年利润/成本/折旧/利润分配/工资计提发放）
      //   ② 固定资产   —— 卡片上的 deprVoucher / cleanVoucher 存【凭证号 word-no】，与 kind 无关
      //                   （外部导入的折旧凭证没有 kind，但卡片有 deprVoucher）
      //   ③ 工资模块   —— v.payroll 标记
      // 三类都不该手工红字冲销，但【理由不同】：
      //   · 期末类 / 工资：官方入口是「重新生成」，会先删旧凭证、再按最新数据重算；
      //     手工红字冲销后结账清单仍认为本期已结转/已计提，两套判定打架，账反而更乱。
      //   · 固定资产折旧 / 清理：红字冲销【不会回退卡片】—— 只有「删除凭证」才会
      //     （_revertAssetDepr / _revertAssetClean）。红字冲销后卡片的累计折旧、清理状态
      //     会与总账脱节，账实不符。
      var vno = (orig.word || '记') + '-' + (orig.no != null ? orig.no : '');
      var assets = this.state.fixedAssets || [];
      var faDepr = assets.filter(function (f) { return f.deprVoucher === vno; })[0];
      if (faDepr) {
        return { ok: false, msg: '该凭证是固定资产「计提折旧」凭证（卡片 ' + (faDepr.code || '') + '）。'
          + '红字冲销不会回退卡片的累计折旧，会造成账实不符。如需更正，请到「期末处理」用「计提折旧」重新生成'
          + '（会先删原凭证、再按最新数据重算，同时回退卡片）' };
      }
      var faClean = assets.filter(function (f) { return f.cleanVoucher === vno; })[0];
      if (faClean) {
        return { ok: false, msg: '该凭证是固定资产「清理」凭证（卡片 ' + (faClean.code || '') + '）。'
          + '红字冲销不会撤销处置业务，会造成账实不符。请先到「固定资产」对该卡片执行「取消清理」，'
          + '系统会同时删掉这张凭证' };
      }
      if (orig.payroll) {
        return { ok: false, msg: '该凭证由「工资」模块生成。红字冲销不改动工资记录，会造成「工资已发、账上无凭证」。'
          + '请先到工资模块处理对应工资记录，再用工资模块重新生成凭证' };
      }
      if (orig.kind) {
        var K = this.VOUCHER_KINDS, KIND_LABEL = {}, KIND_WHERE = {};
        KIND_LABEL[K.CARRY_PL] = '结转损益';
        KIND_LABEL[K.CARRY_YE] = '结转本年利润';
        KIND_LABEL[K.CARRY_COST] = '结转销售成本';
        KIND_LABEL[K.DEPR] = '计提折旧';
        KIND_LABEL[K.PAYROLL_ACC] = '计提工资';
        KIND_LABEL[K.PAYROLL_PAY] = '发放工资';
        KIND_LABEL[K.PROFIT_DIST] = '利润分配';
        KIND_WHERE[K.DEPR] = '「固定资产 → 计提折旧」或「期末处理」';
        KIND_WHERE[K.PAYROLL_ACC] = '「工资」模块';
        KIND_WHERE[K.PAYROLL_PAY] = '「工资」模块';
        return { ok: false, msg: '该凭证是「' + (KIND_LABEL[orig.kind] || '期末业务') + '」自动生成的凭证，'
          + '不应手工红字冲销（它的自动逻辑自带「重新生成」入口，会先删旧再按最新数据重算）。'
          + '如需更正，请到' + (KIND_WHERE[orig.kind] || '「结账 → 期末处理」') + '重新生成' };
      }

      // 防重复红字冲销：以账上【实际存在的未删除红字冲销凭证】为准，而不是只看 orig.reversedBy 字段
      // —— 后者在「红字冲销凭证又被删除」时会失真，导致原凭证无法再次红字冲销。
      var exist = (this.state.vouchers || []).filter(function (x) {
        return x.reverses === id && x.deleted !== 'y';
      })[0];
      if (exist) {
        return { ok: false, msg: '该凭证已被 ' + (exist.word || '记') + '-' + exist.no + ' 红字冲销，请勿重复冲销'
          + '（若要撤销这次红字冲销，可对其红字冲销凭证再做一次红字冲销）' };
      }

      // 摘要口径（对齐金蝶）：「冲销 + 期间(YYYYMM) + 原凭证字号 + 原摘要」
      //   例：原凭证 记-63（2026-08）摘要「结转餐厅厨房原材料」
      //       → 红字冲销凭证摘要「冲销202608记-63结转餐厅厨房原材料」
      // 每一行沿用【本行自己的原摘要】，多行不同摘要的凭证冲销后才不会串味。
      var sign = '冲销' + month.replace('-', '') + vno;
      // 构造红字分录：方向不变、金额取负（num(e.dr) === 0 时显式写 0，避免出现 -0）
      var entries = orig.entries.map(function (e) {
        var row = {
          code: e.code,
          name: e.name,
          summary: sign + (e.summary || ''),
          dr: num(e.dr) === 0 ? 0 : -num(e.dr),
          cr: num(e.cr) === 0 ? 0 : -num(e.cr)
        };
        if (e.cashActivity) row.cashActivity = e.cashActivity;   // 现金流量映射随分录一并继承
        return row;
      });
      // 红字冲销后要不要提示「重新结转」—— 判据必须收紧，否则天天误报就成噪音：
      //   ① 本期【原本已结转】：用 carryForwardState()，它是「本期是否已结转」的单点实现
      //   ② 红字冲销【打破了】那个已结平的状态：用 periodProfitNet() 取前后两次对比
      // 两者缺一不可，各自排除一类误报：
      //   · 本期还没结转（月中红字冲销）→ 不提示（期末正常结转即可，此时提示反而误导）
      //   · 本期已结转，但红字冲销没动损益类科目 → 不提示（结转不受影响）
      // 判据口径与 settleChecklist / carryForwardProfit 完全一致（三者共用 periodProfitNet），
      // 避免出现「红字冲销说不用结转、结账说必须结转」这种两套口径打架的老问题。
      var carryBefore = this.carryForwardState(month).done;
      var netBefore = this.periodProfitNet(month);
      function plSettled(o) { return Math.abs(o.rev) < EPS && Math.abs(o.exp) < EPS; }
      // 日期：目标期间即当前自然月用今天，否则用该月最后一天 —— 保证日期落在目标期间内，
      // 否则 voucherMonth() 会把凭证归到别的月份，与目标期间不符。
      var natMonth = fmtDate(new Date()).slice(0, 7);
      var date = (month === natMonth) ? fmtDate(new Date()) : lastDay(month);

      var created = this.addVoucher({
        word: orig.word || '记',
        date: date,
        attach: 0,
        summary: entries.length ? entries[0].summary : sign,
        entries: entries,
        reverses: orig.id,                                        // 本凭证冲销了谁（关联追溯）
        reverseReason: String(opts.reason == null ? '' : opts.reason).trim()
      });
      if (!created || created.ok === false) return created || { ok: false, msg: '红字冲销失败' };

      // 双向关联：原凭证记下「被谁冲销」，供列表标记与事后追溯
      orig.reversedBy = created.id;
      orig.reversedAt = fmtDateTime(new Date());
      this.persist();
      this.addLog('红字冲销凭证',
        (created.word || '记') + '-' + created.no + ' 冲销 ' + vno,
        '凭证', created.reverseReason || '(未填写)',
        vno + (orig.summary ? ' ' + orig.summary : ''),
        null,
        { id: created.id, action_type: 'reverse',
          target_name: (created.word || '记') + '-' + created.no,
          related_id: orig.id, result: 'success' });
      // 红字冲销落库后再取一次损益净额，与红字冲销前对比：
      // 只有「原本结平 → 现在不结平」才算被打破（此时才提示；否则一声不吭）。
      var netAfter = this.periodProfitNet(month);
      var brokeCarry = carryBefore && plSettled(netBefore) && !plSettled(netAfter);
      return {
        ok: true,
        voucher: created,
        hint: brokeCarry
          ? '本次红字冲销打破了「' + month + '」已完成（且当时是结平的）损益结转 —— 请到「结账 → 期末处理」'
            + '重新结转本期损益，否则报表净利润会与结转损益凭证金额分叉'
          : null
      };
    },

    // 列出已软删凭证（供 UI「回收站」入口展示）
    deletedVouchers: function () {
      return (this.state.vouchers || []).filter(function (v) { return v.deleted === 'y'; });
    },
    // 物理清除已软删凭证（不可恢复，高危；用于清理历史软删凭证）
    purgeDeletedVouchers: function () {
      var before = (this.state.vouchers || []).length;
      this.state.vouchers = (this.state.vouchers || []).filter(function (v) { return v.deleted !== 'y'; });
      var purged = before - this.state.vouchers.length;
      if (purged > 0) {
        this._glCache = {};
        this.persist();
        this.addLog('清除回收站', '物理清除 ' + purged + ' 张已软删凭证', '凭证',
          null, null, null,
          { action_type: 'purge', result: 'success' });
      }
      return { ok: true, purged: purged };
    },
    /* ---------- 业务科目角色解析（单点，规范化） ----------
     * 自动凭证生成与默认科目只说「角色」，编码由当前准则决定（两准则费用类不同 5xxx/6xxx）。
     * 解析顺序：用户配置编码 preferred → 准则 subjectRoles → 按名称关键字回退 → null。
     * 科目缺失统一由调用方给出明确提示，绝不裸调 subject(code).name 导致崩溃。
     */
    subjectRole: function (role, preferred) {
      // 兜底必须是 'small2013'：STANDARDS 里【只有】这一套（standards.js 已统一为小企业会计准则 2013）。
      // 旧代码兜到 'old' 会取到 undefined → roles 为空 → 折旧/工资等科目角色解析静默失效。
      var std = (this.state && this.state.standard) || 'small2013';
      var roles = (global.STANDARDS && global.STANDARDS[std] && global.STANDARDS[std].roles) || {};
      var want = preferred || roles[role];
      if (want) { var s = this.subject(want); if (s) return s; }
      var kw = {
        DEPR_FEE: ['管理费用'], PAYROLL_FEE: ['管理费用'], ACC_DEPR: ['累计折旧'],
        FA_ASSET: ['固定资产'], FA_CLEAN: ['固定资产清理'], FA_IMPAIR: ['减值准备'],
        PAYROLL_PAYABLE: ['应付职工薪酬'], BANK: ['银行存款'],
        PROFIT_YEAR: ['本年利润'], PROFIT_RESIDUAL: ['利润分配'],
        SURPLUS_RESERVE: ['盈余公积'], DIVIDEND_PAYABLE: ['应付股利', '应付利润'],
        COST_PROD: ['生产成本'], COST_INV: ['库存商品']
      }[role];
      if (kw) {
        // 精确等值优先（避免「固定资产」误配「固定资产清理」等含相同前缀的科目）
        var exact = (this.state.subjects || []).filter(function (x) {
          return kw.some(function (k) { return (x.name || '').trim() === k; });
        });
        if (exact.length) return exact[0];
        var subs = (this.state.subjects || []).filter(function (x) {
          return kw.some(function (k) { return (x.name || '').indexOf(k) >= 0; });
        });
        if (subs.length) return subs[0];
      }
      return null;
    },
    // 凭证借贷平衡校验
    voucherBalance: function (entries) {
      var dr = 0, cr = 0;
      (entries || []).forEach(function (e) { dr += num(e.dr); cr += num(e.cr); });
      // 合计后 round2 消除二进制浮点累积误差（0.1+0.1+...≠1.0），再与 EPS 比较。
      // diff 也要 round2：Math.abs(100-100.01)=0.010000000000005116 ≠ 0.01，直接比会越过 EPS。
      var drR = round2(dr), crR = round2(cr);
      return { dr: drR, cr: crR, balanced: round2(Math.abs(drR - crR)) <= EPS };
    },

    /* ===================== 运行期自检（防算错） =====================
     * 「结账检查 / 试算平衡」：开机、选账套、结账后自动跑，
     * 任何一项不过即在顶部弹红字，绝不掩盖。返回 { ok, items:[{level,label,detail}] } */
    // month 可选：传了就检查指定期间（结账清单用），不传则检查当前期间（开机自检/横幅用）。
    // 之所以要能传期间：结账清单必须与运行期自检共用同一套判定，否则两边口径一打架，
    // 就会出现「横幅说账不平、结账说可以结」的死锁（历史教训，见 carryForwardProfit 注释）。
    runSelfTest: function (month) {
      var self = this;
      var items = [];
      function push(level, label, detail) { items.push({ level: level, label: label, detail: detail || '' }); }
      if (!this.state || !this.state.subjects) {
        return { ok: true, items: items, skipped: true };
      }
      // 1、所有科目期初：借贷合计应相等（开账不平则全盘错）
      var opDr = 0, opCr = 0;
      (this.state.openingBalances || {});
      var obMap = this.state.openingBalances || {};
      Object.keys(obMap).forEach(function (k) {
        var o = obMap[k];
        opDr += num(o.dr); opCr += num(o.cr);
      });
      if (Math.abs(opDr - opCr) >= 0.01) {
        push('error', '期初余额借贷不平', '借方合计 ¥' + opDr.toFixed(2) + '，贷方合计 ¥' + opCr.toFixed(2) + '，差额 ¥' + Math.abs(opDr - opCr).toFixed(2));
      }
      // 2、每张凭证借贷平衡（防止脏数据绕过 UI 校验进账）
      var badV = 0;
      (this.state.vouchers || []).forEach(function (v) {
        var r = self.voucherBalance(v.entries);
        if (!r.balanced) badV++;
      });
      if (badV > 0) {
        push('error', '存在借贷不平的凭证', '共 ' + badV + ' 张凭证借贷不相等，将导致账簿与报表失真');
      }
      // 3、资产负债表恒等式（默认取当前期间，入参优先）
      try {
        var m = month || ((typeof currentPeriod === 'function') ? currentPeriod() : (this.state.currentPeriod || ''));
        if (m) {
          var bs = this.balanceSheet(m);
          if (Math.abs(bs.totalAsset - bs.totalAll) >= 0.01) {
            var diff = bs.totalAsset - bs.totalAll;
            var net = 0;
            try { net = this.profitStatement(m).netProfit; } catch (e) {}
            var carried = 0;
            try {
              var eq = bs.groups.equity.items;
              for (var i = 0; i < eq.length; i++) { if (eq[i].label && eq[i].label.indexOf('本年利润') >= 0) carried = eq[i].end; }
            } catch (e) {}
            var residual = Math.abs((net - carried) - diff) < 1;
            var detail = '资产 ¥' + bs.totalAsset.toFixed(2) + '，负债及权益 ¥' + bs.totalAll.toFixed(2) + '，差额 ¥' + Math.abs(diff).toFixed(2);
            if (residual) {
              push('warn', '资产负债表暂不平衡（未结转损益）', detail + '；差额≈未结转损益净额，结转后自动平衡');
            } else {
              push('error', '资产负债表不平衡（非未结转损益导致）', detail + '；差额无法由未结转损益解释，可能源于期初录入不平或科目属性标注问题，建议回到数据源规范后重新导入账套');
            }
          }
        }
      } catch (e) {
        push('error', '资产负债表计算异常', String(e && e.message || e));
      }
      // 4、三表勾稽（**软关系 —— 仅作参考信息，不告警**）
      // 【为什么降级为 info，而不是 warn】
      //   原实现断言「利润表净利润 = 资产负债表未分配利润本年变动」，但这个等式只在
      //   「本年无利润分配、且损益结转结构与标准模板一致」时才成立。真实账套普遍不成立：
      //     · 有利润分配时，正确关系是
      //         未分配利润本年变动 = 本年累计净利润 − 本年已分配利润
      //       实测本账套（2026-08）：-467,387.60 = 597,776.09 − 1,065,163.69，
      //       差额恰为 310410「应付利润」的余额（挂在 3104 利润分配下的分配类科目）。
      //     · 且原实现用「本期净利润」去比「本年累计变动」，**口径本身就不匹配** ——
      //       该账套 7 月差 110,599.71、8 月差 926,986.59，**每月必报**，属确定性误报。
      //   曾尝试按正确口径修正（改用本年累计净利 − 本年已分配），仍不成立：
      //   逐项累加 items.ytd 得 1,069,618.68（父子科目重复），改取末级得 534,520.38，
      //   与应有的 597,776.09 均不符 —— 因导入账套的结转结构（月度结转到 3103、
      //   分配走 3104 明细）与通用公式的假设不同，无法用一套通用取数精确复现。
      // 【风险权衡】硬关系「资产 = 负债 + 所有者权益」已由第 3 项独立且严格地检查
      //   （判据能区分「未结转损益导致的差额」与「真实不平衡」）。而本项是软关系，
      //   保留为 warn 只会每月弹一条**无法解释**的告警，让用户对真实告警脱敏。
      //   故保留计算、降为 info（首页横幅不显示），需要时可在控制台查阅。
      try {
        var mp = month || ((typeof currentPeriod === 'function') ? currentPeriod() : (this.state.currentPeriod || ''));
        if (mp) {
          var pl = this.profitStatement(mp);
          var bs2 = this.balanceSheet(mp);
          var unprofitEnd = 0, unprofitOp = 0;
          bs2.groups.equity.items.forEach(function (it) {
            if (it.label && it.label.indexOf('未分配利润') >= 0) { unprofitEnd = it.end; unprofitOp = it.year; }
          });
          var profitDelta = unprofitEnd - unprofitOp;
          // 本年已分配利润：3104 利润分配（父行已 rollCodes 上卷，含提取盈余公积/应付利润/转作资本等全部明细）
          var allocate = 0;
          try {
            this.generalLedger(mp).forEach(function (r) { if (String(r.code) === '3104') allocate += num(r.ytdDr); });
          } catch (e2) {}
          push('info', '三表勾稽（参考）',
            '未分配利润本年变动 ¥' + profitDelta.toFixed(2) +
            '，本期净利润 ¥' + pl.netProfit.toFixed(2) +
            '，本年已分配利润 ¥' + allocate.toFixed(2) +
            '；三者不等属常见（利润分配与结转结构所致），仅供参考，不影响账务正确性');
        }
      } catch (e) {}
      var ok = !items.some(function (x) { return x.level === 'error'; });
      return { ok: ok, items: items };
    },

    /* ===================== 期间过滤 =====================
     * 软删除过滤：所有"活动凭证"查询入口（periodVouchers/vouchersBefore/ytdVouchers/getVoucher）
     * 均排除 deleted==='y'。软删凭证只在 deletedVouchers() 回收站可见。
     * 直接访问 state.vouchers 的少数派生场景（如 ensureVoucherIds 初始化、_voucherRefs 反查），
     * 通过显式过滤或调用上述入口间接过滤。
     */
    periodVouchers: function (month) {
      return this.state.vouchers.filter(function (v) { return v.deleted !== 'y' && voucherMonth(v) === month; })
        // 排序：月份 → 凭证字 → 字号（数值，避免记-19 排在记-2 前的字典序）
        .sort(voucherOrderCmp);
    },
    vouchersBefore: function (month) { // < month（含期初之前）
      return this.state.vouchers.filter(function (v) { return v.deleted !== 'y' && voucherMonth(v) < month; });
    },
    ytdVouchers: function (month) { // 本年累计：当年 1 月 ~ 当前月
      var y = month.slice(0, 4);
      return this.state.vouchers.filter(function (v) {
        if (v.deleted === 'y') return false;
        var m = voucherMonth(v);
        return m >= y + '-01' && m <= month;
      }).sort(voucherOrderCmp);
    },

    // ============ 立即存档（手动按钮与结账/结转等触发点共用） ============
    // 立即落一份「自动存档」（最近 10 份滚动），不依赖 3 秒防抖窗口。
    // 说明：录错账不靠备份（走红字冲销/反结账更正），错删账套走回收站还原；
    // 「导入 / 恢复备份」等整本覆盖动作前的回退，由「覆盖前存档」saveRestoreSnapshot 单独承担。
    backupNow: function () {
      var bid = this.currentBookId();
      // 兜底：当前指针为空但有账套时，回退到 default / 第一个（避免空指针导致备份直接失败）
      if (!bid) {
        var bs = this._bookList || [];
        var cand = bs.map(function (b) { return b && b.id; }).filter(function (x) { return !!x; });
        bid = cand.indexOf('default') >= 0 ? 'default' : (cand[0] || '');
      }
      if (!bid) return Promise.resolve(false);
      var st = this.state;
      // 清掉 persist 的防抖窗口，避免与本次强制备份重复/交错
      if (this._bkTimer) { clearTimeout(this._bkTimer); this._bkTimer = null; this._bkWindow = false; this._bkDirty = false; }
      try {
        if (typeof window.Storage !== 'undefined') {
          return window.Storage.saveBackup(bid, st).then(function (r) {
            if (!(r && r.ok)) {
              console.warn('[backupNow] 自动存档失败：' + ((r && r.error) || '未知原因'));
            }
            return !!(r && r.ok);
          }).catch(function (e) {
            console.warn('[backupNow] 自动存档失败：' + (e && e.message || e));
            return false;
          });
        }
        return Promise.resolve(false);
      } catch (e) {
        console.warn('[backupNow] 备份异常：' + (e && e.message || e));
        return Promise.resolve(false);
      }
    },

    /* ===================== 期末业务凭证类型（v.kind） =====================
     * 背景（系统性缺陷，此处一次性根治；此后禁止再新增「摘要正则判定期末凭证」的写法）：
     *   此前全工程 14 处「某类期末凭证是否已存在」的判定，全部依赖凭证摘要正则
     *   （/结转.*损益/、/年度本年利润/、/计提.*折旧/ …）。而  / Excel 导入的凭证
     *   **没有凭证级 summary 字段**（摘要只落在分录级 entries[].summary，见 kis-import.js:192），
     *   故 re.test(v.summary || '') 对导入凭证恒为 false，导致：
     *     · 幂等失效 → 重复生成年结/税金凭证（错账）；
     *     · 结账检查恒 fail → 12 月年度结转死锁，该月永远无法结账；
     *     · 期末处理页恒显示「未生成 / 待结转」（展示错误）。
     * 方案：以 v.kind 为单一事实源——
     *   - 生成端：新增期末凭证时直接打标（addVoucher 原样保存传入对象，字段天然持久化）；
     *   - 存量：normalizeState 时按「结构特征」识别并回填一次，此后永久固化；
     *   - 消费端：一律读 v.kind，不再依赖摘要。
     * 结构识别只按「科目角色/编码组合」判断，费用类科目码经 subjectRole() 解析（不硬编码，
     * 两准则自动适配）。识别不出一律返回 undefined（按普通凭证处理）——宁可漏标，绝不错标。
     */

    // 期末业务凭证类型（值存于 v.kind；未标记/undefined = 普通业务凭证）
    VOUCHER_KINDS: {
      CARRY_PL: 'carryPL',           // 结转损益（损益类科目 ⇄ 本年利润）
      CARRY_YE: 'carryYE',           // 结转本年利润（本年利润 → 利润分配，仅 12 月）
      DEPR: 'depr',                  // 计提固定资产折旧
      CARRY_COST: 'carryCost',       // 结转销售成本
      // CARRY_VAT / ACCRUE_SURTAX / ACCRUE_INCTAX 已随对应期末模板下线（2026-09-18），
      // 不再定义。理由见 _detectVoucherKind 与 settleChecklist 处注释。
      PAYROLL_ACC: 'payrollAcc',     // 计提工资
      PAYROLL_PAY: 'payrollPay',     // 发放工资
      PROFIT_DIST: 'profitDist'      // 利润分配（提取盈余公积/分配股利，仅 12 月）
    },

    // 按结构特征识别单张凭证的期末业务类型（不读摘要，兼容导入凭证）
    _detectVoucherKind: function (v) {
      var self = this;
      var es = (v && v.entries) || [];
      if (!es.length) return undefined;
      // 红字冲销凭证（v.reverses）不参与期末业务识别：它是「某张凭证的镜像」，不是一笔新业务。
      // 必须显式排除：若原凭证是【手工做的】结转损益类结构（借收入 / 贷本年利润），
      // 红字冲销后金额全为负、但结构特征仍在 —— 会被误判成 carryPL，污染结账清单
      // 「本期是否已结转」的判定。（ensureVoucherKinds 只回填无 kind 的凭证，故这里必须挡。）
      if (v && v.reverses) return undefined;
      var codes = {}, hasPL = false;
      es.forEach(function (e) {
        var c = String(e.code == null ? '' : e.code);
        if (c) codes[c] = true;
        var s = self.subject(e.code);
        if (s && (s.cls === 'revenue' || s.cls === 'expense')) hasPL = true;
      });
      var codeList = Object.keys(codes);
      function has(code) { return !!codes[String(code)]; }
      function startsWith(p) { return codeList.some(function (c) { return c.indexOf(p) === 0; }); }
      function hasRole(role) { var s = self.subjectRole(role); return !!(s && has(s.code)); }
      var K = this.VOUCHER_KINDS;

      // 1) 结转损益：同时出现「损益类科目」与「本年利润」（本软件与结转凭证的共同结构）
      if (hasPL && hasRole('PROFIT_YEAR')) return K.CARRY_PL;
      // 2) 年度结转：本年利润 + 利润分配，且不含损益类科目（含损益的归入结转损益）
      if (hasRole('PROFIT_YEAR') && hasRole('PROFIT_RESIDUAL') && !hasPL) return K.CARRY_YE;
      // 2.5) 利润分配：利润分配科目 +（盈余公积或应付股利），且不含本年利润（含本年利润归 CARRY_YE）
      if (hasRole('PROFIT_RESIDUAL') && !hasRole('PROFIT_YEAR') && (hasRole('SURPLUS_RESERVE') || hasRole('DIVIDEND_PAYABLE'))) return K.PROFIT_DIST;
      // 3) 计提折旧：【与 deprVoucherIn() 严格同口径】贷方落在累计折旧科目 + 借方是费用类。
      // 为什么不再依赖 DEPR_FEE 角色科目：导入账套的折旧费用科目是 5401006「折旧」，
      // 而 DEPR_FEE 角色在角色表未配置时会按关键词兜底匹配到「管理费用」，二者对不上，
      // 于是导入的历史折旧凭证识别不出来 —— 表现为「结账清单说本期有待计提折旧，
      // 点计提却被 deprVoucherIn 拦住说该月已存在折旧凭证」，两条路径互相矛盾。
      // 安全性与 deprVoucherIn 相同论证：清理凭证是【借】累计折旧（方向相反），天然不会误命中。
      var accDeprPrefixes = [];
      var accDeprRole = self.subjectRole('ACC_DEPR');
      if (accDeprRole) accDeprPrefixes.push(String(accDeprRole.code));
      // 兼容多累计折旧科目账套（1602 / 1622 等），按名称兜底一并纳入
      (self.state.subjects || []).forEach(function (s) {
        if (/累计折旧/.test(String(s.name || ''))) {
          var c = String(s.code);
          if (accDeprPrefixes.indexOf(c) < 0) accDeprPrefixes.push(c);
        }
      });
      var hasAccDeprCr = es.some(function (e) {
        return num(e.cr) > 0 && accDeprPrefixes.some(function (c) { return String(e.code).indexOf(c) === 0; });
      });
      var hasExpenseDr = es.some(function (e) {
        var s = self.subject(e.code);
        return num(e.dr) > 0 && s && s.cls === 'expense';
      });
      if (hasAccDeprCr && hasExpenseDr) return K.DEPR;
      // 4) 结转销售成本：生产成本 + 库存商品
      if (hasRole('COST_PROD') && hasRole('COST_INV')) return K.CARRY_COST;
      // 5) 工资：应付职工薪酬 +（费用科目=计提 / 银行或现金=发放）；限短凭证，避免误判手工凭证
      if (hasRole('PAYROLL_PAYABLE') && es.length <= 3) {
        if (hasRole('PAYROLL_FEE')) return K.PAYROLL_ACC;
        if (hasRole('BANK') || has('1001')) return K.PAYROLL_PAY;
      }
      // 6/7/8 已随「转出未交增值税 / 计提附加税 / 计提所得税」三个期末模板一并下线（2026-09-18）。
      // 下线理由：真实账套（绅蓝之星、添钰来客）经核对从未使用「转出未交增值税」；
      // 附加税与所得税虽有真实计提，但计税口径（按利润×税率）与账套实际不符，
      // 自动生成的金额不可信，误导风险 > 便利。税款一律由会计按实际申报数手工录入。
      return undefined;
    },

    // 读取凭证的期末业务类型：已打标直接返回，未打标按结构识别（不回写）
    voucherKind: function (v) {
      if (!v) return undefined;
      if (v.kind) return v.kind;
      return this._detectVoucherKind(v);
    },
    // 某期间内指定类型的期末凭证
    periodVouchersOfKind: function (month, kind) {
      var self = this;
      return (this.periodVouchers(month) || []).filter(function (v) {
        return self.voucherKind(v) === kind;
      });
    },
    // 存量凭证类型回填：仅补未打标凭证，识别结果固化到 v.kind（随下次写盘落库）。
    // 已打标的凭证绝不重判——标记是既成事实，不应随科目表配置变化而漂移。
    ensureVoucherKinds: function () {
      var self = this;
      var vs = (this.state && this.state.vouchers) || [];
      var n = 0;
      vs.forEach(function (v) {
        if (v.kind) return;
        var k = self._detectVoucherKind(v);
        if (k) { v.kind = k; n++; }
      });
      return n;
    },

    /* ===================== 结转损益 ===================== */
    // 本期损益类科目（收入/费用）净发生额——「是否需要结转损益」的唯一取数口径。
    // 关键：carryForwardProfit 与 settleChecklist 必须共用本函数。此前二者各自实现
    // （一个取轧差、一个取发生额），口径打架造成「结账说未结转、点结转说无需结转」的死锁。
    // 注：3103/3104 的 cls 为 equity（见 standards.js），本就不会进入 revenue/expense 分支，
    // 此处显式排除仅作防御（科目表被改坏时不致污染损益）。
    periodProfitNet: function (month) {
      var self = this;
      var rev = 0, exp = 0;
      (this.periodVouchers(month) || []).forEach(function (v) {
        v.entries.forEach(function (e) {
          var s = self.subject(e.code);
          if (!s) return;
          if (e.code === PROFIT_CODE || e.code === '3104') return;
          if (s.cls === 'revenue') rev += num(e.cr) - num(e.dr);
          else if (s.cls === 'expense') exp += num(e.dr) - num(e.cr);
        });
      });
      return { rev: rev, exp: exp };
    },
    // 本期损益结转状态：以「是否存在结转损益凭证」为准（按 v.kind 识别，兼容导入凭证）。
    // 返回 { done, vouchers }——调用方据此拦截，并可从 vouchers 取到凭证号用于提示/删除。
    carryForwardState: function (month) {
      var vs = this.periodVouchersOfKind(month, this.VOUCHER_KINDS.CARRY_PL);
      return { done: vs.length > 0, vouchers: vs };
    },
    // 是否已结转损益（布尔，兼容历史调用）
    hasCarryForward: function (month) {
      return this.carryForwardState(month).done;
    },
    // 【冻结】结转损益：行为已由自动化守护锁定 —— 幂等见 tools/verify_invariants.js I6，
    // 口径见 tools/audit_books.js「结转损益口径 = 利润表口径（逐期）」。
    // 纯可读性改动（花括号/缩进/拆辅助函数）不改业务口径，风险 > 收益，默认不动；
    // 确需重构时：单独开一轮，改完立即跑上述两脚本，全绿才算完成（决策记录见 CHANGELOG 2026-09-12）。
    carryForwardProfit: function (month, opts) {
      opts = opts || {};
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账，请先反结账' };
      // 幂等（财务规范：一个期间只能结转一次损益）：按 v.kind 定位结转凭证，
      // 兼容导入账套（其凭证无 summary，摘要正则恒不命中，必须靠结构识别）。
      var st = this.carryForwardState(month);
      if (st.done) {
        var nums = st.vouchers.map(function (v) { return (v.word || '转') + '-' + v.no; }).join('、');
        return { ok: false, msg: '本期损益已结转，请勿重复；如需重做请先删除结转凭证（' + nums + '）', vouchers: st.vouchers };
      }
      // 取数口径与 settleChecklist 完全一致（共用 periodProfitNet），杜绝两边打架。
      var vs = this.periodVouchers(month);
      var net0 = this.periodProfitNet(month);
      var totalRev = net0.rev, totalExp = net0.exp;
      var self = this;
      if (Math.abs(totalRev) < EPS && Math.abs(totalExp) < EPS)
        return { ok: false, msg: '本期损益净额为零，无需结转' };

      // 汇总各收入/费用科目净发生额，逐一结转（排除结转科目 3103/3104，与上面一致）
      var map = {};
      vs.forEach(function (v) {
        v.entries.forEach(function (e) {
          var s = self.subject(e.code);
          if (!s) return;
          if (e.code === PROFIT_CODE || e.code === '3104') return; // 排除结转科目
          if (s.cls === 'revenue' || s.cls === 'expense') {
            var net = 0;
            if (s.cls === 'revenue') net = num(e.cr) - num(e.dr);
            else net = num(e.dr) - num(e.cr);
            if (net) { map[e.code] = (map[e.code] || 0) + net; }
          }
        });
      });
      // 按科目性质分成收入类 entriesRev 和费用类 entriesExp
      var entriesRev = [], entriesExp = [];
      Object.keys(map).forEach(function (code) {
        var s = self.subject(code);
        var amt = map[code];
        if (s.cls === 'revenue') {
          entriesRev.push({ code: code, name: s.name, summary: '结转' + s.name, dr: amt, cr: 0 });
        } else {
          entriesExp.push({ code: code, name: s.name, summary: '结转' + s.name, dr: 0, cr: amt });
        }
      });
      var net = totalRev - totalExp;
      var profitCode = opts.targetSubj || (this.subjectRole('PROFIT_YEAR') || { code: PROFIT_CODE }).code;
      var profitName = this.subject(profitCode) ? this.subject(profitCode).name : '本年利润';
      var savedVouchers = [];
      var baseV = {
        word: opts.word || this.state.param.voucherWord || '记',
        date: (opts && opts.date) || lastDay(month), attach: 0,
        kind: this.VOUCHER_KINDS.CARRY_PL
      };
      var doSave = function (entries) {
        if (!entries.length) return null;
        // 结转凭证 entries 由程序生成，理论上借贷平衡；但若前面科目汇总存在 rounding 误差，
        // 最后一条「本年利润」分录的金额可能与汇总项差几分钱，导致 addVoucher 拒绝。
        // 这里做一次预检：若发现不平衡，调整最后一条 entries 的金额让它平衡（plug 分录）。
        var _bal = self.voucherBalance(entries);
        if (!_bal.balanced) {
          var _diff = round2(_bal.dr - _bal.cr);
          var _last = entries[entries.length - 1];
          if (_diff > 0) _last.cr = round2(num(_last.cr) + _diff);   // 借 > 贷 → 补贷
          else if (_diff < 0) _last.dr = round2(num(_last.dr) - _diff); // 贷 > 借 → 补借
          // 必须留痕：plug 会**悄悄改变金额**，若汇总环节真有错会被它掩盖。
          // 差几分属正常的逐科目 round2 累积，差到「元」级则说明汇总有问题，需人工核查。
          var _msg = '[结转] 损益结转借贷差 ' + _diff.toFixed(2) + ' 元，已调整末笔分录配平';
          console.warn(_msg + (Math.abs(_diff) >= 1 ? '（差额较大，请核查科目汇总！）' : ''));
        }
        var v = Object.assign({}, baseV, { entries: entries });
        v.summary = opts.summary || ('结转' + month + '损益');
        var r = self.addVoucher(v);
        if (r && r.ok !== false) savedVouchers.push(r);
        return r;
      };
      // separate=true（默认）：收入→3103（贷）一张、费用→3103（借）一张
      if (opts.separate !== false) {
        var saved1 = null, saved2 = null;
        // 凭证 1：收入类 → 本年利润（3103 在贷方）
        if (entriesRev.length || Math.abs(totalRev) >= EPS) {
          var e1 = entriesRev.slice();
          if (Math.abs(totalRev) >= EPS) e1.push({ code: profitCode, name: profitName, summary: '结转本年利润', dr: 0, cr: totalRev });
          saved1 = doSave(e1);
        }
        // 凭证 2：成本费用类 → 本年利润（3103 在借方）
        if (entriesExp.length || Math.abs(totalExp) >= EPS) {
          var e2 = entriesExp.slice();
          if (Math.abs(totalExp) >= EPS) e2.push({ code: profitCode, name: profitName, summary: '结转本年利润', dr: totalExp, cr: 0 });
          saved2 = doSave(e2);
        }
        if (!saved1 && !saved2) return { ok: false, msg: '结转损益失败' };
      } else {
        // 同时结转（一张净额，旧逻辑）
        var entriesAll = entriesRev.concat(entriesExp);
        if (Math.abs(net) >= EPS) {
          if (net > 0) entriesAll.push({ code: profitCode, name: profitName, summary: '结转本年利润', dr: 0, cr: net });
          else entriesAll.push({ code: profitCode, name: profitName, summary: '结转本年利润', dr: -net, cr: 0 });
        }
        if (!entriesAll.length) return { ok: false, msg: '结转损益失败：无损益类科目' };
        doSave(entriesAll);
      }
      this.backupNow();
      return { ok: true, vouchers: savedVouchers, totalRev: totalRev, totalExp: totalExp, net: net };
    },

    /* ===================== 年末结转本年利润 ===================== */
    // 12 月结账前，结转损益后需把「本年利润 3103」余额结平，
    // 转入「利润分配-未分配利润 3104」。盈利：借 3103 贷 3104；亏损反向。
    // 缺此步会导致跨年资产负债表「未分配利润」年初数失真（3103 未清零、未并入 3104）。
    carryYearEnd: function (month, opts) {
      opts = opts || {}; // 下面要用 opts.date（此前漏声明：函数签名只有 month，引用 opts 会抛
      // ReferenceError，导致 12 月年结在「本年利润有余额」时直接崩溃 —— 空余额时提前 return 掩盖了它）
      if (!month || month.substring(5, 7) !== '12')
        return { ok: false, msg: '仅 12 月需结转本年利润' };
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账，请先反结账' };
      // 幂等保护（财务大忌：重复生成同额凭证）：按 v.kind 定位年度结转凭证。
      // 原实现仅用摘要正则 /年度本年利润/，导入凭证无 summary 时恒不命中，
      // 会导致同一 12 月重复生成年结凭证（错账）。改用结构识别后对导入账套同样有效。
      var existedYE = this.periodVouchersOfKind(month, this.VOUCHER_KINDS.CARRY_YE);
      if (existedYE.length) {
        var yeNums = existedYE.map(function (v) { return (v.word || '转') + '-' + v.no; }).join('、');
        return { ok: false, msg: '本期已生成 ' + existedYE.length + ' 张结转本年利润凭证（' + yeNums + '），请勿重复；如需重做请先删除旧凭证', vouchers: existedYE };
      }
      var profit = this.subjectRole('PROFIT_YEAR');
      var undist = this.subjectRole('PROFIT_RESIDUAL');
      if (!profit || !undist) return { ok: false, msg: '缺失本年利润/利润分配科目' };
      // 本年利润余额（含本期结转损益后）
      var glRow = (this.generalLedger(month) || []).filter(function (r) { return r.code === PROFIT_CODE; })[0];
      if (!glRow) return { ok: false, msg: '缺失本年利润科目' };
      var bal = glRow.normal === 'dr' ? (num(glRow.endDr) - num(glRow.endCr)) : (num(glRow.endCr) - num(glRow.endDr));
      if (Math.abs(bal) < EPS) return { ok: false, msg: '本年利润无余额，无需结转' };
      var entries;
      if (bal > 0) {
        // 盈利：借 本年利润 贷 利润分配-未分配利润
        entries = [
          { code: profit.code, name: profit.name, summary: '结转本年利润至未分配利润', dr: bal, cr: 0 },
          { code: undist.code, name: undist.name, summary: '结转本年利润至未分配利润', dr: 0, cr: bal }
        ];
      } else {
        // 亏损：借 利润分配-未分配利润 贷 本年利润
        entries = [
          { code: undist.code, name: undist.name, summary: '结转本年利润至未分配利润', dr: -bal, cr: 0 },
          { code: profit.code, name: profit.name, summary: '结转本年利润至未分配利润', dr: 0, cr: -bal }
        ];
      }
      var v = {
        word: this.state.param.voucherWord || '记', date: (opts && opts.date) || lastDay(month), attach: 0,
        summary: '结转 ' + month.substring(0, 4) + ' 年度本年利润',
        kind: this.VOUCHER_KINDS.CARRY_YE, // 期末业务类型标记（幂等/结账检查按此识别，不依赖摘要）
        entries: entries
      };
      var saved = this.addVoucher(v);
      if (!saved || saved.ok === false) {
        return { ok: false, msg: (saved && saved.msg) || '年末结转失败' };
      }
      this.backupNow(); // 年末结转利润高风险，强制立即备份
      return { ok: true, voucher: saved, amount: Math.abs(bal) };
    },

    /* ===================== 年末利润分配 ===================== */
    // 12 月结账前，结转本年利润（3103→3104）后，按净利润提取盈余公积、分配股利。
    // 结账方案（GLServiceType FID=8/9/10）：法定盈余公积 10%、任意盈余公积 10%、应付股利 30%。
    // 本软件合并法定/任意盈余公积为「盈余公积」20%、应付股利 30%（默认比例）；
    // 账套无对应明细科目时仅对存在的科目生成分录（灵活适配小企业简化科目）。
    carryProfitDistribute: function (month) {
      if (!month || month.substring(5, 7) !== '12')
        return { ok: false, msg: '仅 12 月可进行利润分配' };
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该期已结账，请先反结账' };
      // 必须先结转本年利润（3103→3104），否则基数（净利润/未分配利润）失真
      var ye = this.periodVouchersOfKind(month, this.VOUCHER_KINDS.CARRY_YE);
      if (!ye.length) return { ok: false, msg: '请先结转本年利润，再进行利润分配' };
      // 幂等保护（同 carryYearEnd）：按 v.kind 定位，避免重复生成错账
      var old = this.periodVouchersOfKind(month, this.VOUCHER_KINDS.PROFIT_DIST);
      if (old.length) {
        var nums = old.map(function (v) { return (v.word || '转') + '-' + v.no; }).join('、');
        return { ok: false, msg: '本期已生成 ' + old.length + ' 张利润分配凭证（' + nums + '），请勿重复；如需重做请先删除旧凭证', vouchers: old };
      }
      var undist = this.subjectRole('PROFIT_RESIDUAL');
      if (!undist) return { ok: false, msg: '缺失利润分配科目' };
      var self = this, year = month.slice(0, 4);
      // 净利润基数取自「结转本年利润」凭证金额。
      // 注意：已结账账套中损益科目已被结转凭证平掉，profitStatement 逐分录累加会因
      // 「借费用 贷3103」「借3103 贷收入」导致发生额重复计入而失真；故直接以 CARRY_YE
      // 凭证中 借3103(本年利润) / 贷3104(利润分配-未分配利润及其明细) 的金额为准。
      var R = function (x) { return Math.round(x * 100) / 100; };
      var net = 0;
      ye.forEach(function (v) {
        v.entries.forEach(function (e) {
          if (e.code === '3103' || e.code === PROFIT_CODE) net += num(e.dr);
          if (/^3104/.test(e.code) || e.code === undist.code) net += num(e.cr);
        });
      });
      net = R(net);
      if (!(net > 0.005)) return { ok: false, msg: '本期无净利润可供分配（结转本年利润凭证金额为 0）' };
      // 找科目：优先明细（310101 法定 / 310102 任意 / 2232 应付利润），回退父科目或名称匹配
      function findSub(kw, code) {
        var s = code ? self.subject(code) : null; if (s) return s;
        return self.subjects().filter(function (x) { return x.name && x.name.indexOf(kw) >= 0; })[0];
      }
      var legal = findSub('法定盈余公积', '310101');
      var disc = findSub('任意盈余公积', '310102');
      var div = this.subjectRole('DIVIDEND_PAYABLE') || findSub('应付利润', '2232');
      var surplus = this.subjectRole('SURPLUS_RESERVE');
      var entries = [];
      var alloc = 0;
      if (legal) { var a = R(net * 0.10); entries.push({ code: legal.code, name: legal.name, summary: '提取法定盈余公积', dr: 0, cr: a }); alloc += a; }
      if (disc) { var b = R(net * 0.10); entries.push({ code: disc.code, name: disc.name, summary: '提取任意盈余公积', dr: 0, cr: b }); alloc += b; }
      // 无明细科目时回退：合并计提盈余公积 20%（法定+任意）
      if (!legal && !disc && surplus) { var c = R(net * 0.20); entries.push({ code: surplus.code, name: surplus.name, summary: '提取盈余公积', dr: 0, cr: c }); alloc += c; }
      if (div) { var d = R(net * 0.30); entries.push({ code: div.code, name: div.name, summary: '分配股利', dr: 0, cr: d }); alloc += d; }
      if (!entries.length) return { ok: false, msg: '未找到盈余公积/应付股利科目，请先在「科目」中增设利润分配明细科目，或使用自定义结转模板' };
      alloc = R(alloc);
      entries.unshift({ code: undist.code, name: undist.name, summary: '利润分配（提取盈余公积及分配股利）', dr: alloc, cr: 0 });
      var v = {
        word: this.state.param.voucherWord || '记', date: lastDay(month), attach: 0,
        summary: '分配 ' + year + ' 年度利润',
        kind: this.VOUCHER_KINDS.PROFIT_DIST,
        entries: entries
      };
      var saved = this.addVoucher(v);
      if (!saved || saved.ok === false) return { ok: false, msg: (saved && saved.msg) || '利润分配失败' };
      this.backupNow(); // 利润分配高风险，强制立即备份
      return { ok: true, voucher: saved, amount: alloc, netProfit: net };
    },

    // 注：原「期末调汇（exchangeAdjust）」外币核算功能已整体下线（产品定为纯本币人民币记账），
    // 相关入口（设置-币别、科目外币核算、结账-期末调汇卡片）已同步移除。
    // 旧账套若历史存在「期末调汇」摘要凭证，保留原样不再重复生成，报表口径不受影响。

    /* ===================== 结账/反结账 ===================== */
    isPeriodClosed: function (month) {
      if (!this.state.closedPeriods) this.state.closedPeriods = [];
      return this.state.closedPeriods.indexOf(month) >= 0;
    },
    // 系统模板默认全部启用，用户可在设置里停用
    settleTplDefaultEnabled: function (id) {
      // vat / surTax / incTax 三个模板已下线（2026-09-18）
      // cost（结转销售成本）默认关闭（2026-09-18）：实测真实账套该业务确实存在，
      // 但借方科目是「5401 主营业务成本」的各明细（商品/客房/餐厅，各账套不同），
      // 而本软件默认指向「4001 生产成本」（账套里零发生额），且金额靠收入比例测算不准。
      // 与其猜错科目把成本记歪，不如默认关闭，由用户在期末处理页显式「启用」并指定科目后再用。
      if (id === 'cost') return false;
      var systemTpls = ['dep', 'cost', 'profit'];
      return systemTpls.indexOf(id) >= 0;
    },
    // 模板当前是否启用（读 state.settleTemplates，未保存时用默认）
    settleTplEnabled: function (id) {
      var tpls = this.state.settleTemplates;
      if (!tpls || !Array.isArray(tpls)) return this.settleTplDefaultEnabled(id);
      for (var i = 0; i < tpls.length; i++) {
        if (tpls[i].id === id) return tpls[i].enabled !== false;
      }
      return this.settleTplDefaultEnabled(id);
    },
    // 结账前检查清单（损益结转 + 借贷平衡是硬性条件；
    // 折旧/调汇/税费等启用的期末处理模板为提示项，未完成时结账需确认）。
    // 返回 [{ key, label, status: 'ok'|'fail'|'warn', tip }]
    // 部分 fail 项（vbal/ghost）属于硬错误，**不可被 checkOverrides 降级**——
    // 借贷不平或存在幽灵科目的账绝对不能结账，用户强制也不行。
    // 其余 fail 项（结转损益/本年利润等）可通过 checkOverrides 降级为 warn，
    // 再由 opts.force 跳过——给极端场景（如导入账套无损益结转结构）留口子。
    settleChecklist: function (month) {
      var self = this;
      // 硬错误键：绝对不可被降级的检查项
      var NON_OVERRIDABLE_KEYS = { vbal: true, ghost: true };
      var vs = this.periodVouchers(month);
      var est = this.profitStatement(month);
      var checks = [];
      function add(key, label, status, tip) {
        var ov = (self.state.param && self.state.param.checkOverrides) || {};
        var o = ov[key];
        // 硬错误键不可被降级
        if (!NON_OVERRIDABLE_KEYS[key]) {
          if (o === 'warn' && status === 'fail') status = 'warn';   // 降级为提醒
          if (o === 'block' && status === 'warn') status = 'fail';  // 升级为拦截
        }
        checks.push({ key: key, label: label, status: status, tip: tip });
      }
      // 期末处理凭证是否已生成：一律按 v.kind 判定（结构识别，兼容导入的无摘要凭证）。
      // 此前用摘要正则（/结转.*损益/、/计提.*折旧/ …），对导入凭证恒不命中，
      // 导致这些项在账套上永远显示「未生成/建议生成」，且幂等保护形同虚设。
      function kindCount(kind) { return self.periodVouchersOfKind(month, kind).length; }

      // 1. 凭证借贷平衡（硬性：本期内任意凭证借贷不平则拦截结账）
      if (vs.some(function (v) { return !self.voucherBalance(v.entries).balanced; })) {
        add('vbal', '凭证借贷平衡', 'fail', '本期存在借贷不平衡的凭证，请修正后再结账');
      } else {
        add('vbal', '凭证借贷平衡', 'ok', '本期凭证借贷均已平衡');
      }

      // 1.2 凭证号连续性（提示：软删凭证会导致活动列表断号，但号仍在系统中未丢失）
      var byWord = {};
      vs.forEach(function (v) {
        var w = v.word || '记';
        if (!byWord[w]) byWord[w] = [];
        byWord[w].push(v.no);
      });
      var gapTips = [];
      for (var wd in byWord) {
        var nos = byWord[wd].sort(function (a, b) { return a - b; });
        for (var i = 1; i < nos.length; i++) {
          if (nos[i] - nos[i - 1] > 1) {
            gapTips.push(wd + '-' + (nos[i - 1] + 1) + '~' + (nos[i] - 1));
          }
        }
      }
      if (gapTips.length) {
        add('vseq', '凭证号连续', 'warn', '本期存在断号：' + gapTips.join('、') + '（已删除的凭证可在回收站还原）');
      } else {
        add('vseq', '凭证号连续', 'ok', '本期凭证号连续无断号');
      }

      // 1.6 幽灵科目检查（硬性：任何分录 e.code 不在科目表中都会被总账静默漏算，必须拦截）
      var codeSet = {};
      self.subjects().forEach(function (s) { codeSet[s.code] = true; });
      var ghost = [];
      vs.forEach(function (v) {
        (v.entries || []).forEach(function (e) {
          if (!codeSet[e.code]) ghost.push(v.word + '-' + v.no + '(' + (e.code || '空') + ')');
        });
      });
      if (ghost.length) {
        add('ghost', '科目代码完整性', 'fail', '存在不在科目表中的分录（幽灵科目）：' + ghost.slice(0, 5).join('、') + (ghost.length > 5 ? ' 等' : ''));
      } else {
        add('ghost', '科目代码完整性', 'ok', '本期所有分录的科目代码均在科目表中');
      }

      // 2. 损益结转（硬性：本期损益净额非 0 则必须结转）
      // 关键：判定与 carryForwardProfit 共用同一个取数函数 periodProfitNet()，二者条件严格等价，
      // 从根上消除「结账说未结转、点结转说无需结转」的死锁（曾出现于导入账套）。
      // 文案另用利润表发生额口径区分「已结转」与「本期确无损益」，避免误导。
      var netPL = self.periodProfitNet(month);
      var needCarry = Math.abs(netPL.rev) >= EPS || Math.abs(netPL.exp) >= EPS;
      var hasPLActivity = Math.abs(num(est.totalRevenue)) >= EPS || Math.abs(num(est.totalExpense)) >= EPS;
      if (!needCarry) {
        add('carry', '结转损益', 'ok', hasPLActivity ? '损益已结转（本期损益净额已清零）' : '本期无损益发生');
      } else {
        add('carry', '结转损益', 'fail', '本期损益未结转，请先结转损益');
      }

      // 2.5 结转本年利润（硬性，仅 12 月）：年末须把「本年利润 3103」结平转入
      // 「利润分配-未分配利润 3104」，否则跨年资产负债表「未分配利润」年初数失真
      // （3103 未清零、未并入 3104）。此前 carryYearEnd() 已实现但全工程零调用（死代码），
      // 此处将其接入结账检查，使 12 月未结转时被拦截并可见。
      if (String(month).substring(5, 7) === '12') {
        var hasUndist = !!self.subject('3104');
        if (!hasUndist) {
          add('yearend', '结转本年利润', 'ok', '无利润分配科目，跳过年度结转');
        } else {
          var glP = (self.generalLedger(month) || []).filter(function (r) { return r.code === PROFIT_CODE; })[0];
          var pBal = glP
            ? (glP.normal === 'dr' ? (num(glP.endDr) - num(glP.endCr)) : (num(glP.endCr) - num(glP.endDr)))
            : 0;
          // 按 v.kind 判定：原摘要正则对导入凭证恒不命中，
          // 会让 12 月永远判「未结转本年利润」而卡死结账。
          var yeDone = kindCount(self.VOUCHER_KINDS.CARRY_YE) > 0;
          if (Math.abs(pBal) < EPS) {
            add('yearend', '结转本年利润', 'ok', '本年利润无余额，无需结转');
          } else if (yeDone) {
            add('yearend', '结转本年利润', 'ok', '本年利润已结转至未分配利润');
          } else {
            add('yearend', '结转本年利润', 'fail',
              '12 月须结转本年利润（当前余额 ' + money(pBal) + '）至未分配利润，否则跨年未分配利润失真');
          }
        }
      }

      // 3. 计提折旧（提示项：模板启用且本期有待折旧资产）
      // 【模板禁用时不加入清单】：禁用意味着用户不打算用这个期末项，
      // 再显示一条「模板已禁用」既无可操作信息、又占坑，属噪音（此前会加一个 ok 项）。
      if (self.settleTplEnabled('dep')) {
        var faNeed = self.state.fixedAssets.filter(function (fa) {
          return fa.status !== '清理' && fa.deprMonth !== month && self.assetMonthlyDepr(fa) > 0.004;
        });
        var depCnt = kindCount(self.VOUCHER_KINDS.DEPR);
        if (!faNeed.length) add('dep', '计提折旧', 'ok', '本期无待折旧资产');
        else add('dep', '计提折旧', depCnt ? 'ok' : 'warn',
          depCnt ? ('折旧已计提 ' + depCnt + ' 张') : ('本期有 ' + faNeed.length + ' 项资产待计提折旧'));
      }

      // 4.（原期末调汇提示项已随外币功能下线移除，序号不再回填以免历史规则错位）

      // 5. 结转销售成本（提示项：模板启用且本期有收入）
      // 【模板禁用时不加入清单】同 dep：cost 默认禁用，若仍塞一条 ok 项，
      // 结账检查里会永远挂着一个「结转销售成本 · 模板已禁用」，与「已下线」观感无异。
      if (self.settleTplEnabled('cost')) {
        var costNeed = num(est.totalRevenue) >= EPS;
        var costCnt = kindCount(self.VOUCHER_KINDS.CARRY_COST);
        if (!costNeed) add('cost', '结转销售成本', 'ok', '本期无收入');
        else add('cost', '结转销售成本', costCnt ? 'ok' : 'warn',
          costCnt ? '成本已结转' : '本期有收入，建议结转销售成本');
      }

      // 6/7/8「转出未交增值税 / 计提附加税 / 计提所得税」三个期末模板已下线（2026-09-18），
      // 不再纳入结账检查。理由见 _detectVoucherKind 处注释：账套从未使用增值税转出，
      // 且按「利润×税率」测算的税额与实际申报口径不符，自动生成的金额不可信。
      // 税款一律由会计按实际申报数手工录入凭证。

      // 9. 科目余额检查（标准结账守卫；小公司可在「检查项处置」里降级/关闭）
      // 取数口径复用 generalLedger（行已带 normal/endDr/endCr），与报表一致。
      var glRows = self.generalLedger(month) || [];
      function endBalOf(code) {
        var r = glRows.filter(function (x) { return x.code === code; })[0];
        if (!r) return null;
        return r.normal === 'cr' ? (num(r.endCr) - num(r.endDr)) : (num(r.endDr) - num(r.endCr));
      }
      // 现金/银行/其他货币资金期末出现贷方余额（赤字）—— 判定规则见下，默认只提醒不拦截
      var cashAccts = (self.cashAccounts ? self.cashAccounts() : []).map(function (s) { return s.code; });
      var negCash = cashAccts.filter(function (c) { var b = endBalOf(c); return b !== null && b < -EPS; });
      // 现金及现金等价物「期末余额是否存在异常」默认【不参与检查】。
      // 真实账套常见「已停用账户历史挂账」「POS 机在途资金」等合理贷方余额，若硬拦会让账永远结不掉。
      // 故降级为提醒：仍显示在清单里提醒核查，但不阻止结账（用户可在「检查项处置」里升级为拦截）。
      if (negCash.length) add('cashNeg', '货币资金赤字', 'warn', '以下科目期末为贷方余额（赤字）：' + negCash.join('、') + '，请核查（已停用账户挂账、POS 在途资金等属常见情况）');
      else add('cashNeg', '货币资金赤字', 'ok', '货币资金余额正常（无赤字）');
      // 应收(1122)/应付(2202) 出现反向余额 → 仅提醒（可能为重分类事项）
      var ar = endBalOf('1122');
      if (ar !== null && ar < -EPS) add('arRev', '应收账款反向余额', 'warn', '应收账款为贷方余额，可能为预收款项未重分类');
      else add('arRev', '应收账款反向余额', 'ok', '应收账款余额方向正常');
      var ap = endBalOf('2202');
      if (ap !== null && ap < -EPS) add('apRev', '应付账款反向余额', 'warn', '应付账款为借方余额，可能为预付款项未重分类');
      else add('apRev', '应付账款反向余额', 'ok', '应付账款余额方向正常');

      // 10. 财务初始余额试算平衡（硬性：未处理不允许结账）
      // 11. 资产负债表是否平衡（硬性：未处理不允许结账）
      // 判定完全复用运行期自检 runSelfTest(month) —— 单一实现，杜绝「横幅说不平、结账说能结」的打架。
      //   · 期初借贷不平            → error → fail
      //   · 资产负债表差额 ≈ 未结转损益净额 → warn（结转损益后自动平衡，由第 4 项 carry 兜底拦截）
      //   · 其余资产负债表不平      → error → fail
      var stt = this.runSelfTest(month);
      function pickSelfTestItem(match, exclude) {
        var hit = null;
        (stt.items || []).forEach(function (it) {
          if (hit) return;
          var lb = String(it.label || '');
          if (lb.indexOf(match) >= 0 && (!exclude || lb.indexOf(exclude) < 0)) hit = it;
        });
        return hit;
      }
      var stInit = pickSelfTestItem('期初余额借贷不平');
      if (stInit) add('initBal', '财务初始余额试算', 'fail', stInit.detail || '期初余额借贷不平，请核对开账数据');
      else add('initBal', '财务初始余额试算', 'ok', '期初余额借贷平衡');

      // 排除「利润表与资产负债表勾稽偏差」—— 那一项是三表勾稽提示，不属本检查项
      var stBs = pickSelfTestItem('资产负债表', '利润表');
      if (stBs) add('bsBal', '资产负债表平衡', stBs.level === 'error' ? 'fail' : 'warn', stBs.detail || stBs.label);
      else add('bsBal', '资产负债表平衡', 'ok', '资产 = 负债 + 所有者权益，恒等式成立');

      // 12. 启用的自定义/凭证模板：本期是否已生成凭证（**仅提醒，绝不拦截结账**）
      // 【为什么只 warn 不 fail】模板本期该不该用，取决于业务是否真实发生（如本月没电话费就不该有这笔凭证），
      // 属「业务触发」而非「客观必做」（折旧、结转损益那种不做账就必错的才算），
      // 用 fail 拦截会把正常月份误报为漏做，反而诱发「为消警报而硬提一笔」的错账。
      // 判定口径与生成时完全对齐：genVoucherFromTpl 打的就是 kind='settleTpl:<模板id>'，不依赖摘要。
      // 系统模板（dep/cost/profit）已有各自检查项，此处只处理自定义/凭证模板，避免重复。
      (this.state.settleTemplates || []).forEach(function (t) {
        if (!t || !t.id) return;
        if (!(t.custom || t.fromVchTpl)) return;
        if (!self.settleTplEnabled(t.id)) return;            // 未启用则不检查
        var cnt = self.periodVouchersOfKind(month, 'settleTpl:' + t.id).length;
        var label = t.name || '自定义模板';
        if (cnt) add('tpl:' + t.id, label, 'ok', '已生成 ' + cnt + ' 张');
        else add('tpl:' + t.id, label, 'warn', '本期尚未生成凭证（如本期确实无需此笔，可忽略）');
      });

      return checks;
    },
    closePeriod: function (month, opts) {
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账' };
      opts = opts || {};
      // 结账必须逐期顺序进行（财务规范）：上一期间未结账，本期不能结账。
      // 否则会「跳期结账」，导致中间期间的数据可随意修改、账簿断档。
      // 上期 = 比 month 早且最接近的「有凭证/有业务」期间；若存在且未结账则拦截。
      // （无更早期间的账套首期除外）
      var prev = this._prevPeriod(month);
      if (prev && !this.isPeriodClosed(prev)) {
        return { ok: false, msg: '上一期间 ' + prev + ' 尚未结账，请先结账上一期（结账须逐期顺序进行）' };
      }
      var checks = this.settleChecklist(month);
      var fails = checks.filter(function (c) { return c.status === 'fail'; });
      if (fails.length) {
        return { ok: false, msg: '结账检查未通过：' + fails[0].label + '（' + fails[0].tip + '）', checks: checks, fails: fails };
      }
      var warns = checks.filter(function (c) { return c.status === 'warn'; });
      if (warns.length && !opts.force) {
        return { ok: false, warnOnly: true, warns: warns, checks: checks };
      }
      this.state.closedPeriods.push(month);
      this.state.closedPeriods.sort();
      this.persist();
      this.addLog('期末结账', '结账期间 ' + month, '结账');
      this.backupNow(); // 结账不可逆，强制立即备份
      return { ok: true, checks: checks, warns: warns };
    },
    reopenPeriod: function (month, reason) {
      // 风险控制：仅允许反结账「最近一期」（已结账期间的最新月）。
      // 财务规范：跨期反结账会破坏多期账务的连续性，且历史报表已被引用/报税时影响面更大。
      // 如确需反结账更早期间，须先逐期反结账至目标期。
      if (!this.state.closedPeriods || !this.state.closedPeriods.length)
        return { ok: false, msg: '无可反结账期间' };
      var latest = this.state.closedPeriods.slice().sort().pop();
      if (month !== latest) {
        return { ok: false, msg: '仅允许反结账最近一期（' + latest + '）；如需反结账更早期间，请先逐期反结账至目标期' };
      }
      this.state.closedPeriods = this.state.closedPeriods.filter(function (m) { return m !== month; });
      this.persist();
      // 反结账审计留痕：reason 字段独立于 detail，便于操作日志页红标醒目展示
      this.addLog('反结账', '取消结账期间 ' + month, '结账', reason || '', null, null,
        { target_id: month, target_name: month, action_type: 'reopen', result: 'success' });
      this.backupNow(); // 反结账影响历史报表，强制立即备份
      return { ok: true };
    },

    // 结账顺序校验辅助：返回比 month 早且最接近的「有凭证/业务」期间；无则返回 null。
    // 用途：closePeriod 校验「上期必须已结账」（逐期结账，禁止跳期）。
    _prevPeriod: function (month) {
      var months = {};
      (this.state.vouchers || []).forEach(function (v) {
        var m = voucherMonth(v);
        if (m) months[m] = 1;
      });
      var list = Object.keys(months).filter(function (m) { return m < month; }).sort();
      return list.length ? list[list.length - 1] : null;
    },

    /* ===================== 账簿（由凭证+期初动态生成） ===================== */
    // 期初余额（累计至某月之前）
    // 科目层级：返回 code 的所有末级子目 code（code 为父级前缀；标准会计科目编码为前缀层级）
    childCodesOf: function (code) {
      var c = String(code);
      return (this.state.subjects || []).filter(function (s) {
        return s.code !== c && s.code.indexOf(c) === 0;
      }).map(function (s) { return s.code; });
    },
    // 该科目及全部末级子目的 code 集合（口径：父级余额=自身+子目合计）
    rollCodes: function (code) {
      return [String(code)].concat(this.childCodesOf(code));
    },
    openingOf: function (code, month) {
      var self = this;
      var codes = this.rollCodes(code);
      var dr = 0, cr = 0;
      codes.forEach(function (c) {
        var o = self.opening(c);
        dr += o.dr; cr += o.cr;
      });
      var before = this.vouchersBefore(month);
      before.forEach(function (v) {
        v.entries.forEach(function (e) {
          if (codes.indexOf(e.code) < 0) return;
          dr += num(e.dr); cr += num(e.cr);
        });
      });
      return { dr: dr, cr: cr };
    },
    /* ===================== 资金风险体检 =====================
     * 一键扫描当前账套，输出风险点清单。每项含类型/严重度/明细/穿透凭证入口。
     * 检测项：
     *   1. 科目方向异常（资产/费用类出现贷方余额 / 负债/权益/收入类出现借方余额）
     *   2. 关键科目大额异常（实收资本/长期待摊/其他应收款余额超阈值）
     *   3. 大额凭证（单笔借贷总额超阈值）
     *   4. 期末损益未结转（损益类科目有期末余额）
     *   5. 资产负债表恒等式不平衡
     *   6. 跨年余额跳变（基于 meta.yearBoundaries，多年合并账套才有）
     */
    financialHealthCheck: function (options) {
      options = options || {};
      var self = this;
      var largeVoucherThreshold = options.largeVoucher || 50000;       // 大额凭证阈值
      var keySubjectThreshold = options.keySubject || 100000;          // 关键科目大额阈值
      var directionThreshold = options.direction || 100;               // 方向异常金额阈值
      var checks = [];

      // 取最新期间 = company.currentPeriod 或所有凭证最大期间
      var month = this.state.company && this.state.company.currentPeriod;
      if (!month) {
        var maxM = '';
        (this.state.vouchers || []).forEach(function (v) {
          if ((v.date || '') > maxM) maxM = v.date;
        });
        month = maxM.slice(0, 7);
      }
      if (!month) return { period: '', checks: [], summary: { total: 0, high: 0, medium: 0, low: 0 } };

      // === 检测 1：科目方向异常 ===
      var gl = this.generalLedger(month);
      var dirAnomalies = [];
      gl.forEach(function (row) {
        if (!row.balance || row.balance < directionThreshold) return;
        // 父级科目是子科目的汇总，父子同时报警等于同一件事说两遍——
        // 如「利润分配 283.6 万」就是「应付利润 101.2 万」+「未分配利润 182.4 万」。
        // 只看末级科目，信息不丢、清单不重复（本账套 9 项 → 6 项）。
        if ((self.childCodesOf(row.code) || []).length) return;
        var isDrNormal = (row.normal === 'dr');
        var isCrNormal = (row.normal === 'cr');
        // 资产/费用类（dr 正常方向）出现贷方余额，或负债/权益/收入类（cr 正常方向）出现借方余额
        if ((isDrNormal && row.dir === '贷') || (isCrNormal && row.dir === '借')) {
          // 权益类出现借方余额 = 累计亏损/已分配超额，是经营结果不是记账错误，
          // 与"科目用错"混为一谈会吓到人，也可能让人忽视真正要查的（如应付利润挂账）。
          var equityLoss = (row.cls === 'equity' && row.dir === '借');
          dirAnomalies.push({
            code: row.code, name: row.name, cls: row.cls,
            normal: row.normal, dir: row.dir, balance: row.balance,
            issue: equityLoss
              ? '权益类为借方余额 ¥' + row.balance.toFixed(2) + '，通常表示累计亏损或已分配超额，属经营结果；如与实际经营情况不符再核查'
              : (isDrNormal ? '资产/费用类科目出现贷方余额' : '负债/权益/收入类科目出现借方余额')
                + '（正常方向：' + (isDrNormal ? '借' : '贷') + '，实际：' + row.dir
                + '），可能源于预收/预付/结算在途，也可能科目用错，请穿透明细确认'
          });
        }
      });
      if (dirAnomalies.length) {
        // 按金额分档：本账套里既有未分配利润 182 万这种必须看的，也有 POS 机 1475 元这种
        // 结算时差造成的零头，一律挂 high 会让真正的重灾项被淹没。
        var maxDirAbs = dirAnomalies.reduce(function (m, x) { return Math.max(m, Math.abs(x.balance)); }, 0);
        checks.push({
          type: 'direction_anomaly',
          severity: maxDirAbs >= 100000 ? 'high' : 'medium',
          title: '科目余额方向异常',
          desc: '余额方向与科目正常方向相反。可能是正常业务（预收、预付、多还备用金、结算在途），也可能是科目用错或结转不到位——请穿透明细逐笔确认，方向相反本身不构成结论',
          items: dirAnomalies
        });
      }

      // === 检测 2：关键科目大额异常 ===
      // 文案原则：只陈述「金额 + 需核实什么」，不做定性指控。
      // 这类科目大额本身是业务常态（酒店装修费进长期待摊、股东投入进实收资本），
      // 写成"虚假出资/资金挪用"属于危言耸听，反而淹没真正的问题。
      var keySubjects = [
        { codes: ['3001', '3002', '3001001', '3001002', '3001003', '3001004', '3001005'], name: '实收资本及资本公积', risk: '建议核实出资流水与验资凭证是否齐全' },
        { codes: ['1801', '1801001', '1801002', '1801003', '1801004'], name: '长期待摊费用', risk: '建议核实合同、付款凭证与摊销进度是否匹配' },
        { codes: ['1221', '1221001', '1221002', '1221015', '1221020', '1221022'], name: '其他应收款', risk: '建议核实往来对象、用途与账龄，长期挂账留意税务处理' }
      ];
      var keyAnomalies = [];
      keySubjects.forEach(function (ks) {
        var total = 0;
        gl.forEach(function (row) {
          if (ks.codes.indexOf(row.code) >= 0) total += row.balance;
        });
        // 用绝对值：权益/往来类常以贷方余额（负数）呈现，只看正数会漏报——
        // 绅蓝之星实收资本 762 万就因是负数而从未被提示过。
        if (Math.abs(total) >= keySubjectThreshold) {
          keyAnomalies.push({
            codes: ks.codes.join('/'), name: ks.name, balance: total,
            issue: '余额 ¥' + total.toFixed(2) + '（超 ¥' + keySubjectThreshold + ' 关注线）；' + ks.risk
          });
        }
      });
      if (keyAnomalies.length) {
        checks.push({
          type: 'key_subject_large', severity: 'medium', title: '大额科目待核实',
          desc: '以下三类科目金额较大，属需人工核实的重点（大额本身不等于有问题），请核对凭证支撑',
          items: keyAnomalies
        });
      }

      // === 检测 3：金额最大的若干笔凭证（阈值随账套规模自适应）===
      // 固定 5 万阈值在本账套会命中 355 笔（房租/装修/采购普遍超 5 万，而中位数仅 3534 元），
      // 清单长到无法人工复核，等于没提示。改为取本账套金额最大的 TOPN 笔：
      // 大酒店看到的是它真正的超大额，小账套看到的是它的相对大额，两头都可用。
      // 需要固定口径时可传 options.largeVoucher。
      var TOPN = 30;
      var vAmts = [];
      (this.state.vouchers || []).forEach(function (v) {
        var amt = 0;
        (v.entries || []).forEach(function (e) { amt += Math.abs(num(e.dr) || num(e.cr) || 0); });
        vAmts.push(amt / 2);
      });
      vAmts.sort(function (a, b) { return b - a; });
      var effThreshold = options.largeVoucher
        ? largeVoucherThreshold
        : (vAmts.length ? vAmts[Math.min(TOPN, vAmts.length) - 1] : largeVoucherThreshold);
      var largeVouchers = [];
      var vmk = this.voucherMaker;   // forEach 回调内 this 不再指向 store（严格模式），先取出方法引用
      (this.state.vouchers || []).forEach(function (v) {
        var amt = 0;
        (v.entries || []).forEach(function (e) {
          amt += Math.abs(num(e.dr) || num(e.cr) || 0);
        });
        amt = amt / 2;  // 借贷相等，取一半作为凭证金额
        if (amt >= effThreshold) {
          largeVouchers.push({
            id: v.id, date: v.date, word: v.word, no: v.no,
            summary: v.summary, amount: amt, maker: vmk(v),
            entries: (v.entries || []).slice(0, 6)
          });
        }
      });
      largeVouchers.sort(function (a, b) { return b.amount - a.amount; });
      if (largeVouchers.length > TOPN) largeVouchers = largeVouchers.slice(0, TOPN);
      if (largeVouchers.length) {
        checks.push({
          type: 'large_voucher', severity: 'medium',
          title: '金额最大的 ' + largeVouchers.length + ' 笔凭证（≥ ¥' + Math.round(effThreshold).toLocaleString() + '）',
          desc: '按本账套金额分布取最大的若干笔供复核——大额不等于异常，仅提示重点关注',
          items: largeVouchers
        });
      }

      // === 检测 4：期末损益未结转（只看「已结账期间」）===
      // 关键：当期（currentPeriod）尚未结账，损益科目本来就有余额，检查它必然全量误报——
      // 绅蓝之星 2026-08 未结账时这里会一次报出 16 条，而同期已结账的 2026-07 实为 0 条。
      // 只有「已结账期间」损益仍有余额，才说明结账真的没做完整。
      var closedList = (this.state.closedPeriods || []).slice().sort();
      var plMonth = closedList.length ? closedList[closedList.length - 1] : '';
      var glClosed = plMonth ? this.generalLedger(plMonth) : [];
      var unclosedPL = [];
      glClosed.forEach(function (row) {
        if ((row.cls === 'revenue' || row.cls === 'expense') && row.balance >= directionThreshold) {
          unclosedPL.push({
            code: row.code, name: row.name, cls: row.cls,
            balance: row.balance, dir: row.dir,
            issue: '已结账期间 ' + plMonth + ' 期末仍有余额 ¥' + row.balance.toFixed(2) +
              '，损益应结转至本年利润，残留余额会影响利润表准确性'
          });
        }
      });
      if (unclosedPL.length) {
        checks.push({
          type: 'unclosed_pl', severity: 'medium', title: '期末损益未结转',
          desc: '损益类科目期末应有 0 余额（已结转至本年利润），残留余额说明结账未完整执行',
          items: unclosedPL
        });
      }

      // === 检测 5：资产负债表恒等式 ===
      try {
        var bs = this.balanceSheet(month);
        var diff = bs.totalAsset - bs.totalAll;
        if (Math.abs(diff) >= 0.005) {
          checks.push({
            type: 'bs_unbalanced', severity: 'high', title: '资产负债表恒等式不平衡',
            desc: '资产总计 ≠ 负债及所有者权益总计',
            items: [{
              totalAsset: bs.totalAsset, totalAll: bs.totalAll, diff: diff,
              issue: '差额 ¥' + Math.abs(diff).toFixed(2) + '（' + (diff > 0 ? '资产多于负债权益' : '负债权益多于资产') + '），常见原因：损益未结转、期初录入不平、科目属性错标'
            }]
          });
        }
      } catch (e) {}

      // === 检测 6：跨年余额跳变（多年合并账套） ===
      var meta = this.state.meta || {};
      if (meta.yearBoundaries && meta.yearBoundaries.length) {
        var yearJumps = [];
        meta.yearBoundaries.forEach(function (b) {
          var diffs = b.allDiffs || b.samples || [];
          diffs.forEach(function (d) {
            if (Math.abs(d.diff) >= keySubjectThreshold) {
              yearJumps.push({
                fromYear: b.fromYear, toYear: b.toYear,
                code: d.code,
                prevEnd: d.prevEnd, curOpen: d.curOpen, diff: d.diff,
                issue: b.fromYear + '→' + b.toYear + ' 跳变 ¥' + Math.abs(d.diff).toFixed(2) +
                  '（上年期末 ¥' + d.prevEnd.toFixed(2) + ' → 本年期初 ¥' + d.curOpen.toFixed(2) + '），' +
                  (d.prevEnd * d.curOpen < 0 ? '符号反转，' : '') + '可能是手动调期初或年结未达账'
              });
            }
          });
        });
        if (yearJumps.length) {
          checks.push({
            type: 'year_jump', severity: 'high', title: '跨年余额跳变',
            desc: '多年合并账套的跨年期初与上年期末不一致（超 ¥' + keySubjectThreshold + ' 阈值），可能是手动调期初',
            items: yearJumps
          });
        }
      }

      // 汇总统计
      var summary = { total: checks.length, high: 0, medium: 0, low: 0 };
      checks.forEach(function (c) {
        if (c.severity === 'high') summary.high++;
        else if (c.severity === 'medium') summary.medium++;
        else summary.low++;
      });

      return { period: month, checks: checks, summary: summary };
    },

    // 科目某期间借贷方发生额 + 期末余额（按正常方向）
    generalLedger: function (month) {
      var self = this;
      month = normMonth(month); // 期间非法时归一化为「空期间」，避免 split/slice 抛异常白屏
      // 记忆化：同一 month 全量计算成本高（遍历所有凭证×分录），切换科目时
      // findGLRow 会反复请求同一月份，缓存可避免重复全量计算导致卡顿。
      // 缓存键必须带 bookId：否则切换账套后查询「同月份」会命中上一个账套的缓存，
      // 导致新账套账簿/报表显示旧账套数据（严重：错误数据且难以察觉）。
      // 用 bookId 作键的一部分，切换账套即自然失效，无需记忆每个 state 替换点。
      this._glCache = this._glCache || {};
      var glKey = (this.bookId || '_') + '|' + month;
      if (this._glCache.hasOwnProperty(glKey)) return this._glCache[glKey];
      var result = this.subjects().map(function (s) {
        var codes = self.rollCodes(s.code);
        var op = self.openingOf(s.code, month);
        var periodDr = 0, periodCr = 0;
        self.periodVouchers(month).forEach(function (v) {
          v.entries.forEach(function (e) {
            if (codes.indexOf(e.code) >= 0) { periodDr += num(e.dr); periodCr += num(e.cr); }
          });
        });
        // 本年累计（年初 ~ 当前月）
        var ytdDr = 0, ytdCr = 0;
        self.ytdVouchers(month).forEach(function (v) {
          v.entries.forEach(function (e) {
            if (codes.indexOf(e.code) >= 0) { ytdDr += num(e.dr); ytdCr += num(e.cr); }
          });
        });
        // 损益类（收入/费用）期初余额恒为 0：按年结转清零，与标准科目余额表口径一致；
        // 否则往月损益发生额会被累加进期初，导致「期初/期末」两列与标准口径对不上（本期/累计不受影响）。
        if (s.cls === 'revenue' || s.cls === 'expense') op = { dr: 0, cr: 0 };
        // 期末余额（按正常方向）
        var endDr = op.dr + periodDr, endCr = op.cr + periodCr;
        var balance = 0, dir = '';
        if (s.normal === 'dr') { balance = endDr - endCr; dir = balance >= 0 ? '借' : '贷'; balance = Math.abs(balance); }
        else { balance = endCr - endDr; dir = balance >= 0 ? '贷' : '借'; balance = Math.abs(balance); }
        // 本年累计期末（按正常方向）
        var yEndDr = op.dr + ytdDr, yEndCr = op.cr + ytdCr;
        var ytdBalance = 0, ytdDir = '';
        if (s.normal === 'dr') { ytdBalance = yEndDr - yEndCr; ytdDir = ytdBalance >= 0 ? '借' : '贷'; ytdBalance = Math.abs(ytdBalance); }
        else { ytdBalance = yEndCr - yEndDr; ytdDir = ytdBalance >= 0 ? '贷' : '借'; ytdBalance = Math.abs(ytdBalance); }
        return {
          code: s.code, name: s.name, cls: s.cls, normal: s.normal,
          obDr: op.dr, obCr: op.cr, periodDr: periodDr, periodCr: periodCr,
          endDr: endDr, endCr: endCr, balance: balance, dir: dir,
          ytdDr: ytdDr, ytdCr: ytdCr, ytdBalance: ytdBalance, ytdDir: ytdDir
        };
      });
      this._glCache[glKey] = result;
      return result;
    },

    /* ============================================================
     * 余额取数「唯一实现」（契约层）
     * ------------------------------------------------------------
     * 【契约】generalLedger 每行余额已用 rollCodes 上卷：父行 = 自身 + 全部下级。
     *   因此取某科目余额时：
     *     ① 科目表中存在该科目 → 直接取这一行（它已含下级），
     *        **严禁**再按前缀把子科目加一遍（否则成倍虚增）；
     *     ② 只有明细科目、没有该一级科目（如只建了 100201/100202）→
     *        回退为其下属「末级」行相加（末级无下级，不会重复计）。
     * 【历史踩坑】本项目已因此口径翻车 4 次（利润汇总、现金流量表、试算平衡合计、
     *   首页资金余额），故收敛为下面两个 API：页面一律调用，禁止自行遍历子科目聚合。
     * ============================================================ */

    // 科目期末余额（带符号：借正贷负），已含下级。全站唯一实现。
    subjectEndBalance: function (code, month) {
      var self = this;
      var rows = this.generalLedger(month) || [];
      function signed(r) {
        if (!r) return 0;
        var b = Number(r.balance) || 0;
        return r.dir === '借' ? b : -b;   // 借正贷负，还原真实余额方向
      }
      var c = String(code);
      var direct = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].code === c) { direct = rows[i]; break; }
      }
      if (direct) return round2(signed(direct));   // 父行已含下级，直接用
      // 回退：无该一级科目行 → 仅累加其下属末级行
      var kids = this.childCodesOf(c) || [];
      var cand = [c].concat(kids);
      var sum = 0;
      cand.forEach(function (k) {
        if (!(self.childCodesOf(k) || []).length) {   // 末级：无下级
          var r = null;
          for (var j = 0; j < rows.length; j++) { if (rows[j].code === k) { r = rows[j]; break; } }
          sum += signed(r);
        }
      });
      return round2(sum);
    },

    // 资金余额 = 库存现金(1001) + 银行存款(1002) + 其他货币资金(1012)
    // 只取三个一级科目行（各自已含下级银行子户等），不可再按前缀匹配子行。
    cashBalance: function (month) {
      var self = this;
      var sum = 0;
      ['1001', '1002', '1012'].forEach(function (c) { sum += self.subjectEndBalance(c, month); });
      return round2(sum);
    },

    // 科目本期发生额 {dr, cr}——与 subjectEndBalance 完全同一取数契约：
    // ① 科目表存在该科目 → 直接取这一行（父行已上卷全部下级，禁止再加子行）；
    // ② 无该科目行（如只建了 100201）→ 回退为其下属末级行相加。
    // 用途：首页「资金净收入」= 资金类科目本期借方(流入) − 本期贷方(流出)（标准口径）。
    subjectPeriodAmount: function (code, month) {
      var self = this;
      var rows = this.generalLedger(month) || [];
      function rowOf(c) {
        for (var i = 0; i < rows.length; i++) if (rows[i].code === c) return rows[i];
        return null;
      }
      function acc(r, out) {
        if (!r) return;
        out.dr += Number(r.periodDr) || 0;
        out.cr += Number(r.periodCr) || 0;
      }
      var out = { dr: 0, cr: 0 };
      var c = String(code);
      var direct = rowOf(c);
      if (direct) { acc(direct, out); return { dr: round2(out.dr), cr: round2(out.cr) }; }
      var kids = this.childCodesOf(c) || [];
      [c].concat(kids).forEach(function (k) {
        if (!(self.childCodesOf(k) || []).length) acc(rowOf(k), out);   // 末级：无下级
      });
      return { dr: round2(out.dr), cr: round2(out.cr) };
    },
    // 明细账：逐笔 + 每行余额 + 期初/本期合计/本年累计
    detailLedger: function (code, month) {
      var self = this;
      var s = this.subject(code);
      if (!s) return null;
      var codes = this.rollCodes(code);
      var op = this.openingOf(code, month);
      var rows = [];
      var dr = op.dr, cr = op.cr;
      this.periodVouchers(month).forEach(function (v) {
        v.entries.forEach(function (e) {
          if (codes.indexOf(e.code) < 0) return;
          dr += num(e.dr); cr += num(e.cr);
          var bal = 0, dir = '';
          if (s.normal === 'dr') { bal = dr - cr; dir = bal >= 0 ? '借' : '贷'; bal = Math.abs(bal); }
          else { bal = cr - dr; dir = bal >= 0 ? '贷' : '借'; bal = Math.abs(bal); }
          rows.push({
            date: v.date || voucherMonth(v), word: v.word, no: v.no, summary: e.summary || v.summary,
            dr: num(e.dr), cr: num(e.cr), bal: bal, dir: dir,
            qtyDr: num(e.qtyDr), qtyCr: num(e.qtyCr), aux: e.aux || null,
            entryCode: e.code
          });
        });
      });
      // 本年累计（年初 ~ 当前月）
      var ytdDr = 0, ytdCr = 0;
      this.ytdVouchers(month).forEach(function (v) {
        v.entries.forEach(function (e) {
          if (codes.indexOf(e.code) >= 0) { ytdDr += num(e.dr); ytdCr += num(e.cr); }
        });
      });
      return {
        subject: s, obDr: op.dr, obCr: op.cr, rows: rows,
        periodDr: dr - op.dr, periodCr: cr - op.cr, endDr: dr, endCr: cr,
        ytdDr: ytdDr, ytdCr: ytdCr
      };
    },
    // 明细账（期间范围版）：期初 = startMonth 月初，明细 = startMonth → endMonth 逐月合并，
    // 本期合计 = 区间汇总，本年累计 = 年初到 endMonth。与单期版 detailLedger 结构一致，
    // 仅取数范围不同；渲染层统一吃同一份返回结构。
    detailLedgerRange: function (code, startMonth, endMonth) {
      var self = this;
      var s = this.subject(code);
      if (!s) return null;
      var codes = this.rollCodes(code);
      var op = this.openingOf(code, startMonth);
      var rows = [];
      var dr = op.dr, cr = op.cr;
      var months = monthList(startMonth, endMonth);
      months.forEach(function (m) {
        self.periodVouchers(m).forEach(function (v) {
          v.entries.forEach(function (e) {
            if (codes.indexOf(e.code) < 0) return;
            dr += num(e.dr); cr += num(e.cr);
            var bal = 0, dir = '';
            if (s.normal === 'dr') { bal = dr - cr; dir = bal >= 0 ? '借' : '贷'; bal = Math.abs(bal); }
            else { bal = cr - dr; dir = bal >= 0 ? '贷' : '借'; bal = Math.abs(bal); }
            rows.push({
              date: v.date || voucherMonth(v), word: v.word, no: v.no, summary: e.summary || v.summary,
              dr: num(e.dr), cr: num(e.cr), bal: bal, dir: dir,
              qtyDr: num(e.qtyDr), qtyCr: num(e.qtyCr), aux: e.aux || null,
              entryCode: e.code
            });
          });
        });
      });
      // 本年累计（年初 ~ endMonth）
      var ytdDr = 0, ytdCr = 0;
      this.ytdVouchers(endMonth).forEach(function (v) {
        v.entries.forEach(function (e) {
          if (codes.indexOf(e.code) >= 0) { ytdDr += num(e.dr); ytdCr += num(e.cr); }
        });
      });
      return {
        subject: s, obDr: op.dr, obCr: op.cr, rows: rows,
        periodDr: dr - op.dr, periodCr: cr - op.cr, endDr: dr, endCr: cr,
        ytdDr: ytdDr, ytdCr: ytdCr
      };
    },
    // 科目本期借贷发生额（「结转生产成本设置」：收入科目自动汇总本期发生额）
    subjectPeriod: function (code, month) {
      var gl = this.generalLedger(month);
      for (var i = 0; i < gl.length; i++) if (gl[i].code === code) return gl[i];
      return null;
    },
    // 结转销售成本预估（预计结转成本 = 主营业务收入金额 × 成本结转百分比）
    costVoucherEstimate: function (month, tpl) {
      var rev = this.subjectPeriod(tpl.costRevSubj || '5001', month);
      var revAmt = rev ? num(rev.periodDr) + num(rev.periodCr) : 0;
      var rate = num(tpl.costRate === undefined || tpl.costRate === '' ? 80 : tpl.costRate);
      return { revAmt: revAmt, rate: rate, amount: revAmt * rate / 100 };
    },
    // 生成结转销售成本凭证（「结转生产成本设置」：借 生产成本科目，贷 库存商品科目）
    genCostVoucher: function (month, tpl, amount) {
      // 结账守卫：与同文件其它自动结转（损益/年结/折旧/工资）保持一致，禁止写入已结账期间
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账，请先反结账' };
      // 成本结转科目：模板可配置；未配置时按准则角色默认（两准则恒 4001/1405，随准则扩展自动适配）
      var prodRole = this.subjectRole('COST_PROD');
      var invRole = this.subjectRole('COST_INV');
      var prodCode = tpl.costProdSubj || (prodRole ? prodRole.code : '4001');
      var invCode = tpl.costInvSubj || (invRole ? invRole.code : '1405');
      var summary = tpl.summary || '结转生产成本';
      var amt = num(amount);
      var prod = this.subject(prodCode), inv = this.subject(invCode);
      var entries = [
        { code: prodCode, name: prod ? prod.name : '生产成本', summary: summary, dr: amt, cr: 0 },
        { code: invCode, name: inv ? inv.name : '库存商品', summary: summary, dr: 0, cr: amt }
      ];
      var v = this.addVoucher({
        word: tpl.word || this.state.param.voucherWord || '记', date: (tpl && tpl.date) || lastDay(month), attach: 0,
        summary: summary, kind: this.VOUCHER_KINDS.CARRY_COST, entries: entries
      });
      if (!v || v.ok === false) {
        return { ok: false, msg: (v && v.msg) || '结转成本失败' };
      }
      this.backupNow(); // 结转成本批量写凭证，强制立即备份
      return { ok: true, voucher: v, amount: amt };
    },
    // 科目余额表（至某月末）
    trialBalance: function (month) {
      return this.generalLedger(month);
    },

    /* ===================== 报表 ===================== */
    // 利润表：本期金额 + 本年累计（按标准项目）
    profitStatement: function (month) {
      var self = this;
      month = normMonth(month);
      var year = month.split('-')[0];
      var ym = year + '-01';
      // 取某类科目本期净发生额
      function netOf(cls, monthScope) { // monthScope: 'period' 或 'year'
        var vs = monthScope === 'year' ? self.vouchersBefore(month).concat(self.periodVouchers(month))
                                       : self.periodVouchers(month);
        var t = 0;
        vs.forEach(function (v) {
          v.entries.forEach(function (e) {
            var s = self.subject(e.code);
            if (!s || s.cls !== cls) return;
            if (cls === 'revenue') t += num(e.cr) - num(e.dr);
            else t += num(e.dr) - num(e.cr);
          });
        });
        return t;
      }
      // 期间范围：从年初到目标月末（用于本年累计）
      function netOfRange(cls) {
        // 同 netOfCls：统一走 ytdVouchers（已排除软删除凭证），避免累计口径漏掉删除标记
        var vs = self.ytdVouchers(month);
        var t = 0;
        vs.forEach(function (v) {
          v.entries.forEach(function (e) {
            var s = self.subject(e.code);
            if (!s || s.cls !== cls) return;
            if (cls === 'revenue') t += num(e.cr) - num(e.dr);
            else t += num(e.dr) - num(e.cr);
          });
        });
        return t;
      }
      void netOf; void netOfRange;
      // 结转科目（本年利润 3103 / 利润分配 3104）虽可能被标为 revenue/expense cls，
      // 但它们是「权益/结转类」科目，不是损益类科目。若纳入利润表，结转损益凭证中
      // 「贷 3103 本年利润」会被误计入收入，导致结转后利润表收入/净利润翻倍虚增。
      // 修复：取数时显式排除这两个结转科目（符合会计准则：利润表只统计各损益类科目发生额）。
      function isCarryOver(code) {
        return code === PROFIT_CODE || code === '3104';
      }
      var revItems = self.subjects().filter(function (s) { return s.cls === 'revenue' && !isCarryOver(s.code); });
      var expItems = self.subjects().filter(function (s) { return s.cls === 'expense' && !isCarryOver(s.code); });
      var items = [];
      // 结转损益凭证：含「本年利润 3103」或「利润分配 3104」分录的凭证。
      // 【为什么必须整张排除】结转凭证会把每个损益科目做反向分录结平（借收入 / 贷费用）：
      //   若把它的分录计入，取净额会得到 0 —— 这正是旧实现被迫改用「单边发生额」的原因。
      //   但单边口径（收入只算贷方、费用只算借方）会连同**真实的红字冲销/冲减**一起漏掉，
      //   例如「借 待摊费用 / 贷 管理费用」这类冲减是真实发生的，必须抵减该费用。
      //   结果是利润表净利润与结转金额对不上（实测真实账套 6/8 个月偏差，最大 -47429.72）。
      // 正确做法：排除结转凭证后取【净额】—— 冲减被保留、结转被排除，与结转口径逐分一致。
      // 【已外部核对 2026-09-21】用金蝶打开原始账套（添钰来客_2026年）核对：金蝶 2026-05 净利润 = 87263.75，
      //   与本实现、结转凭证、绕开本软件的独立手算三方逐分一致；修复前本软件显示 39834.03 已确认为错误值。
      //   详见 CHANGELOG v0.6.10 与 tools/verify_invariants.js 的 I11（跨口径对账，防止再次分叉）。
      function isCarryVoucher(v) {
        return (v.entries || []).some(function (e) {
          var c = String(e.code);
          return c === PROFIT_CODE || c === '3104';
        });
      }
      // 汇总总额走「逐分录」累加（标准利润表口径：收入净额=贷-借，费用净额=借-贷）。
      // 逐分录累加，避免用 rollCodes 上卷时对父+子重复累加导致金额翻倍。
      var totalRevenue = 0, totalExpense = 0;
      self.periodVouchers(month).forEach(function (v) {
        if (isCarryVoucher(v)) return; // 排除结转损益凭证（其分录是结平用的反向分录）
        v.entries.forEach(function (e) {
          var es = self.subject(e.code);
          if (!es) return;
          if (isCarryOver(e.code)) return; // 排除结转科目本身
          if (es.cls === 'revenue') totalRevenue += num(e.cr) - num(e.dr);
          else if (es.cls === 'expense') totalExpense += num(e.dr) - num(e.cr);
        });
      });
      revItems.forEach(function (s) {
        var cur = netOfCls(s.code, 'period');
        var ytd = netOfCls(s.code, 'year');
        items.push({ name: s.name, cur: cur, ytd: ytd, _cls: 'revenue', code: s.code });
      });
      expItems.forEach(function (s) {
        var cur = netOfCls(s.code, 'period');
        var ytd = netOfCls(s.code, 'year');
        items.push({ name: s.name, cur: cur, ytd: ytd, _cls: 'expense', code: s.code });
      });
      function netOfCls(code, scope) {
        var codes = self.rollCodes(code);
        // 【必须走统一入口】原 year 分支自写 filter，漏了 v.deleted 判断 —— 导致
        // 「删除凭证后，利润表『本年累计』列不更新，而『本月』列已更新」，同一张表两列自相矛盾。
        // （本月分支用 periodVouchers，本就排除软删除；累计分支自写 filter 时漏了，故只有累计错。）
        // ytdVouchers 是「活动凭证 + 本年区间」的统一入口，已排除软删除，这里直接复用。
        var vs = scope === 'year' ? self.ytdVouchers(month) : self.periodVouchers(month);
        var t = 0;
        vs.forEach(function (v) {
          if (isCarryVoucher(v)) return; // 排除结转损益凭证，理由同 totalRevenue/totalExpense
          v.entries.forEach(function (e) {
            if (codes.indexOf(e.code) < 0) return;
            var s = self.subject(code);
            // 取【净额】：收入 = 贷-借，费用(含成本/税金) = 借-贷。
            // 与 totalRevenue/totalExpense 同口径，也与结转损益完全一致。
            if (s.cls === 'revenue') t += num(e.cr) - num(e.dr);
            else t += num(e.dr) - num(e.cr);
          });
        });
        return t;
      }
      var netProfit = totalRevenue - totalExpense;
      return {
        items: items,
        totalRevenue: totalRevenue,
        totalExpense: totalExpense,
        netProfit: netProfit,
        month: month
      };
    },
    // 利润表（配置化行计算）：读 state.reportRules.incomeStatement 规则按行求值。
    // 返回 [{ id, label, codes, cur, ytd, isGrp }]：
    //   cur = 本月金额，ytd = 本年累计（年初至该月），对应本月发生 / 本年累计。
    // 本方法是利润表的【唯一行计算实现】，「报表 → 利润表」渲染/导出与首页财务指标
    // （见 plSummary）共用，从根上杜绝「首页一套口径、利润表另一套」的漂移。
    // 缺规则时回退 STANDARDS.small2013（兼容异常账套）。规则结构见 js/standards.js。
    incomeStatement: function (month) {
      var self = this;
      var pl = this.profitStatement(month);
      var byCode = {};
      pl.items.forEach(function (it) { byCode[it.code] = it; });
      function amt(code) { var it = byCode[code]; return it ? { cur: it.cur, ytd: it.ytd } : { cur: 0, ytd: 0 }; }
      function sum(codes) {
        return (codes || []).reduce(function (a, c) { var x = amt(c); return { cur: a.cur + x.cur, ytd: a.ytd + x.ytd }; },
                                    { cur: 0, ytd: 0 });
      }
      var fallback = (global.STANDARDS && global.STANDARDS.small2013 && global.STANDARDS.small2013.reportRules.incomeStatement) || [];
      var rules = (self.state.reportRules && self.state.reportRules.incomeStatement) || fallback;
      var subtotals = {}; // id -> {cur, ytd}，供后续 subtotal 引用 ref
      var out = [];
      rules.forEach(function (r) {
        if (r.type === 'subtotal') {
          var cur = 0, ytd = 0;
          (r.formula || []).forEach(function (f) {
            var v = f.ref ? (subtotals[f.ref] || { cur: 0, ytd: 0 }) : sum(f.codes || []);
            var sign = f.sign === '-' ? -1 : 1;
            cur += sign * v.cur; ytd += sign * v.ytd;
          });
          if (r.id) subtotals[r.id] = { cur: cur, ytd: ytd };
          out.push({ id: r.id || '', label: r.label, cur: cur, ytd: ytd, isGrp: true, codes: [] });
        } else {
          var s = sum(r.codes || []);
          out.push({ id: r.id || '', label: r.label, cur: s.cur, ytd: s.ytd, isGrp: false, codes: r.codes || [] });
        }
      });
      return out;
    },
    // 首页财务指标取数：按【语义行 id】从利润表行取值，与「报表 → 利润表」共用同一份行计算。
    // 对应：首页调利润表服务生成报表 → 按 itemCode 取该行 currentBalance。
    // 期间语义（与通用报表期间类型等价，故无需给报表引擎新增 periodType）：
    //   单月（本期 / 上期）→ 取 cur，即本月金额（期间类型=本月的发生额）
    //   整段（本年 / 去年）→ 取 ytd，即年初至该月累计（期间类型=本年的累计口径）
    // 返回各项含 ids / codes：
    //   ids  → 实际命中的利润表行 id（供首页点金额跳利润表时高亮；「费用」命中三行，故为列表）
    //   codes → 各行取数科目的并集（供需要跳总账明细的场合）
    // 「卡片显示的数字」「跳过去的报表行」「跳过去的科目」三者同源，不会出现对不上的情况。
    // 行缺失（用户自定义改过规则）时该项计 0 并列入 missing，由页面显式提示，不静默给错数。
    plSummary: function (month) {
      var self = this;
      var rows = this.incomeStatement(month);
      var byId = {};
      rows.forEach(function (r) { if (r.id) byId[r.id] = r; });
      function pick(ids) {
        var cur = 0, ytd = 0, codes = [], matched = [], missing = [];
        ids.forEach(function (id) {
          var r = byId[id];
          if (!r) { missing.push(id); return; }
          matched.push(id);
          cur += num(r.cur); ytd += num(r.ytd);
          (r.codes || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
        });
        // ids = 实际命中的行 id（供首页跳利润表时高亮；「费用」卡命中三行，
        //       故这里返回列表而非单值）。codes 同理是各行取数科目的并集。
        return { cur: cur, ytd: ytd, codes: codes, ids: matched, missing: missing };
      }
      return {
        month: month,
        revenue: pick(['revenue']),
        cost: pick(['cost']),
        // 期间费用合计：优先取利润表规则里的 periodExpenseTotal subtotal 行
        // （公式 = 销售费用 + 管理费用 + 财务费用 + 可选研发费用，由用户自定义规则控制），
        // 老账套（reportRules 是旧模板，没有 periodExpenseTotal）回退到三行硬编码相加。
        // 这样用户改利润表规则（如给 rdExp 填 codes、或调整费用口径）时，费用卡自动跟随。
        // 额外带 formula 明细：每项 {label, cur, ytd, ids}，供首页费用卡渲染
        // "销售费用 12万 + 管理费用 8万 + 财务费用 2万" 公式行。
        expense: (function () {
          var rules = (self.state.reportRules && self.state.reportRules.incomeStatement) || [];
          var periodRule = null;
          for (var k = 0; k < rules.length; k++) {
            if (rules[k].id === 'periodExpenseTotal') { periodRule = rules[k]; break; }
          }
          var e, formulaItems = [];
          if (periodRule) {
            // 新账套：用 periodExpenseTotal 的 formula 取数 + 构造明细
            e = pick(['periodExpenseTotal']);
            (periodRule.formula || []).forEach(function (f) {
              // f 可能是 ref（引用另一个 subtotal 行）或 codes（直接引用科目）
              // 我们优先查 byId 里已有的行（普通行 id 如 sellExp 在 byId 里）
              var refId = f.ref || null;
              // codes 模式：尝试按 codes 匹配到 byId 里的普通行（如 codes=['5601'] → sellExp 行）
              if (!refId && f.codes && f.codes.length) {
                for (var idKey in byId) {
                  var rCodes = byId[idKey].codes || [];
                  if (rCodes.length === f.codes.length && rCodes.every(function (c, i) { return c === f.codes[i]; })) {
                    refId = idKey; break;
                  }
                }
              }
              if (refId && byId[refId]) {
                var row = byId[refId];
                formulaItems.push({ label: row.label, cur: row.cur, ytd: row.ytd, ids: [refId], sign: f.sign === '-' ? -1 : 1 });
              }
            });
          } else {
            // 老账套：回退三行硬编码 + 从 byId 拿明细
            e = pick(['sellExp', 'adminExp', 'finExp']);
            ['sellExp', 'adminExp', 'finExp'].forEach(function (id) {
              if (byId[id]) {
                var r = byId[id];
                formulaItems.push({ label: r.label, cur: r.cur, ytd: r.ytd, ids: [id], sign: 1 });
              }
            });
          }
          e.formula = formulaItems;
          return e;
        })(),
        netProfit: pick(['netProfit'])
      };
    },
    // 未结转损益净额（截至 month 月末，含当月）：收入净额 − 费用净额。
    // 背景：损益类科目在「结转损益」前仍保留余额，这部分已实现的净损益按会计准则
    // 应并入资产负债表「未分配利润」列示。若忽略，则结转损益前恒等式表面不成立
    // （资产 = 负债 + 权益 + 净损益），用户每月查看当期报表都会看到"不平衡"告警
    // 而误以为记账出错（实测两账套当期差额 59 万 / 48 万，全部来自此处）。
    // 口径：只统计末级科目——generalLedger 每行已按「父 = 自身 + 子目」上卷，
    // 若父行与子行同时累加会翻倍（与 profitStatement 总额口径一致）。
    unclosedProfit: function (month) {
      var self = this;
      month = normMonth(month);
      if (month === '0000-00') return 0;
      var subs = this.subjects();
      // 【为什么按「全部科目」而非「末级科目」建账户】凭证允许直接记在有下级的父科目上
      // （科目选择器不限制末级）。若只建末级，记在父科目上的损益分录会因 acc[e.code]
      // 查不到而被静默跳过 —— 表现为资产负债表「未分配利润」偏小、与利润表/总账分叉。
      // 按全部科目建账户后，每笔分录都归属到它实际所在的科目：既不漏计、也不重复（一笔分录只有一个 code）。
      // 期初照旧取自 opening()：有下级的科目本就禁止录入自身期初（见 setOpening），
      // 故父科目期初恒为 0，不会重复计入。
      var acc = {};
      subs.forEach(function (s) {
        var c = String(s.code);
        var o = self.opening(c);
        acc[c] = { dr: num(o.dr), cr: num(o.cr) };
      });
      this.state.vouchers.forEach(function (v) {
        if (v.deleted === 'y') return;
        if (voucherMonth(v) > month) return;
        (v.entries || []).forEach(function (e) {
          var a = acc[e.code];
          if (!a) return;
          a.dr += num(e.dr); a.cr += num(e.cr);
        });
      });
      var t = 0;
      subs.forEach(function (s) {
        var a = acc[String(s.code)] || { dr: 0, cr: 0 };
        if (s.cls === 'revenue') t += a.cr - a.dr;
        else if (s.cls === 'expense') t -= a.dr - a.cr;
      });
      return t;
    },
    // 资产负债表（标准：按报表项目列示，含期末余额/年初余额两列）
    yearStart: function (month) { return month.slice(0, 4) + '-01'; },
    balanceSheet: function (month) {
      var self = this;
      month = normMonth(month);
      var gl = this.generalLedger(month);
      var ys = this.yearStart(month);
      // 期末余额（带正常方向符号）：资产/成本类借正，负债/权益/收入类贷正。
      // 用 endDr/endCr 现算符号，避免 generalLedger.balance 的 Math.abs 在
      // 「异常余额方向」(如亏损年 3103 借记、资产出现贷方余额) 下丢失负号。
      function endBal(code) {
        var r = gl.filter(function (x) { return x.code === code; })[0];
        if (!r) return 0;
        return r.normal === 'dr' ? (r.endDr - r.endCr) : (r.endCr - r.endDr);
      }
      function yearBal(code) {
        // 年初余额：取当年 1 月初的期初余额（无上年数据时为建账期初）
        var op = self.openingOf(code, ys);
        var sign = (self.subject(code) || {}).normal === 'cr' ? -1 : 1;
        return (op.dr - op.cr) * sign;
      }
      // 报表项目取数：按科目（含末级上卷）取期末/年初余额
      // normal=dr 科目：余额 = dr-cr；normal=cr 科目：余额 = cr-dr（已在 endBal/yearBal 内处理）
      function val(code) { return { end: endBal(code), year: yearBal(code) }; }
      // 报表项目定义：codes 求和；minus 为抵减项（如累计折旧、累计摊销）
      function fillItem(it) {
        var e = 0, y = 0;
        (it.codes || []).forEach(function (c) { e += endBal(c); y += yearBal(c); });
        (it.minus || []).forEach(function (c) { e -= endBal(c); y -= yearBal(c); });
        // codes/minus 一并带出：报表页面据此提供「点金额跳总账」下钻。
        // 抵减项（如固定资产净值 = 1601 − 1602）也一并带上，跳过去能同时看到
        // 资产与其累计折旧，否则净值无法在总账里对上。
        return { label: it.label, end: e, year: y, codes: it.codes || [], minus: it.minus || [] };
      }
      // 资产负债表项目规则：优先读账套 state.reportRules.balanceSheet（配置化），
      // 缺失时回退内置默认（与改造前硬编码等价，兼容异常账套）。
      var groups = (self.state.reportRules && self.state.reportRules.balanceSheet)
        || (global.STANDARDS && global.STANDARDS.small2013 && global.STANDARDS.small2013.reportRules.balanceSheet)
        || {};
      function fillGroup(g) {
        var items = (g && g.items ? g.items : []).map(fillItem);
        var se = items.reduce(function (s, x) { return s + x.end; }, 0);
        var sy = items.reduce(function (s, x) { return s + x.year; }, 0);
        return { title: (g && g.title) || '', subtotal: (g && g.subtotal) || '', items: items, subEnd: se, subYear: sy };
      }
      var ga = fillGroup(groups.assetCurrent), gn = fillGroup(groups.assetNonCurrent);
      var glc = fillGroup(groups.liaCurrent), glnc = fillGroup(groups.liaNonCurrent);
      var ge = fillGroup(groups.equity);
      // 未结转损益并入「未分配利润」：期末与年初两个时点分别并入，
      // 保证「资产 = 负债 + 所有者权益」在未结转损益的期间同样成立。
      // 已结转损益的期间损益科目余额为 0，并入值为 0，历史报表数值不受影响。
      var unEnd = this.unclosedProfit(month);
      var unYear = this.unclosedProfit(prevMonth(ys));
      if (Math.abs(unEnd) > EPS || Math.abs(unYear) > EPS) {
        var plItem = null;
        (ge.items || []).forEach(function (it) { if (/未分配利润/.test(it.label || '')) plItem = it; });
        if (!plItem) {
          plItem = { label: '未分配利润', end: 0, year: 0 };
          ge.items = (ge.items || []).concat([plItem]);
        }
        plItem.end += unEnd;
        plItem.year += unYear;
        ge.subEnd = ge.items.reduce(function (s, x) { return s + x.end; }, 0);
        ge.subYear = ge.items.reduce(function (s, x) { return s + x.year; }, 0);
      }
      var totalAsset = ga.subEnd + gn.subEnd;
      var totalLia = glc.subEnd + glnc.subEnd;
      var totalEquity = ge.subEnd;
      return {
        groups: { assetCurrent: ga, assetNonCurrent: gn, liaCurrent: glc, liaNonCurrent: glnc, equity: ge },
        totalAsset: totalAsset, totalLiability: totalLia, totalEquity: totalEquity,
        totalAll: totalLia + totalEquity,
        month: month
      };
    },
    // 应交税金明细表（2221 应交税费）
    // 主要应交税金明细表：按科目 2221 应交税费及其下级明细，构建标准多级结构
    // 返回 { rows:[{level,name,rowNum,cur,ytd,bold}] }  level:0=税种一级,1=子项,2=明细科目
    taxDetail: function (month) {
      var self = this;
      var root = this.subject('2221');
      if (!root) return null;
      var subs = (this.state.subjects || []).filter(function (s) {
        return s.code !== '2221' && s.code.indexOf('2221') === 0;
      });
      function codeObj(code) {
        return subs.filter(function (s) { return s.code === code; })[0] || self.subject(code);
      }
      // 某科目本月贷方-借方、本年累计贷方-借方
      function flow(code, useYtd) {
        var dr = 0, cr = 0;
        var vs = useYtd ? self.ytdVouchers(month) : self.periodVouchers(month);
        vs.forEach(function (v) { v.entries.forEach(function (e) {
          if (e.code === code) { dr += num(e.dr); cr += num(e.cr); }
        }); });
        return { dr: dr, cr: cr, net: cr - dr }; // 应交税金：贷(+)增、借(-)减(缴纳)
      }
      var rows = [];
      var no = 1;
      function add(level, name, cur, ytd, bold) {
        rows.push({ level: level, name: name, rowNum: no++, cur: cur, ytd: ytd, bold: !!bold });
      }
      // 一、增值税（按科目树识别应交增值税/未交增值税，兼容标准编码 222101 与变体编码如 2221001）
      // 名称识别优先（跨账套稳定），且限定「2221 直接子科目」——避免把「转出未交增值税」明细误当未交增值税科目
      function isDirectTaxSub(s) {
        for (var dk = 0; dk < subs.length; dk++) {
          var dt = subs[dk];
          if (dt.code !== s.code && s.code.indexOf(dt.code) === 0) return false;
        }
        return true;
      }
      function firstBy(pred) {
        for (var fk = 0; fk < subs.length; fk++) { if (pred(subs[fk])) return subs[fk]; }
        return null;
      }
      var vatSub = firstBy(function (s) { return isDirectTaxSub(s) && s.name.indexOf('增值税') >= 0 && s.name.indexOf('未交') < 0; }) || codeObj('222101');
      var unpaySub = firstBy(function (s) { return isDirectTaxSub(s) && s.name.indexOf('未交') >= 0; }) || codeObj('222102');
      if (vatSub || unpaySub) {
        add(0, '一、增值税', 0, 0, true);
        // 1、应交增值税（如实遍历账套科目树，重复/非标命名系账套建账不规范所致，不做掩盖）
        add(1, '1、应交增值税', 0, 0, false);
        var vatNet = 0, vatNetY = 0;
        if (vatSub) {
          var vatchildren = subs.filter(function (s) {
            return s.code.length > vatSub.code.length && s.code.indexOf(vatSub.code) === 0;
          });
          vatchildren.forEach(function (s) {
            var f = flow(s.code, false), fy = flow(s.code, true);
            // 进项税额（科目名含"进项"）在以红字（负数）列示
            var cur = f.net, y = fy.net;
            if (s.name.indexOf('进项') >= 0) { cur = -Math.abs(cur); y = -Math.abs(y); }
            vatNet += cur; vatNetY += y;
            add(2, s.name, cur, y, false);
          });
        }
        // 2、未交增值税及其下
        if (unpaySub) {
          var uf = flow(unpaySub.code, false), ufy = flow(unpaySub.code, true);
          add(1, '2、未交增值税', uf.net, ufy.net, false);
          var unpchildren = subs.filter(function (s) {
            return s.code.length > unpaySub.code.length && s.code.indexOf(unpaySub.code) === 0;
          });
          unpchildren.forEach(function (s) {
            var f = flow(s.code, false), fy = flow(s.code, true);
            add(2, s.name, f.net, fy.net, false);
          });
        }
        add(1, '增值税合计', vatNet + (unpaySub ? flow(unpaySub.code, false).net : 0), vatNetY + (unpaySub ? flow(unpaySub.code, true).net : 0), true);
      }
      // 其他税种（按名称识别兼容编码差异，顺序按标准模板）
      // 命名兼容：城市维护建设税/城建税、车船税/车船使用税、地方教育附加/地方教育费附加
      var taxNames = [
        { key: '城市维护建设税', label: '二、城市维护建设税' },
        { key: '教育费附加', label: '三、教育费附加' },
        { key: '地方教育附加', label: '四、地方教育附加' },
        { key: '企业所得税', label: '五、企业所得税' },
        { key: '个人所得税', label: '六、个人所得税' },
        { key: '印花税', label: '七、印花税' },
        { key: '房产税', label: '八、房产税' },
        { key: '土地使用税', label: '九、土地使用税' },
        { key: '车船税', label: '十、车船税' },
        { key: '消费税', label: '十一、消费税' },
        { key: '资源税', label: '十二、资源税' },
        { key: '土地增值税', label: '十三、土地增值税' }
      ];
      function taxMatch(t, s) {
        var n = s.name;
        if (t.key === '教育费附加') return n.indexOf('教育费附加') >= 0 && n.indexOf('地方') < 0;
        if (t.key === '地方教育附加') return n.indexOf('地方') >= 0 && n.indexOf('附加') >= 0;
        if (t.key === '车船税') return n.indexOf('车船') >= 0;
        return n.indexOf(t.key) >= 0;
      }
      // 名称未命中时按标准编码回退（覆盖名称不规范的账套）
      var order = ['222117','222113','222114','222111','222112','222122','222118','222119','222120','222121','222105','222116'];
      taxNames.forEach(function (t, ti) {
        var s = firstBy(function (x) { return isDirectTaxSub(x) && taxMatch(t, x); });
        if (!s) s = codeObj(order[ti]);
        if (!s) return;
        var f = flow(s.code, false), fy = flow(s.code, true);
        add(0, t.label, f.net, fy.net, true);
      });
      return { rows: rows };
    },
    // 转出未交增值税 凭证设置（结账页「检查并结账」→ 增值税编辑弹窗）
    // 存 state.vatTplEntries（[{code,name,target}]），读取时无自定义则按科目树生成默认
    vatEditGet: function (month) {
      var saved = this.state.vatTplEntries;
      if (saved && saved.length) {
        return { entries: saved.map(function (x) { return { code: x.code || '', name: x.name || '', target: x.target || '' }; }) };
      }
      var subs = (this.state.subjects || []).filter(function (s) {
        return s.code !== '2221' && s.code.indexOf('2221') === 0;
      });
      function isDirect(s) {
        for (var i = 0; i < subs.length; i++) {
          var t = subs[i];
          if (t.code !== s.code && s.code.indexOf(t.code) === 0) return false;
        }
        return true;
      }
      var vatSub = null, unpaySub = null;
      for (var i = 0; i < subs.length; i++) {
        var s = subs[i];
        if (!isDirect(s)) continue;
        if (!vatSub && s.name.indexOf('增值税') >= 0 && s.name.indexOf('未交') < 0) vatSub = s;
        if (!unpaySub && s.name.indexOf('未交') >= 0) unpaySub = s;
        if (vatSub && unpaySub) break;
      }
      var entries = [];
      if (vatSub && unpaySub) entries.push({ code: vatSub.code, name: vatSub.name, target: unpaySub.code });
      return { entries: entries };
    },
    vatEditSet: function (month, data) {
      var entries = (data && Array.isArray(data.entries)) ? data.entries : [];
      this.state.vatTplEntries = entries.filter(function (x) { return x && x.code; }).map(function (x) {
        return { code: x.code, name: x.name || '', target: x.target || '' };
      });
      this.persist();
      return { ok: true };
    },
    // 现金流量表（按凭证指定现金流量活动汇总）
    cashFlow: function (month) {
      var self = this;
      month = normMonth(month);
      this.ensureCashFlowMap();
      var map = this.state.subjectCashFlowMap || {};
      // 现金及现金等价物期初/期末余额（取 1001/1002/1012 三科目，父行已含子目上卷）
      // 修复：科目对象（state.subjects[]）不存余额字段，原 s.obDr/s.curDr 恒为 0，
      // 导致现金流量表「期初/期末现金余额」两行恒 0。改从 generalLedger（期初+凭证动态计算）取数。
      // 注意：generalLedger 每行已是按 rollCodes 上卷的科目行（父行=自身+子目合计），
      // 此处只取 1001/1002/1012 三行即可，不能再按前缀匹配子行（否则重复翻倍）。
      var cashCodes = ['1001', '1002', '1012'];
      var opening = 0, ending = 0;
      var cfGl = this.generalLedger(month);
      cfGl.forEach(function (gr) {
        if (cashCodes.indexOf(gr.code) < 0) return;
        opening += num(gr.obDr) - num(gr.obCr);
        ending += num(gr.endDr) - num(gr.endCr);
      });
      // 直接法：遍历凭证非现金科目，按科目→现金流项目映射归类（借贷分别）
      // 项目金额带符号：流入为正、流出为负
      var items = {};   // 本月金额
      var ytd = {};     // 本年累计金额
      var add = function (bucket, id, amt) { if (id) bucket[id] = (bucket[id] || 0) + amt; };
      // 现金及现金等价物判定：父码 + 全部下级明细科目。
      // 真实账套的现金收付多记在明细子目（如 100201 建行），仅精确匹配三父码会把子目现金分录误归其他经营收付、使三项净额与现金净变动脱钩；故用前缀匹配 cashAccounts() 上卷。
      // 此处口径必须与 generalLedger 的 rollCodes 上卷一致（cashAccounts() 同为前缀匹配）。
      var CASH_ROOTS = ['1001', '1002', '1012'];
      var isCashCode = function (c) {
        if (!c) return false;
        c = String(c);
        return CASH_ROOTS.some(function (p) { return c === p || c.indexOf(p) === 0; });
      };
      var classify = function (bucket, v) {
        // 仅统计真正引起现金收付的凭证：纯转账凭证（计提折旧、损益结转、内部结转等）
        // 不产生现金流量；若不过滤，其非现金两侧会被误计入不同大类，虚增流入流出并破坏勾稽。
        var hasCash = (v.entries || []).some(function (e) { return isCashCode(e.code); });
        if (!hasCash) return;
        // H3 修复：凭证现金分录上若【已指定】现金流量大类（操作/投资/筹资），以指定为准，
        // 不再按科目映射归类，避免「用户指定了却不生效」（习惯：凭证上直接指定）。
        // 指定只产生在现金分录（UI 仅在现金科目行提供下拉），对侧非现金分录跳过，防止双重计数。
        // 大类 -> 该大类下的「其他收支」兜底项目（与科目映射兜底项目一致）。
        var specified = (v.entries || []).filter(function (e) { return isCashCode(e.code) && e.cashActivity; });
        if (specified.length) {
          specified.forEach(function (e) {
            var cr = num(e.cr), dr = num(e.dr);
            var act = String(e.cashActivity);
            var inId = act === 'investing' ? 'cf_invothin' : (act === 'financing' ? 'cf_finother' : 'cf_opother');
            var outId = act === 'investing' ? 'cf_invothp' : (act === 'financing' ? 'cf_finothp' : 'cf_opothp');
            if (cr) add(bucket, inId, cr);       // 贷方发生额→该类流入(+)，负数红字冲销(-)
            if (dr) add(bucket, outId, -dr);     // 借方发生额→该类流出(-)，负数红字冲销(+)
          });
          return;
        }
        v.entries.forEach(function (e) {
          if (isCashCode(e.code)) return; // 现金科目为通道，不归类
          var m = map[e.code];
          var cr = num(e.cr), dr = num(e.dr);
          // 未映射或该方向未配置映射时，必须回落到「其他经营收/付」兜底，
          // 不得静默丢弃金额（否则 Σ三项净额 ≠ 现金净变动，恒等式被打破）。
          // 金额判断用 != 0 而非 > 0：真实账套存在负数红字冲销分录（如客房收入贷方 -126），按 > 0 会整笔漏归、破坏恒等式；带符号归类后红字冲销自然抵减对应项目。
          if (cr) {
            if (!m || !m.credit) add(bucket, 'cf_opother', cr);
            else add(bucket, m.credit, cr);     // 贷方发生额→该项目流入(+)，负数为红字冲销(-)
          }
          if (dr) {
            if (!m || !m.debit) add(bucket, 'cf_opothp', -dr);
            else add(bucket, m.debit, -dr);     // 借方发生额→该项目流出(-)，负数为红字冲销(+)
          }
        });
      };
      // 本月
      this.periodVouchers(month).forEach(function (v) { classify(items, v); });
      // 本年累计（当年 1 月 ~ 当前月）
      this.ytdVouchers(month).forEach(function (v) { classify(ytd, v); });
      // 叠加现金流量初始余额（各项目年初结转/期初数）到本年累计，使现金流量表期初衔接正确
      // 默认初始余额页为空（ytd=0）时不叠加，仅当用户在「现金流量初始余额」页录入后才生效
      var cfOpen = this.getCashFlowOpening() || {};
      Object.keys(cfOpen).forEach(function (id) {
        var v = num((cfOpen[id] || {}).ytd);
        if (v) add(ytd, id, v);
      });
      // 项目 → 所属大类（标准模板全部明细项目）
      var CAT = {
        cf_sale: 'operating', cf_taxret: 'operating', cf_opother: 'operating',
        cf_buy: 'operating', cf_payemp: 'operating', cf_taxpay: 'operating', cf_opothp: 'operating',
        // 投资活动
        cf_invgain: 'investing', cf_invother: 'investing', cf_fixgain: 'investing',
        cf_dissub: 'investing', cf_invothin: 'investing', cf_invpay: 'investing',
        cf_investpay: 'investing', cf_dissubpay: 'investing', cf_invothp: 'investing',
        // 筹资活动
        cf_absinv: 'financing', cf_finloan: 'financing', cf_finother: 'financing',
        cf_finrepay: 'financing', cf_paydiv: 'financing', cf_finothp: 'financing',
        // 汇率变动（单独归类）
        cf_exchg: 'exchange'
      };
      var groups = { operating: 0, investing: 0, financing: 0, exchange: 0 };
      Object.keys(items).forEach(function (id) {
        var cat = CAT[id] || 'operating';
        groups[cat] = (groups[cat] || 0) + (items[id] || 0);
      });
      Object.keys(ytd).forEach(function (id) {
        var cat = CAT[id] || 'operating';
        groups[cat] = (groups[cat] || 0); // ytd 仅用于明细列展示，不重复累加大类
      });
      return {
        items: items,
        ytd: ytd,
        operating: groups.operating,
        investing: groups.investing,
        financing: groups.financing,
        exchange: groups.exchange,
        opening: opening,
        ending: ending
      };
    },

    setParam: function (k, v) {
      this.state.param = this.state.param || {};
      this.state.param[k] = v;
      this.persist();
      return this.state.param;
    },
    getParam: function (k, def) {
      return this.state.param && this.state.param[k] !== undefined ? this.state.param[k] : def;
    },

    /* ===================== 固定资产 ===================== */
    // 资产类别档案（单一事实源）。缺省/为空时用默认 6 类补齐（老账套首次打开资产页时也会走到这里）。
    assetCats: function () {
      if (!Array.isArray(this.state.assetCats) || !this.state.assetCats.length) {
        this.state.assetCats = DEFAULT_ASSET_CATS.map(function (c) { return Object.assign({}, c); });
      }
      return this.state.assetCats;
    },
    /* 把外来的「类别」值归一为**类别编码**（本系统唯一契约）。
     * 顺序：空 → ''；命中编码 → 原值；命中名称 → 对应编码；都命中不了 → 按该名称**新建**一条档案。
     * 「新建」是为了迁移不丢信息：外部账套的资产类别未必正好是我们预置的 6 类，
     * 若不新建，那张卡片的类别就永远筛不到、且编辑时会被清空（正是本次要修的病）。
     * 幂等：归一后的值是编码，再次调用在第一步就返回。 */
    normalizeAssetCategory: function (v) {
      var raw = String(v == null ? '' : v).trim();
      if (!raw) return '';
      var list = this.assetCats(), i;
      for (i = 0; i < list.length; i++) { if (String(list[i].code) === raw) return raw; }
      for (i = 0; i < list.length; i++) { if (String(list[i].name) === raw) return String(list[i].code); }
      var max = 0;
      list.forEach(function (c) { var n = parseInt(c.code, 10); if (!isNaN(n) && n > max) max = n; });
      var code = String(max + 1);
      while (code.length < 3) code = '0' + code;
      list.push({ code: code, name: raw, method: '平均年限法', life: '', salvage: '',
        asset: '', depr: '', memo: '导入资产时自动建立', enabled: true });
      this.state.assetCats = list;
      return code;
    },
    /* ---------- 部门（基础资料）：单一事实源 + 名称归一 ----------
     * ⚠️ 与「资产类别」**方向相反**，别照抄：
     *   类别字段存**编码**（卡片表单是下拉、store 注释里写明「类别编码」）；
     *   部门字段存**名称** —— 卡片表单的「使用部门」是**自由文本输入**，addFixedAsset 也没有
     *   「部门编码」的契约，且全库消费方（卡片左树 / fDept 筛选 / 折旧汇总表「按部门汇总」）
     *   都是按**名称**比对。故这里归一为**名称**，code 只作档案内部标识。
     * 【为什么要归一】和类别同一个病根：外部账套导入**不带部门档案**（kis-import.js 全库 0 处提及），
     *   本系统的 depts 一直是内置默认种子（前台/客房/餐厅）；而外部账套卡片表里的部门是
     *   厨房/客房/酒店/酒店洗衣房 —— 于是「资产左树的部门」跟外部账套对不上、按部门筛选也筛不到。 */
    depts: function () {
      if (!Array.isArray(this.state.depts) || !this.state.depts.length) {
        this.state.depts = DEFAULT_DEPTS.map(function (d) { return Object.assign({}, d); });
      }
      return this.state.depts;
    },
    // 把外来的「部门」值归一为**部门名称**：空 → ''；命中名称 → 原值；命中编码 → 对应名称；
    // 都命中不了 → 按该名称**新建**一条档案（外部账套的部门未必在我们默认种子里，不新建就永远选不到）。
    // 幂等：归一后是名称，再次调用在第一步返回。
    normalizeDept: function (v) {
      var raw = String(v == null ? '' : v).trim();
      if (!raw) return '';
      var list = this.depts(), i;
      for (i = 0; i < list.length; i++) { if (String(list[i].name) === raw) return raw; }
      for (i = 0; i < list.length; i++) { if (String(list[i].code) === raw) return String(list[i].name); }
      var max = 0;
      list.forEach(function (d) { var n = parseInt(d.code, 10); if (!isNaN(n) && n > max) max = n; });
      var code = String(max + 1);
      while (code.length < 3) code = '0' + code;
      list.push({ code: code, name: raw, type: '部门', parent: '', enabled: true });
      this.state.depts = list;
      return raw;
    },
    /* 部门改名 / 改编码（基础资料编辑的**唯一入口**：把「改档案」与「回写卡片」绑在一起做）。
     * ⚠️ 为什么必须回写：部门是按**名称**存的（与类别存编码相反，理由见 normalizeDept），
     * 只改档案名而不动 fa.dept，历史卡片就变成「档案里查无此部门」—— 按部门筛选掉出去、
     * 编辑卡片时下拉回落成「请选择」。那正是本次要修的那个病的翻版，所以两件事不能拆开。
     * 返回 { ok, renamed, touched }（touched = 被改写的卡片数）。 */
    renameDept: function (idx, name, code) {
      var list = this.depts();
      var d = list[idx];
      if (!d) return { ok: false, msg: '部门不存在' };
      name = String(name == null ? '' : name).trim();
      code = String(code == null ? '' : code).trim();
      if (!name) return { ok: false, msg: '部门名称不能为空' };
      if (!code) return { ok: false, msg: '部门编码不能为空' };
      for (var i = 0; i < list.length; i++) {
        if (i !== idx && String(list[i].code) === code) return { ok: false, msg: '部门编码「' + code + '」已被占用' };
      }
      var oldName = String(d.name == null ? '' : d.name);
      var renamed = oldName !== name;
      d.name = name;
      d.code = code;
      var touched = 0;
      if (renamed) {
        (this.state.fixedAssets || []).forEach(function (fa) {
          if (String(fa.dept == null ? '' : fa.dept) === oldName) { fa.dept = name; touched++; }
        });
      }
      this.state.depts = list;
      this.persist();
      return { ok: true, renamed: renamed, touched: touched };
    },
    /* 资产变动历史：关键字段清单 + 中文标签。
     * 只记录影响折旧计算/资产价值/归属的字段，编码、名称、规格等不改折旧的不记。
     * history 挂在 fa 自身上，随卡片持久化，老账套 undefined 自动兜底为空数组。 */
    _ASSET_HISTORY_FIELDS: [
      'original', 'salvage', 'impairment',
      'method', 'life',
      'category', 'dept',
      'status', 'cleanPeriod', 'cleanVoucher',
      'faAcctId', 'accDeprAcct', 'deprFeeAcct'
    ],
    _ASSET_HISTORY_LABELS: {
      original: '原值', salvage: '残值', impairment: '减值准备',
      method: '折旧方法', life: '使用期限（年）',
      category: '类别', dept: '部门',
      status: '状态', cleanPeriod: '清理期间', cleanVoucher: '清理凭证',
      faAcctId: '固定资产科目', accDeprAcct: '累计折旧科目', deprFeeAcct: '折旧费用科目'
    },
    _assetHistoryFields: function () { return this._ASSET_HISTORY_FIELDS; },
    _assetHistoryLabels: function () { return this._ASSET_HISTORY_LABELS; },
    _pushAssetHistory: function (fa, op, fields) {
      if (!fa) return;
      if (!fa.history) fa.history = [];
      var d = new Date();
      var time = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
      fa.history.unshift({ op: op || '修改', time: time, fields: fields || {} });
    },

    addFixedAsset: function (fa) {
      fa.id = 'A' + Date.now() + Math.floor(Math.random() * 1000);
      // 数值字段初始化（严格对齐卡片列）
      fa.code = fa.code || '';                       // 编码
      fa.name = fa.name || '';                       // 名称
      // 类别：唯一契约是**类别编码**。导入（Excel/外部账套）给的多是类别名称，此处归一 ——
      // 否则按类别筛选筛不到、编辑卡片时下拉选不中（保存会把类别清空）。见 normalizeAssetCategory。
      fa.category = this.normalizeAssetCategory(fa.category);
      // 部门：契约是**部门名称**。导入（Excel/外部账套卡片表）给的是名称，此处归一 ——
      // 档案里没有的部门会按名称补进 depts，否则资产左树/按部门筛选永远对不上。见 normalizeDept。
      fa.dept = this.normalizeDept(fa.dept);
      fa.acqDate = fa.acqDate || '';                  // 开始使用日期
      fa.original = num(fa.original);                 // 原值
      fa.accumDeprBegin = num(fa.accumDeprBegin);     // 期初累计折旧
      fa.accumDepr = num(fa.accumDepr);               // 期末累计折旧
      if (!fa.accumDepr && fa.accumDeprBegin) fa.accumDepr = fa.accumDeprBegin;   // 卡片新增只给期初时，期末以期初为起点
      if (!fa.accumDeprBegin && fa.accumDepr) fa.accumDeprBegin = fa.accumDepr;   // 外部账套清单常有期末累计但无期初，默认期初=期末
      fa.life = num(fa.life);                         // 预计使用期限（年）
      fa.salvage = num(fa.salvage);                  // 残值
      fa.salvageRate = fa.salvageRate !== undefined && fa.salvageRate !== '' ? num(fa.salvageRate)
        : (fa.original > 0 ? (fa.salvage / fa.original * 100) : 0); // 残值率%
      fa.impairment = num(fa.impairment);             // 减值准备
      fa.netValueBegin = num(fa.netValueBegin);       // 期初净值
      fa.netValueEnd = num(fa.netValueEnd);           // 期末净值
      // 净值自动补算：未指定时按恒等式 original - accumDepr - impairment 回填
      if (!fa.netValueBegin && fa.original > 0) fa.netValueBegin = fa.original - fa.accumDeprBegin - fa.impairment;
      if (!fa.netValueEnd && fa.original > 0) fa.netValueEnd = fa.original - fa.accumDepr - fa.impairment;
      fa.method = fa.method || '平均年限法';           // 折旧方法
      fa.status = fa.status || '正常';                 // 状态
      fa.qty = num(fa.qty);                           // 数量
      fa.spec = fa.spec || '';                        // 规格型号
      fa.location = fa.location || '';                // 存放地点
      fa.user = fa.user || '';                        // 使用人
      fa.periodUsed = num(fa.periodUsed);             // 已折旧期间
      fa.cleanPeriod = fa.cleanPeriod || '';          // 清理期间
      fa.addVoucher = fa.addVoucher || '';            // 新增资产凭证
      fa.cleanVoucher = fa.cleanVoucher || '';        // 清理凭证
      fa.impairVoucher = fa.impairVoucher || '';      // 减值准备凭证
      fa.otherVoucher = fa.otherVoucher || '';        // 其他变动凭证
      fa.memo = fa.memo || '';                        // 备注
      fa.deprMonth = fa.deprMonth || '';              // 已计提截至月份
      // 新增卡片表单科目字段（对照资产_卡片新增源码）
      fa.faAcctId = fa.faAcctId || '';                // 固定资产科目
      fa.accDeprAcct = fa.accDeprAcct || '';          // 累计折旧科目
      fa.deprFeeAcct = fa.deprFeeAcct || '';          // 折旧费用科目
      fa.cleanAcct = fa.cleanAcct || '';              // 资产清理科目
      fa.purchaseAcct = fa.purchaseAcct || '';        // 资产购入对方科目
      fa.impairAcct = fa.impairAcct || '';            // 减值准备对方科目
      fa.yearDepr = num(fa.yearDepr);                 // 本年已折旧
      fa.addVoucherId = fa.addVoucherId || '';        // 新增资产凭证的**凭证 id**（唯一、含月份）
      fa.history = [];
      this._pushAssetHistory(fa, '新增', this._collectAssetHistoryFields(fa));
      this.state.fixedAssets.push(fa);
      this.persist();
      return fa;
    },
    /* 从 fa 中提取关键字段的当前值（用于新增时记一条 baseline） */
    _collectAssetHistoryFields: function (fa) {
      var self = this;
      var out = {};
      this._ASSET_HISTORY_FIELDS.forEach(function (k) { out[k] = self._fmtAssetHistoryVal(k, fa[k]); });
      return out;
    },
    /* 字段值格式化：金额用千分位，其他原样返回 */
    _fmtAssetHistoryVal: function (key, val) {
      if (val === undefined || val === null || val === '') return '—';
      if (['original', 'salvage', 'impairment'].indexOf(key) >= 0) {
        var n = num(val);
        return n === 0 ? '0' : money(n);
      }
      return String(val);
    },
    updateFixedAsset: function (id, fa) {
      var idx = -1;
      this.state.fixedAssets.forEach(function (x, i) { if (x.id === id) idx = i; });
      if (idx < 0) return { ok: false, msg: '卡片不存在' };
      // Object.assign 之前先存 old 快照，用于 diff 关键字段
      var old = this.state.fixedAssets[idx];
      var self = this;
      var oldVals = {};
      this._ASSET_HISTORY_FIELDS.forEach(function (k) { oldVals[k] = old[k]; });
      // 与 addFixedAsset 同口径：编辑保存进来的类别/部门也过一遍归一（下拉/输入给的本就合规，此处是防呆，
      // 并保证手填的新部门会被补进部门档案）
      if (fa && fa.category !== undefined) fa.category = this.normalizeAssetCategory(fa.category);
      if (fa && fa.dept !== undefined) fa.dept = this.normalizeDept(fa.dept);
      Object.assign(this.state.fixedAssets[idx], fa, { id: id });
      // 合并后做净值/累计折旧兜底补算（表单 _collectAsset 不采集 accumDepr/netValue* 字段，
      // 直接 Object.assign 后可能为 undefined 或原值未同步，需要主动补算）
      var r = this.state.fixedAssets[idx];
      r.original = num(r.original);
      r.accumDeprBegin = num(r.accumDeprBegin);
      r.accumDepr = num(r.accumDepr);
      r.impairment = num(r.impairment);
      r.netValueBegin = num(r.netValueBegin);
      r.netValueEnd = num(r.netValueEnd);
      // 卡片表单只有「期初累计折旧」一个输入框（没有"期末"栏），二者语义恒等 ——
      // 都是【锚点月末】的累计：_accumDeprAt（列表显示）读 accumDeprBegin，
      // assetMonthlyDepr（实提）读 accumDepr。原实现仅在旧值为 0 时才同步，
      // 于是用户一旦改了期初，两字段永久分离（实测：begin 1698.10 / accum 698.10），
      // 页面显示与实提金额基于不同基数，越提越对不上。此处无条件跟随表单值同步。
      r.accumDepr = r.accumDeprBegin;
      if (!r.netValueBegin && r.original > 0) r.netValueBegin = r.original - r.accumDeprBegin - r.impairment;
      if (!r.netValueEnd && r.original > 0) r.netValueEnd = r.original - r.accumDepr - r.impairment;
      // diff 关键字段，有变化就记 history
      var diff = {};
      this._ASSET_HISTORY_FIELDS.forEach(function (k) {
        var newVal = r[k];
        if (self._valuesDiffer(oldVals[k], newVal)) {
          diff[k] = [self._fmtAssetHistoryVal(k, oldVals[k]), self._fmtAssetHistoryVal(k, newVal)];
        }
      });
      if (Object.keys(diff).length > 0) {
        this._pushAssetHistory(r, '修改', diff);
      }
      this.persist();
      return { ok: true };
    },
    _valuesDiffer: function (a, b) {
      // 先看是否都是**可转成数字**的（字符串 '5000' 也可）。任何一边不是数字 → 按字符串比
      var an = Number(a), bn = Number(b);
      var bothNumeric = !isNaN(an) && !isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '';
      if (bothNumeric) return Math.abs(an - bn) > 0.005; // 容差 0.005 防浮点
      return String(a) !== String(b);
    },
    removeFixedAsset: function (id) {
      var fa = this.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
      // 财务严谨：卡片已有折旧/清理记录的禁止直接删除（删掉会让卡片辅助账凭空少一块累计折旧，
      // 与总账 1602 立刻不符），只能走「清理」。
      // ⚠️ 判断依据必须是【账面事实】，不能再用 deprMonth —— 它只是「最近一次计提月」：
      //   ① 外部导入的卡可能本来就没有该字段；② 卡片锚点修复（清残留）也会清空它。
      //   一旦它为空，守卫就整体失效 → 有折旧的卡片被静默放行删除。
      //   2026-09-18 实测事故：002 电视（累计折旧 13,749.19）被删，卡片合计比总账少 13,749.19。
      // ⚠️ addVoucher 仍不在拦截之列：它只是「卡片 ↔ 购入凭证」的关联，凭证本就在账里，
      //   不因删卡片而消失（若把它算作「已生成凭证」，导入卡一经关联就再也删不掉）。
      var hasDeprRecord = num(fa && fa.accumDepr) > 0 || num(fa && fa.periodUsed) > 0 || !!(fa && fa.deprVoucher);
      if (fa && (hasDeprRecord || fa.cleanVoucher)) {
        return { ok: false, msg: '该资产已有折旧/清理记录' +
          (fa.cleanVoucher ? '（含清理凭证 ' + fa.cleanVoucher + '）' : '（累计折旧 ' + num(fa.accumDepr).toFixed(2) + '）') +
          '，直接删除会使卡片辅助账与总账不符；请改用「清理」处理' };
      }
      this.state.fixedAssets = this.state.fixedAssets.filter(function (x) { return x.id !== id; });
      this.persist();
      return { ok: true };
    },
    /* ===================== 「新增资产凭证」= 关联已有凭证（绝不生成） =====================
     * 【为什么是「关联」而不是「生成」】
     * 迁移账套的购入凭证**本来就在凭证表里** —— 实测添钰来客账套 10 张卡片，10/10 都能在 1037 张
     * 凭证里按「借 固定资产 = 卡片原值」精确命中（记-48/49/…）。若这里再「生成」一张，就是
     * **固定资产重复入账（翻倍）**，属本项目最忌讳的错误。故本函数只把已存在的凭证挂到卡片上。
     * 【匹配规则】（需同时满足）
     *   ① 凭证未删除；
     *   ② 含一条分录：科目 == 卡片固定资产科目(faAcctId) 且 借方 == 卡片原值(original)；
     *   ③ 该凭证的贷方含「卡片购入对方科目」(purchaseAcct) —— 与卡片配置互证，避免同额错配；
     *      purchaseAcct 为空时只按 ② 判（不强求 ③）。
     * 【多重命中择优】先排除已被其它卡片占用的凭证；再按凭证日期离「开始使用日期」最近；最后按凭证字号升序。
     * 【幂等】已有 addVoucher 的卡片直接跳过，可反复点。**不新增任何凭证**。
     * ids：可选。给定（非空）时只处理这些卡片 id —— 「批量操作 → 关联凭证」勾了就传勾选的，没勾就传空 = 全部。
     * 返回 { ok, linked:[{code,name,no,date}], unmatched:[{code,name,reason}] } */
    linkAssetAcquisitions: function (ids) {
      var self = this;
      var only = null;
      if (ids && ids.length) { only = {}; ids.forEach(function (id) { only[id] = 1; }); }
      var list = this.state.fixedAssets || [];
      var vs = (this.state.vouchers || []).filter(function (v) { return v.deleted !== 'y'; });
      var used = {};                                    // 凭证 id → 已挂它的卡片编码
      list.forEach(function (fa) { if (fa.addVoucherId) used[fa.addVoucherId] = fa.code; });
      var linked = [], unmatched = [];
      list.forEach(function (fa) {
        if (only && !only[fa.id]) return;               // 只处理指定的那些卡片
        if (fa.addVoucher) return;                      // 已关联 → 幂等跳过
        var faCode = String(fa.faAcctId || '');
        var orig = num(fa.original);
        var opp = String(fa.purchaseAcct || '');
        if (!orig) { unmatched.push({ code: fa.code, name: fa.name, reason: '原值为 0，无从匹配' }); return; }
        var cands = vs.filter(function (v) {
          var okDr = (v.entries || []).some(function (e) {
            return String(e.code) === faCode && Math.abs(num(e.dr) - orig) < 0.005;
          });
          if (!okDr) return false;
          if (!opp) return true;
          return (v.entries || []).some(function (e) { return String(e.code) === opp && num(e.cr) > 0; });
        });
        if (!cands.length) {
          unmatched.push({ code: fa.code, name: fa.name,
            reason: '凭证表里找不到「借 ' + (faCode || '固定资产') + ' = ' + orig + (opp ? ' 且 贷 ' + opp : '') + '」的凭证' });
          return;
        }
        // 择优：优先未被占用；全被占用时允许复用（一张凭证买多张同额资产是合法的）
        var pool = cands.filter(function (v) { return !used[v.id]; });
        if (!pool.length) pool = cands;
        var acq = String(fa.acqDate || '');
        var acqTs = acq ? Date.parse(acq) : NaN;
        pool.slice().sort(function (a, b) {
          var da = isNaN(acqTs) ? 0 : Math.abs(Date.parse(a.date) - acqTs);
          var db = isNaN(acqTs) ? 0 : Math.abs(Date.parse(b.date) - acqTs);
          if (da !== db) return da - db;
          var ka = (a.word || '记') + '-' + a.no, kb = (b.word || '记') + '-' + b.no;
          return ka < kb ? -1 : (ka > kb ? 1 : 0);
        });
        var pick = pool[0];
        fa.addVoucher = (pick.word || '记') + '-' + pick.no;   // 显示用（列/导出/筛选读它）
        fa.addVoucherId = pick.id;                             // 跳转用（id 含月份，唯一）
        used[pick.id] = fa.code;
        linked.push({ code: fa.code, name: fa.name, no: fa.addVoucher, date: pick.date || '' });
      });
      if (linked.length) this.persist();
      return { ok: true, linked: linked, unmatched: unmatched };
    },
    // 解除关联（错配回退）：只清卡片的 addVoucher/addVoucherId —— **绝不碰凭证本身**
    // （凭证是账，不能因为解关联而消失或改动）。
    unlinkAssetAcquisitions: function (ids) {
      var map = {}; (ids || []).forEach(function (id) { map[id] = 1; });
      var n = 0;
      (this.state.fixedAssets || []).forEach(function (fa) {
        if (!map[fa.id]) return;
        if (fa.addVoucher || fa.addVoucherId) { fa.addVoucher = ''; fa.addVoucherId = ''; n++; }
      });
      if (n) this.persist();
      return { ok: true, n: n };
    },
    // 清理（报废/处置业务，卡片保留、状态=已清理、记清理期间）
    cleanFixedAsset: function (id, month) {
      var fa = this.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
      if (!fa) return { ok: false, msg: '卡片不存在' };
      fa.status = '清理';
      fa.cleanPeriod = month || '';
      this._pushAssetHistory(fa, '标记清理', { status: '清理', cleanPeriod: month || '' });
      this.persist();
      return { ok: true };
    },
    // 取消清理（误清理可恢复；已生成清理凭证须先删凭证）
    // 取消清理 = 撤销整个处置动作：连清理凭证一起删（走 removeVoucher，内部回退卡片状态）。
    // 只翻卡片状态不够 —— 卡片走正常路径必然带凭证，那样会被凭证挡住，等于死功能。
    // 无凭证的（历史遗留清理态）→ 直接恢复卡片。
    // ⚠️ 本方法会删凭证，只用于用户显式撤销；「清理失败后回滚刚标记的卡片」只能回滚本次新标记的
    //   （彼时无凭证，走无凭证分支），否则会误删既有凭证（见 Asset.js 回滚处）。
    cancelCleanFixedAsset: function (id) {
      var fa = this.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
      if (!fa) return { ok: false, msg: '卡片不存在' };
      var vno = fa.cleanVoucher;
      if (vno) {
        var v = (this.state.vouchers || []).filter(function (x) {
          return ((x.word || '记') + '-' + x.no) === vno && x.deleted !== 'y';
        })[0];
        if (v) {
          var r = this.removeVoucher(v.id); // 内部 _revertAssetClean 负责把卡片恢复为「正常」
          if (!r || r.ok === false) return { ok: false, msg: '无法取消清理：' + ((r && r.msg) || '清理凭证未删除成功') };
          this._pushAssetHistory(fa, '取消清理', { cleanVoucher: '—', cleanPeriod: '—', status: '正常' });
          this.persist();
          return { ok: true, removedVoucher: vno };
        }
        delete fa.cleanVoucher; // 凭证已不在账上（历史脏数据）→ 清掉悬空引用再恢复卡片
      }
      fa.status = '正常';
      fa.cleanPeriod = '';
      this._pushAssetHistory(fa, '取消清理', { cleanVoucher: '—', cleanPeriod: '—', status: '正常' });
      this.persist();
      return { ok: true };
    },
    // 对已清理且未生成清理凭证的卡片生成清理凭证
    // 分录：借 固定资产清理(账面净值=原值-累计折旧-减值准备) / 累计折旧 / 减值准备，贷 固定资产(原值)
    genCleanVoucher: function (ids, month) {
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账，请先反结账' };
      var self = this;
      var entries = [];
      var total = 0;
      var done = [];
      var errMsg = '';
      var idsMap = {};
      ids.forEach(function (i) { idsMap[i] = 1; });
      this.state.fixedAssets.forEach(function (fa) {
        if (!idsMap[fa.id]) return;
        if (fa.status !== '清理') return;
        if (fa.cleanVoucher) return;
        var orig = num(fa.original), dep = num(fa.accumDepr), imp = num(fa.impairment);
        var net = Math.max(0, orig - dep - imp); // 账面净值
        // 科目角色解析（单点）：固定资产/累计折旧/固定资产清理 由卡片配置或准则 roles 提供
        var faSubj = self.subjectRole('FA_ASSET', fa.faAcctId);
        var depSubj = self.subjectRole('ACC_DEPR', fa.accDeprAcct);
        var cleanSubj = self.subjectRole('FA_CLEAN', fa.cleanAcct);
        if (!faSubj || !depSubj || !cleanSubj) {
          errMsg = '缺少清理所需科目（固定资产/累计折旧/固定资产清理）之一，请先在对应卡片设置科目或在科目页添加，再生成清理凭证';
          return;
        }
        entries.push({ code: cleanSubj.code, name: cleanSubj.name, summary: '固定资产清理-' + fa.name, dr: net, cr: 0 });
        if (dep > 0) entries.push({ code: depSubj.code, name: depSubj.name, summary: '累计折旧清理-' + fa.name, dr: dep, cr: 0 });
        if (imp > 0) {
          var impSubj = self.subjectRole('FA_IMPAIR', fa.impairAcct);
          if (!impSubj) { errMsg = '科目表缺少「固定资产减值准备」科目，请先添加后再生成清理凭证'; return; }
          entries.push({ code: impSubj.code, name: impSubj.name, summary: '减值准备清理-' + fa.name, dr: imp, cr: 0 });
        }
        entries.push({ code: faSubj.code, name: faSubj.name, summary: '固定资产清理-' + fa.name, dr: 0, cr: orig });
        total += net;
        done.push(fa);
      });
      if (errMsg) return { ok: false, msg: errMsg };
      if (!entries.length) return { ok: false, msg: '勾选的卡片中没有待生成清理凭证的已清理资产' };
      var v = {
        word: this.state.param.voucherWord || '记', date: lastDay(month), attach: 0,
        summary: '清理' + month + '固定资产',
        entries: entries
      };
      var saved = this.addVoucher(v);
      if (!saved || saved.ok === false) {
        return { ok: false, msg: (saved && saved.msg) || '生成清理凭证失败' };
      }
      done.forEach(function (fa) {
        fa.cleanVoucher = saved.word + '-' + saved.no;
      });
      var self2 = this;
      done.forEach(function (fa) {
        self2._pushAssetHistory(fa, '清理', {
          status: '清理', cleanPeriod: month,
          cleanVoucher: saved.word + '-' + saved.no
        });
      });
      this.persist();
      return { ok: true, voucher: saved, total: total, count: done.length };
    },
    // 月折旧额（直线法，按月均摊剩余净值）
    // 关键：以「已折旧期间」为计数器，按 剩余净值 / 剩余寿命 计算，
    // 这样导入/带历史卡片（原账套折旧率可能不同）也能精确摊到（原值-残值），不会重提或超提。
    assetMonthlyDepr: function (fa) {
      if (!fa.life || fa.life <= 0) return 0;
      var base = num(fa.original) - num(fa.salvage);
      var totalMonths = fa.life * 12;
      var monthsPosted = num(fa.periodUsed || 0);
      var remainingMonths = totalMonths - monthsPosted;
      if (remainingMonths <= 0) return 0;
      var accumulated = num(fa.accumDepr);
      var remainingBase = Math.max(0, base - accumulated);
      return remainingBase / remainingMonths;
    },
    /* 某资产在**某期间实际应提**的折旧额（0 = 该月不需计提）。
     *
     * 【历史问题（已于 2026-09-18 修正；此处存档原因备查）】
     * 这套判断原先只写在 depreciateMonth 里，而「折旧汇总表 / 折旧明细表」的「本月折旧」
     * 列却无条件对所有在用卡求 assetMonthlyDepr(fa) —— 于是两边口径分叉：
     * 报表把"购置晚于本月 / 已提满 / 本月已计提 / 次月起提"的卡也算进去了。
     * 实测（添钰来客 2026-03~06）：报表显示 10,866.63，而凭证与总账都是 10,810.42，
     * 差额 56.21 正是一张「购置晚于本月」的卡（010 沙发折叠床）。
     * 「本年折旧额」同理（报表用 md×月份数，忽略跳过，差 281.07）。
     * 现报表已改为「累计折旧滚增」，与总账 1602 只剩逐张舍入的 0.01~0.03（见 Asset.js:953）。
     *
     * 【⚠ 适用范围 —— 并非所有地方都用本函数】
     * 本函数当前【仅】被 depreciateMonth 调用（store.js:4455）。
     * 两个折旧报表【刻意不用】它：本函数含 "deprMonth === month → 0" 的计提幂等保护，
     * 对已计提的历史期间会算出 0，而凭证里是有金额的 —— 报表要的是账面滚增（详见 Asset.js:959）。
     * ⚠ 切勿为了「统一口径」把报表改用 assetDeprDue()：那会把已计提的卡算成 0，
     *   反而让折旧报表数字出错。（2026-09-21 更正：原注释写作「两个折旧报表共用」，
     *   与实现不符，会误导后来者去"统一"而引入 bug。）
     *
     * 判断顺序与 depreciateMonth 保持一致（顺序本身有语义：先排除不存在的、再算金额）。 */
    assetDeprDue: function (fa, month) {
      if (!fa || !month) return 0;
      if (fa.status === '清理') return 0;                      // 已清理不再计提
      if (!fa.acqDate) return 0;
      if (fa.deprMonth === month) return 0;                    // 本月已计提（幂等，防重复入账）
      if (fa.acqDate >= lastDay(month)) return 0;              // 购置晚于本月，本月不提
      var acqMonth = String(fa.acqDate).slice(0, 7);
      var totalMonths = num(fa.life) * 12;
      var monthsPosted = num(fa.periodUsed || 0);
      if (monthsPosted >= totalMonths) return 0;               // 已提满
      if (monthsBetween(acqMonth, month) < 1) return 0;        // 次月起提
      var md = this.assetMonthlyDepr(fa);
      if (md <= 0) return 0;
      // 末月按剩余净值精确补足，保证累计折旧恰好落到（原值 - 残值）
      var lastMonth = (monthsPosted + 1 >= totalMonths);
      var amt = lastMonth ? Math.max(0, (num(fa.original) - num(fa.salvage)) - num(fa.accumDepr)) : md;
      return amt > 0 ? amt : 0;
    },
    /* 某期间是否已存在折旧凭证 —— 「计提折旧」的防重复入账守卫。
     * 识别口径（两条都刻意不依赖凭证 kind：外部导入的凭证没有 kind）：
     *   期间内存在一张凭证，其中有【贷方】分录落在「累计折旧科目」上。
     *   累计折旧科目的识别取三种并集，任一命中即可（科目码体系随账套/准则而变，只靠码相等太脆）：
     *     ① 系统角色科目（subjectRole('ACC_DEPR')）
     *     ② 各卡片自定义的累计折旧科目（fa.accDeprAcct）
     *     ③ 分录名称含「累计折旧」，或科目码以①/②为前缀（末级子目）
     * 命中返回凭证字号（如 '记-53'），未命中返回 ''。
     * 【为什么只判贷方、不再判对方费用科目】曾按「贷 累计折旧 + 借 折旧费用科目」双条件判定，
     * 结果实测漏判：导入账套的折旧费用科目是 5401006，与角色科目「管理费用」对不上，
     * 导致守卫形同虚设。而「贷 累计折旧」本身已足够精确 —— 清理凭证是【借】累计折旧（方向相反），
     * 天然不会命中。宁可偶发误拦（用户可手工入账），也不能漏拦导致重复计提。
     * 【为什么必须挡】迁移账套的折旧凭证本来就在账里 —— 实测绅蓝之星 2024-09~2026-08
     * 每月一张「借 折旧费用 / 贷 1602 累计折旧」，再计提一次 = 同一笔折旧入账两次，
     * 1602 累计折旧翻倍、账实不符。 */
    deprVoucherIn: function (month) {
      var self = this;
      var depCodes = {};
      var roleSubject = this.subjectRole('ACC_DEPR');
      if (roleSubject && roleSubject.code) depCodes[String(roleSubject.code)] = 1;
      (this.state.fixedAssets || []).forEach(function (fa) {
        if (fa.accDeprAcct) depCodes[String(fa.accDeprAcct)] = 1;
      });
      var keys = Object.keys(depCodes);
      function isAccDeprCredit(e) {
        if (num(e.cr) <= 0) return false;
        var c = String(e.code);
        if (depCodes[c]) return true;
        if (String(e.name || '').indexOf('累计折旧') >= 0) return true;
        for (var i = 0; i < keys.length; i++) {
          if (keys[i] && c.indexOf(keys[i]) === 0) return true;
        }
        return false;
      }
      var hit = '';
      (this.state.vouchers || []).forEach(function (v) {
        if (hit) return;
        // 必须排除软删凭证：与 periodVouchers 等所有「活动凭证」入口同口径。
        // 否则用户删掉本期折旧凭证想重做时，守卫仍报「已存在折旧凭证（记-xx）」，
        // 导致永远无法重新计提 —— 删除即死结。回收站里的凭证不算账上凭证。
        if (v.deleted === 'y') return;
        if (String(v.date || '').slice(0, 7) !== month) return;
        if ((v.entries || []).some(isAccDeprCredit)) hit = (v.word || '记') + '-' + (v.no != null ? v.no : '');
      });
      return hit;
    },
    // 【冻结】计提折旧：幂等（重复计提不产生额外凭证）由 tools/verify_e2e_snapshot.js ② 守护，
    // 凭证借贷平衡由不变量 I1 兜底。纯可读性改动不改业务口径，风险 > 收益，默认不动；
    // 确需重构时：单独开一轮，改完立即跑 verify_e2e_snapshot.js 与 verify_invariants.js，全绿才算完成。
    // 计提某月折旧 -> 生成凭证（借 5602 管理费用-折旧费 / 贷 1602 累计折旧）
    depreciateMonth: function (month, opts) {
      opts = opts || {};
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账，请先反结账' };
      var self = this;
      // 科目角色解析（单点）：累计折旧 / 折旧费用(管理费用) 随准则取码（5602|6602），卡片可配置覆盖
      var depSubj = this.subjectRole('ACC_DEPR');
      var feeSubj = this.subjectRole('DEPR_FEE');
      if (!depSubj) return { ok: false, msg: '科目表缺少「累计折旧」科目，请先在科目页添加' };
      if (!feeSubj) return { ok: false, msg: '科目表缺少「管理费用」科目，请先在科目页添加' };
      // 【防重复入账】本月若已有折旧凭证（含随账套导入的外部凭证），一律拒绝再计提。
      // 迁移账套的折旧凭证随账套一起进来，重复计提会让累计折旧翻倍；而期末累计折旧
      // 已按账面逐月滚算（见 pages/asset/Asset.js 的 _accumDeprAt），本就不需要补提。
      var dupDepr = this.deprVoucherIn(month);
      if (dupDepr) {
        return { ok: false, msg: '该月已存在折旧凭证（' + dupDepr + '），不能重复计提 —— 固定资产折旧每月只计提一次' };
      }
      var acq0 = month + '-01';
      var entries = [];
      var total = 0;
      var assetLines = [];
      this.state.fixedAssets.forEach(function (fa) {
        // 判断与金额一并交给 assetDeprDue（唯一权威口径，折旧汇总表/明细表共用同一函数）。
        // 原先前述 8 行判断 + 后述 5 行金额都写在这里，而报表侧又各写了一遍、且漏了跳过条件，
        // 造成"报表显示 10,866.63 / 凭证与总账 10,810.42"的口径分叉（实测差 56.21 = 一张
        // 「购置晚于本月」的卡）。含幂等保护：fa.deprMonth === month 时返回 0，不会重复入账。
        var amt = self.assetDeprDue(fa, month);
        if (amt <= 0) return;
        // 取卡片配置科目：先按「科目码真实存在」校验，再退回角色科目，最后用默认。
        // 详见下方调用处的说明（脏科目码会让 subjectRole 静默兜底到无关科目）。
        function pickConfiguredSubject(role, cfgCode, fallback) {
          var code = String(cfgCode == null ? '' : cfgCode).split(',')[0].trim(); // 兼容 "5401006,5401006"
          if (code) {
            var s = self.subject(code);
            if (s) return s;
          }
          return self.subjectRole(role) || fallback;
        }
        // 卡片上配置的科目码可能带脏数据（实测：导入时把同一编码重复拼接成 "5401006,5401006"）。
        // 直接把这种值交给 subjectRole(role, preferred) 是危险的：preferred 解析不到时，
        // 它不会返回 null，而是静默走「关键词兜底」—— 于是折旧费用被记到「管理费用」上，
        // 与其余卡片所在的「折旧」科目分家，费用结构失真，且不报任何错。
        // 故先按科目码真实存在性校验（并兼容逗号重复），确认无效才回退角色/默认科目。
        var fee = pickConfiguredSubject('DEPR_FEE', fa.deprFeeAcct, feeSubj);
        var dep = pickConfiguredSubject('ACC_DEPR', fa.accDeprAcct, depSubj);
        entries.push({ code: fee.code, name: fee.name, summary: '计提折旧-' + fa.name, dr: amt, cr: 0 });
        entries.push({ code: dep.code, name: dep.name, summary: '累计折旧-' + fa.name, dr: 0, cr: amt });
        total += amt;
        assetLines.push({ id: fa.id, amt: amt });
      });
      if (!entries.length) return { ok: false, msg: '本月无资产需要计提折旧' };
      var v = {
        word: opts.word || this.state.param.voucherWord || '记', date: (opts && opts.date) || lastDay(month), attach: 0,
        summary: opts.summary || ('计提' + month + '固定资产折旧'),
        kind: this.VOUCHER_KINDS.DEPR, // 期末业务类型标记（结账检查按此识别，不依赖摘要）
        entries: entries
      };
      var saved = this.addVoucher(v);
      if (!saved || saved.ok === false) {
        return { ok: false, msg: (saved && saved.msg) || '生成折旧凭证失败' };
      }
      // 更新卡片已计提月份与累计折旧，并记录折旧凭证号（供删除凭证时引用校验）
      // 月末滚转：accumDeprBegin / netValueBegin ← 上月期末，然后本月折旧累加；netValueEnd / netValueBegin 用恒等式重算
      var dvno = (saved.word || '转') + '-' + (saved.no != null ? saved.no : '');
      assetLines.forEach(function (al) {
        self.state.fixedAssets.forEach(function (fa) {
          if (fa.id === al.id) {
            fa.deprMonth = month;
            fa.accumDepr = num(fa.accumDepr) + al.amt;       // 本月折旧累加 → 期末累计
            fa.accumDeprBegin = fa.accumDepr;                // 月末 = 下月初
            fa.periodUsed = num(fa.periodUsed || 0) + 1;
            fa.yearDepr = num(fa.yearDepr || 0) + al.amt;   // 本年已折旧同步累加
            // 净值重算（期末=下月初，此时两者恒等）
            fa.netValueEnd = Math.max(0, num(fa.original) - num(fa.accumDepr) - num(fa.impairment));
            fa.netValueBegin = fa.netValueEnd;
            fa.deprVoucher = dvno;
          }
        });
      });
      this.persist();
      this.backupNow(); // 计提折旧批量写凭证，强制立即备份
      return { ok: true, voucher: saved, total: total, count: assetLines.length };
    },
    // 折旧汇总表
    // （原始凭证 / 电子档案功能已于 2026-09-21 按用户要求整体移除：
    //   originals、addOriginalFromAttachment、removeOriginal 三个方法与
    //   state.originals 字段一并删除。两个账套实测 originals 均为 0 条，无数据残留。）

    /* ===================== 备份与恢复 ===================== */
    restoreFromData: function (data) {
      if (!data || !data.subjects) return { ok: false, msg: '备份文件无效' };
      // 修复：emptyState 是模块内私有函数、未挂在 S 上（原写法 this.emptyState() 必抛 TypeError，
      // 导致备份恢复整体不可用）。此处直接调用私有函数，并补上与「加载账套」一致的兜底链路：
      // normalizeState（缺字段补全）→ ensureVoucherIds（凭证 id 唯一）→ ensureCashFlowFields。
      // 缺了这些，旧备份文件恢复后会因字段缺失导致部分页面渲染崩溃。
      this.state = Object.assign({}, emptyState(), data);
      this.state.schemaVersion = SCHEMA_VERSION;
      this.normalizeState();
      this.ensureVoucherIds();
      this.ensureCashFlowFields();
      // 关键：恢复备份后必须作废总账记忆化缓存。否则查询「同月份」时会命中恢复前的
      // 缓存结果，导致账簿/报表显示恢复前的旧数据（数据已换但显示未换）。
      this._glCache = {};
      this.persist();
      return { ok: true };
    },

    /* ===================== 工资 ===================== */
    addPayroll: function (p) {
      p.id = 'P' + Date.now();
      p.should = num(p.should); p.real = num(p.real);
      this.state.payrolls.push(p);
      this.persist();
    },
    removePayroll: function (id) {
      var p = this.state.payrolls.filter(function (x) { return x.id === id; })[0];
      if (!p) return { ok: false, msg: '工资记录不存在' };
      // 财务严谨：该期间已生成工资计提/发放凭证则禁删，避免账实不符
      if (p.month && this.hasPayrollVoucher(p.month)) {
        return { ok: false, msg: p.month + ' 已生成工资凭证，请先删除工资凭证再删除记录' };
      }
      this.state.payrolls = this.state.payrolls.filter(function (x) { return x.id !== id; });
      this.persist();
      return { ok: true };
    },
    // 某期间是否已生成工资计提/发放凭证
    // 此前两处失效：摘要正则对导入凭证恒不命中（无 v.summary）；v.period 归期错误（自生成凭证无 period 字段，导入 period 为数字 1~12，与 'YYYY-MM' 恒不等）。改用 voucherMonth() 统一归期（与 periodVouchers 同口径）。
    hasPayrollVoucher: function (month) {
      var self = this;
      var K = this.VOUCHER_KINDS;
      return (this.state.vouchers || []).some(function (v) {
        if (v.deleted === 'y' || voucherMonth(v) !== month) return false;
        var k = self.voucherKind(v);
        return k === K.PAYROLL_ACC || k === K.PAYROLL_PAY;
      });
    },
    // 工资表汇总（某月）
    payrollSummary: function (month) {
      return this.state.payrolls.filter(function (p) { return p.month === month; });
    },
    // 计提工资与发放工资两类凭证分别生成
    // 计提：借 管理费用(5602) 贷 应付职工薪酬(2211)
    // 发放：借 应付职工薪酬(2211) 贷 库存现金(1001)/银行存款(1002)
    // 凭证字按「工资凭证模板」取（按凭证类型 + 工资类别匹配已启用模板；
    // 无匹配则回退账套默认凭证字 param.voucherWord）。模板类别为空时匹配"全部/全部(旧)"。
    pickPayrollWord: function (type, category) {
      var vchType = (type === 'pay') ? '发放工资' : '计提工资';
      var tpls = this.salaryVchTpls() || [];
      var hit = null;
      // 优先精确匹配工资类别
      for (var i = 0; i < tpls.length; i++) {
        var t = tpls[i];
        if (t.enabled && t.vchType === vchType && t.category === (category || '')) { hit = t; break; }
      }
      // 回退"全部"类（含"全部(旧)"）
      if (!hit) {
        for (var j = 0; j < tpls.length; j++) {
          var u = tpls[j];
          if (u.enabled && u.vchType === vchType && (u.category === '全部' || u.category === '全部(旧)')) { hit = u; break; }
        }
      }
      var w = hit && hit.word ? hit.word : (this.state.param && this.state.param.voucherWord) || '记';
      return w;
    },
    genPayrollVoucher: function (month, type) {
      if (this.isPeriodClosed(month)) return { ok: false, msg: '该月已结账' };
      var list = this.payrollSummary(month);
      if (!list.length) return { ok: false, msg: '本月无工资记录' };
      var total = 0;
      list.forEach(function (p) { total += num(p.real); });
      // 科目角色解析（单点）：工资费用(管理费用) 随准则 5602|6602；应付职工薪酬/银行存款 恒 2211/1002
      var paySubj = this.subjectRole('PAYROLL_PAYABLE');
      var feeSubj = this.subjectRole('PAYROLL_FEE');
      var bankSubj = this.subjectRole('BANK');
      if (!paySubj) return { ok: false, msg: '科目表缺少「应付职工薪酬」科目，请先在科目页添加' };
      var entries, summary;
      if (type === 'pay') {
        if (!bankSubj) return { ok: false, msg: '科目表缺少「银行存款」科目，请先在科目页添加' };
        entries = [
          { code: paySubj.code, name: paySubj.name, summary: month + '工资发放', dr: total, cr: 0 },
          { code: bankSubj.code, name: bankSubj.name, summary: month + '工资发放', dr: 0, cr: total }
        ];
        summary = month + '发放工资';
      } else {
        if (!feeSubj) return { ok: false, msg: '科目表缺少「管理费用」科目，请先在科目页添加' };
        entries = [
          { code: feeSubj.code, name: feeSubj.name, summary: month + '工资计提', dr: total, cr: 0 },
          { code: paySubj.code, name: paySubj.name, summary: month + '工资计提', dr: 0, cr: total }
        ];
        summary = month + '计提工资';
      }
      // 凭证字按模板取（全部类默认启用，按工资类别分流需职员绑定类别）
      var word = this.pickPayrollWord(type, '');
      var v = {
        word: word, date: lastDay(month), attach: 0, summary: summary,
        kind: (type === 'pay') ? this.VOUCHER_KINDS.PAYROLL_PAY : this.VOUCHER_KINDS.PAYROLL_ACC,
        payroll: true,
        entries: entries
      };
      var saved = this.addVoucher(v);
      if (!saved || saved.ok === false) {
        return { ok: false, msg: (saved && saved.msg) || '生成工资凭证失败' };
      }
      return { ok: true, voucher: saved, total: total, type: type };
    },
    // 工资凭证模板：计提工资 / 发放工资，按工资类别（全部/全部(旧)）配制证字与启用状态
    // 默认 13 条（对照： struct/工资_凭证模板.md L8105-8260）
    defaultSalaryVchTpls: function () {
      var base = [
        ['计提工资', '计提工资', '全部', '记', 1],
        ['发放工资', '发放工资', '全部', '记', 1],
        ['计提工资', '计提工资', '前台', '记', 1],
        ['发放工资', '发放工资', '前台', '记', 1],
        ['计提工资', '计提工资', '客房', '记', 1],
        ['发放工资', '发放工资', '客房', '记', 1],
        ['计提工资', '计提工资', '餐厅', '记', 1],
        ['发放工资', '发放工资', '餐厅', '记', 1]
      ];
      return base.map(function (r, i) {
        return {
          id: 'SVT' + (i + 1),
          name: r[0], vchType: r[1], category: r[2], word: r[3],
          enabled: r[4], memo: (r[1] === '计提工资' ? '计提本月工资' : '发放本月工资')
        };
      });
    },
    salaryVchTpls: function () {
      if (!this.state.salaryVchTpls || !this.state.salaryVchTpls.length) {
        this.state.salaryVchTpls = this.defaultSalaryVchTpls();
        this.persist();
      }
      return this.state.salaryVchTpls;
    },
    addSalaryVchTpl: function (t) {
      t.id = 'SVT' + Date.now();
      this.state.salaryVchTpls.push(t);
      this.persist();
    },
    updateSalaryVchTpl: function (id, patch) {
      var arr = this.state.salaryVchTpls;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === id) { Object.assign(arr[i], patch); break; }
      }
      this.persist();
    },
    removeSalaryVchTpl: function (id) {
      this.state.salaryVchTpls = this.state.salaryVchTpls.filter(function (x) { return x.id !== id; });
      this.persist();
    },
    resetSalaryVchTpls: function () {
      this.state.salaryVchTpls = this.defaultSalaryVchTpls();
      this.persist();
    },

    /* ===================== 设置：现金流量初始余额 ===================== */
    // 对照：该页仅录入各现金流量项目「本年累计」(balance) 一列，无期初列（期初现金由现金科目余额体现）。
    // 存储：{ itemId: { ytd:Number } }，itemId 为 cashFlowItems 的 id。
    getCashFlowOpening: function () {
      this.state.cashFlowOpening = this.state.cashFlowOpening || {};
      return this.state.cashFlowOpening;
    },
    setCashFlowOpening: function (itemId, ytd) {
      this.state.cashFlowOpening = this.state.cashFlowOpening || {};
      this.state.cashFlowOpening[itemId] = { ytd: num(ytd) };
      this.persist();
      this.addLog('现金流量初始余额', '调整现金流量项目本年累计');
      return { ok: true };
    },

    /* ===================== 设置：科目现金流量项目 ===================== */
    getSubjectCashFlowMap: function () {
      this.state.subjectCashFlowMap = this.state.subjectCashFlowMap || {};
      return this.state.subjectCashFlowMap;
    },
    setSubjectCashFlow: function (code, credit, debit) {
      this.state.subjectCashFlowMap = this.state.subjectCashFlowMap || {};
      this.state.subjectCashFlowMap[code] = { credit: credit || '', debit: debit || '' };
      this.persist();
      this.addLog('科目现金流量项目', '设置科目 ' + code + ' 的现金流量主表项目映射');
      return { ok: true };
    },
    // 按小企业会计准则科目编码，推导「贷方/借方」分别映射到的现金流量主表项目
    suggestCashFlowMap: function (subjects) {
      var map = {};
      // 现金及现金等价物本身为通道，不映射（含全部下级明细科目，与 cashAccounts/cashFlow 口径一致）
      var CASH = ['1001', '1002', '1012'];
      var isCash = function (c) {
        c = String(c);
        return CASH.some(function (p) { return c === p || c.indexOf(p) === 0; });
      };
      subjects.forEach(function (s) {
        if (isCash(s.code)) return;
        var code = s.code;
        var credit = '', debit = '';
        // 经营-流入
        if (['5001','5051','5111','5301'].indexOf(code) >= 0) { credit = 'cf_sale'; }       // 主营业务收入/其他业务/投资收益(分红外)/其他收益 贷方=销售收现
        else if (['1122','1123','2203','1161'].indexOf(code) >= 0) { credit = 'cf_sale'; debit = 'cf_sale'; } // 应收/预付贷方收回、预收借方转收=销售收现(净额)
        // 经营-流出
        else if (['2202','1401','1402','1403','1404','1405','1406','1408'].indexOf(code) >= 0) { debit = 'cf_buy'; credit = 'cf_buy'; } // 存货/应付 购货付现(净额)
        else if (code === '2211') { debit = 'cf_payemp'; }                                          // 应付职工薪酬借方=付职工
        else if (code === '2221') { debit = 'cf_taxpay'; }                                          // 应交税费借方=交税
        else if (['5601','5602','5603','5604','5401','5402','5403','5601','5711','5601'].indexOf(code) >= 0) { debit = 'cf_opothp'; } // 各项费用借=支付其他经营
        else if (['1601','1602','1604','1605','1701','1702','1801'].indexOf(code) >= 0) { debit = 'cf_invpay'; credit = 'cf_fixgain'; } // 长期资产购建/处置
        else if (['2001','2501','2502','2701','2711'].indexOf(code) >= 0) { credit = 'cf_finloan'; debit = 'cf_finrepay'; } // 借款借入/偿还
        else { credit = 'cf_opother'; debit = 'cf_opothp'; }                                         // 其余：收=其他经营收，付=其他经营付
        if (credit || debit) map[code] = { credit: credit, debit: debit };
      });
      return map;
    },
    // 账套加载时若未配置映射，自动填充准则默认映射（用户可在设置中调整）
    ensureCashFlowMap: function () {
      this.state.subjectCashFlowMap = this.state.subjectCashFlowMap || {};
      if (!Object.keys(this.state.subjectCashFlowMap).length) {
        this.state.subjectCashFlowMap = this.suggestCashFlowMap(this.state.subjects || []);
        this.persist();
      }
      return this.state.subjectCashFlowMap;
    },

    // 首屏/加载后统一兜底现金流量相关字段，避免 S.state.cashFlowItems / subjectCashFlowMap
    // 为 undefined 导致现金流量初始余额、科目现金流量项目等页面 forEach 崩溃（空白）。
    // 冷启动(init)与从磁盘加载账本(loadCurrentBookFromDisk)后都必须调用，不能只靠 switchBook。
    ensureCashFlowFields: function () {
      if (!this.state) return;
      if (!Array.isArray(this.state.cashFlowItems) || !this.state.cashFlowItems.length) {
        this.state.cashFlowItems = CASH_FLOW_ITEMS.map(function (it) { return Object.assign({}, it); });
      }
      this.ensureCashFlowMap();
    },


    /* ===================== 设置：操作日志 =====================
     * 「设置-操作日志」：记录本账套关键操作，便于追溯与审计。
     * 字段：操作时间 / 操作人 / 操作类型 / 操作模块 / 操作详情。
     * 操作日志同步持久化到
     * 账套 json（与凭证同生命周期），刷新/重开不丢失。
     */
    addLog: function (action, detail, module, reason, before, after, meta) {
      this.state.operationLogs = this.state.operationLogs || [];
      // 审计留痕：reason(反结账原因) + before/after(凭证增删改前后值)
      // + meta 结构化字段（target_id/target_name/action_type/result）便于操作日志页过滤与统计
      // 仅在传入时落字段，避免污染普通操作日志条目（老日志条目无这些字段，渲染时容错）
      var entry = {
        time: fmtDateTime(new Date()),
        user: (this.state.company && this.state.company.bookkeeper) || '会计',
        action: action,
        module: module || '设置',
        detail: detail || ''
      };
      if (reason) entry.reason = reason;
      if (before != null) entry.before = before;  // null/undefined 均跳过
      if (after != null) entry.after = after;
      // 结构化元数据：target_id（操作对象 id）/ target_name（对象名）/ action_type（create/update/delete/restore/purge/reopen 等）/ result（success/fail）
      if (meta && typeof meta === 'object') {
        if (meta.target_id != null) entry.target_id = meta.target_id;
        if (meta.target_name) entry.target_name = meta.target_name;
        if (meta.action_type) entry.action_type = meta.action_type;
        if (meta.result) entry.result = meta.result;
      }
      this.state.operationLogs.unshift(entry);
      if (this.state.operationLogs.length > 1000) this.state.operationLogs.length = 1000;
      // 同步落盘指针（与凭证同源，避免刷新即丢）
      this._writeLocalBookSafe();
      // 追加式增量变更日志（data/changelog.json），供 rj-cloud 共享 data/ 目录后直接读取同步
      if (typeof window.Storage !== 'undefined') {
        window.Storage.appendChangeLog({
          bookId: this.bookId,
          action: action,
          module: module || '设置',
          detail: detail || '',
          user: (this.state.company && this.state.company.bookkeeper) || '会计'
        }).catch(function () {});
      }
      if (typeof this.persist === 'function') this.persist();
    },
    getLogs: function () {
      return this.state.operationLogs || [];
    },

    // 通用字段补全：旧数据/磁盘文件缺字段时，按 emptyState() 兜底所有顶层 + param/company 深层字段，
    // 并回填默认币别。init 冷启动与从磁盘加载账本后都必须调用，
    // 否则磁盘缺字段的账本 JSON 覆盖内存后，任意依赖缺字段的页面会渲染崩溃（空白）。
    normalizeState: function () {
      if (!this.state) return;
      var def = emptyState();
      // 准则字段迁移：老账套无 standard/reportRules 时补默认并重灌规则快照。
      // 关键：必须在 def 填充【前】判断账套原本的 standard 是否缺失/无效——因为 def 本身默认 'old'，
      // 若先 for-in 填充再判断，就永远分不清「账套原本没有」与「原本就是 old」。
      // 账套原本缺失/无效时，统一对齐小企业会计准则 2013。
      var hasStd = this.state && global.STANDARDS && global.STANDARDS[this.state.standard];
      if (!hasStd) {
        var autoStd = detectStandardBySubjects(this.state && this.state.subjects);
        this.state.standard = (autoStd && global.STANDARDS[autoStd]) ? autoStd : 'small2013';
      }
      for (var k in def) {
        if (this.state[k] === undefined) this.state[k] = def[k];
      }
      // 资产类别回填（老账套迁移，幂等）：早期导入把「类别**名称**」直接写进了 fa.category，
      // 与类别档案的**编码**错配 —— 显示看不出问题（_catName 查不到编码就原样返回），但按类别
      // 筛选筛不到、编辑卡片时下拉选不中（保存后类别被清空）。此处统一归一为编码。
      // 必须在上面 def 填充【之后】做：normalizeAssetCategory 要用 this.state.assetCats。
      // 只改内存，随下一次正常写盘落库（与 backfillIncomeRowIds 的只读语义一致）。
      (function (self) {
        var fixed = 0;
        (self.state.fixedAssets || []).forEach(function (fa) {
          var before = String(fa.category == null ? '' : fa.category);
          var after = self.normalizeAssetCategory(before);
          if (before !== after) { fa.category = after; fixed++; }
        });
        // 供自检/回归脚本读取（瞬态字段，不落盘）
        self._assetCatBackfilledN = fixed;
      })(this);
      // 资产「使用部门」回填（老账套迁移，幂等）：同源问题 —— 外部账套导入不带部门档案，
      // 本系统 depts 只有默认种子（前台/客房/餐厅），而卡片里写的是厨房/酒店/酒店洗衣房，
      // 于是资产左树与「按部门筛选」对不上（筛选比的是 d.code，卡片存的是名称）。
      // 归一为**名称**并把档案里缺的部门补进去（值本身不变，只是让档案认得它）。
      (function (self) {
        var fixed = 0;
        (self.state.fixedAssets || []).forEach(function (fa) {
          var before = String(fa.dept == null ? '' : fa.dept);
          var after = self.normalizeDept(before);
          if (before !== after) { fa.dept = after; fixed++; }
        });
        self._assetDeptBackfilledN = fixed;
      })(this);
      // reportRules 必须是独立深拷贝（cloneStandard 已深拷），不可与模板/他账套共享引用。
      if (!this.state.reportRules || typeof this.state.reportRules !== 'object') {
        this.state.reportRules = (global.cloneStandard ? global.cloneStandard(this.state.standard).reportRules : def.reportRules);
      }
      // 利润表规则行 id 回填（老账套迁移，幂等）：快照不会自动获得模板新增的语义 id，
      // 缺失会让首页「收入/成本/费用/净利润」取不到数。此处只改内存，随下次写盘落库。
      backfillIncomeRowIds(this.state.reportRules);
      // 同步 param.standard 显示名与机器键一致（标签随准则，避免「小企业」标签配旧准则编码的误导）
      if (global.STANDARDS && global.STANDARDS[this.state.standard]) {
        this.state.param.standard = global.STANDARDS[this.state.standard].label;
      }
      if (!this.state.param || typeof this.state.param !== 'object') this.state.param = def.param;
      for (var pk in def.param) {
        if (this.state.param[pk] === undefined) this.state.param[pk] = def.param[pk];
      }
      if (!this.state.param.checkOverrides) this.state.param.checkOverrides = {}; // 结账检查项处置策略（block/warn）
      if (!this.state.voucherWords) this.state.voucherWords = def.voucherWords;
      // 凭证字迁移：老账套 voucherWords 未预置 → 按 param.voucherWord 补一条
      // （保证默认凭证字在列表中存在，否则设置页空表且 fillVoucherWord 硬兜底看不到）
      if (!this.state.voucherWords.length) {
        var defName = (this.state.param && this.state.param.voucherWord) || '记';
        var defTitle = defName + '账凭证';
        this.state.voucherWords = [{ name: defName, title: defTitle, enabled: true }];
      }
      // 扫描所有凭证实际使用过的凭证字 → 全部加入 voucherWords 并启用
      // （外部导入账套可能有收/付/转/记四个字，全部要保留和可见；param.voucherWord 只决定默认值）
      var _usedWords = {};
      (this.state.vouchers || []).forEach(function (v) { if (v.word) _usedWords[v.word] = true; });
      var _vwChanged = false;
      Object.keys(_usedWords).forEach(function (wn) {
        var found = this.state.voucherWords.find(function (w) { return w.name === wn; });
        if (!found) {
          this.state.voucherWords.push({ name: wn, title: wn + '账凭证', enabled: true });
          _vwChanged = true;
        } else if (found.enabled === false) {
          found.enabled = true;
          _vwChanged = true;
        }
      }.bind(this));
      if (_vwChanged) this.persist();
      // param.voucherWord 必须指向列表中存在的条目；否则回退到第一个
      var curVW = this.state.param && this.state.param.voucherWord;
      var vwMatch = this.state.voucherWords.find(function (x) { return x.name === curVW; });
      if (!vwMatch) this.state.param.voucherWord = this.state.voucherWords[0].name;
      // 科目层级统一（存量校正）：父子一律按「表内最长真前缀」实算，level=1 基（一级=1）。
      // 兼容 4+2、7 位、9 位与混长账套——旧式按 (长度-4)/2 推导在 7 位账会偏，此处强制幂等收敛。
      if (Array.isArray(this.state.subjects) && this.state.subjects.length) {
        var subjRaw = this.state.subjects;
        var subjBy = {};
        subjRaw.forEach(function (x) { subjBy[String(x.code)] = 1; });
        var subjRawSort = subjRaw.slice().sort(function (a, b) {
          return (a.code ? String(a.code).length : 0) - (b.code ? String(b.code).length : 0)
            || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
        });
        var subjLv = {};
        subjRawSort.forEach(function (x) {
          var c = String(x.code || ''); if (!c) return;
          var best = '';
          for (var L2 = c.length - 1; L2 > 0; L2--) {
            var pre2 = c.slice(0, L2);
            if (subjBy[pre2]) { best = pre2; break; }
          }
          x.parent = best || '';
          x.level = best ? (subjLv[best] || 1) + 1 : 1;
          subjLv[c] = x.level;
        });
      }
      // 软删除字段迁移：老账套凭证无 deleted 字段，统一补 'n'（活动凭证）。
      // 已 deleted==='y' 的凭证保持原状（回收站可见）。deletedAt/deletedBy 无则不补。
      // 出纳复核状态迁移：reviewed（出纳复核）已随出纳板块整体下线，无任何 UI 可达；
      // 历史该状态归一为 audited（已审核），此后状态机仅 draft ↔ audited。
      if (Array.isArray(this.state.vouchers)) {
        this.state.vouchers.forEach(function (v) {
          if (v.deleted === undefined) v.deleted = 'n';
          if (v.status === 'reviewed') v.status = 'audited';
        });
        // 期末业务凭证类型回填（一次性）：存量/导入凭证按结构识别补 v.kind。
        // 挂在 normalizeState 是因为它是所有账套入口（本地加载 / 服务端加载 / 导入 / 备份恢复）
        // 的公共钩子，在此接入即可一处覆盖全部路径。只改内存，随下一次正常写盘落库，不主动 persist。
        this.ensureVoucherKinds();
      }
      if (!this.state.company || typeof this.state.company !== 'object') this.state.company = def.company;
      for (var ck in def.company) {
        if (this.state.company[ck] === undefined) this.state.company[ck] = def.company[ck];
      }
      // 凭证归期统一走 voucherMonth()（优先 date，缺失时按 period + 启用月反推），
      // 此处在 normalize 阶段不再修改凭证数据，保持账套原始数据不被改动。
      // 注：原「自动补齐出纳账户档案(ensureBankAccounts)」已随出纳板块整体移除，不再生成账户数据。
    }
  };

  // ===================== 渲染层字段契约（单一事实源） =====================
  // 用途：store 输出的字段与渲染层消费字段的契约字典，只定义这一份。
  // - 审计 tools/audit_render_contract.js 直接读 S.__contracts，不再自带拷贝，
  // 消除「审计脚本契约与真实契约脱节」的二次维护问题；
  // - 渲染层要消费 store 输出的新字段，必须先在此登记（否则审计报缺登记）；
  // - 改动 store 输出字段 / 渲染层消费字段时，必须同步更新本字典。
  // 类型标记：num 有限数值 | str 字符串 | obj 对象 | array 数组 | bool 布尔
  // any 存在即通过（含 null）；后缀 '?' 可缺省（不存在/空跳过）。
  // 键名：self = 函数自身返回对象；row/group/item = 数组内元素。
  // 字段来源（渲染层真实消费点）：Report.js renderPl/renderTax/renderBs/renderCf、
  // Settle.js 增值税设置等。
  S.__contracts = {
    generalLedger: { row: { code: 'str', name: 'str', cls: 'str', normal: 'str',
      obDr: 'num', obCr: 'num', periodDr: 'num', periodCr: 'num',
      endDr: 'num', endCr: 'num', balance: 'num', dir: 'str',
      ytdDr: 'num', ytdCr: 'num', ytdBalance: 'num', ytdDir: 'str' } },
    detailLedger: { self: { subject: 'obj', obDr: 'num', obCr: 'num',
      periodDr: 'num', periodCr: 'num', endDr: 'num', endCr: 'num',
      ytdDr: 'num', ytdCr: 'num', rows: 'array' },
      row: { date: 'str', word: 'str', no: 'any', summary: 'str',
        dr: 'num', cr: 'num', bal: 'num', dir: 'str',
        qtyDr: 'num', qtyCr: 'num', aux: 'any?', entryCode: 'str' } },
    profitStatement: { self: { totalRevenue: 'num', totalExpense: 'num', netProfit: 'num' },
      row: { code: 'str', name: 'str', cur: 'num', ytd: 'num' } },
    taxDetail: { row: { level: 'num', name: 'str', rowNum: 'num', cur: 'num', ytd: 'num', bold: 'bool' } },
    balanceSheet: { self: { totalAsset: 'num', totalLiability: 'num', totalEquity: 'num', totalAll: 'num', groups: 'obj' },
      group: { title: 'str', subtotal: 'str', subEnd: 'num', subYear: 'num', items: 'array' },
      item: { label: 'str', end: 'num', year: 'num' } },
    cashFlow: { self: { items: 'obj', ytd: 'obj',
      operating: 'num', investing: 'num', financing: 'num', exchange: 'num', opening: 'num' } },
    vatEditGet: { row: { code: 'str', name: 'str', target: 'str' } },
    opening: { self: { dr: 'num', cr: 'num', yb: 'num', ytdDr: 'num', ytdCr: 'num' } }
  };
  // 契约断言（只校验、不修改数据）。供 tools/audit_render_contract.js 复用；
  // 挂在全局 S 上，运行期字段错位时浏览器 console 也会直接报「[契约错位]」。
  S.__checkShape = function (ctx, obj, def) {
    var fails = 0;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      if (typeof console !== 'undefined') console.error('[契约错位] ' + ctx + '：输出不是对象');
      return 1;
    }
    for (var f in def) {
      var want = def[f], v = obj[f];
      var optional = want.slice(-1) === '?';
      var t = optional ? want.slice(0, -1) : want;
      if (v === null || v === undefined) {
        if (!optional) { fails++; if (typeof console !== 'undefined') console.error('[契约错位] ' + ctx + '：缺少字段 ' + f); }
        continue;
      }
      if (t === 'any') continue;
      var ok = (t === 'num') ? (typeof v === 'number' && isFinite(v))
        : (t === 'str') ? (typeof v === 'string')
        : (t === 'bool') ? (typeof v === 'boolean')
        : (t === 'obj') ? (typeof v === 'object' && !Array.isArray(v))
        : (t === 'array') ? Array.isArray(v)
        : true;
      if (!ok) { fails++; if (typeof console !== 'undefined') console.error('[契约错位] ' + ctx + '：字段 ' + f + ' 非' + t + '（' + JSON.stringify(v) + '）'); }
    }
    return fails;
  };

  // 暴露（兼容旧全局脚本：app.js 等仍依赖 global.S）
  global.S = S;
  global.ACCOUNT_CLASSES = ACCOUNT_CLASSES;
  global.util = {
    pad2: pad2, fmtDate: fmtDate, monthOf: monthOf, lastDay: lastDay,
    prevMonth: prevMonth, monthsBetween: monthsBetween, monthList: monthList, num: num, money: money
  };

  // B 方案迁移：新增 ESM 导出（不破坏旧全局）。后续页面模块通过 import 使用。
  const exported = {
    store: S,
    ACCOUNT_CLASSES: ACCOUNT_CLASSES,
    util: {
      pad2: pad2, fmtDate: fmtDate, monthOf: monthOf, lastDay: lastDay,
      prevMonth: prevMonth, monthsBetween: monthsBetween, monthList: monthList, num: num, money: money
    }
  };
  // 支持 <script type="module"> 的 import；旧 <script src> 走上面的 global。
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (typeof globalThis !== 'undefined') globalThis.__TY_EXPORT__ = exported;

})(window);
