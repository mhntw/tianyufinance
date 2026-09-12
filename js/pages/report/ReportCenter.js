// 自 report/Extra.js 拆分（B 方案第 2 批试点）：报表中心。只挪窝不改写。
import { $, S, money, fmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2,
  periodRangeOptions, periodRangeOptionsOri, monthsBetween, prevYearMonth, monthLabel, subjectLevel, subjectFilter, getSubjectNameByCode } from './_shared.js';
export function renderReportCenter() {
  bindReportCenter();
  var type = $('rcType') ? $('rcType').value : '';
  var kw = $('rcKw') ? $('rcKw').value.trim() : '';
  var sys = [
    { name: '资产负债表', no: 'P001', type: '系统报表', fav: '已收藏', note: '反映企业某一特定日期财务状况', std: '小企业会计准则', creator: '系统', cdate: '—', mod: '系统', mdate: '—', page: 'report-balance' },
    { name: '利润表', no: 'P002', type: '系统报表', fav: '已收藏', note: '反映企业一定会计期间经营成果', std: '小企业会计准则', creator: '系统', cdate: '—', mod: '系统', mdate: '—', page: 'report-profit' },
    { name: '费用明细表', no: 'P004', type: '系统报表', fav: '未收藏', note: '按费用科目展开明细', std: '小企业会计准则', creator: '系统', cdate: '—', mod: '系统', mdate: '—', page: 'expense-detail' },
    { name: '标准现金流量表', no: 'P005', type: '系统报表', fav: '已收藏', note: '反映现金及现金等价物流入流出', std: '小企业会计准则', creator: '系统', cdate: '—', mod: '系统', mdate: '—', page: 'report-cashflow' },
    { name: '主要应交税金明细表', no: 'P006', type: '系统报表', fav: '未收藏', note: '各税种应交明细', std: '小企业会计准则', creator: '系统', cdate: '—', mod: '系统', mdate: '—', page: 'report-tax' }
  ];
  var list = sys.filter(function (r) {
    if (type && r.type !== type) return false;
    if (kw && (r.name + r.no).indexOf(kw) < 0) return false;
    return true;
  });
  var tb = $('rcBody'); tb.innerHTML = '';
  list.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td class="col-op"><a class="link-open" data-page="' + r.page + '">打开</a></td>' +
      '<td>' + esc(r.name) + '</td><td>' + esc(r.no) + '</td><td>' + esc(r.type) + '</td>' +
      '<td>' + esc(r.fav) + '</td><td>' + esc(r.note) + '</td><td>' + esc(r.std) + '</td>' +
      '<td>' + esc(r.creator) + '</td><td>' + esc(r.cdate) + '</td><td>' + esc(r.mod) + '</td><td>' + esc(r.mdate) + '</td>';
    tb.appendChild(tr);
  });
  refreshRcDash();
}
function refreshRcDash() {
  document.querySelectorAll('.rc-dash-period').forEach(function (sel) {
    if (!sel._filled) { sel._filled = true; periodRangeOptionsOri(sel, currentPeriod()); }
  });
  function mOf(per) { var sel = document.querySelector('.rc-dash-period[data-per="' + per + '"]'); return (sel && sel.value) || currentPeriod(); }
  setRcVal('rcFundVal', rcDashFund(mOf('fund')));
  setRcVal('rcArVal', rcDashAr(mOf('arap')));
  setRcVal('rcApVal', rcDashAp(mOf('arap')));
  setRcVal('rcProfitVal', rcDashProfit(mOf('profit')));
  setRcVal('rcRevVal', rcDashRev(mOf('revcost')));
  setRcVal('rcCostVal', rcDashCost(mOf('cost')));
}
function setRcVal(id, v) { var el = $(id); if (el) el.textContent = money(v); }
function rcDashFund(m) {
  var r = S.generalLedger(m).filter(function (x) { return x.code === '1001' || x.code === '1002'; });
  return r.reduce(function (s, x) { return s + num(x.endDr) - num(x.endCr); }, 0);
}
function rcDashAr(m) { var r = S.generalLedger(m).filter(function (x) { return x.code === '1122'; })[0]; return r ? num(r.endDr) - num(r.endCr) : 0; }
function rcDashAp(m) { var r = S.generalLedger(m).filter(function (x) { return x.code === '2202'; })[0]; return r ? num(r.endCr) - num(r.endDr) : 0; }
// 利润/收入概览：与正式利润表同源（S.profitStatement），不再在概览层重复实现取数口径；
// 仅「营业成本」保持科目速算（5401/5402 借方，与利润表营业成本口径一致），正式数值以利润表为准。
function rcDashProfit(m) {
  var ps = (S.profitStatement ? S.profitStatement(m) : null);
  if (ps && (ps.totalRevenue !== undefined || ps.totalExpense !== undefined))
    return round2(num(ps.totalRevenue) - num(ps.totalExpense));
  var inc = 0, exp = 0;
  S.periodVouchers(m).forEach(function (v) { v.entries.forEach(function (e) {
    if (/^50(01|51)/.test(e.code)) inc += num(e.cr);
    if (/^5[456]/.test(e.code)) exp += num(e.dr);
  }); });
  return round2(inc - exp);
}
function rcDashRev(m) {
  var ps = (S.profitStatement ? S.profitStatement(m) : null);
  if (ps && ps.totalRevenue !== undefined) return num(ps.totalRevenue);
  var inc = 0; S.periodVouchers(m).forEach(function (v) { v.entries.forEach(function (e) { if (/^50(01|51)/.test(e.code)) inc += num(e.cr); }); }); return inc;
}
function rcDashCost(m) { var c = 0; S.periodVouchers(m).forEach(function (v) { v.entries.forEach(function (e) { if (/^5401|^5402/.test(e.code)) c += num(e.dr); }); }); return c; }
function bindReportCenter() {
  if ($('rcType') && !$('rcType')._bound) {
    $('rcType')._bound = $('rcKw')._bound = true;
    $('btnRcFilter').addEventListener('click', renderReportCenter);
    var body = $('rcBody');
    if (body) body.addEventListener('click', function (e) {
      var a = e.target.closest('.link-open'); if (a) { goPage(a.getAttribute('data-page')); return; }
    });
    document.querySelectorAll('.rc-dash-period').forEach(function (sel) {
      sel.addEventListener('change', refreshRcDash);
    });
  }
}

