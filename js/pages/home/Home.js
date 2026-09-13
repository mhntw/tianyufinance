// Home.js —— 首页工作台（资金余额/应收应付/预计可用资金/净利润/收入成本/费用）
// 本文件是从原始 app.js home 工作台块迁移而来，逻辑与 index.html DOM 一一对应。
// 依赖桥接层 globalThis.__TY_HELPERS__（由 js/app.js 在启动时挂载）。
// 设计原则：不依赖账套 cls 字段，避免导出标错导致数据失真。

const H = globalThis.__TY_HELPERS__ || {};
const $ = H.$;
const S = H.S || window.S;
const fmt = H.fmt;
const signed = H.signed;
const round2 = H.round2;
// 科目名称来自导入账套，可能含 < & " 等字符，拼进 innerHTML 前必须转义
const esc = H.esc || function (s) { return String(s == null ? '' : s); };
const currentPeriod = H.currentPeriod;
const U = H.U || (typeof EX !== 'undefined' && EX.util) || { num: function (x) { return Number(x) || 0; } };

function setEl(id, val) { const el = $(id); if (el) el.textContent = val; }

/* ---------------- 首页指标口径常量（对齐金蝶） ----------------
 * 资金类：库存现金 + 银行存款 + 其他货币资金
 * 短期应收：应收票据 + 应收账款 + 其他应收款（不含预付账款——钱已付，不会再有现金流入）
 * 短期应付：应付票据 + 应付账款 + 其他应付款（不含预收账款——钱已收，不会再有现金流出）
 */
var FUND_CODES = ['1001', '1002', '1012'];
// 短期应收/应付科目清单：对齐金蝶（jinbooks 是金蝶口径的开源复刻，默认配置
// sys.default.shortTermAccountsReceivable / shortTermAccountsPayable）。
// 判据是「未来会带来现金流入/流出的短期债权债务」：
//   应收 = 1121 应收票据 + 1122 应收账款 + 1131 应收股利 + 1132 应收利息 + 1221 其他应收款
//   应付 = 2201 应付票据 + 2202 应付账款 + 2211 应付职工薪酬 + 2231 应付利息
//        + 2232 应付股利 + 2241 其他应付款
// 刻意排除 1123 预付账款（钱已付，不会再有流出/流入）与 2203 预收账款（钱已收），
// 与从真实账套反推金蝶数值的结论一致。
// 已知偏差：金蝶/jinbooks 均未纳入 2221 应交税费（理论上属刚性短期支付义务），
// 为与金蝶对账一致此处跟随；若将来要做更专业的口径，可视为可选项开启。
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

function prevMonth(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  m--; if (m < 1) { m = 12; y--; }
  return y + '-' + (m < 10 ? '0' + m : '' + m);
}
// 期间区间 [from, to] 展开为月份数组（含首尾）。
// 统一走 store 的 monthList（此前此处内联展开了一份，与 store/_shared/Voucher 三处重复）。
function monthsOf(p) {
  return U.monthList(p.from, p.to);
}
// 期间文案：与金蝶一致——月粒度显示「2026年08期」，年粒度显示「2026年」
function ymText(ym) { return ym.slice(0, 4) + '年' + ym.slice(5, 7) + '期'; }
function yearText(ym) { return ym.slice(0, 4) + '年'; }
function resolvePeriod(mode) {
  var cur = currentPeriod();
  var y = cur.slice(0, 4);
  var prev = prevMonth(cur);
  var lastY = String(+y - 1);
  switch (mode) {
    case 'lastPeriod':  return { end: prev, from: prev, to: prev, text: ymText(prev) };
    case 'currentYear': return { end: cur, from: y + '-01', to: cur, text: yearText(cur) };
    // 存量指标取去年末时点；流量指标取去年 1~12 月整年累计（与金蝶 year 口径一致）
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
}

/* ---------------- 首页「云备份」提醒（被动一条，两级静默） ---------------- */
// 静默力度按「用户做了什么」区分，避免"点了去配置但没配成"反而安静 7 天：
// × 忽略        → 7 天（用户明确不想看）
// 去配置/去备份 → 到明天 0 点（响应了但没办成，第二天再来；办成了后端状态自会变，横幅自动消失）
var TIP_MUTE_MS = 7 * 24 * 60 * 60 * 1000;
var TIP_MUTE_KEY = 'hbTipMute';

function msUntilTomorrow() {
  var d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime() - Date.now();
}
// hbTipMute 存「静默截止时间戳」；过期或解析失败一律视为不静默（宁可多提醒，不可漏提醒）
function tipMuted() {
  try {
    var v = localStorage.getItem(TIP_MUTE_KEY);
    if (!v) return false;
    var t = Number(v);
    if (!isFinite(t) || t <= 0) {
      // 兼容旧值：时间戳字符串或 toDateString()，均为过去时刻 → 自然到期，不静默
      t = Date.parse(v);
      if (!isFinite(t)) return false;
    }
    return Date.now() < t;
  } catch (e) { return false; }
}
function muteTip(ms) {
  try { localStorage.setItem(TIP_MUTE_KEY, String(Date.now() + (ms || 0))); } catch (e) {}
}

function checkBackupTip() {
  var tip = $('homeBackupTip');
  if (!tip || typeof window.Storage === 'undefined' || !window.Storage.syncPending) return;
  window.Storage.syncPending().then(function (r) {
    if (!r) { tip.style.display = 'none'; return; }
    // 处于静默期（× 7 天 / 点过按钮到明天）→ 不打扰
    if (tipMuted()) { tip.style.display = 'none'; return; }
    var txt = $('homeBackupTipTxt');
    var go = $('btnBackupTipGo');
    if (r.unconfigured) {
      tip.dataset.go = 'config';
      if (txt) txt.textContent = '尚未配置云备份，建议配置云备份。';
      if (go) go.textContent = '去配置';
    } else if (r.neverPushed) {
      // 已配置但一次都没备份：自动备份要以「上次备份时间」为基准，不备份一次永远不会启动
      tip.dataset.go = 'push';
      if (txt) txt.textContent = '云备份已配置，但尚未备份过，建议立即备份一次。';
      if (go) go.textContent = '去备份';
    } else if (r.pending) {
      tip.dataset.go = 'push';
      if (txt) txt.textContent = '距离上次云备份已经超过 7 天，建议做一次云备份。';
      if (go) go.textContent = '去备份';
    } else {
      tip.style.display = 'none';
      return;
    }
    tip.style.display = '';
  }).catch(function () { tip.style.display = 'none'; });
}
function bindBackupTip() {
  var go = $('btnBackupTipGo'), close = $('btnBackupTipClose');
  if (go) go.addEventListener('click', function () {
    var tipEl = $('homeBackupTip');
    var isCfg = tipEl && tipEl.dataset.go === 'config';
    if (globalThis.goPage) globalThis.goPage('system-settings');
    // 跳过去后滚动到「云同步」卡；未配置 → 高亮「配置」并直接弹出配置，否则高亮「云备份」
    setTimeout(function () {
      var card = document.getElementById('cardCloudSync');
      if (card) card.scrollIntoView({ block: 'center' });
      var b = document.getElementById(isCfg ? 'btnCsConfig' : 'btnCsPush');
      if (b) { b.classList.add('btn-hl'); setTimeout(function () { b.classList.remove('btn-hl'); }, 1600); }
      if (isCfg && globalThis.__CS_OPEN_CONFIG__) globalThis.__CS_OPEN_CONFIG__();
    }, 150);
    // 只静默到明天：没配成 / 没备份成，第二天继续提醒
    muteTip(msUntilTomorrow());
  });
  if (close) close.addEventListener('click', function () {
    var tip = $('homeBackupTip');
    if (tip) tip.style.display = 'none';
    muteTip(TIP_MUTE_MS);
  });
}

/** 填充财务指标卡片数据：存量卡固定最新期末，三张流量卡各自独立期间 */
function fillMetrics() {
  // 最新期间：存量指标（资金余额/应收应付/预计可用资金）固定显示最新期末
  var latestPeriod = (S.state.company && S.state.company.currentPeriod) || currentPeriod();
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
  // fmt() 内部是 money(Math.abs(n))，会把「贷方余额/亏损/净流出」显示成正数，与金蝶不一致。

  // ---- 资金余额卡（存量：最新期末余额）----
  var totalFund = sumBalAt(FUND_CODES);
  setEl('mFundBalance', signed(totalFund));
  setEl('mBank', signed(balOfAt('1002')));
  setEl('mCash', signed(balOfAt('1001')));
  setEl('mOtherCash', signed(balOfAt('1012')));
  setEl('periodFund', periodText);

  // 资金净收入 = 所选期间「资金收入 − 资金支出」（流量：区间累计）
  // 金蝶口径：取数来自科目余额模块（综合本位币）→ 资金类科目借方发生额(流入) − 贷方发生额(流出)。
  // 注意：这是「资金的收付差」，不是损益口径的净利润（旧实现误用当期净利润，与金蝶对不上）。
  // 归属「净利润」卡片的期间选择（与净利润同属利润/现金流维度）
  var fundDr = 0, fundCr = 0;
  monthsOf(pProfit).forEach(function (m) {
    FUND_CODES.forEach(function (c) {
      var a = (S.subjectPeriodAmount ? S.subjectPeriodAmount(c, m) : null) || { dr: 0, cr: 0 };
      fundDr += a.dr; fundCr += a.cr;
    });
  });
  setEl('mFundNet', signed(round2(fundDr - fundCr)));

  // ---- 应收 / 应付（存量：最新期末余额）----
  renderArapItems(latestPeriod, '1122', 'arapItemsAr', 'mReceivable', '应收');
  renderArapItems(latestPeriod, '2202', 'arapItemsAp', 'mPayable', '应付');
  setEl('periodArap', periodText);

  // ---- 预计可用资金（存量：最新期末余额）= 现有资金 + 短期应收款 − 短期应付款（金蝶口径）----
  // 现有资金与资金余额卡同口径，直接复用 totalFund，不重复计算。
  // 余额方向：资产类(应收)借正贷负 → 正常为正；负债类(应付)正常是贷方余额，取反后为正显示。
  var shortAr = sumBalAt(SHORT_AR_CODES);
  var shortAp = -sumBalAt(SHORT_AP_CODES);
  setEl('mAvailCash', signed(round2(totalFund + shortAr - shortAp)));
  setEl('mAvailFund', signed(totalFund));
  setEl('mAvailAr', signed(shortAr));
  setEl('mAvailAp', signed(shortAp));
  setEl('periodAvail', periodText);

  // ---- 损益（流量：区间累计）----
  // 与「报表 → 利润表」同源：一律走 store.plSummary（内部即利润表的行计算）。
  // 三张卡片各自独立期间，分别计算：
  //   净利润卡 → periodProfit（净利润 + 资金净收入）
  //   收入成本卡 → periodRevCost（收入 + 成本 + 毛利率）
  //   费用卡 → periodFee（费用 + 费用占收入比）
  // 期间映射（等价金蝶 periodType）：
  //   本期 / 上期（单月）→ 取 cur，本月金额
  //   本年 / 去年（整段）→ 取 ytd，年初至末月累计
  var plIsYearProfit = (periodProfit === 'currentYear' || periodProfit === 'lastYear');
  var plKeyProfit = plIsYearProfit ? 'ytd' : 'cur';
  var plProfit = S.plSummary(pProfit.to);
  setEl('mNetProfit', signed(round2(plProfit.netProfit[plKeyProfit])));
  setEl('mProfitRate', (plProfit.revenue[plKeyProfit] ? (plProfit.netProfit[plKeyProfit] / plProfit.revenue[plKeyProfit] * 100) : 0).toFixed(1) + '%');
  markPlRow('mNetProfit', plProfit.netProfit.ids);
  hintPlMissing(plProfit.netProfit, 'mNetProfit', '净利润');

  var plIsYearRC = (periodRevCost === 'currentYear' || periodRevCost === 'lastYear');
  var plKeyRC = plIsYearRC ? 'ytd' : 'cur';
  var plRC = S.plSummary(pRevCost.to);
  setEl('bIncome', signed(round2(plRC.revenue[plKeyRC])));
  setEl('bCost', signed(round2(plRC.cost[plKeyRC])));
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
  setEl('bExpense', signed(feeAmt));
  setEl('feeToIncome', revForFee ? (feeAmt / revForFee * 100).toFixed(1) + '%' : '--%');
  hintPlMissing(plFee.expense, 'bExpense', '期间费用（销售+管理+财务）');
  // 费用公式行：把 plFee.expense.formula 渲染成
  // "销售费用 ¥12万 + 管理费用 ¥8万 + 财务费用 ¥2万" 的可点链接
  // 用户改利润表规则（增删费用行）时自动跟随，老账套无 periodExpenseTotal 时 fallback 也有
  var formulaEl = $('feeFormula');
  if (formulaEl && plFee.expense.formula && plFee.expense.formula.length) {
    // 两行布局：标签在上、金额在下，加号对齐
    // 销售费用 + 管理费用 + 财务费用
    // ¥8.00    +     ¥12.00   +  ¥2.00
    var items = plFee.expense.formula.map(function (f) {
      var val = round2(plIsYearFee ? f.ytd : f.cur);
      var amtHtml = (val < 0 ? '−' : '') + fmt(Math.abs(val));
      var cls = f.ids && f.ids.length ? 'formula-cell amt-link' : 'formula-cell';
      var attrs = f.ids && f.ids.length ? ' data-pl-rows="' + f.ids.join(',') + '"' : '';
      return '<div class="' + cls + '"' + attrs + '>'
           + '<div class="formula-label">' + esc(f.label) + '</div>'
           + '<div class="formula-amt">' + amtHtml + '</div>'
           + '</div>';
    });
    var seps = [];
    for (var si = 0; si < items.length - 1; si++) seps.push('<div class="formula-sep">+</div>');
    // 组合：cell sep cell sep cell ...
    var combo = '';
    for (var ci = 0; ci < items.length; ci++) {
      combo += items[ci];
      if (ci < seps.length) combo += seps[ci];
    }
    formulaEl.innerHTML = combo;
  } else if (formulaEl) {
    formulaEl.innerHTML = '';
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

// 判断 sub 是否为 parent 的下级：带点编码(1122.03)或无点编码(1122003，长度差≥2)均兼容
function isChildOf(parent, sub) {
  if (sub.length <= parent.length) return false;
  if (sub.indexOf(parent + '.') === 0) return true;          // 带点层级
  if (parent.indexOf('.') < 0 && sub.indexOf('.') < 0) {     // 双方均无点（风格）
    return sub.indexOf(parent) === 0 && (sub.length - parent.length) >= 2;
  }
  return false;
}

// 科目期末余额：一律走 store.subjectEndBalance（唯一实现）。
// 说明：generalLedger 每行余额已含全部下级，页面若自行「父级 + 子级」聚合会成倍虚增
// （本项目已因此翻车 4 次），故此处不再维护第二份聚合逻辑。
function subjectBalance(code, month) {
  return S.subjectEndBalance ? S.subjectEndBalance(code, month) : 0;
}

// 应收应付卡片：顶部合计 + 末级往来单位明细
// ar：一级科目码(1122/2202)；itemsBox：明细容器 id；totalId：合计元素 id
function renderArapItems(month, ar, itemsBox, totalId, label) {
  var box = document.getElementById(itemsBox);
  if (!box) return;
  // 取该一级科目下的「末级」往来单位（排除有下级子目的父科目，避免父子重名都列出）。
  // 兼容无点编码：凡 code 以 ar 开头且更长、且不被其他科目 code 前缀包含者，即为末级。
  var subs = (S.subjects() || []);
  var children = subs.filter(function (s) {
    if (!isChildOf(ar, s.code)) return false;   // 仅取 ar 的「直接/间接」下级
    var isParent = subs.some(function (o) {
      return o.code !== s.code && isChildOf(s.code, o.code);
    });
    return !isParent;                            // 排除有下级的父科目
  }).map(function (s) {
    return { s: s, v: subjectBalance(s.code, month) };
  }).filter(function (x) { return x.v; });
  // 同名往来单位合并（导入/建账重名时，金额累加，避免同一单位在明细里出现两次）；
  // 同时收集合并到的末级科目编码，供「点明细行跳总账看该单位流水」使用。
  var merged = {};
  children.forEach(function (x) {
    var nm = (x.s.name && String(x.s.name).trim()) || x.s.code;
    if (!merged[nm]) merged[nm] = { name: nm, v: 0, codes: [] };
    merged[nm].v += x.v;
    merged[nm].codes.push(String(x.s.code));
  });
  var list = Object.keys(merged).map(function (k) { return merged[k]; })
    .filter(function (x) { return x.v; })
    .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
  var html = '';
  list.forEach(function (x) {
    // 余额在贷方（应收）或借方（应付）反向时，金额前置负号以提示性质
    var sign = (label === '应收' && x.v < 0) || (label === '应付' && x.v > 0) ? '-' : '';
    var tag = (label === '应收' && x.v < 0) ? ' 预收'
            : (label === '应付' && x.v > 0) ? ' 预付' : '';
    html += '<div class="arap-item"><span class="ai-name">' + esc(x.name) +
            '</span><span class="ai-val amt-link" data-codes="' + esc(x.codes.join(',')) + '">' +
            sign + fmt(Math.abs(x.v)) + tag + '</span></div>';
  });
  box.innerHTML = html;
  var total = subjectBalance(ar, month);
  // 余额方向与正常方向相反时标注性质（subjectBalance 为借正贷负）：
  //   应收（资产，正常在借）→ 出现贷方余额(total<0) 才是「预收」
  //   应付（负债，正常在贷）→ 出现借方余额(total>0) 才是「预付」
  // 旧实现两种科目都判 total<0，对应付正好判反：正常的应付余额(贷方=负)被标成「预付」，
  // 于是卡片上出现「应付账款 → 预付 162,591.72」这种自相矛盾的显示。
  // （同函数内明细行的判法本就正确，见上方 tag 计算，仅合计行有误。）
  var reversed = (label === '应收') ? (total < 0) : (total > 0);
  var nature = reversed ? (label === '应收' ? '预收' : '预付') : label;
  setEl(totalId, (reversed ? nature + ' ' : '') + fmt(Math.abs(total)));
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
function clearAmtTarget(el) {
  el.classList.remove('amt-link');
  el.removeAttribute('data-codes');
  el.removeAttribute('data-pl-rows');
}
function markAmt(id, codes) {
  var el = $(id);
  if (!el) return;
  codes = (codes || []).filter(Boolean);
  if (!codes.length) { clearAmtTarget(el); return; }
  el.classList.add('amt-link');
  el.removeAttribute('data-pl-rows');
  el.setAttribute('data-codes', codes.join(','));
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
}
function bindAmtTargets() {
  markAmt('mFundBalance', FUND_CODES);          // 资金余额
  markAmt('mBank', ['1002']);                   // 银行存款
  markAmt('mCash', ['1001']);                   // 库存现金
  markAmt('mOtherCash', ['1012']);              // 其他货币资金
  markAmt('mFundNet', FUND_CODES);              // 资金净收入
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
    // 从被点击元素往上找最近的卡片容器（.grid-square-wrapper[data-metric]），
    // 反推出该卡片当前使用的期间——三张流量卡期间独立，存量卡固定最新期末。
    var wrapper = a.closest('.grid-square-wrapper');
    var metric = wrapper ? wrapper.getAttribute('data-metric') : '';
    var p;
    switch (metric) {
      case 'netProfit':     p = resolvePeriod(periodProfit); break;
      case 'revenueCost':   p = resolvePeriod(periodRevCost); break;
      case 'fee':           p = resolvePeriod(periodFee); break;
      default: {
        // 存量卡片（fundBalance / arap / estimatedBalance）：固定最新期末
        var lp = (S.state.company && S.state.company.currentPeriod) || currentPeriod();
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
  bindBackupTip();
}
globalThis.__renderHome = refreshHome;
globalThis.__HOME__ = {
  refreshHome: refreshHome,
  setupHome: setupHome
};

export { refreshHome, setupHome };
