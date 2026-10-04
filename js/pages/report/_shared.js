/* 报表 / 账簿族的共享基座。
   引导块（H / EX / S / U / $ / money / esc / num / showToast / currentPeriod / round2 / yuan）
   已收口到 ../../common/helpers.js —— 本文件只保留**本族专属**的名字
   （goPage / absFmt / lastClosedPeriod / nowTimeStr / 月历 / 科目工具）。
   收口前这 20 行引导在本族两个文件 + 15 个页面里各写一遍，且写法互不相同
   （详见 common/helpers.js 头部那张差异表；其中 3 处 esc 兜底甚至是"不转义"的）。 */
import { H, $, S, U, money, esc, num, showToast, currentPeriod, round2, yuan } from '../../common/helpers.js?v=dev';

const absFmt = H.absFmt || (v => v == null ? '' : String(v));
const goPage = H.goPage || (p => { if (window.goPage) window.goPage(p); });
// 本期 = 最近一个已结账期间（桥接层 lastClosedPeriod）；无已结账回退 currentPeriod()
const lastClosedPeriod = H.lastClosedPeriod || currentPeriod;
const nowTimeStr = H.nowTimeStr || (() => {
  const d = new Date();
  const p = n => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
});

// 月份区间展开为月份列表（含首尾）。实现已下沉到 store（见 store.js 的 monthList），此处仅转发。
// 改名理由：本函数原本叫 monthsBetween 且返回「列表」，而 store.monthsBetween 返回「相差整月数」——
// 同名却语义相反，是最容易踩错的坑；现统一为「差月数=monthsBetween、列表=monthList」。
function monthList(start, end) {
  const U2 = (typeof window !== 'undefined' && window.util) || {};
  if (typeof U2.monthList === 'function') return U2.monthList(start, end);
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

// 期间文案单点（见 store.js 的 periodText）：原为「2026年7期」（无"第"、不补零），
// 与顶栏/首页写法不一致；现三处统一（本函数的输出还进 Excel 表头，改动后表头字样随之统一）。
function monthLabel(m) { return U.periodText(m); }

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

export { H, $, S, U, money, esc, num, showToast, currentPeriod, round2, yuan,
  absFmt, goPage, lastClosedPeriod, nowTimeStr, monthList, prevYearMonth, monthLabel, subjectLevel, subjectFilter };
