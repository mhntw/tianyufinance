// 账簿域模块（B 方案解耦）
// 包含：总账(refreshGl) / 明细账(refreshDl) / 多栏账(refreshMl) / 数量总账(refreshQg) /
// 数量明细账(refreshQd) / 核算项目明细账(refreshAx) / 核算项目余额表(refreshAb) /
// 核算项目组合表(refreshAc)
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 注：试算平衡表(trial-balance) 已在 js/pages/ledger/TrialBalance.js 独立迁走，本模块不含。
//
// ============================================================
// 【账簿余额显示口径 —— 本模块唯一总说明，改前必读】
// 总账 / 明细账 / 多栏账的余额固定按**金蝶「账簿余额方向与科目方向相同」的勾选态**渲染：
//   · 方向列 = 科目正常方向（余额为 0 时「平」）
//   · 余额列 = 按科目正常方向为正的带符号金额（反向余额为负，如「借 -2,000.12」）；
//     余额为 0 时留给空
// ------------------------------------------------------------
// 依据（2026-09-22 金蝶实测 + .ais 核对）：
//   · 金蝶账套参数 GLPref.FAutoBalDC = true
//     （添钰来客 2025/2026、绅蓝之星 2025/2026 四个账套全部为 true）
//   · 1012 其他货币资金（借方正科目出现贷方余额 2,000.12）→ 金蝶显示「借 -2,000.12」
//   · 1122006 应收账款_首免全球购（期末余额 0）→ 金蝶三行方向均为「平」、余额列空
//   · 取数层（store.generalLedger 的 obDr/obCr/…/endDr/endCr）已与金蝶 GLBal 逐科目
//     逐月 100% 一致，本口径只影响显示、不影响任何金额
// ------------------------------------------------------------
// 【将来若遇到 FAutoBalDC = false 的金蝶账套】需按该参数切换为：
//   方向列 = 实际余额方向；余额列 = 正数（如「贷 2,000.12」）。届时改本文件 5 处：
//   renderGl / renderDlSegment / renderMl / exportGl / exportDl
// （2026-09-22 决定：不引入用户可切换的开关 —— 账套全为 true，加开关等于造一个永不
//   切换的按钮，且本项目在「凭证字切换」上有过同类返工教训。）
// ------------------------------------------------------------
// 【已知代价，勿当笔误改掉】勾选态下「方向」列表达的是**科目固有方向**，而非
//   《会计基础工作规范》三栏式账页「借或贷」栏所要求的**实际余额方向** ——
//   「借 -2,000.12」需要读者知道"负号 = 与该科目正常方向相反"。这是跟随金蝶默认
//   口径的取舍；业务事实（余额在哪一方、多少钱）不受影响。
// ============================================================

const H = globalThis.__TY_HELPERS__ || {};
const EX = globalThis.__TY_EXPORT__ || {};
const $ = H.$;

const money = H.money;
const currentPeriod = H.currentPeriod;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };

// 科目名来自用户录入，渲染前需转义；title 用于列宽不足、名称被省略号截断时展示全名
// HTML 转义：统一走 app.js 的单点实现（H.esc）。
// 复用统一期间取值实现。
const escHtml = H.esc;
const escAttr = escHtml;

import { bindSubjectPicker } from '../../components/SubjectPicker.js?v=dev';
import { createSubjectTree } from '../../components/SubjectTree.js?v=dev';
import { updatePeriodRangeTrigger } from '../../components/PeriodRangePicker.js';

/* ===================== 总账 ===================== */
// 起止期间取值：统一走 app.js 的单点实现（H.periodRangeValue）。
// 复用统一期间取值实现，避免多份拷贝失同步。
// 口径：回填默认期间 + 同步触发器文本，返回结束期间。
const periodRangeValue = H.periodRangeValue;
// 区间期间取值：返回 {start, end}，供明细账等支持范围选择的页面使用。
const periodRangeValues = H.periodRangeValues || function (prefix) {
  var e = periodRangeValue(prefix);
  return { start: e, end: e };
};

// 利润表金额跳转来的总账科目过滤（Set(code) | null）：仅显示对应编码，跳转目标强制显示
var glFilterCodes = null;

// 金额点击触发：按科目编码跳总账并定位
// codes: 科目编码数组（多科目行全部带入）
// month: 目标期间，一律传区间末月 —— 总账是单期口径，只按这一期取数。
// 注：单期口径下只传区间末月，Start=End 同值（原范围签名第三参 toMonth 已废弃）。
globalThis.__glJumpTo = function (codes, month) {
  var gi = document.getElementById('glCode');
  if (gi) gi.value = (codes || []).join(','); // 同步到筛选框，与手输筛选表现一致
  var sInp = document.getElementById('glPeriodStart');
  var eInp = document.getElementById('glPeriodEnd');
  if (sInp && eInp && month) {
    sInp.value = month;
    eInp.value = month;
    updatePeriodRangeTrigger('glPeriodStart', 'glPeriodEnd');
  }
  if (globalThis.goPage) globalThis.goPage('general-ledger');
  glFilterCodes = new Set((codes || []).map(String)); // 跳转来的编码始终有效，直接写入过滤集合
  refreshGl();
};

// 跳转到总账后，表头展示“仅显示”提示与清除入口
function updateGlFilterBanner() {
  var el = document.getElementById('glFilterHint');
  if (!el) return;
  if (!glFilterCodes || glFilterCodes.size === 0) { el.hidden = true; el.innerHTML = ''; return; }
  var subs = (S.subjects() || []).filter(function (s) { return glFilterCodes.has(String(s.code)); });
  var names = subs.map(function (s) { return s.code + ' ' + s.name; });
  glFilterCodes.forEach(function (c) {
    if (!subs.some(function (s) { return String(s.code) === c; })) names.push(c);
  });
  el.hidden = false;
  el.innerHTML = '当前仅显示：' + escHtml(names.join('、')) +
    ' <a href="#" id="glFilterClear" class="gl-filter-clear">清除筛选</a>';
}

// 清除总账科目过滤
if (!globalThis.__glFilterClearBound) {
  globalThis.__glFilterClearBound = true;
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('#glFilterClear');
    if (!a) return;
    e.preventDefault();
    glFilterCodes = null;
    var gi = document.getElementById('glCode');
    if (gi) gi.value = '';
    refreshGl();
  });
}

// 总账「科目」筛选框：单框模式（bindSubjectPicker，与录凭证科目框同款）。
// 点/聚焦即弹科目树，输入实时按编码/名称过滤，Enter 确认；选中科目及其下级组成过滤集合。
// 与利润表跳转共用同一 glFilterCodes 过滤机制与横幅（跳转直接写 glFilterCodes，不走此框）。
var glSubjPicker = null;
function glSubjectPicker() {
  if (!glSubjPicker) {
    glSubjPicker = bindSubjectPicker(document.getElementById('glCode'), {
      getSubjects: function () { return S.subjects(); },
      onPick: function (code) {
        if (!code) return;
        var gi = document.getElementById('glCode');
        if (gi) gi.value = code; // 框内显示当前选中（重开弹层时与录凭证同款：先看到当前科目）
        glFilterCodes = glCodesFor(code);
        refreshGl();
      }
    });
  }
  return glSubjPicker;
}
// 选中科目及其下级（前缀匹配）组成过滤集合；无可匹配时回落为全部
function glCodesFor(code) {
  var c = String(code);
  var set = new Set();
  (S.subjects() || []).forEach(function (s) {
    var sc = String(s.code);
    if (sc === c || sc.indexOf(c) === 0) set.add(sc);
  });
  return set.size ? set : null;
}

function refreshGl() {
  // 同步 glHideZero 勾选（仅在 __refreshAll 场景下有意义：切账套后 checkbox 要跟新账套的 param 对齐）
  // 不能删：否则用户在账套 A 勾选隐藏零行，切到账套 B 还是 checked 但 param 可能是 false
  var glHz = document.getElementById('glHideZero');
  if (glHz) glHz.checked = !!(S.state.param && S.state.param.bookHideZero);
  glSubjectPicker(); // 确保筛选框已绑定（页面 section 常驻 DOM）
  var month = periodRangeValue('glPeriod');
  renderGl(month);
}
function renderGl(month) {
  var tb = $('glBody'); tb.innerHTML = '';
  if (!month) return;
  var hideZero = !!(document.getElementById('glHideZero') && document.getElementById('glHideZero').checked);
  var glExpand = document.getElementById('glExpandAll');
  var expandAll = !!(glExpand && glExpand.checked);
  S.generalLedger(month).forEach(function (r) {
    if (glFilterCodes && !glFilterCodes.has(r.code)) return;
    if (!expandAll && r.code.length > 4) return;
    // 隐藏零行：判据唯一实现在 store.isZeroLedgerRow（含本年累计，对齐金蝶 GL_ShowZeroRecOnLdg）。
    // 有科目筛选时不隐藏 —— 否则筛完只剩几行还被藏掉，人会以为科目丢了。
    if (hideZero && !glFilterCodes && S.isZeroLedgerRow(r)) return;
    var subj = S.subject(r.code);
    var depth = (expandAll && subj && typeof subj.level === 'number') ? subj.level : 0;
    var indent = S.subjectIndentHTML(depth);
    // 余额显示口径 = 金蝶账簿口径（总说明与切换指引见文件顶部；与明细账 renderDlSegment 同口径）：
    //   方向列 = 科目正常方向（余额为 0 时「平」）；余额列 = 按科目正常方向为正的带符号金额，
    //   反方向为负；余额为 0 时余额列留空。
    // 依据（2026-09-22 用户实测金蝶）：1012 其他货币资金（借方科目）出现贷方余额 2,000.12 时，
    //   金蝶显示「方向 借 + 余额 -2,000.12」；贷方科目贷余则显示「方向 贷 + 正数」。
    // 【历史缺陷】本表原用「实际方向 + 绝对值」，同一笔余额在总账（贷 +2,000.12）与明细账
    //   （借 -2,000.12）符号相反、也与金蝶对不上 —— 现统一为金蝶口径，勿再改回。
    // 余额显示口径：统一走 store.displayBalance（**唯一实现**，见 store.js 说明）。
    // 总账余额为 0 时方向列显示「平」（与金蝶账簿一致）。
    // 【历史缺陷】本表曾自写一套「实际方向 + 绝对值」，与明细账的「科目正常方向 + 符号」
    //   各写一份 → 同一笔 1012 余额在总账（贷 +2,000.12）与明细账（借 -2,000.12）反号。
    //   收口到单点后，页面不再持有任何余额换算逻辑（只做取值与排版）。
    var _ob = S.displayBalance(r.obDr - r.obCr, r.normal);
    var _end = S.displayBalance(r.endDr - r.endCr, r.normal);
    var obDir = _ob.dir, obSigned = _ob.amount;
    var endDir = _end.dir, endSigned = _end.amount;
    // Row 1: 期初余额（前两列 rowspan=3；编码列不缩进，名称列缩进——与余额表统一）
    var tr1 = document.createElement('tr');
    tr1.className = 'gl-subject';
    tr1.innerHTML =
      '<td rowspan="3" class="mono"><a href="#" class="link-gl-subject" data-code="' + escAttr(r.code) + '">' + escHtml(r.code) + '</a></td>' +
      '<td rowspan="3" class="gl-name" title="' + escAttr(r.name) + '">' + indent + escHtml(r.name) + '</td>' +
      '<td class="gl-period">' + escHtml(month) + '</td>' +
      '<td class="gl-seg">期初余额</td>' +
      '<td class="ta-r mono"></td>' +
      '<td class="ta-r mono"></td>' +
      '<td class="gl-dir">' + obDir + '</td>' +
      '<td class="ta-r mono">' + (obSigned ? money(obSigned) : '') + '</td>';
    tb.appendChild(tr1);
    // Row 2: 本期合计
    var tr2 = document.createElement('tr');
    tr2.className = 'gl-sub';
    tr2.innerHTML =
      '<td class="gl-period">' + escHtml(month) + '</td>' +
      '<td class="gl-seg">本期合计</td>' +
      '<td class="ta-r mono">' + (r.periodDr ? money(r.periodDr) : '') + '</td>' +
      '<td class="ta-r mono">' + (r.periodCr ? money(r.periodCr) : '') + '</td>' +
      '<td class="gl-dir">' + endDir + '</td>' +
      '<td class="ta-r mono">' + (endSigned ? money(endSigned) : '') + '</td>';
    tb.appendChild(tr2);
    // Row 3: 本年累计
    var tr3 = document.createElement('tr');
    tr3.className = 'gl-sub gl-last';
    tr3.innerHTML =
      '<td class="gl-period">' + escHtml(month) + '</td>' +
      '<td class="gl-seg">本年累计</td>' +
      '<td class="ta-r mono">' + (r.ytdDr ? money(r.ytdDr) : '') + '</td>' +
      '<td class="ta-r mono">' + (r.ytdCr ? money(r.ytdCr) : '') + '</td>' +
      '<td class="gl-dir">' + endDir + '</td>' +
      '<td class="ta-r mono">' + (endSigned ? money(endSigned) : '') + '</td>';
    tb.appendChild(tr3);
  });
  updateGlFilterBanner();
}

/* ===================== 明细账 ===================== */
// 科目选择由右侧「科目快速切换」树驱动（表头已无科目输入框）：
// dlCurCode = 当前科目 code；null 表示全部科目（按科目分组列出）。
var dlCurCode = null;
var dlTree = null;        // 明细账右侧「科目快速切换」树
var dlTreeSig = '';       // 科目表签名：账套切换后科目变化则重建树
function dlSubjectCodes() {
  return { codes: dlCurCode ? new Set([String(dlCurCode)]) : null, err: '' };
}
// 树只显示「有发生记录的科目」及其祖先：账套 420 个科目全列出来没有切换的意义，
// 会计实际用到的通常几十到一百来个（的快速切换也是只显示发生科目）。
// 口径：出现过在任意凭证分录中的科目；为保留层级，其父科目一并带上。
function dlTreeSubjects() {
  var subs = S.subjects() || [];
  var used = new Set();
  (S.state.vouchers || []).forEach(function (v) {
    (v.entries || []).forEach(function (e) {
      if (e.code != null) used.add(String(e.code));
    });
  });
  if (!used.size) return subs;
  return subs.filter(function (s) {
    var code = String(s.code);
    if (used.has(code)) return true;
    // 有下级发生了，则本父科目也需要出现（否则层级断裂、点不到）
    for (var i = 0; i < subs.length; i++) {
      var t = String(subs[i].code);
      if (used.has(t) && t.length > code.length && t.indexOf(code) === 0) return true;
    }
    return false;
  });
}
// 挂载明细账右侧「科目快速切换」树（惰性一次）
function dlTreePanel() {
  var panel = document.getElementById('dlSubjectTreePanel');
  if (!panel) return null;
  if (!dlTree) {
    dlTree = createSubjectTree({
      container: panel,
      getSubjects: dlTreeSubjects,
      onPick: function (code) {
        dlCurCode = String(code);
        refreshDl();
      },
      storageKey: 'dlSubjTree'
    });
    if (dlTree) dlTree.refresh();
  }
  return dlTree;
}
// 科目表变了（换账套）则重建树；单一科目查询时让树高亮当前行
function dlTreeSyncCurrent(sc) {
  var t = dlTreePanel();
  if (!t) return;
  var sig = dlTreeSubjects().length;   // 换账套后发生科目集合变化 → 触发重建
  if (sig !== dlTreeSig) { dlTreeSig = sig; if (dlTree) dlTree.refresh(); }
  var single = null;
  if (sc && sc.codes && sc.codes.size === 1) sc.codes.forEach(function (c) { single = c; });
  t.setCurrent(single);
}
// 首次进入明细账默认定位第一个有发生的科目（行为）——右侧树自动展开父链并高亮，
// 主表直接显示该科目明细，而不是一进来铺全部科目。只做一次，之后由树的点选决定。
var dlAutoFirstDone = false;
function dlFirstUsedCode() {
  var inSubs = {};
  (S.subjects() || []).forEach(function (s) { inSubs[String(s.code)] = 1; });
  var min = null;
  (S.state.vouchers || []).forEach(function (v) {
    (v.entries || []).forEach(function (e) {
      if (e.code == null) return;
      var c = String(e.code);
      if (!inSubs[c]) return;
      if (min === null || c < min) min = c;
    });
  });
  return min;
}
function refreshDl() {
  var range = periodRangeValues('dlPeriod');
  if (!dlAutoFirstDone) {
    dlAutoFirstDone = true;
    if (dlCurCode == null) {
      var first = dlFirstUsedCode();
      if (first) { dlCurCode = first; renderDl(range); return; }
    }
  }
  renderDl(range);
}
// 跨页跳转：总账等页点「科目编码」→ 切到明细账并定位该科目（明细账单科目模式）
globalThis.__dlJumpTo = function (code) {
  if (code == null) return;
  dlCurCode = String(code);
  if (globalThis.goPage) globalThis.goPage('detail-ledger');
};
// 账簿中 .link-gl-subject（科目编码链接）点击 → 跳明细账（只绑一次）
if (!globalThis.__glSubjectBound) {
  globalThis.__glSubjectBound = true;
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.link-gl-subject');
    if (!a) return;
    e.preventDefault();
    if (globalThis.__dlJumpTo) globalThis.__dlJumpTo(a.getAttribute('data-code'));
  });
}
// 渲染一个科目的明细账段（期初 / 逐笔 / 本期合计 / 本年累计）
// vmap：date|word-no → voucher.id，用于把凭证字号渲染成可点链接
// 全部凭证一次性建立（按日期+字号精确匹配，天然规避跨月同字号串号）
function voucherVmap() {
  var vm = {};
  (S.state.vouchers || []).forEach(function (v) {
    var vk = (v.date || '') + '|' + (v.word || '') + '-' + v.no;
    if (!vm[vk]) vm[vk] = v.id;
  });
  return vm;
}
// 凭证字号单元格：命中映射出可点链接 → 打开该凭证；未命中（如已删除）退化为纯文本
function voucherLinkCell(r, vm) {
  var vk = (r.date || '') + '|' + (r.word || '') + '-' + r.no;
  var vId = (vm && vm[vk]) || '';
  return vId
    ? '<a href="#" class="link-voucher" data-id="' + escAttr(vId) + '">' + escHtml(r.word) + '-' + escHtml(r.no) + '</a>'
    : escHtml(r.word) + '-' + escHtml(r.no);
}
function renderDlSegment(tb, code, range, vmap) {
  var d;
  if (range && range.start && range.end && range.start !== range.end && typeof S.detailLedgerRange === 'function') {
    d = S.detailLedgerRange(code, range.start, range.end);
  } else {
    d = S.detailLedger(code, range && range.end ? range.end : (range && range.start ? range.start : null));
  }
  if (!d) return false;
  var s = d.subject;
  // 余额显示口径 = 金蝶账簿口径（总说明与切换指引见文件顶部；总账 renderGl / 多栏账 renderMl 同此实现）：
  //   余额非 0 → 方向列 = 科目正常方向；余额列 = 按科目正常方向为正的带符号金额（反方向为负）。
  //   余额为 0 → 方向列 = 「平」，余额列留空。
  // 依据（2026-09-22 用户实测金蝶 KIS 明细账）：
  //   ① 1012 其他货币资金（借方科目）出现贷方余额 2,000.12 → 金蝶显示「方向 借 + 余额 -2,000.12」；
  //      同一笔余额在金蝶「科目余额表」里则是「借方列 -2,000.12」（借贷分列 + 反向带负号，
  //      那是另一张表的表式，两者不冲突）。
  //   ② 1122006 应收账款_首免全球购 期末余额 0 → 金蝶方向列显示「平」、金额列空
  //      （原实现显示空白 + 0.00，与金蝶不一致）。
  // ⚠ 不要再改回「实际方向 + 绝对值」：那会让同一笔余额在总账/明细账之间反号
  //   （2026-09 已犯过一次，见 renderGl 注释）。
  // 余额显示口径：统一走 store.displayBalance（**唯一实现**，见 store.js 顶部说明）。
  // 数据来源有两种形态，先用 store.netFromBalDir 归一为「借正贷负」净额：
  //   · 期初 / 本期合计 / 本年累计行 → store 给净额分量（obDr/obCr、endDr/endCr）
  //   · 逐笔明细行                  → store 给「绝对值 bal + 实际方向 dir」
  // 历史缺陷：本表曾自己维护 dirText/balText 两个换算函数（且期初行的 obDir 还用「实际
  //   方向」），与总账各写一份 → 同一笔 1012 余额两页反号。收口到单点后已无此可能。
  var obView = S.displayBalance(d.obDr - d.obCr, s.normal, '平');
  var endView = S.displayBalance(d.endDr - d.endCr, s.normal, '平');
  function lineView(row) { return S.displayBalance(S.netFromBalDir(row.bal, row.dir), s.normal, '平'); }
  function amtText(v) { return v ? money(v) : ''; }
  // 科目分组行：单科目模式下一眼看不出在看哪个科目，"全部"模式下更是必需
  var th = document.createElement('tr');
  th.className = 'dl-subj-head';
  th.innerHTML = '<td class="mono">' + escHtml(s.code) + '</td><td colspan="6">' + escHtml(s.name) + '</td>';
  tb.appendChild(th);
  var tro = document.createElement('tr');
  tro.className = 'dl-seg';
  // 期初行：借贷方列强制空，只在方向+余额列显示净额（列序与金蝶一致：方向在前、余额在后）
  tro.innerHTML = '<td></td><td></td><td>期初余额</td><td class="ta-r mono"></td><td class="ta-r mono"></td><td>' + obView.dir + '</td><td class="ta-r mono">' + amtText(obView.amount) + '</td>';
  tb.appendChild(tro);
  d.rows.forEach(function (r) {
    // 凭证字号可点 → 跳转到该凭证（可编辑，store 保证仅未结账期间可保存）
    var vchTd = voucherLinkCell(r, vmap);
    var v = lineView(r);
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + r.date + '</td><td>' + vchTd + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(r.summary) + '">' + escHtml(r.summary) + '</td>' +
      '<td class="ta-r mono">' + money(r.dr) + '</td><td class="ta-r mono">' + money(r.cr) + '</td><td>' + v.dir + '</td><td class="ta-r mono">' + amtText(v.amount) + '</td>';
    tb.appendChild(tr);
  });
  var trc = document.createElement('tr');
  trc.className = 'dl-seg';
  trc.innerHTML = '<td></td><td></td><td>本期合计</td><td class="ta-r mono">' + money(d.periodDr) + '</td><td class="ta-r mono">' + money(d.periodCr) + '</td><td>' + endView.dir + '</td><td class="ta-r mono">' + amtText(endView.amount) + '</td>';
  tb.appendChild(trc);
  var try_ = document.createElement('tr');
  try_.className = 'dl-seg';
  try_.innerHTML = '<td></td><td></td><td>本年累计</td><td class="ta-r mono">' + money(d.ytdDr) + '</td><td class="ta-r mono">' + money(d.ytdCr) + '</td><td>' + endView.dir + '</td><td class="ta-r mono">' + amtText(endView.amount) + '</td>';
  tb.appendChild(try_);
  return true;
}

function renderDl(range) {
  var tb = $('dlBody'); if (!tb) return;
  tb.innerHTML = '';
  var sc = dlSubjectCodes();
  if (sc.err) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-hint" style="color:var(--ty-red)">' + escHtml(sc.err) + '</td></tr>';
    return;
  }
  if (!range || !range.start || !range.end) return;
  // 全部科目：按科目分组依次列出，每组自带期初/合计/累计（汇总行是科目级概念，不能跨科目合并）
  var codes = sc.codes
    ? S.subjects().filter(function (s) { return sc.codes.has(String(s.code)); }).map(function (s) { return s.code; })
    : S.subjects().map(function (s) { return s.code; });
  // date|word-no → voucher.id，供明细行凭证字号跳转
  var vmap = voucherVmap();
  var shown = 0;
  codes.forEach(function (c) {
    if (renderDlSegment(tb, c, range, vmap)) shown++;
  });
  if (!shown) {
    var emptyText = (range.start && range.end && range.start !== range.end)
      ? '所选期间范围无明细记录' : '本期无明细记录';
    tb.innerHTML = '<tr><td colspan="7" class="empty-hint">' + emptyText + '</td></tr>';
  }
  // 右侧科目快速切换树：账套变化重建 + 单一科目查询时高亮当前行
  dlTreeSyncCurrent(sc);
}

/* ===================== 多栏账（按明细科目分栏） ===================== */
// 多栏账与查凭证/明细账不同：它必须选一个「有下级科目」的父科目才能分栏，
// 所以不提供「全部」。但旧实现默认选中第一个科目，而第一个科目往往是叶子科目，
// 一进页面就显示红色错误提示 —— 改为只列非明细科目供选择，没有则给出明确说明。
var mlSubjPicker = null;
var mlCurCode = null;
function mlSubjectCode() {
  if (!mlSubjPicker) {
    mlSubjPicker = bindSubjectPicker(document.getElementById('mlCode'), {
      getSubjects: function () { return S.subjects(); },
      onlyParent: true,
      onPick: function (code) {
        var gi = document.getElementById('mlCode');
        if (gi) gi.value = code || '';
        mlCurCode = code || null;
        refreshMl();
      }
    });
  }
  return { code: mlCurCode || '', err: '' };
}
function refreshMl() {
  var month = periodRangeValue('mlPeriod');
  var r = mlSubjectCode();
  renderMl(r.code, month, r.err);
}
// 取某科目的【直属】下级科目（多栏账按直属子目分栏）。
// 父子一律以「表内最长真前缀」判定（兼容 4+2 与 7/9 位混合账）：
// B 是 A 的直属子 ⟺ B 的最长表内前缀 == A。
function childSubjectsOf(code) {
  var subs = S.subjects();
  var by = {};
  subs.forEach(function (s) { by[s.code] = 1; });
  var under = subs.filter(function (s) {
    return s.code !== code && s.code.indexOf(code) === 0 && s.code.length > code.length;
  });
  var direct = under.filter(function (s) {
    for (var L = s.code.length - 1; L > 0; L--) {
      var pre = s.code.slice(0, L);
      if (by[pre]) return pre === code; // 最长表内前缀
    }
    return false;
  });
  if (!direct.length) direct = under; // 兜底：无直属时沿用全部下级（保持旧行为不空列）
  return direct;
}
function renderMl(code, month, err) {
  var tb = $('mlBody'); tb.innerHTML = '';
  var thead = $('mlHead'); thead.innerHTML = '';
  var tip = $('mlTip');
  if (err && tip) {
    tip.className = 'open-check warn';
    tip.textContent = err;
    emptyRow(tb, 7, '');
    return;
  }
  if (!month) return;
  // 未选科目：给出引导，而不是像旧实现那样默认选一个叶子科目后报错
  if (!code) {
    if (tip) {
      tip.className = 'open-check';
      tip.textContent = '请选择需要分栏查看的科目（多栏账按该科目的下级科目分栏）。';
    }
    emptyRow(tb, 7, '请选择科目');
    return;
  }
  var cols = childSubjectsOf(code);
  if (!cols.length) {
    tip.className = 'open-check warn';
    tip.textContent = '所选科目为最明细科目或无下级科目，无法生成多栏式明细账。请选择存在下级科目的非明细科目。';
    emptyRow(tb, 7, '请选择非最明细科目');
    return;
  }
  tip.className = 'open-check';
  tip.textContent = '多栏账须选择非最明细科目（该科目下应有下级科目或核算项目），否则无法生成多栏式格式。';
  // 表头两行：基础 7 列 rowspan 占满两行；第 1 行末是跨全部分栏列的父表头
  // 「借方」，第 2 行才是各分栏列头（编码 + 名称）。分栏列头长短不一，加 title 保证
  // 列宽不足时悬停仍能看到全名（CSS .ml-col-head 会截断）。
  // 对齐按全局约定：金额列（借方/贷方/余额）带 ta-r，其余列默认左
  var ML_BASE_HEADS = ['日期', '凭证字号', '摘要', '借方', '贷方', '方向', '余额'];
  var ML_AMT_HEADS = { '借方': 1, '贷方': 1, '余额': 1 };
  // 摘要列吸收剩余宽度（列宽约定里的 col-fill）：多栏账列数动态，只有摘要适合吸收
  var ML_FILL_HEADS = { '摘要': 1 };
  thead.innerHTML = '<tr>'
    + ML_BASE_HEADS.map(function (h) {
        var cls = ML_AMT_HEADS[h] ? 'ta-r' : (ML_FILL_HEADS[h] ? 'col-fill' : '');
        return '<th rowspan="2"' + (cls ? ' class="' + cls + '"' : '') + '>' + h + '</th>';
      }).join('')
    + '<th class="ml-col-parent" colspan="' + cols.length + '">借方</th></tr>'
    + '<tr>' + cols.map(function (c) {
        var label = c.code + (c.name ? ' ' + c.name : '');
        return '<th class="ml-col-head" title="' + escAttr(label) + '">'
          + escHtml(c.code) + (c.name ? ' ' + escHtml(c.name) : '') + '</th>';
      }).join('') + '</tr>';
  // 不再手工计算 minWidth：全局 `.grid { width: max-content }` 会按内容自动得出表格宽度，
  // 多栏账列数动态（7 + 下级科目数）也能正确覆盖，无需 JS 参与。
  var d = S.detailLedger(code, month);
  if (!d || !d.rows.length) {
    var colCount = 7 + cols.length;
    tb.innerHTML = '<tr><td colspan="' + colCount + '" class="empty-hint">暂无数据</td></tr>';
    return;
  }
  var subj = d.subject;
  // 余额列口径 = 金蝶账簿口径（总说明与切换指引见文件顶部；与总账 renderGl、明细账 renderDlSegment 完全一致）：
  //   余额非 0 → 方向列 = 科目正常方向；余额列 = 按科目正常方向为正的带符号金额。
  //   余额为 0 → 方向列 = 「平」，余额列留空（金蝶账簿实测）。
  // 【历史缺陷】本表原用「实际方向 + 绝对值」，与同构的明细账、与金蝶均不符，现统一。
  // 余额显示口径：统一走 store.displayBalance（**唯一实现**，见 store.js 说明）。
  // 本表与總账/明细账同构（方向列 + 带符号余额），历史上却各写一份 → 三页符号不一。
  var obView = S.displayBalance(d.obDr - d.obCr, subj.normal);
  var obSigned = obView.amount, obDir = obView.dir;
  var tro = document.createElement('tr');
  tro.className = 'ml-seg';
  // 各分栏列期初余额（此前整行留空）。
  // 取总账口径：generalLedger 的行已按 rollCodes 上卷（父行 = 自身 + 子目合计），
  // 与分栏列「命中本列及其下级」的取数范围一致；符号同样「借方为正、贷方为负」。
  var obByCode = {};
  S.generalLedger(month).forEach(function (gr) { obByCode[gr.code] = num(gr.obDr) - num(gr.obCr); });
  // 期初行：借贷方列强制空（期初是"状态"不是"本期发生额"），
  // 只在方向+余额列显示净额，分栏列显示各下级科目的期初余额。
  // 日期列取区间首月 1 号（此前留空）——
  // 期初是"区间首月月初"这个时点，标出日期才看得出锚在哪一天；单期口径下即 month-01。
  var obDate = /^\d{4}-\d{2}$/.test(String(month)) ? month + '-01' : '';
  var initCells = '<td>' + obDate + '</td><td></td><td>期初余额</td>' +
    '<td class="ta-r mono"></td><td class="ta-r mono"></td>' +
    '<td>' + obDir + '</td><td class="ta-r mono">' + (obSigned ? money(obSigned) : '') + '</td>';
  cols.forEach(function (c) {
    initCells += '<td class="ta-r mono">' + money(obByCode[c.code] || 0) + '</td>';
  });
  tro.innerHTML = initCells;
  tb.appendChild(tro);
  // 逐笔滚动余额：内部一律维护「借正贷负」净额，方向与符号交给 store.displayBalance（唯一口径）
  var runNet = d.obDr - d.obCr;
  var colDr = {}, colCr = {};
  cols.forEach(function (c) { colDr[c.code] = 0; colCr[c.code] = 0; });
  var vm = voucherVmap();
  d.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var rowCells = '<td>' + r.date + '</td><td>' + voucherLinkCell(r, vm) + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(r.summary) + '">' + escHtml(r.summary) + '</td>' +
      '<td class="ta-r mono">' + money(r.dr) + '</td><td class="ta-r mono">' + money(r.cr) + '</td>';
    runNet += num(r.dr) - num(r.cr);
    var runView = S.displayBalance(runNet, subj.normal);
    rowCells += '<td>' + runView.dir + '</td><td class="ta-r mono">' + (runView.amount ? money(runView.amount) : '') + '</td>';
    var entryCode = r.entryCode || '';
    cols.forEach(function (c) {
      var amt = '';
      if (entryCode && (entryCode === c.code || entryCode.indexOf(c.code) === 0)) {
        // 有符号金额：借方为正、贷方为负（标准口径）。原实现 money(r.dr || r.cr)
        // 一律取正数，贷方发生额也显示为正，看表时分不出方向。
        amt = money(num(r.dr) - num(r.cr));
      }
      rowCells += '<td class="ta-r mono">' + amt + '</td>';
    });
    tr.innerHTML = rowCells;
    tb.appendChild(tr);
  });
  // 本期合计：借贷列给本期发生额；余额列给期末余额
  // （原实现误用「本期发生额净额」当期余额，与明细账、金蝶均不符，已改正）
  var endView = S.displayBalance(d.endDr - d.endCr, subj.normal);
  var endDir = endView.dir, endSigned = endView.amount;
  var sumCells = '<td></td><td></td><td>本期合计</td>' +
    '<td class="ta-r mono">' + money(d.periodDr) + '</td><td class="ta-r mono">' + money(d.periodCr) + '</td>' +
    '<td>' + endDir + '</td><td class="ta-r mono">' + (endSigned ? money(endSigned) : '') + '</td>';
  cols.forEach(function (c) { sumCells += '<td class="ta-r mono"></td>'; });
  var trc = document.createElement('tr'); trc.className = 'ml-seg';
  trc.innerHTML = sumCells;
  tb.appendChild(trc);
  // 本年累计：借贷列给本年累计发生额；余额列同样给期末余额
  // （与明细账 renderDlSegment、金蝶总账「本年累计」行同口径）
  var ytdCells = '<td></td><td></td><td>本年累计</td>' +
    '<td class="ta-r mono">' + money(d.ytdDr) + '</td><td class="ta-r mono">' + money(d.ytdCr) + '</td>' +
    '<td>' + endDir + '</td><td class="ta-r mono">' + (endSigned ? money(endSigned) : '') + '</td>';
  cols.forEach(function (c) { ytdCells += '<td class="ta-r mono"></td>'; });
  var try_ = document.createElement('tr'); try_.className = 'ml-seg ml-last';
  try_.innerHTML = ytdCells;
  tb.appendChild(try_);
}

function emptyRow(tbody, colspan, text) {
  tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="empty-hint">' + text + '</td></tr>';
}

export {
  refreshGl, refreshDl, refreshMl
};

// 总账导出：标准 8 列 + 合并单元格（A/B 列按科目纵向合并 3 行）
function exportGl() {
  var XLSX = globalThis.XLSX;
  if (!XLSX) { H.showToast('导出组件未加载', 'error'); return; }
  var safeExport = globalThis.__safeExportExcel;
  if (!safeExport) { H.showToast('导出功能不可用', 'error'); return; }
  var month = periodRangeValue('glPeriod');
  if (!month) { H.showToast('请先选择期间', 'warn'); return; }
  var hideZero = !!(document.getElementById('glHideZero') && document.getElementById('glHideZero').checked);
  var expandAll = !!(document.getElementById('glExpandAll') && document.getElementById('glExpandAll').checked);
  var rows = [
    ['科目编码', '科目名称', '期间', '摘要', '借方', '贷方', '方向', '余额']
  ];
  // 合并单元格记录：XLSX 用 0-based 行索引
  var merges = [];
  S.generalLedger(month).forEach(function (r) {
    if (glFilterCodes && !glFilterCodes.has(r.code)) return;
    if (!expandAll && r.code.length > 4) return;
    if (hideZero && !glFilterCodes && S.isZeroLedgerRow(r)) return;   // 与屏幕 renderGl 同判据
    var subj = S.subject(r.code);
    var depth = (expandAll && subj && typeof subj.level === 'number') ? subj.level : 0;
    var indent = S.subjectIndentSpaces(depth);
    var nameCol = indent + (r.name || '');
    // 余额口径与屏幕 renderGl 完全一致（金蝶账簿口径）：方向列 = 科目正常方向（0 时「平」），
    // 余额列 = 按科目正常方向为正的带符号金额（反方向为负）。
    // 期初余额列此前漏填（屏幕已有、导出空白）—— 一并补上，保证导出与屏幕同一口径。
    // 余额显示口径：统一走 store.displayBalance（**唯一实现**，见 store.js 说明）。
    // 导出口径必须与屏幕 renderGl 完全同源 —— 历史上曾出现「导出与自己的屏幕反号／漏列」。
    var _ob = S.displayBalance(r.obDr - r.obCr, r.normal);
    var _end = S.displayBalance(r.endDr - r.endCr, r.normal);
    var obDir = _ob.dir, obSigned = _ob.amount;
    var endDir = _end.dir, endSigned = _end.amount;
    // 记录当前科目起始行（0-based，不含表头）
    var startRow = rows.length;
    // Row 1: 期初余额（A/B 列第一行写值，后两行空，靠 merge 合并）
    rows.push([r.code, nameCol, month, '期初余额', '', '', obDir, obSigned || '']);
    // Row 2: 本期合计
    rows.push(['', '', month, '本期合计', r.periodDr || '', r.periodCr || '', endDir, endSigned || '']);
    // Row 3: 本年累计
    rows.push(['', '', month, '本年累计', r.ytdDr || '', r.ytdCr || '', endDir, endSigned || '']);
    // 合并 A 列 (科目编码) 和 B 列 (科目名称)
    merges.push({ s: { r: startRow, c: 0 }, e: { r: startRow + 2, c: 0 } });
    merges.push({ s: { r: startRow, c: 1 }, e: { r: startRow + 2, c: 1 } });
  });
  if (rows.length <= 1) { H.showToast('当前条件下没有可导出的数据', 'warn'); return; }
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  ws['!cols'] = [
    { wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 10 },
    { wch: 14 }, { wch: 14 }, { wch: 6 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '总账');
  safeExport(wb, '总账_' + month);
  H.showToast('已导出总账_' + month, 'success');
}
// 挂到全局 + 绑定按钮
globalThis.__exportGl = exportGl;
var bGlExport = document.getElementById('btnGlExport');
if (bGlExport) bGlExport.addEventListener('click', exportGl);

// 明细账导出：标准 9 列（科目编码/名称 + 日期/凭证字号/摘要/借/贷/方向/余额，
// 列序与屏幕及金蝶一致：方向在余额前），
// 每个科目一段（期初余额 → 逐笔 → 本期合计 → 本年累计），与界面渲染口径一致。
function exportDl() {
  var XLSX = globalThis.XLSX;
  if (!XLSX) { H.showToast('导出组件未加载', 'error'); return; }
  var safeExport = globalThis.__safeExportExcel;
  if (!safeExport) { H.showToast('导出功能不可用', 'error'); return; }
  var range = periodRangeValues('dlPeriod');
  if (!range.end) { H.showToast('请先选择期间', 'warn'); return; }
  var isRange = range.start && range.end && range.start !== range.end;
  var rows = [['科目编码', '科目名称', '日期', '凭证字号', '摘要', '借方', '贷方', '方向', '余额']];
  // dlCurCode 为 null = 「全部科目」模式（与界面 renderDl 一致），否则仅当前科目
  var codes = dlCurCode
    ? [String(dlCurCode)]
    : (S.subjects() || []).map(function (s) { return s.code; });
  var shown = 0;
  codes.forEach(function (code) {
    var d;
    if (isRange && typeof S.detailLedgerRange === 'function') {
      d = S.detailLedgerRange(code, range.start, range.end);
    } else {
      d = S.detailLedger(code, range.end);
    }
    if (!d) return;
    var s = d.subject;
    // 余额口径与屏幕 renderDlSegment 完全一致（金蝶账簿口径）：方向列 = 科目正常方向
    // （余额为 0 时留空），余额列 = 按科目正常方向为正的带符号金额。
    // 【历史缺陷】导出原用「实际方向 + 绝对值」，与同表屏幕显示反号，导出后核对会再次对不上。
    // 余额口径与屏幕 renderDlSegment 完全同源：一律走 store.displayBalance（**唯一实现**）。
    // 导出口径若与屏幕不一致，用户拿导出件核对时照样会对不上（2026-09 已发生过一次）。
    var obView = S.displayBalance(num(d.obDr) - num(d.obCr), s.normal);
    rows.push([s.code, s.name, '', '', '期初余额', '', '', obView.dir, obView.amount || '']);
    d.rows.forEach(function (r) {
      var vch = (r.word || '') + '-' + (r.no || '');
      // 明细行：store 给「绝对值 + 实际方向」，先由 store.netFromBalDir 归一为净额，再走同一口径
      var v = S.displayBalance(S.netFromBalDir(r.bal, r.dir), s.normal);
      rows.push([s.code, s.name, r.date || '', vch, r.summary || '', num(r.dr), num(r.cr), v.dir, v.amount || '']);
    });
    var endView = S.displayBalance(num(d.endDr) - num(d.endCr), s.normal);
    rows.push([s.code, s.name, '', '', '本期合计', num(d.periodDr), num(d.periodCr), endView.dir, endView.amount || '']);
    rows.push([s.code, s.name, '', '', '本年累计', num(d.ytdDr), num(d.ytdCr), endView.dir, endView.amount || '']);
    shown++;
  });
  if (!shown) { H.showToast('当前条件下没有可导出的数据', 'warn'); return; }
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 12 }, { wch: 22 }, { wch: 11 }, { wch: 10 }, { wch: 30 },
    { wch: 14 }, { wch: 14 }, { wch: 6 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '明细账');
  var fname = isRange
    ? '明细账_' + range.start + '_' + range.end
    : '明细账_' + range.end;
  safeExport(wb, fname);
  H.showToast('已导出' + fname, 'success');
}
globalThis.__exportDl = exportDl;
var bDlExport = document.getElementById('btnDlExport');
if (bDlExport) bDlExport.addEventListener('click', exportDl);

// 总账页面内展开勾选框 onchange 入口（暴露到全局，HTML 直接调用）
globalThis.__renderGl = refreshGl;

// glHideZero change → 先写全局 param，再刷新（保证 refreshGl 读到最新值，不会把用户勾选还原）
document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'glHideZero') {
    S.state.param.bookHideZero = e.target.checked;
    S.persist();
    refreshGl();
  }
});
