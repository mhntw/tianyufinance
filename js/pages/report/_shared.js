const H = window.__KINGDEE_HELPERS__ || {};
const $ = id => document.getElementById(id);
const S = H.S || window.store;
const money = H.money || (v => v == null ? '0.00' : Number(v).toFixed(2));
const fmt = H.fmt || (v => v == null ? '' : String(v));
const goPage = H.goPage || (p => { if (window.goPage) window.goPage(p); });
const currentPeriod = H.currentPeriod || (() => (window.store ? window.store.currentPeriod : '2026-01'));
// 本期 = 最近一个已结账期间（桥接层 lastClosedPeriod）；无已结账回退 currentPeriod()
const lastClosedPeriod = H.lastClosedPeriod || currentPeriod;
const esc = H.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const num = H.num || (v => Number(v) || 0);
const showToast = H.showToast || (msg => console.log('[toast]', msg));
const nowTimeStr = H.nowTimeStr || (() => {
  const d = new Date();
  const p = n => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
});

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function periodRangeOptions() {
  const cp = currentPeriod();
  const [y, m] = cp.split('-').map(Number);
  const opts = [];
  for (let yy = y - 1; yy <= y; yy++) {
    for (let mm = 1; mm <= 12; mm++) {
      const val = `${yy}-${String(mm).padStart(2, '0')}`;
      opts.push(`<option value="${val}" ${val === cp ? 'selected' : ''}>${yy}年${mm}期</option>`);
    }
  }
  return opts.join('');
}

function allBookedMonthsOri() {
  const set = {};
  (S.state.vouchers || []).forEach(v => { if (v.date) set[v.date.substring(0, 7)] = 1; });
  return Object.keys(set).sort();
}

function periodRangeOptionsOri(sel, cur) {
  if (!sel) return;
  sel.innerHTML = '';
  const months = allBookedMonthsOri();
  if (!months.length) months.push(cur);
  months.forEach(m => {
    const y = m.substring(0, 4), mon = parseInt(m.substring(5, 7), 10);
    const op = document.createElement('option');
    op.value = m;
    op.textContent = y + '年第' + mon + '期';
    sel.appendChild(op);
  });
  sel.value = cur;
}

function monthsBetween(start, end) {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  const res = [];
  let yy = sy, mm = sm;
  while (yy < ey || (yy === ey && mm <= em)) {
    res.push(`${yy}-${String(mm).padStart(2, '0')}`);
    mm++;
    if (mm > 12) { mm = 1; yy++; }
  }
  return res;
}

function prevYearMonth(m) {                 // YYYY-MM -> 去年同月 YYYY-1-MM
  const [y, mm] = m.split('-').map(Number);
  return `${y - 1}-${String(mm).padStart(2, '0')}`;
}

function monthLabel(m) {
  const [y, mm] = m.split('-');
  return `${y}年${parseInt(mm, 10)}期`;
}

function subjectLevel(code) {
  // 优先用科目自带 level（真实级次）：本项目支持非标准段式（如绅蓝之星一级4位+二级7位+三级9位），
  // 纯按编码长度推导在奇数长度编码上会算错（7位算成3级、实为2级）。缺失 level 字段再回退段式推导。
  var s = (S.subjects() || []).find(function (x) { return x.code === code; });
  if (s && typeof s.level === 'number') return s.level;
  return Math.floor(code.length / 2) - 1; // 4位->1, 6位->2, 8位->3
}

function subjectFilter(fn) {
  return (S.subjects() || []).filter(fn);
}

function getSubjectNameByCode(code) {
  const s = (S.subjects() || []).find(x => x.code === code);
  return s ? s.name : code;
}


export { $, S, money, fmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2, periodRangeOptions, allBookedMonthsOri, periodRangeOptionsOri, monthsBetween, prevYearMonth, monthLabel, subjectLevel, subjectFilter, getSubjectNameByCode };
