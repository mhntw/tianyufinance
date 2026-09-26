const H = window.__TY_HELPERS__ || {};
const $ = id => document.getElementById(id);
const S = H.S || window.store;
const money = H.money || (v => v == null ? '0.00' : Number(v).toFixed(2));
const absFmt = H.absFmt || (v => v == null ? '' : String(v));
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

/* 【2026-09-26 收口】此处原先自带**第三份**「金额归零」实现（`Math.round((Number(n)||0)*100)/100`）——
   与 store.js 的规范版相比**同样少了 `-0` 归一**（(-0).toLocaleString() 会显示 "-0.00"、写进 Excel 可能带负号）。
   同一口径当时共三份（store.js / app.js / 本文件），改一处必漏两处。
   现统一委托 store 的唯一实现（经 util.round2 暴露；store.js 必然先于页面加载，故此处不会取空）。 */
function round2(n) { return window.util.round2(n); }

// 月份区间展开为月份列表（含首尾）。实现已下沉到 store（见 store.js 的 monthList），此处仅转发。
// 改名理由：本函数原本叫 monthsBetween 且返回「列表」，而 store.monthsBetween 返回「相差整月数」——
// 同名却语义相反，是最容易踩错的坑；现统一为「差月数=monthsBetween、列表=monthList」。
// 同时删掉三个从未被调用的旧实现：periodRangeOptions / periodRangeOptionsOri / allBookedMonthsOri
// （它们只在 Original.js 的 import 里出现过，全库零调用点；其中 allBookedMonthsOri 还是 store.allMonths 的重复实现）。
function monthList(start, end) {
  const U = (typeof window !== 'undefined' && window.util) || {};
  if (typeof U.monthList === 'function') return U.monthList(start, end);
  // 兜底：store 尚未注册时本地展开，口径与 store 保持一致（含 01~12 的月份校验）
  const res = [];
  const ok = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m == null ? '' : m));
  if (!ok(start) || !ok(end)) return res;
  const [sy, sm] = String(start).split('-').map(Number);
  const [ey, em] = String(end).split('-').map(Number);
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

export { $, S, money, absFmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2, monthList, prevYearMonth, monthLabel, subjectLevel, subjectFilter };
