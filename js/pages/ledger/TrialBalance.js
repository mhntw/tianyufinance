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
// 期间下拉守卫统一走桥接层 H.safeFillPeriod（app.js 内定义，含 bookKey 记忆）
const H = globalThis.__TY_HELPERS__ || {};

// 科目名来自用户录入，渲染进 HTML / 属性前需转义，避免破坏结构
// HTML 转义：统一走 app.js 的单点实现（H.esc），此前各页面各存一份逐字相同的拷贝。
const escHtml = H.esc;
const escAttr = escHtml;

/* ===== 科目余额表树形折叠（与科目页同款交互） =====
 * tbCollapsed: { code: true } = 该科目已收起（隐藏其直接子级；祖先收起时后级递归隐藏）
 * 默认（未勾选「展开所有级次」）只露一级，每行行首显示小三角 ▶ 逐级展开/收起。
 */
var tbCollapsed = null;   // null=尚未初始化；{ }=全展开；{ code:true }=该分支收起
var tbBookKey = '';       // 账套守卫：切换账套后重置折叠态，避免旧账套 code 残留

// 直接父科目映射：在给定集合内取该编码的「最长真前缀」作为父。
// 真实账套编码层级不规整（4 位、4+2=6 位、4+3=7 位、更深混合），
// 不能用「固定去尾 2 位」推导（会把 1002001 的父错算成 10020）。
function tbParentMap(subjects) {
  const byCode = {};
  (subjects || []).forEach(function (s) { byCode[String(s.code)] = 1; });
  const pm = {};
  (subjects || []).forEach(function (s) {
    const c = String(s.code); let best = '';
    for (let L = c.length - 1; L > 0; L--) {
      const pre = c.slice(0, L);
      if (byCode[pre]) { best = pre; break; } // 最长的存在于集合中的真前缀 = 直接父
    }
    pm[c] = best;
  });
  return pm;
}

// 初始态：所有「存在直接子科目」的父级一律收起 → 只露一级
function tbCollapseToLevel1(subjects) {
  const pm = tbParentMap(subjects);
  const parents = {};
  (subjects || []).forEach(function (s) {
    const p = pm[String(s.code)];
    if (p) parents[p] = 1;
  });
  tbCollapsed = parents;
}

// 层级深度 = 到根的父链长度（真实缩进依据）
function tbDepth(pm, code) {
  let d = 0, c = code, guard = 0;
  while (c && guard++ < 40) {
    const p = pm[c];
    if (!p) break;
    d++; c = p;
  }
  return d;
}

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
  // 口径保持单期间（用结束期间），仅 UI 对齐参考实现 range picker
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
  // 「展开所有次级」由页内勾选框控制（与科目页同口径）：
  // 未勾选=默认只显示一级科目（父级），行首小三角逐级展开；勾选=显示全部级次。
  const tbExpand = document.getElementById('tbExpandAll');
  const expandAll = !!(tbExpand && tbExpand.checked);

  // 树形折叠态初始化/账套守卫：切换账套后重置为新账套「只露一级」（勾选全展则保持全展）
  const bk = (S && (S.bookId || (S.state && S.state.company && S.state.company.name))) || '';
  if (tbBookKey !== bk || !tbCollapsed) {
    tbBookKey = bk;
    if (expandAll) tbCollapsed = {};
    else tbCollapseToLevel1(S.subjects() || []);
  }

  // 父映射 & 直接子科目集合 & 深度
  const allSubs = S.subjects() || [];
  const pm = tbParentMap(allSubs);
  const hasKids = {};
  allSubs.forEach(function (s) { const p = pm[String(s.code)]; if (p) hasKids[p] = 1; });
  const collapsed = (code) => !expandAll && !!tbCollapsed[code];
  // 可见性：全展=全显示；否则祖先链上任一收起即隐藏（递归）
  function visibleOf(code) {
    if (expandAll) return true;
    let cur = code, guard = 0;
    while (cur && guard++ < 40) {
      const p = pm[cur];
      if (!p) break;
      if (tbCollapsed[p]) return false;
      cur = p;
    }
    return true;
  }

  const sum = { obD: 0, obC: 0, pD: 0, pC: 0, yD: 0, yC: 0, eD: 0, eC: 0 };
  S.generalLedger(month).forEach(function (r) {
    const code = String(r.code);
    // 树形折叠：不可见行（祖先收起）不渲染
    if (!visibleOf(code)) return;
    // 隐藏零行：期初借贷、本期借贷贷方、期末余额均为 0 时跳过（受 bookHideZero 控制）
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;
    const obD = r.obDr >= r.obCr ? r.obDr - r.obCr : 0;
    const obC = r.obCr > r.obDr ? r.obCr - r.obDr : 0;
    const eD = r.dir === '借' ? r.balance : 0;
    const eC = r.dir === '贷' ? r.balance : 0;
    // 合计累加口径（与展开状态自洽，杜绝父/子重复）：
    // 有子且已展开 → 由子级明细贡献，父行不累加（父行已含子树，rollCodes 上卷会翻倍）；
    // 末级 或 有子但收起（子级不可见）→ 累加本行（收起时本行=该支子树总额）。
    if (!hasKids[code] || collapsed(code)) {
      sum.obD += obD; sum.obC += obC; sum.pD += r.periodDr; sum.pC += r.periodCr;
      sum.yD += r.ytdDr; sum.yC += r.ytdCr; sum.eD += eD; sum.eC += eC;
    }
    // 行首小三角：有子科目可展开；末级用等宽占位保证名称对齐
    const cld = collapsed(code);
    const arrow = hasKids[code]
      ? '<span class="tb-arrow' + (cld ? ' collapsed' : '') + '" data-code="' + escAttr(code)
        + '" title="' + (cld ? '展开下级科目' : '收起下级科目') + '">'
        + (cld ? '▶' : '▼') + '</span>'
      : '<span class="tb-arrow-leaf"></span>';
    const indent = '<span class="tb-indent" style="width:' + (tbDepth(pm, code) * 14) + 'px"></span>';
    const tr = document.createElement('tr');
    // title 承载完整科目名：列宽有限时单元格以省略号截断，悬停仍可看到全名
    tr.innerHTML = '<td class="mono"><a href="#" class="link-gl-subject" data-code="' + escAttr(code) + '">' + escHtml(code) + '</a></td><td class="tb-name" title="' + escAttr(r.name) + '">' + indent + arrow + escHtml(r.name) +
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
  // 与 renderTb 同口径：页内「展开所有次级」勾选 + 树形折叠态控制导出内容
  const tbExpand = document.getElementById('tbExpandAll');
  const expandAll = !!(tbExpand && tbExpand.checked);
  // 导出前确保折叠态已初始化/账套守卫生效（复用 renderTb 内同一状态）
  if (!tbCollapsed) {
    if (expandAll) tbCollapsed = {};
    else tbCollapseToLevel1(S.subjects() || []);
  }
  const pm = tbParentMap(S.subjects() || []);
  const hasKids = {};
  (S.subjects() || []).forEach(function (s) { const pp = pm[String(s.code)]; if (pp) hasKids[pp] = 1; });
  const collapsed = (code) => !expandAll && !!tbCollapsed[code];
  function visibleOf(code) {
    if (expandAll) return true;
    let cur = code, guard = 0;
    while (cur && guard++ < 40) {
      const pp = pm[cur];
      if (!pp) break;
      if (tbCollapsed[pp]) return false;
      cur = pp;
    }
    return true;
  }
  const rows = [['科目编码', '科目名称', '期初借方', '期初贷方', '本期借方', '本期贷方', '本年累计借方', '本年累计贷方', '期末借方', '期末贷方']];
  const sum = { obD: 0, obC: 0, pD: 0, pC: 0, yD: 0, yC: 0, eD: 0, eC: 0 };
  S.generalLedger(month).forEach(function (r) {
    const code = String(r.code);
    // 树形折叠：与屏幕所见一致（祖先收起的不导出）
    if (!visibleOf(code)) return;
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;
    const obD = r.obDr >= r.obCr ? r.obDr - r.obCr : 0;
    const obC = r.obCr > r.obDr ? r.obCr - r.obDr : 0;
    const eD = r.dir === '借' ? r.balance : 0;
    const eC = r.dir === '贷' ? r.balance : 0;
    // 合计口径与 renderTb 一致：末级或有子但收起才累加（展开父由子级贡献）
    if (!hasKids[code] || collapsed(code)) {
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
    const S0 = getStore();
    const subs = (S0 && S0.subjects) ? S0.subjects() : [];
    if (cb.checked) tbCollapsed = {};
    else tbCollapseToLevel1(subs);
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
      // 「展开所有次级」态下点箭头 = 退出全展，只收起该分支，其余保持展开（保留后续逐级操作）
      chk.checked = false;
      tbCollapsed = {};
    }
    if (tbCollapsed[aCode]) delete tbCollapsed[aCode]; else tbCollapsed[aCode] = true;
    const eInp = document.getElementById('tbPeriodEnd');
    renderTb(eInp ? eInp.value : currentPeriod());
  });
})();

