// 页面模块：科目余额表（page-trial-balance）
// B 方案探针页：验证 "ESM 模块 + 全局 store 共享 + 渲染/事件" 全链路。
// 设计铁律：只挪窝不改写 —— DOM 结构 / class / 交互与旧 app.js renderTb 逐字一致。
// 本模块不 import store.js（避免重复执行 IIFE），改从 globalThis.__KINGDEE_EXPORT__ 取已加载的单例。

function getStore() {
  // 旧 store.js 以 <script src> 先加载，已挂到 globalThis.__KINGDEE_EXPORT__；
  // 同时也保留全局 S。优先取导出对象，缺失则回退 S。
  const ex = globalThis.__KINGDEE_EXPORT__;
  return (ex && ex.store) || globalThis.S;
}
function getUtil() {
  const ex = globalThis.__KINGDEE_EXPORT__;
  return (ex && ex.util) || globalThis.util;
}

const $ = (id) => document.getElementById(id);
// 期间下拉守卫统一走桥接层 H.safeFillPeriod（app.js 内定义，含 bookKey 记忆）
const H = globalThis.__KINGDEE_HELPERS__ || {};

// 科目名来自用户录入，渲染进 HTML / 属性前需转义，避免破坏结构
// HTML 转义：统一走 app.js 的单点实现（H.esc），此前各页面各存一份逐字相同的拷贝。
const escHtml = H.esc;
const escAttr = escHtml;

// 当前期间（等价旧 currentPeriod）
function currentPeriod() {
  const s = getStore();
  if (s.currentPeriod) return s.currentPeriod();
  const months = s.allMonths ? s.allMonths() : [];
  return months.length ? months[months.length - 1] : '';
}

export function renderTrialBalance() {
  const sInp = $('tbPeriodStart'), eInp = $('tbPeriodEnd');
  const def = currentPeriod();
  if (sInp && eInp) {
    sInp.value = sInp.value || def;
    eInp.value = eInp.value || def;
    if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__('tbPeriodStart', 'tbPeriodEnd');
  }
  // 口径保持单期间（用结束期间），仅 UI 对齐金蝶 range picker
  renderTb(eInp ? eInp.value : def);
}

function renderTb(month) {
  const U = getUtil();
  const S = getStore();
  const tb = $('tbBody');
  if (!tb) return;
  tb.innerHTML = '';
  if (!month) return;
  // 系统参数开关（账簿显示偏好），纯前端渲染控制，不参与任何取数/计算
  const p = (S && S.state && S.state.param) || {};
  const hideZero = p.bookHideZero !== false;   // 默认 true：无期初+本期发生+余额的科目不显示（默认）
  const expandAll = p.bookExpandAll !== false; // 默认 true：展开所有级次；false 时只显示一级科目
  // 末级科目判定：无任何其他科目以其为真前缀（与 store.rollCodes 口径互补，避免合计翻倍）
  const allCodes = S.subjects().map(function (s) { return s.code; });
  function isLeaf(code) {
    return !allCodes.some(function (c) { return c !== code && c.indexOf(code) === 0; });
  }
  const sum = { obD: 0, obC: 0, pD: 0, pC: 0, yD: 0, yC: 0, eD: 0, eC: 0 };
  S.generalLedger(month).forEach(function (r) {
    // 折叠：未展开全部级次时，只保留一级科目（编码长度 <=4，4-2-2 段式）
    if (!expandAll && r.code.length > 4) return;
    // 隐藏零行：期初借贷、本期借贷贷方、期末余额均为 0 时跳过（受 bookHideZero 控制）
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;
    const obD = r.obDr >= r.obCr ? r.obDr - r.obCr : 0;
    const obC = r.obCr > r.obDr ? r.obCr - r.obDr : 0;
    const eD = r.dir === '借' ? r.balance : 0;
    const eC = r.dir === '贷' ? r.balance : 0;
    // 合计只累加末级科目：父级余额=自身+子目（rollCodes 上卷后父行已含子行），
    // 若父、子都累加则合计虚高一倍（如 16510327 vs 末级 10472959）。
    if (isLeaf(r.code)) {
      sum.obD += obD; sum.obC += obC; sum.pD += r.periodDr; sum.pC += r.periodCr;
      sum.yD += r.ytdDr; sum.yC += r.ytdCr; sum.eD += eD; sum.eC += eC;
    }
    const tr = document.createElement('tr');
    // title 承载完整科目名：列宽有限时单元格以省略号截断，悬停仍可看到全名
    tr.innerHTML = '<td class="mono">' + r.code + '</td><td class="tb-name" title="' + escAttr(r.name) + '">' + escHtml(r.name) +
      '</td><td class="ta-r mono">' + U.money(obD) + '</td><td class="ta-r mono">' + U.money(obC) +
      '</td><td class="ta-r mono">' + U.money(r.periodDr) + '</td><td class="ta-r mono">' + U.money(r.periodCr) +
      '</td><td class="ta-r mono">' + U.money(r.ytdDr) + '</td><td class="ta-r mono">' + U.money(r.ytdCr) +
      '</td><td class="ta-r mono">' + U.money(eD) + '</td><td class="ta-r mono">' + U.money(eC) + '</td>';
    tb.appendChild(tr);
  });
  // 合计行
  const tr = document.createElement('tr');
  tr.className = 'tb-total';
  tr.innerHTML = '<td></td><td>合计</td>' +
    '<td class="ta-r mono">' + U.money(sum.obD) + '</td><td class="ta-r mono">' + U.money(sum.obC) +
    '</td><td class="ta-r mono">' + U.money(sum.pD) + '</td><td class="ta-r mono">' + U.money(sum.pC) +
    '</td><td class="ta-r mono">' + U.money(sum.yD) + '</td><td class="ta-r mono">' + U.money(sum.yC) +
    '</td><td class="ta-r mono">' + U.money(sum.eD) + '</td><td class="ta-r mono">' + U.money(sum.eC) + '</td>';
  tb.appendChild(tr);
}

// 科目余额表导出：与 renderTb 同源（S.generalLedger + 相同借贷计算），构造 10 列 Excel
export function exportTb() {
  const S = getStore();
  const U = getUtil();
  const eInp = $('tbPeriodEnd');
  const month = eInp ? eInp.value : currentPeriod();
  if (!month) return H.showToast('请先选择期间', 'warn');
  const p = (S && S.state && S.state.param) || {};
  const hideZero = p.bookHideZero !== false;
  const expandAll = p.bookExpandAll !== false;
  const allCodes = S.subjects().map(function (s) { return s.code; });
  function isLeaf(code) {
    return !allCodes.some(function (c) { return c !== code && c.indexOf(code) === 0; });
  }
  const rows = [['科目编码', '科目名称', '期初借方', '期初贷方', '本期借方', '本期贷方', '本年累计借方', '本年累计贷方', '期末借方', '期末贷方']];
  const sum = { obD: 0, obC: 0, pD: 0, pC: 0, yD: 0, yC: 0, eD: 0, eC: 0 };
  S.generalLedger(month).forEach(function (r) {
    if (!expandAll && r.code.length > 4) return;
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;
    const obD = r.obDr >= r.obCr ? r.obDr - r.obCr : 0;
    const obC = r.obCr > r.obDr ? r.obCr - r.obDr : 0;
    const eD = r.dir === '借' ? r.balance : 0;
    const eC = r.dir === '贷' ? r.balance : 0;
    if (isLeaf(r.code)) {
      sum.obD += obD; sum.obC += obC; sum.pD += r.periodDr; sum.pC += r.periodCr;
      sum.yD += r.ytdDr; sum.yC += r.ytdCr; sum.eD += eD; sum.eC += eC;
    }
    rows.push([r.code, r.name, obD, obC, r.periodDr, r.periodCr, r.ytdDr, r.ytdCr, eD, eC]);
  });
  rows.push(['', '合计', sum.obD, sum.obC, sum.pD, sum.pC, sum.yD, sum.yC, sum.eD, sum.eC]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, '科目余额表');
  __safeExportExcel(wb, '科目余额表_' + month);
}
// 挂到全局，供 app.js 按钮绑定
globalThis.__exportTb = exportTb;

