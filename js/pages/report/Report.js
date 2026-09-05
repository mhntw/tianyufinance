// 报表域模块（B 方案解耦）
// 包含：资产负债表(refreshBs) / 利润表(refreshPl) / 现金流量表(refreshCf) / 应交税费明细表(refreshTx)
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
//
// 设计要点：
// - globalThis.__KINGDEE_HELPERS__ 由 app.js 注册（$, money, moneyRed, currentPeriod, fillPeriodSelect, S, U ...）
// - globalThis.__KINGDEE_EXPORT__ 由 store.js 注册（store, util ...）
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

const H = globalThis.__KINGDEE_HELPERS__ || {};
const EX = globalThis.__KINGDEE_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const moneyRed = H.moneyRed || function (n) {
  var s = money(Math.abs(n));
  return n < 0 ? '<span class="kd-red">' + s + '</span>' : s;
};
const currentPeriod = H.currentPeriod;
const lastClosedPeriod = H.lastClosedPeriod;
const safeFillPeriod = H.safeFillPeriod;
const S = H.S || (EX && EX.store);
// 起止期间取值：统一走 app.js 的单点实现（H.periodRangeValue）。
// 此前本文件存有一份逐字相同的拷贝，改一处漏五处，故收敛为引用。
// 口径：回填默认期间 + 同步触发器文本，返回结束期间。
const periodRangeValue = H.periodRangeValue;

// 统一收口报表表头表名行：单格（名称居中 + 账期小号居名称下方），挂全局多模块共用。
// rowId: 表名行 <tr id> ；title: 表名；cols: 整表列数
// 账期二选一：periodText 已是格式化文本（区间/任意）优先；否则由 month("YYYY-MM") 推导 "YYYY年MM月"
globalThis.setRptHead = function (rowId, title, cols, month, periodText) {
  var el = rowId && document.getElementById(rowId);
  if (!el) return;
  var period = periodText != null && periodText !== ''
    ? periodText
    : (month ? (month.slice(0, 4) + '年' + month.slice(5) + '期') : '');
  el.innerHTML = '<th colspan="' + (cols > 1 ? cols : 1) + '">'
    + '<div class="rpt-title">' + title + '</div>'
    + (period ? '<div class="rpt-period">' + period + '</div>' : '')
    + '</th>';
  // 打印专用抬头（表名 + 编制单位/报表日期/单位：元）。屏幕态隐藏，仅打印时显示。
  // 抬头块挂在表格容器的表格之前，由本函数统一注入，覆盖所有走 setRptHead 的报表/账簿。
  // 内容一律取自 app.js 的唯一来源 H.rptHeadPartsHtml（与 stdRptHeadHtml 同源，禁止在此另拼格式）。
  var tbl = el.closest('table');
  var box = tbl && tbl.parentNode;
  if (!box) return;
  var head = box.querySelector(':scope > .rpt-print-head');
  if (!head) {
    head = document.createElement('div');
    head.className = 'rpt-print-head';
    box.insertBefore(head, tbl);
  }
  var comp = (typeof S !== 'undefined' && S.state && S.state.company && S.state.company.name) ? S.state.company.name : '';
  var parts = H.rptHeadPartsHtml ? H.rptHeadPartsHtml(title, comp, period)
    : '<div class="rph-title">' + title + '</div>'; // 兜底（仅在桥接缺失的迁移期出现）
  head.innerHTML = parts;
};

// 金蝶报表行尾「编辑公式」悬浮入口（严谨：仅展示，点击提示公式管理在设置）
// 金额单元格：跟金蝶原版，金额列用普通无衬线字体（与正文同字体），右对齐，不做等宽
function amtCell(v, extra) {
  var cls = 'ta-r' + (extra ? ' ' + extra : '');
  return '<td class="' + cls + '">' + moneyRed(v) + '</td>';
}

/* ===================== 资产负债表 ===================== */
function refreshBs() {
  var sInp = $('bsPeriodStart'), eInp = $('bsPeriodEnd');
  var def = lastClosedPeriod();
  if (sInp && eInp) {
    sInp.value = sInp.value || def;
    eInp.value = eInp.value || def;
    if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__('bsPeriodStart', 'bsPeriodEnd');
  }
  // 口径保持单期间（用结束期间），仅 UI 对齐金蝶 range picker
  renderBs(eInp ? eInp.value : def);
}
function renderBs(month) {
  setRptHead("bsTitleRow", "资产负债表", 8, month);
  var tb = $('bsBody'); tb.innerHTML = '';
  if (!month) return;
  var bs = S.balanceSheet(month);
  var G = bs.groups;
  // 构建左侧（资产）行：流动标题+项目+流动小计 + 非流动标题+项目+非流动小计
  var aRows = [];
  function pushGroup(g) {
    aRows.push({ grp: g.title, end: g.subEnd, year: g.subYear });
    g.items.forEach(function (it) {
      aRows.push({ label: it.label, end: it.end, year: it.year });
    });
  }
  pushGroup(G.assetCurrent);
  pushGroup(G.assetNonCurrent);
  // 构建右侧（负债+所有者权益）行：流动标题+项目+流动小计 + 非流动标题+项目+非流动小计 + 负债合计 + 权益标题+项目+权益小计
  var lRows = [];
  function pushLiaGroup(g) {
    lRows.push({ grp: g.title, end: g.subEnd, year: g.subYear });
    g.items.forEach(function (it) {
      lRows.push({ label: it.label, end: it.end, year: it.year });
    });
  }
  pushLiaGroup(G.liaCurrent);
  pushLiaGroup(G.liaNonCurrent);
  lRows.push({ grp: '负债合计', end: bs.totalLiability, year: G.liaCurrent.subYear + G.liaNonCurrent.subYear });
  pushLiaGroup(G.equity);
  lRows.push({ grp: '所有者权益合计', end: bs.totalEquity, year: G.equity.subYear });
  var max = Math.max(aRows.length, lRows.length);
  // 行次（资产负债表：资产侧 1..N、负债及所有者权益侧 N+1.. 整体连续编号）
  var noA = 0, noL = aRows.length;
  for (var i = 0; i < max; i++) {
    var a = aRows[i], l = lRows[i];
    var tr = document.createElement('tr');
    if (a && a.grp !== undefined) {
      noA += 1;
      tr.innerHTML = '<td class="grp-label">' + a.grp + '</td><td class="ta-c">' + noA + '</td>' + amtCell(a.end, 'grp-amt') + amtCell(a.year, 'grp-amt');
    } else if (a) {
      noA += 1;
      tr.innerHTML = '<td class="bs-name">' + a.label + '</td><td class="ta-c">' + noA + '</td>' + amtCell(a.end) + amtCell(a.year);
    } else {
      tr.innerHTML = '<td></td><td></td><td></td><td></td>';
    }
    if (l && l.grp !== undefined) {
      noL += 1;
      tr.innerHTML += '<td class="grp-label">' + l.grp + '</td><td class="ta-c">' + noL + '</td>' + amtCell(l.end, 'grp-amt') + amtCell(l.year, 'grp-amt');
    } else if (l) {
      noL += 1;
      tr.innerHTML += '<td class="bs-name">' + l.label + '</td><td class="ta-c">' + noL + '</td>' + amtCell(l.end) + amtCell(l.year);
    } else {
      tr.innerHTML += '<td></td><td></td><td></td><td></td>';
    }
    tb.appendChild(tr);
  }
  var totals = document.createElement('tr');
  totals.className = 'grp-row';
  totals.innerHTML = '<td>资产总计</td><td class="ta-c">' + (noA + 1) + '</td>' + amtCell(bs.totalAsset) + '<td></td>' +
                     '<td>负债和所有者权益总计</td><td class="ta-c">' + (noL + 1) + '</td>' + amtCell(bs.totalAll) + '<td></td>';
  tb.appendChild(totals);

  // 恒等式差额提示：资产 ≠ 负债+权益 时说明原因（数据如实呈现，不掩盖）
  var diff = bs.totalAsset - bs.totalAll;
  var wip = $('bsWip');
  if (Math.abs(diff) >= 0.005) {
    var absv = Math.abs(diff);
    // 数据驱动诊断：差额是否≈「利润表净利润 − 已转入本年利润的净额」
    // （即金蝶账套结转损益未完整执行，损益科目尚有余额残留）。
    var period = currentPeriod();
    var pl = S.profitStatement(period);
    var glRow = (S.generalLedger(period) || []).filter(function (x) { return x.code === '3103'; })[0];
    var carried = 0;
    if (glRow) carried = (glRow.normal === 'cr' ? glRow.endCr - glRow.endDr : glRow.endDr - glRow.endCr);
    var net = pl ? pl.netProfit : 0;
    var residual = Math.abs((net - carried) - diff) < 1; // 差额≈未结转损益净额？
    var txt = '资产负债表恒等式暂不平衡：资产比负债及所有者权益' +
              (diff > 0 ? '多 ' : '少 ') + '¥' + absv.toFixed(2) + '。';
    if (residual) {
      txt += '经核对，差额与本期利润表净利润（¥' + net.toFixed(2) +
             '）减去已转入「本年利润(3103)」的净额（¥' + carried.toFixed(2) +
             '）基本相等，说明金蝶源账套「结转本期损益」未完整执行——损益科目仍有余额未结转至本年利润，' +
             '这部分金额同时被计入资产侧与利润表，导致等式表面不平衡。完成结转损益后此处将自动平衡。';
    } else {
      txt += '差额不能直接由未结转损益解释，可能源于账套期初录入不平或科目属性标注问题，' +
             '需回到金蝶规范后重新导出账套（.ais）刷新本软件数据。';
    }
    txt += '本软件如实呈现账套原貌，不做任何掩盖或伪造结转。';
    wip.textContent = txt;
    wip.style.display = 'block';
  } else {
    wip.style.display = 'none';
  }
}

// 资产负债表导出：与 renderBs 同源取数（S.balanceSheet），构造对照式 Excel（资产|行次|期末|年初 | 负债权益|行次|期末|年初）
function exportBs() {
  const eInp = $('bsPeriodEnd');
  const month = eInp ? eInp.value : currentPeriod();
  if (!month) return H.showToast('请先选择期间', 'warn');
  const bs = S.balanceSheet(month);
  const G = bs.groups;
  // 构建左右两列数据（与 renderBs 完全一致）
  function collect(g) {
    const out = [{ grp: g.title, end: g.subEnd, year: g.subYear }];
    g.items.forEach(function (it) { out.push({ label: it.label, end: it.end, year: it.year }); });
    return out;
  }
  const aRows = collect(G.assetCurrent).concat(collect(G.assetNonCurrent));
  let lRows = collect(G.liaCurrent).concat(collect(G.liaNonCurrent));
  lRows = lRows.concat([{ grp: '负债合计', end: bs.totalLiability, year: G.liaCurrent.subYear + G.liaNonCurrent.subYear }]);
  lRows = lRows.concat(collect(G.equity));
  lRows = lRows.concat([{ grp: '所有者权益合计', end: bs.totalEquity, year: G.equity.subYear }]);
  const max = Math.max(aRows.length, lRows.length);
  let noA = 0, noL = aRows.length;
  const rows = [];
  // 表头
  rows.push(['资产', '行次', '期末余额', '年初余额', '负债和所有者权益', '行次', '期末余额', '年初余额']);
  for (let i = 0; i < max; i++) {
    const a = aRows[i], l = lRows[i];
    const left = a ? [a.grp !== undefined ? a.grp : a.label, ++noA, a.end, a.year] : ['', '', '', ''];
    const right = l ? [l.grp !== undefined ? l.grp : l.label, ++noL, l.end, l.year] : ['', '', '', ''];
    rows.push(left.concat(right));
  }
  rows.push(['资产总计', noA + 1, bs.totalAsset, '', '负债和所有者权益总计', noL + 1, bs.totalAll, '']);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 列宽优化
  ws['!cols'] = [{ wch: 24 }, { wch: 6 }, { wch: 14 }, { wch: 14 }, { wch: 26 }, { wch: 6 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, '资产负债表');
  __safeExportExcel(wb, '资产负债表_' + month);
}

/* ===================== 利润表 ===================== */
function refreshPl() {
  var sInp = $('plPeriodStart'), eInp = $('plPeriodEnd');
  var def = lastClosedPeriod();
  if (sInp && eInp) {
    sInp.value = sInp.value || def;
    eInp.value = eInp.value || def;
    if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__('plPeriodStart', 'plPeriodEnd');
  }
  // 口径保持单期间（用结束期间），仅 UI 对齐金蝶 range picker
  renderPl(eInp ? eInp.value : def);
}
// 利润表行计算（配置化）：读 state.reportRules.incomeStatement 规则，
// 按行求值并返回 [{label, cur, ytd, isGrp}]，供 renderPl(DOM) 与 exportPl(Excel) 共用。
// 规则结构见 js/standards.js。缺规则时回退 globalThis.STANDARDS.old（兼容异常账套）。
function computeIncomeRows(month) {
  var pl = S.profitStatement(month);
  var byCode = {};
  pl.items.forEach(function (it) { byCode[it.code] = it; });
  function amt(code) { var it = byCode[code]; return it ? { cur: it.cur, ytd: it.ytd } : { cur: 0, ytd: 0 }; }
  function sum(codes) {
    return (codes || []).reduce(function (a, c) { var x = amt(c); return { cur: a.cur + x.cur, ytd: a.ytd + x.ytd }; },
                                { cur: 0, ytd: 0 });
  }
  var fallback = (globalThis.STANDARDS && globalThis.STANDARDS.old && globalThis.STANDARDS.old.reportRules.incomeStatement) || [];
  var rules = (S.state.reportRules && S.state.reportRules.incomeStatement) || fallback;
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
      out.push({ label: r.label, cur: cur, ytd: ytd, isGrp: true });
    } else {
      var s = sum(r.codes || []);
      out.push({ label: r.label, cur: s.cur, ytd: s.ytd, isGrp: false });
    }
  });
  return out;
}

function renderPl(month) {
  setRptHead("plTitleRow", "利润表", 4, month);
  var tb = $('plBody'); tb.innerHTML = '';
  if (!month) return;
  var rows = computeIncomeRows(month);
  var no = 0;
  rows.forEach(function (r) {
    no += 1;
    var tr = document.createElement('tr');
    tr.className = r.isGrp ? 'grp-row' : '';
    tr.innerHTML = '<td class="' + (r.isGrp ? 'grp-label' : 'pl-name') + '">' + r.label +
                   '</td><td class="ta-c">' + no + '</td>' +
                   amtCell(r.cur, r.isGrp ? 'grp-amt' : '') +
                   amtCell(r.ytd, r.isGrp ? 'grp-amt' : '');
    tb.appendChild(tr);
  });
}

// 利润表导出：与 renderPl 同源（computeIncomeRows），构造「项目|行次|本月|本年累计」Excel
function exportPl() {
  const eInp = $('plPeriodEnd');
  const month = eInp ? eInp.value : currentPeriod();
  if (!month) return H.showToast('请先选择期间', 'warn');
  const rows = computeIncomeRows(month);
  const out = [['项目', '行次', '本月金额', '本年累计金额']];
  let no = 0;
  rows.forEach(function (r) { no += 1; out.push([r.label, no, r.cur, r.ytd]); });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(out);
  ws['!cols'] = [{ wch: 28 }, { wch: 6 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, '利润表');
  __safeExportExcel(wb, '利润表_' + month);
}

/* ===================== 现金流量表 ===================== */
// 现金项目分组：大类标题 → 其下明细项目 id（标准现金流量表模板，固定行次）
var CF_GROUPS = [
  { title: '一、经营活动产生的现金流量', cat: 'operating', subs: [
    'cf_sale', 'cf_taxret', 'cf_opother' ],
    subtotal: '经营活动现金流入小计', outflow: ['cf_buy', 'cf_payemp', 'cf_taxpay', 'cf_opothp'],
    outsub: '经营活动现金流出小计', net: '经营活动产生的现金流量净额' },
  { title: '二、投资活动产生的现金流量', cat: 'investing', subs: [
    'cf_invgain', 'cf_invother', 'cf_fixgain', 'cf_dissub', 'cf_invothin' ],
    subtotal: '投资活动现金流入小计', outflow: ['cf_invpay', 'cf_investpay', 'cf_dissubpay', 'cf_invothp'],
    outsub: '投资活动现金流出小计', net: '投资活动产生的现金流量净额' },
  { title: '三、筹资活动产生的现金流量', cat: 'financing', subs: [
    'cf_absinv', 'cf_finloan', 'cf_finother' ],
    subtotal: '筹资活动现金流入小计', outflow: ['cf_finrepay', 'cf_paydiv', 'cf_finothp'],
    outsub: '筹资活动现金流出小计', net: '筹资活动产生的现金流量净额' }
];
// 明细项目 id → 显示名称（与 state.cashFlowItems 一致，缺失时回退 id）
function cfNameOf(id) {
  var m = (S.state.cashFlowItems || []).filter(function (it) { return it.id === id; })[0];
  return m ? m.name : id;
}
function refreshCf() {
  var month = periodRangeValue('cfPeriod', lastClosedPeriod());
  renderCf(month);
}
function renderCf(month) {
  setRptHead("cfTitleRow", "标准现金流量表", 4, month);
  var tb = $('cfBody'); tb.innerHTML = '';
  if (!month) return;
  var cf = S.cashFlow(month);
  var items = cf.items || {};
  var ytd = cf.ytd || {};
  var no = 1;
  var totalNet = 0;
  function row(cls, name, num, amt, y, bold) {
    var tr = document.createElement('tr');
    tr.className = cls || '';
    var amtCls = 'ta-r mono ' + (bold ? 'grp-amt ' : '') + (amt < 0 ? 'kd-red' : 'kd-green');
    var yCls = 'ta-r mono ' + (bold ? 'grp-amt ' : '') + (y < 0 ? 'kd-red' : 'kd-green');
    tr.innerHTML = '<td' + (cls === 'grp-row' ? ' class="grp-label"' : '') + '>' + name + '</td>' +
      '<td class="ta-c">' + (num === '' ? '' : num) + '</td>' +
      '<td class="' + amtCls + '">' + money(amt) + '</td>' +
      '<td class="' + yCls + '">' + money(y) + '</td>';
    tb.appendChild(tr);
  }
  function subsSum(ids, bucket) {
    return ids.reduce(function (s, id) { return s + (bucket[id] || 0); }, 0);
  }
  CF_GROUPS.forEach(function (g) {
    var net = cf[g.cat] || 0;
    totalNet += net;
    // 大类标题行（无行次、无金额）
    var grp = document.createElement('tr');
    grp.className = 'grp-row';
    grp.innerHTML = '<td class="grp-label">' + g.title + '</td><td class="ta-c"></td><td class="ta-r mono grp-amt"></td><td class="ta-r mono grp-amt"></td>';
    tb.appendChild(grp);
    // 流入明细
    g.subs.forEach(function (id) {
      row('', cfNameOf(id), no++, items[id] || 0, ytd[id] || 0, false);
    });
    // 流入小计
    var inSum = subsSum(g.subs, items), inSumY = subsSum(g.subs, ytd);
    row('grp-row', g.subtotal, no++, inSum, inSumY, true);
    // 流出明细
    g.outflow.forEach(function (id) {
      row('', cfNameOf(id), no++, items[id] || 0, ytd[id] || 0, false);
    });
    // 流出小计
    var outSum = subsSum(g.outflow, items), outSumY = subsSum(g.outflow, ytd);
    row('grp-row', g.outsub, no++, outSum, outSumY, true);
    // 净额
    var netAmt = inSum - outSum, netY = inSumY - outSumY;
    row('grp-row', g.net, no++, netAmt, netY, true);
  });
  // 四、汇率变动对现金的影响
  var exch = cf.exchange || 0, exchY = ytd.cf_exchg || 0;
  row('', '汇率变动对现金的影响额', no++, exch, exchY, false);
  // 五、现金及现金等价物净增加额
  // 口径说明：本年累计列的明细项目走 ytd bucket，但「净增加额」行与「期初/期末」行
  // 为保证列内勾稽（期初+净增=期末）成立，净增加额取当月三类净额 + 期初行取当月月初余额。
  // 详见 docs/go-live-blockers.md M7 待统一设计说明（勿单独改其一，会破坏列内勾稽）。
  var netInc = totalNet + exch, netIncY = (cf.operating + cf.investing + cf.financing + exch);
  row('grp-row', '现金及现金等价物净增加额', no++, netInc, netIncY, true);
  // 加：期初现金及现金等价物余额
  row('', '加：期初现金及现金等价物余额', no++, cf.opening, cf.opening, false);
  // 六、期末现金及现金等价物余额
  // 审计修复：原实现用 opening+netInc 推算「期末」，会掩盖勾稽断裂（三项净额≠现金净变动时
  // 页面依然自洽）。改为直接展示账面真实期末（generalLedger 现金三行），若与期初+净增不符
  // 即说明数据链异常，宁可暴露不可掩盖；正常情况下两者应严格相等。
  var ending = cf.ending;
  row('grp-row', '期末现金及现金等价物余额', no++, ending, ending, true);
}

// 现金流量表导出：与 renderCf 同源（S.cashFlow + CF_GROUPS + cfNameOf），构造「项目|行次|本月|本年累计」Excel
function exportCf() {
  const eInp = $('cfPeriodEnd');
  const month = eInp ? eInp.value : currentPeriod();
  if (!month) return H.showToast('请先选择期间', 'warn');
  const cf = S.cashFlow(month);
  const items = cf.items || {};
  const ytd = cf.ytd || {};
  const rows = [['项目', '行次', '本月金额', '本年累计金额']];
  let no = 1;
  let totalNet = 0;
  function push(name, num, amt, y) { rows.push([name, num, amt, y]); }
  function subsSum(ids, bucket) { return ids.reduce(function (s, id) { return s + (bucket[id] || 0); }, 0); }
  CF_GROUPS.forEach(function (g) {
    const net = cf[g.cat] || 0;
    totalNet += net;
    rows.push([g.title, '', '', '']);
    g.subs.forEach(function (id) { push(cfNameOf(id), no++, items[id] || 0, ytd[id] || 0); });
    const inSum = subsSum(g.subs, items), inSumY = subsSum(g.subs, ytd);
    push(g.subtotal, no++, inSum, inSumY);
    g.outflow.forEach(function (id) { push(cfNameOf(id), no++, items[id] || 0, ytd[id] || 0); });
    const outSum = subsSum(g.outflow, items), outSumY = subsSum(g.outflow, ytd);
    push(g.outsub, no++, outSum, outSumY);
    push(g.net, no++, inSum - outSum, inSumY - outSumY);
  });
  const exch = cf.exchange || 0, exchY = ytd.cf_exchg || 0;
  push('汇率变动对现金的影响额', no++, exch, exchY);
  const netInc = totalNet + exch;
  // 与 renderCf 同口径：净增加额/期初/期末行为保证列内勾稽，本年累计列取当月口径（见 M7 说明）
  push('现金及现金等价物净增加额', no++, netInc, netInc);
  push('加：期初现金及现金等价物余额', no++, cf.opening, cf.opening);
  push('期末现金及现金等价物余额', no++, cf.ending, cf.ending);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 30 }, { wch: 6 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, '现金流量表');
  __safeExportExcel(wb, '现金流量表_' + month);
}

/* ===================== 应交税费明细表 ===================== */
function refreshTx() {
  var month = periodRangeValue('txPeriod', lastClosedPeriod());
  renderTx(month);
}
function renderTx(month) {
  setRptHead("txTitleRow", "应交税金明细表", 4, month);
  var tb = $('txBody'); tb.innerHTML = '';
  if (!month) return;
  var tx = S.taxDetail(month);
  if (!tx || !tx.rows.length) { tb.innerHTML = '<tr><td colspan="4">未设置应交税费科目</td></tr>'; return; }
  tx.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    if (r.level === 0) tr.className = 'grp-row';
    var nameCls = r.level === 2 ? 'cf-sub' : (r.level === 1 ? 'cf-sub2' : '');
    var amtCls = 'ta-r mono ' + (r.bold ? 'grp-amt ' : '') + (r.cur < 0 ? 'kd-red' : 'kd-green');
    var yCls = 'ta-r mono ' + (r.bold ? 'grp-amt ' : '') + (r.ytd < 0 ? 'kd-red' : 'kd-green');
    tr.innerHTML = '<td class="' + nameCls + '">' + r.name + '</td>' +
      '<td class="ta-c">' + (r.level === 2 ? r.rowNum : '') + '</td>' +
      '<td class="' + amtCls + '">' + money(r.cur) + '</td>' +
      '<td class="' + yCls + '">' + money(r.ytd) + '</td>';
    tb.appendChild(tr);
  });
}

// 应交税金明细表导出：与 renderTx 同源（S.taxDetail），构造「项目|行次|本月|本年累计」Excel
function exportTx() {
  const eInp = $('txPeriodEnd');
  const month = eInp ? eInp.value : currentPeriod();
  if (!month) return H.showToast('请先选择期间', 'warn');
  const tx = S.taxDetail(month);
  const rows = [['项目', '行次', '本月数', '本年累计数']];
  if (tx && tx.rows && tx.rows.length) {
    tx.rows.forEach(function (r) {
      rows.push([r.name, (r.level === 2 ? r.rowNum : ''), r.cur, r.ytd]);
    });
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 30 }, { wch: 6 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, '应交税金明细表');
  __safeExportExcel(wb, '应交税金明细表_' + month);
}

// 四大报表导出统一挂到全局，供 app.js 按钮绑定
globalThis.__exportBs = exportBs;
globalThis.__exportPl = exportPl;
globalThis.__exportCf = exportCf;
globalThis.__exportTx = exportTx;

export { refreshBs, refreshPl, refreshCf, refreshTx, exportBs, exportPl, exportCf, exportTx };

