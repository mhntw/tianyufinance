// 页面模块：科目余额表（page-trial-balance）
// B 方案探针页：验证 "ESM 模块 + 全局 store 共享 + 渲染/事件" 全链路。
// 设计铁律：只挪窝不改写 —— DOM 结构 / class / 交互与旧 app.js renderTb 逐字一致。
// 本模块不 import store.js（避免重复执行 IIFE），改从 globalThis.__TY_EXPORT__ 取已加载的单例。

function getStore() {
  // 旧 store.js 以 <script src> 先加载，已挂到 globalThis.__TY_EXPORT__；
  // 同时也保留全局 S。优先取导出对象，缺失则回退 S。
  const ex = globalThis.__TY_EXPORT__;
  return (ex && ex.store) || globalThis.S;
}
function getUtil() {
  const ex = globalThis.__TY_EXPORT__;
  return (ex && ex.util) || globalThis.util;
}

const $ = (id) => document.getElementById(id);
// 桥接层：app.js 注册的通用 helper（$ / currentPeriod / periodRangeValue / esc 等）
const H = globalThis.__TY_HELPERS__ || {};
// 起止期间取值：统一走 app.js 的单点实现（含默认值兜底），页面不再各自决定默认期间
const periodRangeValue = H.periodRangeValue;

// 科目名来自用户录入，渲染进 HTML / 属性前需转义，避免破坏结构
// HTML 转义统一走 H.esc（单点实现）。
const escHtml = H.esc;
const escAttr = escHtml;

/* ===== 科目余额表树形折叠（与科目页同款交互） =====
 * tbExpanded: Set() = 已展开的科目编码（祖先级联：祖先不在 Set 中 → 子级隐藏）
 * 空 Set = 默认全收起（只露一级父科目）
 */
var tbExpanded = new Set();
var tbBookKey = '';       // 账套守卫：切换账套后重置折叠态，避免旧账套 code 残留

// 层级深度 = 到根的父链长度（真实缩进依据）
function tbDepth(pm, code) {
  let d = 0, c = String(code), guard = 0;
  while (c && guard++ < 40) {
    const p = pm[c];
    if (!p) break;
    d++; c = p;
  }
  return d;
}

// 全展开时生成 expanded Set：把所有有直接子科目的父级 code 加进去
function buildAllExpanded() {
  const subs = S.subjects() || [];
  const pm = S.subjectParentMap(subs);
  const parents = {};
  subs.forEach(function (s) { const p = pm[String(s.code)]; if (p) parents[p] = 1; });
  return new Set(Object.keys(parents));
}

// 当前期间（等价旧 currentPeriod）
function currentPeriod() {
  const s = getStore();
  if (s.currentPeriod) return s.currentPeriod();
  const months = s.allMonths ? s.allMonths() : [];
  return months.length ? months[months.length - 1] : '';
}

export function renderTrialBalance() {
  // 初始化 tbHideZero 勾选：读全局参数 bookHideZero（总账 + 余额表共用）
  var tbHz = document.getElementById('tbHideZero');
  if (tbHz && tbHz.checked !== !!(S.state.param && S.state.param.bookHideZero)) {
    tbHz.checked = !!(S.state.param && S.state.param.bookHideZero);
  }
  // 默认期间由 index.html 的 data-default 声明，periodRangeValue 单点兜底并同步触发器文本
  // 口径保持单期间（用结束期间）
  renderTb(periodRangeValue('tbPeriod'));
}

function renderTb(month) {
  const U = getUtil();
  const S = getStore();
  const tb = $('tbBody');
  if (!tb) return;
  tb.innerHTML = '';
  if (!month) return;
  // 隐藏零行：读页面内勾选框，勾选=true 隐藏（跟全局参数 bookHideZero 同步）
  const hideZero = !!(document.getElementById('tbHideZero') && document.getElementById('tbHideZero').checked);
  // 「展开所有次级」由页内勾选框控制（与科目页同口径）：
  // 未勾选=默认只显示一级科目（父级），行首小三角逐级展开；勾选=显示全部级次。
  const tbExpand = document.getElementById('tbExpandAll');
  const expandAll = !!(tbExpand && tbExpand.checked);

  // 树形折叠态初始化/账套守卫：切换账套后重置为新账套「只露一级」（空 Set = 全收起）
  const bk = (S && (S.bookId || (S.state && S.state.company && S.state.company.name))) || '';
  if (tbBookKey !== bk) {
    tbBookKey = bk;
    tbExpanded = expandAll ? buildAllExpanded() : new Set();
  }

  // 父映射 & 直接子科目集合
  const allSubs = S.subjects() || [];
  const pm = S.subjectParentMap(allSubs);
  const hasKids = {};
  allSubs.forEach(function (s) { const p = pm[String(s.code)]; if (p) hasKids[p] = 1; });
  const collapsed = (code) => !expandAll && !tbExpanded.has(String(code));

  const sum = { obD: 0, obC: 0, pD: 0, pC: 0, yD: 0, yC: 0, eD: 0, eC: 0 };
  S.generalLedger(month).forEach(function (r) {
    const code = String(r.code);
    // 树形折叠：不可见行（祖先收起）不渲染
    if (!S.subjectVisible(code, tbExpanded, pm, expandAll)) return;
    // 隐藏零行：期初借贷、本期借贷贷方、期末余额均为 0 时跳过（受 bookHideZero 控制）
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;
    // 余额列（期初/期末）按「科目正常方向」填列，反向余额带负号——与科目余额表的通用口径一致：
    // 贷方类科目（负债/权益/收入）出现借方余额时，金额在「贷方」列以负数显示
    // （例：3104 利润分配为贷方科目，出现借方余额 → 期末贷方显示 -2,836,003.25）。
    // 借正类科目同理：出现贷方余额时，金额在「借方」列以负数显示。
    // 注：本期/本年累计发生额列仍按实际借贷方向填列（红字冲减的差异另行处置，不在本次改动内）。
    const obNet = r.normal === 'dr' ? (r.obDr - r.obCr) : (r.obCr - r.obDr);
    const obD = r.normal === 'dr' ? obNet : 0;
    const obC = r.normal === 'cr' ? obNet : 0;
    const eNet = r.normal === 'dr' ? (r.endDr - r.endCr) : (r.endCr - r.endDr);
    const eD = r.normal === 'dr' ? eNet : 0;
    const eC = r.normal === 'cr' ? eNet : 0;
    // 合计累加口径（与展开状态自洽，杜绝父/子重复）：
    // 有子且已展开 → 由子级明细贡献，父行不累加（父行已含子树，rollCodes 上卷会翻倍）；
    // 末级 或 有子但收起（子级不可见）→ 累加本行（收起时本行=该支子树总额）。
    if (!hasKids[code] || !tbExpanded.has(code)) {
      sum.obD += obD; sum.obC += obC; sum.pD += r.periodDr; sum.pC += r.periodCr;
      sum.yD += r.ytdDr; sum.yC += r.ytdCr; sum.eD += eD; sum.eC += eC;
    }
  // 行首小三角：用 store 公共函数统一生成 ▶▼ 文字；位置在「科目编码」列前（与明细账右侧科目树一致）
  const arrow = S.subjectArrowHTML(code, !!hasKids[code], tbExpanded.has(code), 'tb-arrow');
  const indent = S.subjectIndentHTML(tbDepth(pm, code));
  const tr = document.createElement('tr');
  // title 承载完整科目名：列宽有限时单元格以省略号截断，悬停仍可看到全名
  tr.innerHTML = '<td class="mono">' + arrow + '<a href="#" class="link-gl-subject" data-code="' + escAttr(code) + '">' + escHtml(code) + '</a></td><td class="tb-name" title="' + escAttr(r.name) + '">' + indent + escHtml(r.name) +
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
  // 导出读全局参数 bookHideZero（页面 change 已同步，值一致）
  const hideZero = !!(S && S.state && S.state.param && S.state.param.bookHideZero);
  // 与 renderTb 同口径：页内「展开所有次级」勾选 + 树形折叠态控制导出内容
  const tbExpand = document.getElementById('tbExpandAll');
  const expandAll = !!(tbExpand && tbExpand.checked);
  // 导出前确保折叠态已初始化/账套守卫生效（复用 renderTb 内同一状态）
  const bk = (S && (S.bookId || (S.state && S.state.company && S.state.company.name))) || '';
  if (tbBookKey !== bk) {
    tbBookKey = bk;
    tbExpanded = expandAll ? buildAllExpanded() : new Set();
  }
  const pm = S.subjectParentMap(S.subjects() || []);
  const hasKids = {};
  (S.subjects() || []).forEach(function (s) { const pp = pm[String(s.code)]; if (pp) hasKids[pp] = 1; });
  const rows = [['科目编码', '科目名称', '期初借方', '期初贷方', '本期借方', '本期贷方', '本年累计借方', '本年累计贷方', '期末借方', '期末贷方']];
  const sum = { obD: 0, obC: 0, pD: 0, pC: 0, yD: 0, yC: 0, eD: 0, eC: 0 };
  S.generalLedger(month).forEach(function (r) {
    const code = String(r.code);
    // 树形折叠：与屏幕所见一致（祖先收起的不导出）
    if (!S.subjectVisible(code, tbExpanded, pm, expandAll)) return;
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;
    // 余额列（期初/期末）按「科目正常方向」填列，反向余额带负号——与屏幕 renderTb 同口径
    // （与科目余额表的通用口径一致：贷方科目出现借方余额时，金额在「贷方」列以负数显示）。
    const obNet = r.normal === 'dr' ? (r.obDr - r.obCr) : (r.obCr - r.obDr);
    const obD = r.normal === 'dr' ? obNet : 0;
    const obC = r.normal === 'cr' ? obNet : 0;
    const eNet = r.normal === 'dr' ? (r.endDr - r.endCr) : (r.endCr - r.endDr);
    const eD = r.normal === 'dr' ? eNet : 0;
    const eC = r.normal === 'cr' ? eNet : 0;
    // 合计口径与 renderTb 一致：末级或有子但收起才累加（展开父由子级贡献）
    if (!hasKids[code] || !tbExpanded.has(code)) {
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

// 「展开所有次级」勾选/取消 + 行首小三角点击（绑定一次；模块在 DOM 解析后加载，元素已存在）。
// 行为与科目页「展开所有级次」一致：未勾选=只显示一级科目（默认）；勾选=显示全部级次。
(function () {
  const cb = document.getElementById('tbExpandAll');
  if (cb) cb.addEventListener('change', function () {
    tbExpanded = cb.checked ? buildAllExpanded() : new Set();
    const eInp = document.getElementById('tbPeriodEnd');
    renderTb(eInp ? eInp.value : currentPeriod());
  });
  // tbHideZero change → 同步写全局参数（总账 + 余额表共用）
  const tbHz = document.getElementById('tbHideZero');
  if (tbHz) tbHz.addEventListener('change', function () {
    const S0 = getStore();
    if (S0 && S0.state) S0.state.param.bookHideZero = tbHz.checked;
    S0.persist();
    const eInp = document.getElementById('tbPeriodEnd');
    renderTb(eInp ? eInp.value : currentPeriod());
  });
  const body = document.getElementById('tbBody');
  if (body) body.addEventListener('click', function (e) {
    const el = e.target;
    if (!el.classList || !el.classList.contains('tb-arrow')) return;
    const aCode = el.getAttribute('data-code');
    const chk = document.getElementById('tbExpandAll');
    if (chk && chk.checked) {
      // 「展开所有级次」态下点箭头 = 退出全展，只收起该分支，其余保持展开（保留后续逐级操作）
      chk.checked = false;
      tbExpanded = new Set();
    }
    if (tbExpanded.has(aCode)) tbExpanded.delete(aCode); else tbExpanded.add(aCode);
    const eInp = document.getElementById('tbPeriodEnd');
    renderTb(eInp ? eInp.value : currentPeriod());
  });
})();

