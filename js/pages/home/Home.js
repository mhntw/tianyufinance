// Home.js —— 首页工作台（资金余额/应收应付/预计可用资金/净利润/收入成本/费用）
// 本文件是从原始 app.js home 工作台块迁移而来，逻辑与 index.html DOM 一一对应。
// 依赖桥接层 globalThis.__TY_HELPERS__（由 js/app.js 在启动时挂载）。
// 设计原则：不依赖账套 cls 字段，避免导出标错导致数据失真。

const H = globalThis.__TY_HELPERS__ || {};
const $ = H.$;
const S = H.S || window.S;
const money = H.money;
const fmt = H.fmt;
const signed = H.signed;
const round2 = H.round2;
const esc = H.esc;
const currentPeriod = H.currentPeriod;
const U = H.U || (typeof EX !== 'undefined' && EX.util) || { num: function (x) { return Number(x) || 0; } };

function setEl(id, val) { const el = $(id); if (el) el.textContent = val; }

// ============================================================
// 首页主刷新入口
// ============================================================
function refreshHome() {
  var month = currentPeriod();

  // 财务指标数据（默认使用最新期间）
  fillMetrics(month);
  // 云备份提醒（本地判定，≥7 天未备份且期间有改动才显示，可忽略）
  checkBackupTip();
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

/** 填充财务指标卡片数据 */
function fillMetrics(month) {
  // 余额类口径统一走 subjectBalance（基于 generalLedger，子科目聚合，不依赖 cls）
  function balOf(code) { return subjectBalance(code, month); }

  // 资金余额 = 库存现金(1001)+银行存款(1002)+其他货币资金(1012)
  var totalFund = balOf('1001') + balOf('1002') + balOf('1012');
  setEl('mFundBalance', fmt(totalFund));
  setEl('mBank', fmt(balOf('1002')));
  setEl('mCash', fmt(balOf('1001')));
  setEl('mOtherCash', fmt(balOf('1012')));

  // 近一期损益（净利润/收入/支出）：用 buildProfitSeries 当期口径，不能用余额（结转后归零）
  var lastProfit = buildProfitSeries([month])[0] || { revenue: 0, cost: 0, expense: 0, netProfit: 0 };
  setEl('mFundNet', signed(lastProfit.netProfit));

  // 应收 / 应付
  renderArapItems(month, '1122', 'arapItemsAr', 'mReceivable', '应收');
  renderArapItems(month, '2202', 'arapItemsAp', 'mPayable', '应付');

  // 预计可用资金 = 现有资金 + 短期应收 - 短期应付
  var avail = totalFund + balOf('1122') - balOf('2202');
  setEl('mAvailCash', fmt(avail));
  setEl('mAvailFund', fmt(totalFund));
  setEl('mAvailAr', fmt(balOf('1122')));
  setEl('mAvailAp', fmt(balOf('2202')));

  // 净利润 / 净利润率（本年累计：1月 → 当前期，利润表口径）
  var y = +month.slice(0, 4);
  var curMo = +month.slice(5, 7);
  var yearMonths = [];
  for (var mi = 1; mi <= curMo; mi++) yearMonths.push(y + '-' + (mi < 10 ? '0' + mi : '' + mi));
  var yearSeries = buildProfitSeries(yearMonths);
  var revY = 0, costY = 0, expY = 0, netY = 0;
  yearSeries.forEach(function (d) { revY += d.revenue; costY += d.cost; expY += d.expense; netY += d.netProfit; });

  var profitRate = revY ? (netY / revY * 100) : 0;
  setEl('mNetProfit', fmt(netY));
  setEl('mProfitRate', profitRate.toFixed(1) + '%');

  // 收入成本（本年累计）
  var grossMargin = revY ? (1 - costY / revY) * 100 : 0;
  setEl('bIncome', fmt(revY));
  setEl('bCost', fmt(costY));
  setEl('bGrossMargin', '：' + grossMargin.toFixed(1) + '%');

  // 费用（本年累计）
  setEl('bExpense', fmt(expY));
  setEl('feeToIncome', revY ? (expY / revY * 100).toFixed(1) + '%' : '--%');
}

// 利润表口径聚合：给定月份区间，返回每期的 收入/成本/费用/净利润
// 稳健归类：不依赖数据源 cls 字段（导出常标错），改用科目编码前缀规则
// （同时覆盖小企业准则 5xxx/56xx 与一般准则 6xxx）。排除"结转损益"分录。
function buildProfitSeries(months) {
  var subjects = S.subjects();
  return months.map(function (m) {
    var vs = S.periodVouchers(m);
    var agg = {}; // code -> {dr, cr}
    vs.forEach(function (v) {
      (v.entries || []).forEach(function (e) {
        if (/结转.{0,4}损益/.test(e.summary || '')) return;
        var c = e.code;
        if (!agg[c]) agg[c] = { dr: 0, cr: 0 };
        agg[c].dr += U.num(e.dr); agg[c].cr += U.num(e.cr);
      });
    });
    var revenue = 0, cost = 0, expense = 0;
    var REV = /^5(001|051|111|301)|^6(001|051|111|301)/;        // 主营/其他业务收入、投资收益、营业外收入
    var COST = /^5(401|402|403)|^6(401|402|403)/;               // 主营/其他业务成本、税金及附加
    var FEE = /^56(01|02|03)|^66(01|02|03)/;                    // 销售/管理/财务费用
    var EXP_OTHER = /^5711|^6801/;                              // 营业外支出（并入费用口径）
    subjects.forEach(function (s) {
      var a = agg[s.code] || { dr: 0, cr: 0 };
      if (REV.test(s.code)) {
        revenue += (a.cr - a.dr);
      } else if (COST.test(s.code)) {
        cost += a.dr;                                          // 成本类取借方发生额
      } else if (FEE.test(s.code) || EXP_OTHER.test(s.code)) {
        expense += (a.dr - a.cr);
      }
    });
    var netProfit = revenue - cost - expense;
    return {
      month: m,
      revenue: round2(revenue),
      cost: round2(cost),
      expense: round2(expense),
      netProfit: round2(netProfit),
      rate: round2(revenue ? netProfit / revenue * 100 : 0)
    };
  });
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
  // 同名往来单位合并（导入/建账重名时，金额累加，避免同一单位在明细里出现两次）
  var merged = {};
  children.forEach(function (x) {
    var nm = (x.s.name && String(x.s.name).trim()) || x.s.code;
    if (!merged[nm]) merged[nm] = { name: nm, v: 0 };
    merged[nm].v += x.v;
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
    html += '<div class="arap-item"><span class="ai-name">' + x.name +
            '</span><span class="ai-val">' + sign + fmt(Math.abs(x.v)) + tag + '</span></div>';
  });
  box.innerHTML = html;
  var total = subjectBalance(ar, month);
  // 余额方向与正常相反时标注性质（应收余额在贷=预收；应付余额在借=预付）
  var nature = total < 0 ? (label === '应收' ? '预收' : '预付') : label;
  setEl(totalId, (nature !== label ? nature + ' ' : '') + fmt(Math.abs(total)));
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

// ============================================================
// 导出 / 挂载（供 js/main.js 与 js/app.js 委托调用）
// ============================================================
function setupHome() {
  bindArapTabs();
  bindBackupTip();
}
function resizeAllCharts() { /* 已无图表，保留空壳以满足 app.js 调用约定 */ }

globalThis.__renderHome = refreshHome;
globalThis.resizeAllCharts = resizeAllCharts;
globalThis.__HOME__ = {
  refreshHome: refreshHome,
  resizeAllCharts: resizeAllCharts,
  setupHome: setupHome
};

export { refreshHome, resizeAllCharts, setupHome };
