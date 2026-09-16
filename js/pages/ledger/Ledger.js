// 账簿域模块（B 方案解耦）
// 包含：总账(refreshGl) / 明细账(refreshDl) / 多栏账(refreshMl) / 数量总账(refreshQg) /
// 数量明细账(refreshQd) / 核算项目明细账(refreshAx) / 核算项目余额表(refreshAb) /
// 核算项目组合表(refreshAc)
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 注：试算平衡表(trial-balance) 已在 js/pages/ledger/TrialBalance.js 独立迁走，本模块不含。

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

/* ===================== 通用：安全填充（带守卫，避免查询时重置用户选择） ===================== */
// bookKey：账套切换标识（app.js 内定义）。下面两个下拉守卫靠它判断「是否已为当前账套」，
// 账套不变则跳过重填，保住用户在查询前已选的值。
var bookKey = H.bookKey;
// 核算类别下拉
function safeFillAuxType(sel) {
  var k = bookKey();
  if (sel.dataset.key !== k) { fillAuxTypeSelect(sel); sel.dataset.key = k; }
}
// 核算项目下拉：随类别切换重填
function safeFillAuxItem(sel, typeKey) {
  var k = bookKey() + '|' + typeKey;
  if (sel.dataset.key !== k) { fillAuxItemSelect(sel, typeKey); sel.dataset.key = k; }
}

/* ===================== 总账 ===================== */
// 起止期间取值：统一走 app.js 的单点实现（H.periodRangeValue）。
// 复用统一期间取值实现，避免多份拷贝失同步。
// 口径：回填默认期间 + 同步触发器文本，返回结束期间。
const periodRangeValue = H.periodRangeValue;

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
  el.innerHTML = '当前仅显示：' + names.join('、') +
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
    if (hideZero && !glFilterCodes && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0) return;
    var subj = S.subject(r.code);
    var depth = (expandAll && subj && typeof subj.level === 'number') ? subj.level : 0;
    var indent = S.subjectIndentHTML(depth);
    // 期初方向：obDr - obCr 的符号
    var obDir = (r.obDr - r.obCr > 0) ? '借' : ((r.obDr - r.obCr < 0) ? '贷' : '平');
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
      '<td class="ta-r mono"></td>';
    tb.appendChild(tr1);
    // Row 2: 本期合计
    var tr2 = document.createElement('tr');
    tr2.className = 'gl-sub';
    tr2.innerHTML =
      '<td class="gl-period">' + escHtml(month) + '</td>' +
      '<td class="gl-seg">本期合计</td>' +
      '<td class="ta-r mono">' + (r.periodDr ? money(r.periodDr) : '') + '</td>' +
      '<td class="ta-r mono">' + (r.periodCr ? money(r.periodCr) : '') + '</td>' +
      '<td class="gl-dir">' + (r.dir || '平') + '</td>' +
      '<td class="ta-r mono">' + (r.balance ? money(r.balance) : '') + '</td>';
    tb.appendChild(tr2);
    // Row 3: 本年累计
    var tr3 = document.createElement('tr');
    tr3.className = 'gl-sub gl-last';
    tr3.innerHTML =
      '<td class="gl-period">' + escHtml(month) + '</td>' +
      '<td class="gl-seg">本年累计</td>' +
      '<td class="ta-r mono">' + (r.ytdDr ? money(r.ytdDr) : '') + '</td>' +
      '<td class="ta-r mono">' + (r.ytdCr ? money(r.ytdCr) : '') + '</td>' +
      '<td class="gl-dir">' + (r.dir || '平') + '</td>' +
      '<td class="ta-r mono">' + (r.balance ? money(r.balance) : '') + '</td>';
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
  var month = periodRangeValue('dlPeriod');
  if (!dlAutoFirstDone) {
    dlAutoFirstDone = true;
    if (dlCurCode == null) {
      var first = dlFirstUsedCode();
      if (first) { dlCurCode = first; renderDl(month); return; }
    }
  }
  renderDl(month);
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
function renderDlSegment(tb, code, month, vmap) {
  var d = S.detailLedger(code, month);
  if (!d) return false;
  var s = d.subject;
  // 期初余额行：借贷方列永远显示空（期初是"状态"不是"本期发生额"），
  // 余额列+方向列才显示净额。
  var obNetDr = d.obDr - d.obCr;
  var obBal = Math.abs(obNetDr);
  var obDir = obNetDr === 0 ? '' : (obNetDr > 0 ? '借' : '贷');
  // 科目分组行：单科目模式下一眼看不出在看哪个科目，"全部"模式下更是必需
  var th = document.createElement('tr');
  th.className = 'dl-subj-head';
  th.innerHTML = '<td class="mono">' + escHtml(s.code) + '</td><td colspan="6">' + escHtml(s.name) + '</td>';
  tb.appendChild(th);
  var tro = document.createElement('tr');
  tro.className = 'dl-seg';
  // 期初行：借贷方列强制空，只在余额列显示净额
  tro.innerHTML = '<td></td><td></td><td>期初余额</td><td class="ta-r mono"></td><td class="ta-r mono"></td><td class="ta-r mono">' + money(obBal) + '</td><td>' + obDir + '</td>';
  tb.appendChild(tro);
  d.rows.forEach(function (r) {
    // 凭证字号可点 → 跳转到该凭证（可编辑，store 保证仅未结账期间可保存）
    var vchTd = voucherLinkCell(r, vmap);
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + r.date + '</td><td>' + vchTd + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(r.summary) + '">' + escHtml(r.summary) + '</td>' +
      '<td class="ta-r mono">' + money(r.dr) + '</td><td class="ta-r mono">' + money(r.cr) + '</td><td class="ta-r mono">' + money(r.bal) + '</td><td>' + r.dir + '</td>';
    tb.appendChild(tr);
  });
  var trc = document.createElement('tr');
  trc.className = 'dl-seg';
  var endDir = d.endDr >= d.endCr ? '借' : '贷', endBal = Math.abs(d.endDr - d.endCr);
  trc.innerHTML = '<td></td><td></td><td>本期合计</td><td class="ta-r mono">' + money(d.periodDr) + '</td><td class="ta-r mono">' + money(d.periodCr) + '</td><td class="ta-r mono">' + money(endBal) + '</td><td>' + endDir + '</td>';
  tb.appendChild(trc);
  var try_ = document.createElement('tr');
  try_.className = 'dl-seg';
  try_.innerHTML = '<td></td><td></td><td>本年累计</td><td class="ta-r mono">' + money(d.ytdDr) + '</td><td class="ta-r mono">' + money(d.ytdCr) + '</td><td class="ta-r mono">' + money(endBal) + '</td><td>' + endDir + '</td>';
  tb.appendChild(try_);
  return true;
}

function renderDl(month) {
  var tb = $('dlBody'); if (!tb) return;
  tb.innerHTML = '';
  var sc = dlSubjectCodes();
  if (sc.err) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-hint" style="color:#D93026">' + escHtml(sc.err) + '</td></tr>';
    return;
  }
  if (!month) return;
  // 全部科目：按科目分组依次列出，每组自带期初/合计/累计（汇总行是科目级概念，不能跨科目合并）
  var codes = sc.codes
    ? S.subjects().filter(function (s) { return sc.codes.has(String(s.code)); }).map(function (s) { return s.code; })
    : S.subjects().map(function (s) { return s.code; });
  // date|word-no → voucher.id，供明细行凭证字号跳转
  var vmap = voucherVmap();
  var shown = 0;
  codes.forEach(function (c) {
    if (renderDlSegment(tb, c, month, vmap)) shown++;
  });
  if (!shown) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-hint">本期无明细记录</td></tr>';
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
  var ML_BASE_HEADS = ['日期', '凭证字号', '摘要', '借方', '贷方', '方向', '余额'];
  thead.innerHTML = '<tr>'
    + ML_BASE_HEADS.map(function (h) { return '<th rowspan="2">' + h + '</th>'; }).join('')
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
  // 期初余额行：借贷方列永远空，方向+余额列显示净额
  var obNetDr = d.obDr - d.obCr;
  var obBal = Math.abs(obNetDr);
  var obDir = obNetDr === 0 ? '' : (obNetDr > 0 ? '借' : '贷');
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
    '<td class="ta-c">' + obDir + '</td><td class="ta-r mono">' + money(obBal) + '</td>';
  cols.forEach(function (c) {
    initCells += '<td class="ta-r mono">' + money(obByCode[c.code] || 0) + '</td>';
  });
  tro.innerHTML = initCells;
  tb.appendChild(tro);
  var runBal = obBal, runDir = obDir;
  var colDr = {}, colCr = {};
  cols.forEach(function (c) { colDr[c.code] = 0; colCr[c.code] = 0; });
  var vm = voucherVmap();
  d.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var rowCells = '<td>' + r.date + '</td><td>' + voucherLinkCell(r, vm) + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(r.summary) + '">' + escHtml(r.summary) + '</td>' +
      '<td class="ta-r mono">' + money(r.dr) + '</td><td class="ta-r mono">' + money(r.cr) + '</td>';
    if (runDir === '借') { runBal += num(r.dr) - num(r.cr); }
    else { runBal += num(r.cr) - num(r.dr); }
    if (runBal < 0) { runDir = runDir === '借' ? '贷' : '借'; runBal = Math.abs(runBal); }
    rowCells += '<td class="ta-c">' + runDir + '</td><td class="ta-r mono">' + money(runBal) + '</td>';
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
  var endDr = d.periodDr, endCr = d.periodCr;
  var endDir = endDr >= endCr ? '借' : '贷', endBal = Math.abs(endDr - endCr);
  var sumCells = '<td></td><td></td><td>本期合计</td>' +
    '<td class="ta-r mono">' + money(endDr) + '</td><td class="ta-r mono">' + money(endCr) + '</td>' +
    '<td class="ta-c">' + endDir + '</td><td class="ta-r mono">' + money(endBal) + '</td>';
  cols.forEach(function (c) { sumCells += '<td class="ta-r mono"></td>'; });
  var trc = document.createElement('tr'); trc.className = 'ml-seg';
  trc.innerHTML = sumCells;
  tb.appendChild(trc);
  var ytdEndDir = d.ytdDr >= d.ytdCr ? '借' : '贷', ytdEndBal = Math.abs(d.ytdDr - d.ytdCr);
  var ytdCells = '<td></td><td></td><td>本年累计</td>' +
    '<td class="ta-r mono">' + money(d.ytdDr) + '</td><td class="ta-r mono">' + money(d.ytdCr) + '</td>' +
    '<td class="ta-c">' + ytdEndDir + '</td><td class="ta-r mono">' + money(ytdEndBal) + '</td>';
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
    if (hideZero && !glFilterCodes && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0 && r.ytdBalance === 0) return;
    var subj = S.subject(r.code);
    var depth = (expandAll && subj && typeof subj.level === 'number') ? subj.level : 0;
    var indent = S.subjectIndentSpaces(depth);
    var nameCol = indent + (r.name || '');
    var obDir = (r.obDr - r.obCr > 0) ? '借' : ((r.obDr - r.obCr < 0) ? '贷' : '平');
    // 记录当前科目起始行（0-based，不含表头）
    var startRow = rows.length;
    // Row 1: 期初余额（A/B 列第一行写值，后两行空，靠 merge 合并）
    rows.push([r.code, nameCol, month, '期初余额', '', '', obDir, '']);
    // Row 2: 本期合计
    rows.push(['', '', month, '本期合计', r.periodDr || '', r.periodCr || '', r.dir || '平', r.balance || '']);
    // Row 3: 本年累计
    rows.push(['', '', month, '本年累计', r.ytdDr || '', r.ytdCr || '', r.dir || '平', r.balance || '']);
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

// 明细账导出：标准 9 列（科目编码/名称 + 日期/凭证字号/摘要/借/贷/余额/方向），
// 每个科目一段（期初余额 → 逐笔 → 本期合计 → 本年累计），与界面渲染口径一致。
function exportDl() {
  var XLSX = globalThis.XLSX;
  if (!XLSX) { H.showToast('导出组件未加载', 'error'); return; }
  var safeExport = globalThis.__safeExportExcel;
  if (!safeExport) { H.showToast('导出功能不可用', 'error'); return; }
  var month = periodRangeValue('dlPeriod');
  if (!month) { H.showToast('请先选择期间', 'warn'); return; }
  var rows = [['科目编码', '科目名称', '日期', '凭证字号', '摘要', '借方', '贷方', '余额', '方向']];
  // dlCurCode 为 null = 「全部科目」模式（与界面 renderDl 一致），否则仅当前科目
  var codes = dlCurCode
    ? [String(dlCurCode)]
    : (S.subjects() || []).map(function (s) { return s.code; });
  var shown = 0;
  codes.forEach(function (code) {
    var d = S.detailLedger(code, month);
    if (!d) return;
    var s = d.subject;
    var obNet = num(d.obDr) - num(d.obCr);
    var obBal = Math.abs(obNet);
    var obDir = obNet === 0 ? '' : (obNet > 0 ? '借' : '贷');
    rows.push([s.code, s.name, '', '', '期初余额', '', '', obBal, obDir]);
    d.rows.forEach(function (r) {
      var vch = (r.word || '') + '-' + (r.no || '');
      rows.push([s.code, s.name, r.date || '', vch, r.summary || '', num(r.dr), num(r.cr), num(r.bal), r.dir || '']);
    });
    var endNet = num(d.endDr) - num(d.endCr);
    var endBal = Math.abs(endNet);
    var endDir = endNet >= 0 ? '借' : '贷';
    rows.push([s.code, s.name, '', '', '本期合计', num(d.periodDr), num(d.periodCr), endBal, endDir]);
    rows.push([s.code, s.name, '', '', '本年累计', num(d.ytdDr), num(d.ytdCr), endBal, endDir]);
    shown++;
  });
  if (!shown) { H.showToast('当前条件下没有可导出的数据', 'warn'); return; }
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 12 }, { wch: 22 }, { wch: 11 }, { wch: 10 }, { wch: 30 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 6 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '明细账');
  safeExport(wb, '明细账_' + month);
  H.showToast('已导出明细账_' + month, 'success');
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
