// Home.js —— 首页工作台（资金余额/应收应付/预计可用资金/净利润/收入成本/费用）
// 本文件是从原始 app.js home 工作台块迁移而来，逻辑与 index.html DOM 一一对应。
// 依赖桥接层 globalThis.__TY_HELPERS__（由 js/app.js 在启动时挂载）。
// 设计原则：不依赖账套 cls 字段，避免导出标错导致数据失真。

// 引导块已收口到 common/helpers.js（原先 17 处写法互不相同，其中 esc 的兜底甚至有 3 处"不转义"✗）。
// 科目名称来自导入账套，可能含 < & " 等字符，拼进 innerHTML 前必须转义 —— esc 现在一律真转义。
import { H, $, S, U, esc, currentPeriod, round2 } from '../../common/helpers.js?v=dev';
const absFmt = H.absFmt;
const signed = H.signed;

function setEl(id, val) { const el = $(id); if (el) el.textContent = val; }
// 【2026-10-05 负数红字】setEl 的"金额版"：写带符号文本给负值挂 .neg 类（CSS 标红）。
//   不动全局 signed（Ledger/Voucher 等多页共用）；仅首页卡片用此，局部生效、零污染。
function setSigned(id, val) {
  var el = $(id);
  if (!el) return;
  el.textContent = signed(val);
  el.classList.toggle('neg', val < 0);
}

/* ---------------- 首页指标口径常量 ----------------
 * 资金类：库存现金 + 银行存款 + 其他货币资金
 * 短期应收：应收票据 + 应收账款 + 其他应收款（不含预付账款——钱已付，不会再有现金流入）
 * 短期应付：应付票据 + 应付账款 + 其他应付款（不含预收账款——钱已收，不会再有现金流出）
 */
var FUND_CODES = ['1001', '1002', '1012'];
// 短期应收/应付科目清单：对齐通用财务口径（开源复刻 jinbooks 默认配置
// sys.default.shortTermAccountsReceivable / shortTermAccountsPayable）。
// 判据是「未来会带来现金流入/流出的短期债权债务」：
//   应收 = 1121 应收票据 + 1122 应收账款 + 1131 应收股利 + 1132 应收利息 + 1221 其他应收款
//   应付 = 2201 应付票据 + 2202 应付账款 + 2211 应付职工薪酬 + 2231 应付利息
//        + 2232 应付股利 + 2241 其他应付款
// 刻意排除 1123 预付账款（钱已付，不会再有流出/流入）与 2203 预收账款（钱已收），
// 与从真实账套反推通用数值的结论一致。
// 已知偏差：通用财务口径与 jinbooks 均未纳入 2221 应交税费（理论上属刚性短期支付义务），
// 为与通用口径对账一致此处跟随；若将来要做更专业的口径，可视为可选项开启。
var SHORT_AR_CODES = ['1121', '1122', '1131', '1132', '1221'];
var SHORT_AP_CODES = ['2201', '2202', '2211', '2231', '2232', '2241'];
// 损益类指标（收入 / 成本 / 费用 / 净利润）在此【不再维护科目清单】：
// 一律经 store.plSummary 按「语义行 id」从利润表规则行取数，与「报表 → 利润表」
// 共用同一份行计算（store.incomeStatement）。历史做法是首页自带 5xxx/6xxx 编码清单
// 逐分录累加，属第三套口径 —— 用户自定义利润表规则时首页不跟随，且它与利润表漂移后
// 没有任何机制能发现（利润表侧有 I10 恒等式保护，首页侧游离在外）。
// 口径定义与 id 清单见 store.js 的 incomeStatement / plSummary、js/standards.js。

/* ---------------- 卡片期间选择（本期 / 上期 / 本年 / 去年） ----------------
 * 设计取舍：
 * ① 不持久化——每次进入首页回到「本期」。财务软件里「用户忘了自己选过上期、
 *    看到数字以为算错」的代价，远大于「每次重选一下」。
 * ② 指标分两类，语义不同，期间对象同时给出两个字段：
 *      end        → 存量指标（资金余额/应收应付/预计可用资金）取「该期间期末」余额
 *      from ~ to  → 流量指标（资金净收入/收入/成本/费用/净利润）取「区间累计」发生额
 *    混用会出数错（把余额当累计数、或反过来），故两类严格分开取。
 * ③ 存量卡片固定显示最新期末（无期间选择），三张流量卡片（净利润/收入成本/费用）
 *    各自独立期间选择，放在卡片右上角的 select 里。
 */
var PERIOD_MODES = [
  { value: 'currentPeriod', label: '本期' },
  { value: 'lastPeriod', label: '上期' },
  { value: 'currentYear', label: '本年' },
  { value: 'lastYear', label: '去年' }
];
// 三张流量卡片各自独立的期间（不持久化，默认「本期」）
var periodProfit = 'currentPeriod';     // 净利润 + 资金净收入 共用
var periodRevCost = 'currentPeriod';    // 收入 + 成本 + 毛利率
var periodFee = 'currentPeriod';        // 费用 + 费用占收入比

// 上一个月（'YYYY-MM'）：走 store 单点 U.prevMonth（与本文件 monthsOf 用 U.monthList 同一收口口径）。
// 原先此处自带一份实现（算法与 store 逐字相同，纯重复）。
function prevMonth(ym) { return U.prevMonth(ym); }
// 期间区间 [from, to] 展开为月份数组（含首尾）。
// 月份列表统一走 store.monthList（此前内联展开一份，多处重复）。
function monthsOf(p) {
  return U.monthList(p.from, p.to);
}
// 期间文案：月粒度显示「2026年08期」，年粒度显示「2026年」
// 期间文案单点（见 store.js 的 periodText）：原为「2026年07期」（补零），与顶栏写法不一致。
function ymText(ym) { return U.periodText(ym); }
function yearText(ym) { return ym.slice(0, 4) + '年'; }
function resolvePeriod(mode) {
  var cur = currentPeriod();
  var y = cur.slice(0, 4);
  var prev = prevMonth(cur);
  var lastY = String(+y - 1);
  switch (mode) {
    case 'lastPeriod':  return { end: prev, from: prev, to: prev, text: ymText(prev) };
    case 'currentYear': return { end: cur, from: y + '-01', to: cur, text: yearText(cur) };
    // 存量指标取去年末时点；流量指标取去年 1~12 月整年累计（与年度口径一致）
    case 'lastYear':    return { end: lastY + '-12', from: lastY + '-01', to: lastY + '-12', text: lastY + '年' };
    default:            return { end: cur, from: cur, to: cur, text: ymText(cur) };
  }
}

// 切账套时把所有期间重置回「本期」：否则新账套会沿用上一本账选的「去年」，
// 用户看到的是另一本账、另一期间的数，极易误判。
var _scopeBookId = null;
function syncBookScope() {
  var bid = (S.currentBookId ? S.currentBookId() : null) || null;
  if (bid !== _scopeBookId) {
    _scopeBookId = bid;
    periodProfit = periodRevCost = periodFee = 'currentPeriod';
  }
}

// ============================================================
// 首页主刷新入口
// ============================================================
// opts.skipTip：卡片切换期间时的内部重绘，不重复触发云备份提醒（它是一次异步判定）
function refreshHome(opts) {
  opts = opts || {};
  syncBookScope();
  fillMetrics();
  syncCardPeriodSelects();
  if (!opts.skipTip) checkBackupTip();
  // 下面两条是**同步**判定（不问后端、不发请求），故不受 skipTip 约束：每次刷新都重算 ——
  // 改完名 / 切到「已设置记账员」的账套后立即消失；更新提醒则按上一次推送的结果重绘。
  checkOperatorTip();
  checkUpdateTip();
}

/* ---------------- 首页「有新版本」提醒（由 update.js 推送，不主动轮询） ----------------
   节流不在这里做：update.js 已按「每版本 7 天」记 ty_update_notified，它不推就不显示 ——
   所以这条**没有自己的静默键**（× 只隐藏本次，下次启动是否再提由 update.js 决定），
   避免两处节流打架（一个说"别提醒"，一个说"该提醒了"）。 */
var _pendingUpdate = null;   // { latest, asset } —— 收到推送才置值
function checkUpdateTip() {
  var tip = $('homeUpdateTip');
  if (!tip) return;
  if (!_pendingUpdate) { tip.style.display = 'none'; return; }
  var txt = $('homeUpdateTipTxt');
  var tag = (_pendingUpdate.latest && _pendingUpdate.latest.tag) || '';
  if (txt) txt.textContent = '发现新版本 v' + tag;
  tip.style.display = '';
}
/* 供 update.js 的静默检查调用（跨模块经 globalThis，与 __CS_OPEN_CONFIG__ / __OP_OPEN__ 同一套做法） */
globalThis.__showHomeUpdateTip = function (latest, asset) {
  _pendingUpdate = { latest: latest, asset: asset };
  checkUpdateTip();
};

/* ---------------- 首页「云备份」提醒（被动一条，纯常驻） ----------------
   【2026-10-07】原为「两级静默」（× 静默 7 天 / 点动作静默到明天 0 点），现改为**纯常驻**：
   条件没满足就一直显示，不给"临时藏起来"的口子。故删除 TIP_MUTE_MS / TIP_MUTE_KEY /
   OP_TIP_MUTE_KEY / msUntilTomorrow / tipMuted / muteTip 整套静默设施；
   旧 localStorage 静音键（hbTipMute / opTipMute）的残留值不再被读取，自然失效。 */

function checkBackupTip() {
  var tip = $('homeBackupTip');
  if (!tip || typeof window.Storage === 'undefined' || !window.Storage.syncPending) return;
  window.Storage.syncPending().then(function (r) {
    if (!r) { tip.style.display = 'none'; return; }
    var txt = $('homeBackupTipTxt');
    var go = tip.querySelector('.tip-go');   // 按钮不带 id：统一按类取（见 bindOneTip 的说明）
    if (r.unconfigured) {
      tip.dataset.go = 'config';
      if (txt) txt.textContent = '尚未配置云备份';
      if (go) go.textContent = '去配置';
    } else if (r.neverPushed) {
      // 已配置但一次都没备份：自动备份要以「上次备份时间」为基准，不备份一次永远不会启动
      tip.dataset.go = 'push';
      if (txt) txt.textContent = '云备份尚未备份过';
      if (go) go.textContent = '去备份';
    } else if (r.pending) {
      tip.dataset.go = 'push';
      if (txt) txt.textContent = '已超过 7 天未备份';
      if (go) go.textContent = '去备份';
    } else {
      tip.style.display = 'none';
      return;
    }
    tip.style.display = '';
  }).catch(function () { tip.style.display = 'none'; });
}
/* ---------------- 首页提醒条：统一绑定（三条提醒的唯一入口） ----------------
   【2026-10-07】纯常驻模式：取消临时静默与 × 关闭（index.html 已删 .tip-close），
   显隐完全由业务条件决定 —— 没办成就一直显示，办成（条件不再满足）才消失。
   三条提醒只剩一个动作按钮 .tip-go，点了各做各的事。
   新增提醒 = index.html 加一条 .home-tip + 本函数加一行 bindOneTip（按钮不带 id）。 */
function bindOneTip(tipId, onGo) {
  var tip = $(tipId);
  if (!tip) return;
  var go = tip.querySelector('.tip-go');
  if (go) go.addEventListener('click', function () {
    if (onGo) onGo();
  });
}
function bindHomeTips() {
  // ① 更新：点「去下载」直接下载并收起（不静默：下次启动是否再提，由 update.js 的每版本 7 天节流决定）
  bindOneTip('homeUpdateTip', function () {
    var p = _pendingUpdate;
    var tip = $('homeUpdateTip');
    if (tip) tip.style.display = 'none';
    if (p && globalThis.__TY_UPDATE__ && globalThis.__TY_UPDATE__.download) {
      globalThis.__TY_UPDATE__.download(p.latest, p.asset);
    }
  });
  // ② 云备份：跳过去后滚动到「云同步」卡；未配置 → 高亮「配置」并直接弹出配置，否则高亮「云备份」
  bindOneTip('homeBackupTip', function () {
    var tipEl = $('homeBackupTip');
    var isCfg = tipEl && tipEl.dataset.go === 'config';
    if (globalThis.goPage) globalThis.goPage('system-settings');
    setTimeout(function () {
      var card = document.getElementById('cardCloudSync');
      if (card) card.scrollIntoView({ block: 'center' });
      var b = document.getElementById(isCfg ? 'btnCsConfig' : 'btnCsPush');
      if (b) { b.classList.add('btn-hl'); setTimeout(function () { b.classList.remove('btn-hl'); }, 1600); }
      if (isCfg && globalThis.__CS_OPEN_CONFIG__) globalThis.__CS_OPEN_CONFIG__();
    }, 150);
  });
  // ③ 记账员：跳到该行、高亮「修改」，并直接把改名弹窗弹出来（只有一个字段，别让用户再找一步）
  bindOneTip('homeOperatorTip', function () {
    if (globalThis.goPage) globalThis.goPage('system-settings');
    setTimeout(function () {
      var val = document.getElementById('sysOpVal');
      var row = val && val.closest ? val.closest('.set-row') : null;
      if (row) row.scrollIntoView({ block: 'center' });
      var b = document.getElementById('btnEditOperator');
      if (b) { b.classList.add('btn-hl'); setTimeout(function () { b.classList.remove('btn-hl'); }, 1600); }
      if (globalThis.__OP_OPEN__) globalThis.__OP_OPEN__();
    }, 150);
  });
}

/* ---------------- 首页「记账员未设置」提醒（纯常驻，无静默） ----------------
   为什么要提醒：company.bookkeeper 同时是**凭证制单人**（store.js:1895 的 v.maker）与
   **操作日志的操作人**；而默认账套的它就是占位名 '财务'，不填也照样能记账 ——
   于是"制单人是谁"长期是一句空话。放在首页被动提醒一条，不做成开机弹窗。
   判定用 app.js 暴露的 __operatorUnset__（占位名 '记账员'/'财务' 一律视同未设置），
   与「系统设置 → 基本信息」的显示口径**同一实现**，避免两处口径不一致。
   【2026-10-07】改为纯常驻：不再有 7 天 / 到明天的静默，没设置就一直显示。 */
function checkOperatorTip() {
  var tip = $('homeOperatorTip');
  if (!tip) return;
  var unset = globalThis.__operatorUnset__ && globalThis.__operatorUnset__();
  if (!unset) { tip.style.display = 'none'; return; }
  var c = (window.S && S.state && S.state.company) || {};
  var nm = c.bookkeeper || '';
  var txt = $('homeOperatorTipTxt');
  // 把"会被记成什么名字"直接写出来，比单说"未设置"更能说明后果
  if (txt) txt.textContent = '尚未设置记账员' + (nm ? '：凭证制单人将记为「' + nm + '」' : '');
  tip.style.display = '';
}


/** 填充财务指标卡片数据：存量卡固定最新期末，三张流量卡各自独立期间 */
function fillMetrics() {
  // 最新期间：存量指标（资金余额/应收应付/预计可用资金）固定显示「当前期」。
  // 【2026-10-05】对标金蝶：首页 6 张卡统一用 currentPeriod()（当前期/最近有凭证期），
  //   与首页顶栏「当前账期」(app.js:1685/1884 用 currentPeriod()) 保持一致；
  //   不再用第三套 company.currentPeriod，也不再背离顶栏用 lastClosedPeriod 结账期。取数底座 subjectEndBalance 不动。
  var latestPeriod = currentPeriod();
  var periodText = latestPeriod ? latestPeriod.replace('-', '年') + '期' : '--';
  // 三张流量卡片各自独立的期间对象
  var pProfit = resolvePeriod(periodProfit);
  var pRevCost = resolvePeriod(periodRevCost);
  var pFee = resolvePeriod(periodFee);

  // 余额类口径统一走 subjectBalance（基于 generalLedger，子科目聚合，不依赖 cls）
  function balOfAt(code) { return subjectBalance(code, latestPeriod); }
  // 多个一级科目余额求和（各自已含下级，直接相加即可，不可再展开子科目）
  function sumBalAt(codes) {
    var sum = 0;
    codes.forEach(function (c) { sum += balOfAt(c); });
    return round2(sum);
  }
  // 展示一律用 signed（实际数带符号）：财务指标不许抹掉负号——
  // fmt() 内部是 money(Math.abs(n))，会把「贷方余额/亏损/净流出」显示成正数，与标准口径不一致。

  // ---- 资金余额卡（存量：最新期末余额）----
  var totalFund = sumBalAt(FUND_CODES);
  setSigned('mFundBalance', totalFund);
  setSigned('mBank', balOfAt('1002'));
  setSigned('mCash', balOfAt('1001'));
  setSigned('mOtherCash', balOfAt('1012'));
  setEl('periodFund', periodText);

  // 资金净流量 = 所选期间「资金收入 − 资金支出」（流量：区间累计，收付实现制口径）
  // 标准口径：取数来自科目余额模块（综合本位币）→ 资金类科目借方发生额(流入) − 贷方发生额(流出)。
  // 注意：这是「资金的收付差」，不是损益口径的净利润（旧实现误用当期净利润，与标准口径对不上）。
  // 归属「净利润」卡片的期间选择（与净利润同属利润/现金流维度）
  var fundDr = 0, fundCr = 0;
  monthsOf(pProfit).forEach(function (m) {
    FUND_CODES.forEach(function (c) {
      var a = (S.subjectPeriodAmount ? S.subjectPeriodAmount(c, m) : null) || { dr: 0, cr: 0 };
      fundDr += a.dr; fundCr += a.cr;
    });
  });
  setSigned('mFundNet', round2(fundDr - fundCr));

  // ---- 应收 / 应付（存量：最新期末余额；单科目，合计=明细之和，对齐首页卡片）----
  renderArapItems(latestPeriod, '1122', 'arapItemsAr', 'mReceivable', '应收');
  renderArapItems(latestPeriod, '2202', 'arapItemsAp', 'mPayable', '应付');
  setEl('periodArap', periodText);

  // ---- 预计可用资金（存量：最新期末余额）= 现有资金 + 短期应收款 − 短期应付款（标准口径）----
  // 现有资金与资金余额卡同口径，直接复用 totalFund，不重复计算。
  // 余额方向：资产类(应收)借正贷负 → 正常为正；负债类(应付)正常是贷方余额，取反后为正显示。
  var shortAr = sumBalAt(SHORT_AR_CODES);
  var shortAp = -sumBalAt(SHORT_AP_CODES);
  setSigned('mAvailCash', round2(totalFund + shortAr - shortAp));
  setSigned('mAvailFund', totalFund);
  setSigned('mAvailAr', shortAr);
  setSigned('mAvailAp', shortAp);
  setEl('periodAvail', periodText);

  // ---- 损益（流量：区间累计）----
  // 与「报表 → 利润表」同源：一律走 store.plSummary（内部即利润表的行计算）。
  // 三张卡片各自独立期间，分别计算：
  //   净利润卡 → periodProfit（净利润 + 资金净收入）
  //   收入成本卡 → periodRevCost（收入 + 成本 + 毛利率）
  //   费用卡 → periodFee（费用 + 费用占收入比）
  // 期间映射（等价通用报表期间类型）：
  //   本期 / 上期（单月）→ 取 cur，本月金额
  //   本年 / 去年（整段）→ 取 ytd，年初至末月累计
  var plIsYearProfit = (periodProfit === 'currentYear' || periodProfit === 'lastYear');
  var plKeyProfit = plIsYearProfit ? 'ytd' : 'cur';
  var plProfit = S.plSummary(pProfit.to);
  setSigned('mNetProfit', round2(plProfit.netProfit[plKeyProfit]));
  setEl('mProfitRate', (plProfit.revenue[plKeyProfit] ? (plProfit.netProfit[plKeyProfit] / plProfit.revenue[plKeyProfit] * 100) : 0).toFixed(1) + '%');
  markPlRow('mNetProfit', plProfit.netProfit.ids);
  hintPlMissing(plProfit.netProfit, 'mNetProfit', '净利润');

  var plIsYearRC = (periodRevCost === 'currentYear' || periodRevCost === 'lastYear');
  var plKeyRC = plIsYearRC ? 'ytd' : 'cur';
  var plRC = S.plSummary(pRevCost.to);
  setSigned('bIncome', round2(plRC.revenue[plKeyRC]));
  setSigned('bCost', round2(plRC.cost[plKeyRC]));
  setEl('bGrossMargin', (plRC.revenue[plKeyRC] ? (1 - plRC.cost[plKeyRC] / plRC.revenue[plKeyRC]) * 100 : 0).toFixed(1) + '%');
  markPlRow('bIncome', plRC.revenue.ids);
  markPlRow('bCost', plRC.cost.ids);
  hintPlMissing(plRC.revenue, 'bIncome', '营业收入');
  hintPlMissing(plRC.cost, 'bCost', '营业成本');

  var plIsYearFee = (periodFee === 'currentYear' || periodFee === 'lastYear');
  var plKeyFee = plIsYearFee ? 'ytd' : 'cur';
  var plFee = S.plSummary(pFee.to);
  var feeAmt = round2(plFee.expense[plKeyFee]);
  var revForFee = round2(plFee.revenue[plKeyFee]);
  setSigned('bExpense', feeAmt);
  setEl('feeToIncome', revForFee ? (feeAmt / revForFee * 100).toFixed(1) + '%' : '--%');
  hintPlMissing(plFee.expense, 'bExpense', '期间费用（销售+管理+财务）');
  // 费用子项：格式与「预计可用资金」卡片下方的三项完全一致（.fv2）——
  // 一行一项、标签在左、金额在右，不再用「标签在上 + 金额在下 + 加号分隔」的相加式排版。
  // 取数来源不变：仍是利润表费用公式行（用户增删费用行时自动跟随），
  // 可点行照旧带 amt-link + data-pl-rows（点进去高亮利润表对应行）。
  var formulaEl = $('feeFormula');
  if (formulaEl && plFee.expense.formula && plFee.expense.formula.length) {
    formulaEl.innerHTML = plFee.expense.formula.map(function (f) {
      var val = round2(plIsYearFee ? f.ytd : f.cur);
      var amtHtml = (val < 0 ? '−' : '') + absFmt(Math.abs(val));
      var cls = f.ids && f.ids.length ? 'fv2 amt-link' : 'fv2';
      // 可点行同步键盘语义（Enter/Space → click，见 app.js 的 TYKeyboard 全局激活委托）
      var attrs = f.ids && f.ids.length
        ? ' data-pl-rows="' + f.ids.join(',') + '" tabindex="0" role="button" data-kb-activate'
        : '';
      return '<div class="' + cls + '"' + attrs + '>'
           + '<div class="fv2-f">' + esc(f.label) + '</div>'
           + '<div class="fv2-v' + (val < 0 ? ' neg' : '') + '">' + amtHtml + '</div>'
           + '</div>';
    }).join('');
  } else if (formulaEl) {
    formulaEl.innerHTML = '';
  }

  // ---- 首页三张流量卡片 ECharts 大图（【2026-10-06】接入，与卡片数字同源、接当前期语义）----
  renderHomeCharts({
    pProfit: pProfit, pRevCost: pRevCost, pFee: pFee,
    plProfit: plProfit, plRC: plRC, plFee: plFee,
    plKeyProfit: plKeyProfit, plKeyRC: plKeyRC, plKeyFee: plKeyFee
  });
}


/* ---------------- 首页流量卡片 ECharts 大图（【2026-10-06】接入） ----------------
 * 三张流量卡（净利润/收入成本/费用）底部各嵌入一张 ECharts 图，与卡片数字同源：
 *   净利润 → 折线（截至所选期间末月的最近 6 个月净利润趋势）
 *   收入成本 → 双柱（最近 6 个月收入 / 成本）
 *   费用 → 饼图（所选期间费用子项构成，cur/ytd 随卡片期间模式）
 * 期间语义：趋势截止月 = 卡片所选期间末月 p.to（本期=当月、上期=上月、本年=当期、去年=去年12月），
 *   与卡片数字取数完全一致；饼图用 cur 或 ytd 取决于该卡片期间模式。
 * 依赖：js/echarts.min.js（本地 vendor，仿 xlsx 离线可用），全局 window.echarts。
 * 【2026-10-06】所有 tooltip 设 confine:true（限制在图内，防止它越界去改变页面的可滚动区域）。
 * 【2026-10-07】在此之上再设 appendTo: document.body —— 这才是"鼠标在图上一动、上方数据左右闪"的正解。
 *   实测（用户真机、控制台探针）：悬停图表时**只有被悬停那张卡**的 clientWidth 从 352 掉到 335（-17px），
 *   offsetWidth 不变 —— 即卡片内**纵向滚动条闪现/收起**，卡片内容随之整体左右移 17px。
 *   成因：卡片是 overflow:auto 的滚动容器（.metric-card），而提示框是该容器内的绝对定位后代，
 *   **会参与"可滚动溢出"计算**。鼠标在图上一动，提示框就把卡片顶过 520px 的溢出阈值 → 滚动条出现 →
 *   内容窄 17px → 数据左移；鼠标移开阈值回落 → 滚动条消失 → 数据右移。肉眼即"闪一下"。
 *   把提示框挂到 body 后，它不再是卡片的滚动后代，滚动条就没有理由出现；confine:true 仍在，
 *   保证它不越出图外，也就不会反过来改变整页的可滚动区域（2026-10-06 治的就是那种情况）。
 */
var _homeChart = {};
function _getChart(id) {
  var el = document.getElementById(id);
  if (!el || !window.echarts) return null;
  if (!_homeChart[id]) _homeChart[id] = window.echarts.init(el);
  return _homeChart[id];
}
// 截至 endYm 往前 n 个月（含 endYm），由近及远
function _lastNMonths(n, endYm) {
  var arr = [], ym = endYm;
  for (var i = 0; i < n; i++) { arr.unshift(ym); ym = U.prevMonth(ym); }
  return arr;
}
// 趋势图窗口：年模式（本年/去年）→ 该年 1 月至末月整段，避免"本年趋势"混入上年月份；
// 单月模式（本期/上期）→ 近 6 个月近期走势。endYm 为卡片所选期间末月。
function _trendWindow(endYm, isYear) {
  if (isYear) {
    var y = endYm.slice(0, 4);
    return U.monthList(y + '-01', endYm);
  }
  return _lastNMonths(6, endYm);
}
function renderHomeCharts(ctx) {
  if (!window.echarts) return;
  // 净利润折线：趋势窗口——本年/去年用"1月至末月"整年窗口，本期/上期用近6个月
  var isYearProfit = (periodProfit === 'currentYear' || periodProfit === 'lastYear');
  var mp = _trendWindow(ctx.pProfit.to, isYearProfit);
  var c1 = _getChart('chartNetProfit');
  if (c1) {
    var net = mp.map(function (m) { return round2(S.plSummary(m).netProfit.cur); });
    c1.setOption({
      grid: { left: 4, right: 12, top: 16, bottom: 20, containLabel: true },
      tooltip: { appendTo: document.body, confine: true, trigger: 'axis', valueFormatter: function (v) { return v == null ? '--' : signed(v); } },
      xAxis: { type: 'category', data: mp.map(function (m) { return m.slice(5) + '月'; }), axisLine: { lineStyle: { color: '#c8ced6' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6', fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { show: false }, splitLine: { lineStyle: { color: '#eef1f5' } } },
      series: [{ type: 'line', smooth: true, data: net, symbolSize: 5, lineStyle: { width: 2, color: '#3b6fe0' }, itemStyle: { color: '#3b6fe0' }, areaStyle: { color: 'rgba(59,111,224,0.08)' } }]
    });
    c1.resize();
  }
  // 收入成本双柱：趋势窗口同净利润（年模式整年、单月模式近6个月）
  var isYearRC = (periodRevCost === 'currentYear' || periodRevCost === 'lastYear');
  var mr = _trendWindow(ctx.pRevCost.to, isYearRC);
  var c2 = _getChart('chartRevCost');
  if (c2) {
    var rev = mr.map(function (m) { return round2(S.plSummary(m).revenue.cur); });
    var cst = mr.map(function (m) { return round2(S.plSummary(m).cost.cur); });
    c2.setOption({
      grid: { left: 4, right: 12, top: 28, bottom: 20, containLabel: true },
      tooltip: { appendTo: document.body, confine: true, trigger: 'axis', valueFormatter: function (v) { return v == null ? '--' : signed(v); } },
      legend: { show: true, top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: '#8a94a6', fontSize: 11 }, data: ['收入', '成本'] },
      xAxis: { type: 'category', data: mr.map(function (m) { return m.slice(5) + '月'; }), axisLine: { lineStyle: { color: '#c8ced6' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6', fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { show: false }, splitLine: { lineStyle: { color: '#eef1f5' } } },
      // barMinHeight：与饼图 minAngle 同理——给柱一个最小高度，避免「成本」远小于「收入」时
      // 矮柱细到看不见（默认 0）。仅保证可见，不改变数值与坐标轴比例。
      series: [
        { name: '收入', type: 'bar', data: rev, barMaxWidth: 14, barMinHeight: 2, itemStyle: { color: '#3b6fe0', borderRadius: [3, 3, 0, 0] } },
        { name: '成本', type: 'bar', data: cst, barMaxWidth: 14, barMinHeight: 2, itemStyle: { color: '#f0a23b', borderRadius: [3, 3, 0, 0] } }
      ]
    });
    c2.resize();
  }
  // 费用饼图（所选期间费用子项构成）
  var c3 = _getChart('chartFee');
  if (c3) {
    var items = (ctx.plFee.expense.formula || []).map(function (f) {
      var v = round2(ctx.plKeyFee === 'ytd' ? f.ytd : f.cur);
      return { name: f.label, value: Math.abs(v) };
    }).filter(function (x) { return x.value; });
    c3.setOption({
      tooltip: { appendTo: document.body, confine: true, trigger: 'item', formatter: function (p) { return p.name + '<br/>' + absFmt(p.value) + ' (' + p.percent + '%)'; } },
      legend: { show: true, type: 'scroll', bottom: 0, textStyle: { color: '#8a94a6', fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      // minAngle：给每块一个最小圆心角（默认 0）。否则「财务费用」这类金额极小的项会被渲染成
      // 一条几乎看不见的细线，用户以为"没显示"。角度被适度放大以保证可见，但图例/悬浮提示
      // 仍按真实金额与占比显示，不改变数据口径。
      series: [{ type: 'pie', radius: ['38%', '62%'], center: ['50%', '45%'], minAngle: 6, avoidLabelOverlap: true, label: { show: false }, data: items, color: ['#3b6fe0', '#f0a23b', '#46b97a', '#9b6fe0', '#e06f8a', '#5bc0de'] }]
    });
    c3.resize();
  }

  // ---- 存量卡片图表（固定当前期，显示截至当前期的最近 6 个月期末走势，与卡片主值同源）----
  var ms = _lastNMonths(6, currentPeriod());
  var labels = ms.map(function (m) { return m.slice(5) + '月'; });
  // 资金余额折线（库存现金+银行存款+其他货币资金 期末余额）
  var c4 = _getChart('chartFund');
  if (c4) {
    var fundSeries = ms.map(function (m) {
      var s = 0; FUND_CODES.forEach(function (c) { s += subjectBalance(c, m); }); return round2(s);
    });
    c4.setOption({
      grid: { left: 4, right: 12, top: 16, bottom: 20, containLabel: true },
      tooltip: { appendTo: document.body, confine: true, trigger: 'axis', valueFormatter: function (v) { return v == null ? '--' : signed(v); } },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: '#c8ced6' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6', fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { show: false }, splitLine: { lineStyle: { color: '#eef1f5' } } },
      series: [{ type: 'line', smooth: true, data: fundSeries, symbolSize: 5, lineStyle: { width: 2, color: '#3b6fe0' }, itemStyle: { color: '#3b6fe0' }, areaStyle: { color: 'rgba(59,111,224,0.08)' } }]
    });
    c4.resize();
  }
  // 应收·应付双线（应收=1122 期末余额；应付=2202 取反为正，与卡片显示一致）
  var c5 = _getChart('chartArap');
  if (c5) {
    var arSeries = ms.map(function (m) { return round2(subjectBalance('1122', m)); });
    var apSeries = ms.map(function (m) { return round2(-subjectBalance('2202', m)); });
    c5.setOption({
      grid: { left: 4, right: 12, top: 28, bottom: 20, containLabel: true },
      tooltip: { appendTo: document.body, confine: true, trigger: 'axis', valueFormatter: function (v) { return v == null ? '--' : signed(v); } },
      legend: { show: true, top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: '#8a94a6', fontSize: 11 }, data: ['应收', '应付'] },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: '#c8ced6' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6', fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { show: false }, splitLine: { lineStyle: { color: '#eef1f5' } } },
      series: [
        { name: '应收', type: 'line', smooth: true, data: arSeries, symbolSize: 4, lineStyle: { width: 2, color: '#3b6fe0' }, itemStyle: { color: '#3b6fe0' } },
        { name: '应付', type: 'line', smooth: true, data: apSeries, symbolSize: 4, lineStyle: { width: 2, color: '#f0a23b' }, itemStyle: { color: '#f0a23b' } }
      ]
    });
    c5.resize();
  }
  // 预计可用资金折线（现有资金+短期应收−短期应付 期末净额）
  var c6 = _getChart('chartAvail');
  if (c6) {
    var availSeries = ms.map(function (m) {
      var tf = 0; FUND_CODES.forEach(function (c) { tf += subjectBalance(c, m); });
      var sar = 0; SHORT_AR_CODES.forEach(function (c) { sar += subjectBalance(c, m); });
      var sap = 0; SHORT_AP_CODES.forEach(function (c) { sap += subjectBalance(c, m); });
      return round2(tf + sar - sap);
    });
    c6.setOption({
      grid: { left: 4, right: 12, top: 16, bottom: 20, containLabel: true },
      tooltip: { appendTo: document.body, confine: true, trigger: 'axis', valueFormatter: function (v) { return v == null ? '--' : signed(v); } },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: '#c8ced6' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6', fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { show: false }, splitLine: { lineStyle: { color: '#eef1f5' } } },
      series: [{ type: 'line', smooth: true, data: availSeries, symbolSize: 5, lineStyle: { width: 2, color: '#46b97a' }, itemStyle: { color: '#46b97a' }, areaStyle: { color: 'rgba(70,185,122,0.08)' } }]
    });
    c6.resize();
  }
}

// 首页损益卡片的「规则行缺失」提示：用户改过利润表规则（删行 / 改科目编码）时，
// store.plSummary 会列出该项缺失的语义 id，此时该项按 0 计。
// 若不给提示，用户会把 0 误读成「本期无发生额」——那属于静默给错数，故用 title 显式说明去处。
function hintPlMissing(item, elId, name) {
  var el = $(elId);
  if (!el) return;
  if (item && item.missing && item.missing.length) {
    el.title = '利润表规则中未找到「' + name + '」项目行（可能已自定义修改），请到「报表 → 利润表」核对报表规则';
  } else {
    el.removeAttribute('title');
  }
}

/* 判断 sub 是否为 parent 的下级 —— 走**单点** util.isChildCode（规则与依据见 store.js 的说明）。
   旧实现要求"长度差 ≥2"，那是在假设编码是 4→6→8 偶数位；绅蓝之星是金蝶风格**不等长**编码
   （7 位 326 个），会漏掉真实父子（如 `22210102` 属于 `2221010`）。
   【影响面已量化，故本次改动不改变任何数字】该函数只被下面的应收/应付卡片用，
   而 1122 / 2202 下"纯前缀"与"差≥2"在**两个真实账套上结果完全一致**（9/9、23/23、11/11、41/41）
   —— 唯一差异那对（2221010↳22210102）不在本卡片的科目范围内。
   ⚠ 别再写回"长度差"这类对编码风格的假设。 */
function isChildOf(parent, sub) { return U.isChildCode(parent, sub); }

// 科目期末余额：一律走 store.subjectEndBalance（唯一实现）。
// 说明：generalLedger 每行余额已含全部下级，页面若自行「父级 + 子级」聚合会成倍虚增
// （本项目已因此翻车 4 次），故此处不再维护第二份聚合逻辑。
function subjectBalance(code, month) {
  return S.subjectEndBalance ? S.subjectEndBalance(code, month) : 0;
}

// 应收应付卡片：顶部合计 = subjectEndBalance(code)（父行已含下级，一个调用搞定）
// 明细 = code 下末级科目余额，按绝对值降序
// 简单稳定：不做同名合并、不标注预收预付、不收集 codes
function renderArapItems(month, code, itemsBox, totalId, label) {
  var box = document.getElementById(itemsBox);
  if (!box) return;
  var subs = S.subjects() || [];
  var children = subs.filter(function (s) {
    if (s.code !== code && !isChildOf(code, s.code)) return false;
    // 只留末级（无下级的）
    return !subs.some(function (o) {
      return o.code !== s.code && isChildOf(s.code, o.code);
    });
  }).map(function (s) {
    return { name: s.name, code: s.code, v: subjectBalance(s.code, month) };
  }).filter(function (x) { return x.v; })
    .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
  // 显示符号：资产(应收)借余正常为正、贷余异常(预收)标红；负债(应付)贷余正常为正、借余异常(预付)标红。
  // 即"按科目正常方向归一"——取反仅对负债生效，标红(neg)取决于归一后 disp<0，与 setSigned 行为一致。
  // 【2026-10-05】修复：应付原 signed(x.v) 显负号+红字，与同文件行250"取反后为正显示"及同页 mAvailAp 矛盾；
  //   仅翻转显示符号，不动取数(subjectEndBalance 带符号底座)、不聚合、不写回。
  var isLiability = (label === '应付');
  var html = '';
  children.forEach(function (x) {
    var disp = isLiability ? -x.v : x.v;
    html += '<div class="arap-item"><span class="ai-name">' + esc(x.name) +
            '</span><span class="ai-val amt-link' + (disp < 0 ? ' neg' : '') + '" data-codes="' + esc(x.code) + '" tabindex="0" role="button" data-kb-activate>' +
            signed(disp) + '</span></div>';
  });
  box.innerHTML = html;
  // 合计 = 父科目余额（父行已含全部下级）；显示符号同明细：负债取反为正（与 mAvailAp 一致），异常方向才红
  var total = round2(subjectBalance(code, month));
  setSigned(totalId, isLiability ? -total : total);
}

// 应收 / 应付 Tab 切换（卡片内两个主体互斥显隐）
function bindArapTabs() {
  var tabWrap = document.querySelector('.tab-wrapper');
  if (!tabWrap) return;
  var tabs = tabWrap.querySelectorAll('li[data-arap]');
  var bodies = document.querySelectorAll('.arap-body[data-arap]');
  tabs.forEach(function (li) {
    li.addEventListener('click', function () {
      var key = li.getAttribute('data-arap');
      tabs.forEach(function (x) { x.classList.toggle('active', x === li); });
      bodies.forEach(function (b) {
        b.style.display = (b.getAttribute('data-arap') === key) ? '' : 'none';
      });
    });
  });
}

/* ---------------- 金额点击 → 下钻定位 ----------------
 * 两类目标，按「有没有对应报表」区分，两个属性互斥（各自设置时清掉另一个，防串味）：
 *   ① 损益类卡片 → 利润表并定位本项目行（markPlRow / data-pl-rows）
 *      链路：首页指标 → 利润表 → 点行金额 → 总账明细，是完整的三级下钻。
 *      损益指标的口径归宿就是利润表（两者同源于 store.plSummary），跳过报表层无法核对口径。
 *   ② 其余卡片 → 直接跳总账明细（markAmt / data-codes，复用 __glJumpTo + glFilterCodes 过滤
 *      + 黄色提示条，总账侧有「清除筛选」入口，用户不会被卡在过滤态）。
 *      资金/应收应付没有对应报表可定位，直接到明细账最直接。
 * ★ 目标一律由取数处注入，HTML 里不写任何编码/行号——
 *   否则同一份口径会在取数与跳转两处各写一遍，改一处漏一处就会「卡片数」与
 *   「点进去看到的内容」对不上。
 * 目标为空（规则行缺失）时移除可点态：宁可不点，也不跳到与数字无关的地方。
 * 不可点的金额：资金净收入率、毛利率、费用占收入比等派生比率，
 *   以及预计可用资金主值（多科目净额、无可定位的单一目标）。 */
// 可点金额是 <div>/<span>（无 tabindex 则键盘 Tab 不到）：可点态增删时同步键盘语义
// （Enter/Space 由 app.js 的 TYKeyboard 全局激活委托转为 click）
function setAmtActivatable(el, on) {
  if (on) {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('data-kb-activate', '');
  } else {
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
    el.removeAttribute('data-kb-activate');
  }
}
function clearAmtTarget(el) {
  el.classList.remove('amt-link');
  el.removeAttribute('data-codes');
  el.removeAttribute('data-pl-rows');
  setAmtActivatable(el, false);
}
function markAmt(id, codes) {
  var el = $(id);
  if (!el) return;
  codes = (codes || []).filter(Boolean);
  if (!codes.length) { clearAmtTarget(el); return; }
  el.classList.add('amt-link');
  el.removeAttribute('data-pl-rows');
  el.setAttribute('data-codes', codes.join(','));
  setAmtActivatable(el, true);
}
// 损益类卡片：目标为利润表的语义行 id 列表（多行则高亮多行，如费用 = 销售+管理+财务）
function markPlRow(id, rowIds) {
  var el = $(id);
  if (!el) return;
  rowIds = (rowIds || []).filter(Boolean);
  if (!rowIds.length) { clearAmtTarget(el); return; }
  el.classList.add('amt-link');
  el.removeAttribute('data-codes');
  el.setAttribute('data-pl-rows', rowIds.join(','));
  setAmtActivatable(el, true);
}
function bindAmtTargets() {
  markAmt('mFundBalance', FUND_CODES);          // 资金余额
  markAmt('mBank', ['1002']);                   // 银行存款
  markAmt('mCash', ['1001']);                   // 库存现金
  markAmt('mOtherCash', ['1012']);              // 其他货币资金
  markAmt('mFundNet', FUND_CODES);              // 资金净流量
  markAmt('mAvailFund', FUND_CODES);            // 现有资金
  markAmt('mAvailAr', SHORT_AR_CODES);          // 短期应收款
  markAmt('mAvailAp', SHORT_AP_CODES);          // 短期应付款
  markAmt('mReceivable', ['1122']);             // 应收账款
  markAmt('mPayable', ['2202']);                // 应付账款
  // 损益类卡片（收入/成本/费用/净利润）的目标不在此处注入：它们随账套与期间而变，
  // 由 fillMetrics 取到数后用 store.plSummary 返回的 ids 注入。
}
// 事件委托限定在首页内（#page-home .amt-link），避免其他页面将来出现同名类被误触发
function bindAmtJump() {
  if (globalThis.__homeAmtJumpBound) return;   // 只绑一次
  globalThis.__homeAmtJumpBound = true;
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('#page-home .amt-link');
    if (!a) return;
    e.preventDefault();
    // 从被点击元素往上找最近的卡片容器（.metric-slot[data-metric]），
    // 反推出该卡片当前使用的期间——三张流量卡期间独立，存量卡固定最新期末。
    var wrapper = a.closest('.metric-slot');
    var metric = wrapper ? wrapper.getAttribute('data-metric') : '';
    var p;
    switch (metric) {
      case 'netProfit':     p = resolvePeriod(periodProfit); break;
      case 'revenueCost':   p = resolvePeriod(periodRevCost); break;
      case 'fee':           p = resolvePeriod(periodFee); break;
      default: {
        // 存量卡片（fundBalance / arap / estimatedBalance）：固定「当前期」，与 fillMetrics 的 latestPeriod 同源
        // （防"卡片显示期 ≠ 点入内容期"错位）。【2026-10-05】对标金蝶，统一为 currentPeriod()（与顶栏当前账期一致）。
        var lp = currentPeriod();
        p = { end: lp, from: lp, to: lp, text: lp ? ymText(lp) : '--' };
      }
    }
    // ① 损益类 → 利润表并定位行。期间一律传区间末月 p.to：
    //    本期=当月、上期=上月、本年=当期、去年=去年12月 —— 与取数所用的 p.to 完全一致，
    //    保证「跳过去的期」就是「卡片数字的期」：整段期间（本年/去年）的累计数
    //    落在利润表「本年累计金额」列，与卡片 ytd 同源同值。
    var plRows = (a.getAttribute('data-pl-rows') || '').split(',').filter(Boolean);
    if (plRows.length) {
      // 只传 p.to（不再传 from~to）：利润表是单期口径，refreshPl 只按这一期渲染；
      // 传区间会让期间控件的 Start/End 出现两个不同的值，违反单期契约。
      if (globalThis.__plJumpToRow) globalThis.__plJumpToRow(plRows, p.to);
      return;
    }
    // ② 其余 → 总账明细（同样只传区间末月：总账是单期口径）
    var codes = (a.getAttribute('data-codes') || '').split(',').filter(Boolean);
    if (!codes.length) return;
    if (globalThis.__glJumpTo) globalThis.__glJumpTo(codes, p.to);
  });
}

/* ---------------- 流量卡片独立期间下拉（卡片右上角，每张独立） ---------------- */
// 三张流量卡片各有一个 select，各自维护独立的期间变量
function bindCardPeriodSelects() {
  var cfg = [
    { sel: 'selPeriodProfit',   setter: function(v){ periodProfit = v; } },
    { sel: 'selPeriodRevCost',  setter: function(v){ periodRevCost = v; } },
    { sel: 'selPeriodFee',      setter: function(v){ periodFee = v; } }
  ];
  cfg.forEach(function(c){
    var el = document.getElementById(c.sel);
    if (!el) return;
    el.innerHTML = PERIOD_MODES.map(function (m) {
      return '<option value="' + m.value + '">' + m.label + '</option>';
    }).join('');
  });
  if (globalThis.__cardPeriodsBound) return;
  globalThis.__cardPeriodsBound = true;
  cfg.forEach(function(c){
    var el = document.getElementById(c.sel);
    if (!el) return;
    el.addEventListener('change', function(){
      c.setter(el.value);
      refreshHome({ skipTip: true });
    });
  });
}
// 同步三个卡片 select 的选中态和文案（切账套重置后调）
function syncCardPeriodSelects() {
  var cfg = [
    { sel: 'selPeriodProfit',   val: periodProfit },
    { sel: 'selPeriodRevCost',  val: periodRevCost },
    { sel: 'selPeriodFee',      val: periodFee }
  ];
  cfg.forEach(function(c){
    var el = document.getElementById(c.sel);
    if (!el) return;
    el.value = c.val;
    var resolved = resolvePeriod(c.val).text;
    Array.prototype.forEach.call(el.options || [], function(o){
      o.textContent = (o.value === c.val) ? resolved : labelOfMode(o.value);
    });
  });
}
function labelOfMode(value) {
  for (var i = 0; i < PERIOD_MODES.length; i++) {
    if (PERIOD_MODES[i].value === value) return PERIOD_MODES[i].label;
  }
  return value;
}
// ============================================================
// 导出 / 挂载（供 js/main.js 与 js/app.js 委托调用）
// ============================================================
function setupHome() {
  bindArapTabs();
  bindCardPeriodSelects();
  bindAmtTargets();
  bindAmtJump();
  bindHomeTips();   // 三条首页提醒条的统一点（更新 / 云备份 / 记账员）
  // 【2026-10-06】图表 resize：窗口缩放时让首页 ECharts 实例跟随容器尺寸重绘（只绑一次）
  if (!globalThis.__homeChartResizeBound) {
    globalThis.__homeChartResizeBound = true;
    window.addEventListener('resize', function () {
      Object.keys(_homeChart).forEach(function (k) { if (_homeChart[k]) _homeChart[k].resize(); });
    });
  }
}
globalThis.__renderHome = refreshHome;
globalThis.__HOME__ = {
  refreshHome: refreshHome,
  setupHome: setupHome
};

export { refreshHome, setupHome };
