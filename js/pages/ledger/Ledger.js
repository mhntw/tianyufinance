// 账簿域模块（B 方案解耦）
// 包含：总账(refreshGl) / 明细账(refreshDl) / 多栏账(refreshMl) / 数量总账(refreshQg) /
// 数量明细账(refreshQd) / 核算项目明细账(refreshAx) / 核算项目余额表(refreshAb) /
// 核算项目组合表(refreshAc)
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 注：试算平衡表(trial-balance) 已在 js/pages/ledger/TrialBalance.js 独立迁走，本模块不含。

const H = globalThis.__KINGDEE_HELPERS__ || {};
const EX = globalThis.__KINGDEE_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const currentPeriod = H.currentPeriod;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };

// 科目名来自用户录入，渲染前需转义；title 用于列宽不足、名称被省略号截断时展示全名
// HTML 转义：统一走 app.js 的单点实现（H.esc）。
// 此前本文件存有一份逐字相同的拷贝，故收敛为引用。
const escHtml = H.esc;
const escAttr = escHtml;

import { bindSubjectRange, closeSubjectPop } from '../../components/SubjectRangePicker.js';

/* ===================== 通用：安全填充（带守卫，避免查询时重置用户选择） ===================== */
// 期间下拉守卫统一走桥接层 H.safeFillPeriod（app.js 内定义，含 bookKey 记忆）
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
// 此前本文件存有一份逐字相同的拷贝，改一处漏五处，故收敛为引用。
// 口径：回填默认期间 + 同步触发器文本，返回结束期间。
const periodRangeValue = H.periodRangeValue;
function refreshGl() {
  var month = periodRangeValue('glPeriod', currentPeriod());
  renderGl(month);
}
function renderGl(month) {
  var tb = $('glBody'); tb.innerHTML = '';
  if (!month) return;
  // 系统参数开关（账簿显示偏好），纯前端渲染控制，不参与任何取数/计算
  var p = (S && S.state && S.state.param) || {};
  var hideZero = p.bookHideZero !== false;   // 默认 true：无期初+本期发生额的科目不显示（默认）
  var expandAll = p.bookExpandAll !== false; // 默认 true：展开所有级次；false 时只显示一级科目
  S.generalLedger(month).forEach(function (r) {
    // 折叠：未展开全部级次时，只保留一级科目（编码长度 <=4，4-2-2 段式）
    if (!expandAll && r.code.length > 4) return;
    // 隐藏零行：期初借贷与本期借贷贷方均为 0 时跳过（受 bookHideZero 控制）
    if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0) return;
    var tr = document.createElement('tr');
    tr.className = 'gl-subject';
    tr.innerHTML = '<td rowspan="3" class="mono">' + r.code + '</td><td rowspan="3" class="gl-name" title="' + escAttr(r.name) + '">' + escHtml(r.name) + '</td>' +
      '<td class="gl-seg">期初余额</td>' +
      '<td class="ta-r mono">' + money(r.obDr) + '</td><td class="ta-r mono">' + money(r.obCr) + '</td>' +
      '<td class="ta-r mono gl-empty"></td><td class="ta-r mono gl-empty"></td>' +
      '<td class="ta-r mono">' + money(r.obDr >= r.obCr ? r.obDr - r.obCr : 0) + '</td><td class="ta-r mono">' + money(r.obCr > r.obDr ? r.obCr - r.obDr : 0) + '</td>';
    tb.appendChild(tr);
    var tr2 = document.createElement('tr');
    tr2.className = 'gl-sub';
    tr2.innerHTML = '<td class="gl-seg">本期合计</td>' +
      '<td class="ta-r mono">' + money(r.periodDr) + '</td><td class="ta-r mono">' + money(r.periodCr) + '</td>' +
      '<td class="ta-r mono">' + money(r.ytdDr) + '</td><td class="ta-r mono">' + money(r.ytdCr) + '</td>' +
      '<td class="ta-r mono">' + money(r.balance && r.dir === '借' ? r.balance : 0) + '</td><td class="ta-r mono">' + money(r.balance && r.dir === '贷' ? r.balance : 0) + '</td>';
    tb.appendChild(tr2);
    var tr3 = document.createElement('tr');
    tr3.className = 'gl-sub gl-last';
    tr3.innerHTML = '<td class="gl-seg">本年累计</td>' +
      '<td class="ta-r mono">' + money(r.ytdDr) + '</td><td class="ta-r mono">' + money(r.ytdCr) + '</td>' +
      '<td class="ta-r mono">' + money(r.ytdDr) + '</td><td class="ta-r mono">' + money(r.ytdCr) + '</td>' +
      '<td class="ta-r mono">' + money(r.ytdBalance && r.ytdDir === '借' ? r.ytdBalance : 0) + '</td><td class="ta-r mono">' + money(r.ytdBalance && r.ytdDir === '贷' ? r.ytdBalance : 0) + '</td>';
    tb.appendChild(tr3);
  });
}

/* ===================== 明细账 ===================== */
// 科目筛选：金蝶式「输入框 + 科目树」。留空 = 全部科目（按科目分组依次列出），
// 不再默认选中第一个科目。只绑定一次，避免重复 refresh 冲掉用户已输入的条件。
var dlSubjPicker = null;
function dlSubjectCodes() {
  if (!dlSubjPicker) {
    dlSubjPicker = bindSubjectRange({
      inputId: 'dlCode', btnId: 'dlCodeBtn', onChange: function () { refreshDl(); }
    });
  }
  if (!dlSubjPicker) return { codes: null, err: '' };
  var r = dlSubjPicker.resolve();
  return { codes: r.ok ? r.codes : null, err: r.ok ? '' : r.msg };
}
function refreshDl() {
  var month = periodRangeValue('dlPeriod', currentPeriod());
  renderDl(month);
}
// 渲染一个科目的明细账段（期初 / 逐笔 / 本期合计 / 本年累计）
function renderDlSegment(tb, code, month) {
  var d = S.detailLedger(code, month);
  if (!d) return false;
  var s = d.subject;
  var obD = s.normal === 'dr' ? d.obDr : 0, obC = s.normal === 'cr' ? d.obCr : 0;
  var obBal = 0, obDir = '';
  if (s.normal === 'dr') { obBal = d.obDr - d.obCr; obDir = obBal >= 0 ? '借' : '贷'; obBal = Math.abs(obBal); }
  else { obBal = d.obCr - d.obDr; obDir = obBal >= 0 ? '贷' : '借'; obBal = Math.abs(obBal); }
  // 科目分组行：单科目模式下一眼看不出在看哪个科目，"全部"模式下更是必需
  var th = document.createElement('tr');
  th.className = 'dl-subj-head';
  th.innerHTML = '<td class="mono">' + escHtml(s.code) + '</td><td colspan="6">' + escHtml(s.name) + '</td>';
  tb.appendChild(th);
  var tro = document.createElement('tr');
  tro.className = 'dl-seg';
  tro.innerHTML = '<td></td><td></td><td>期初余额</td><td class="ta-r mono">' + money(obD) + '</td><td class="ta-r mono">' + money(obC) + '</td><td class="ta-r mono">' + money(obBal) + '</td><td>' + obDir + '</td>';
  tb.appendChild(tro);
  d.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + r.date + '</td><td>' + r.word + '-' + r.no + '</td>' +
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
  var shown = 0;
  codes.forEach(function (c) {
    if (renderDlSegment(tb, c, month)) shown++;
  });
  if (!shown) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-hint">本期无明细记录</td></tr>';
  }
}

/* ===================== 多栏账（按明细科目分栏） ===================== */
// 多栏账与查凭证/明细账不同：它必须选一个「有下级科目」的父科目才能分栏，
// 所以不提供「全部」。但旧实现默认选中第一个科目，而第一个科目往往是叶子科目，
// 一进页面就显示红色错误提示 —— 改为只列非明细科目供选择，没有则给出明确说明。
var mlSubjPicker = null;
function mlSubjectCode() {
  if (!mlSubjPicker) {
    mlSubjPicker = bindSubjectRange({
      inputId: 'mlCode', btnId: 'mlCodeBtn', onlyParent: true,
      onChange: function () { refreshMl(); }
    });
  }
  if (!mlSubjPicker) return { code: '', err: '' };
  var r = mlSubjPicker.resolve();
  // 多栏账只接受单个父科目
  var codes = r.ok && r.codes ? Array.from(r.codes) : [];
  if (r.ok && codes.length > 1) return { code: '', err: '多栏账一次只能选择一个科目（当前命中 ' + codes.length + ' 个）' };
  return { code: codes[0] || '', err: r.ok ? '' : r.msg };
}
function refreshMl() {
  var month = periodRangeValue('mlPeriod', currentPeriod());
  var r = mlSubjectCode();
  renderMl(r.code, month, r.err);
}
// 取某科目的【直属】下级科目（多栏账按直属子目分栏）。
// 段式编码（对齐金蝶）：1001 一级，下级 = 前缀 + 2 位（100101、10010101）。
// 直属 = 去掉末级 2 位后的前缀等于父（即层级比父恰好高一级）。
function childSubjectsOf(code) {
  var subs = S.subjects().filter(function (s) {
    return s.code !== code && s.code.indexOf(code) === 0 && s.code.length > code.length;
  });
  var direct = subs.filter(function (s) {
    // 段式：去掉末级 2 位后等于父，即直属（100101 的父是 1001）
    if (s.code.length > code.length + 2) return s.code.slice(0, -2) === code;
    return true; // 恰好高一级
  });
  if (!direct.length) direct = subs;
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
  var headRow = '<th>日期</th><th>凭证字号</th><th>摘要</th><th>借方</th><th>贷方</th><th>方向</th><th>余额</th>';
  // 分栏列头是下级科目名称，长短不一；加 title 保证列宽不足时悬停仍能看到全名
  cols.forEach(function (c) {
    headRow += '<th class="ml-col-head" title="' + escAttr(c.name) + '">' + escHtml(c.name) + '</th>';
  });
  thead.innerHTML = headRow;
  // 不再手工计算 minWidth：全局 `.grid { width: max-content }` 会按内容自动得出表格宽度，
  // 多栏账列数动态（7 + 下级科目数）也能正确覆盖，无需 JS 参与。
  var d = S.detailLedger(code, month);
  if (!d || !d.rows.length) {
    var colCount = 7 + cols.length;
    tb.innerHTML = '<tr><td colspan="' + colCount + '" class="empty-hint">暂无数据</td></tr>';
    return;
  }
  var subj = d.subject;
  var obD = subj.normal === 'dr' ? d.obDr : 0, obC = subj.normal === 'cr' ? d.obCr : 0;
  var obBal = 0, obDir = '';
  if (subj.normal === 'dr') { obBal = d.obDr - d.obCr; obDir = obBal >= 0 ? '借' : '贷'; obBal = Math.abs(obBal); }
  else { obBal = d.obCr - d.obDr; obDir = obBal >= 0 ? '贷' : '借'; obBal = Math.abs(obBal); }
  var tro = document.createElement('tr');
  tro.className = 'ml-seg';
  var initCells = '<td></td><td></td><td>期初余额</td>' +
    '<td class="ta-r mono">' + money(obD) + '</td><td class="ta-r mono">' + money(obC) + '</td>' +
    '<td class="ta-c">' + obDir + '</td><td class="ta-r mono">' + money(obBal) + '</td>';
  cols.forEach(function () { initCells += '<td class="ta-r mono"></td>'; });
  tro.innerHTML = initCells;
  tb.appendChild(tro);
  var runBal = obBal, runDir = obDir;
  var colDr = {}, colCr = {};
  cols.forEach(function (c) { colDr[c.code] = 0; colCr[c.code] = 0; });
  d.rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var rowCells = '<td>' + r.date + '</td><td>' + r.word + '-' + r.no + '</td>' +
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
        amt = money(r.dr || r.cr);
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

/* ===================== 数量金额总账 / 数量金额明细账 ===================== */
function qtySubjects() { return S.subjects().filter(function (s) { return s.qty; }); }
function qtyCells(qty, amt) {
  var price = num(qty) ? num(amt) / num(qty) : 0;
  return '<td class="ta-r mono">' + (num(qty) ? num(qty) : '') + '</td>' +
         '<td class="ta-r mono">' + (num(qty) ? money(price) : '') + '</td>' +
         '<td class="ta-r mono">' + money(amt) + '</td>';
}
function emptyRow(tbody, colspan, text) {
  tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="empty-hint">' + text + '</td></tr>';
}
// 数量金额总账/明细账：只列数量核算科目（s.qty），与旧 safeFillQty 口径一致。
// 两个页面各有自己的科目输入框（qgCode / qdCode），各自独立绑定一次，
// 缓存用模块级变量（ESM 严格模式下 this 为 undefined，不能用 this 存缓存）。
var qgSubjPicker = null;
var qdSubjPicker = null;
function qgSubjectPicker() {
  if (!qgSubjPicker) {
    qgSubjPicker = bindSubjectRange({
      inputId: 'qgCode', btnId: 'qgCodeBtn', filter: function (s) { return s.qty; },
      onChange: function () { refreshQg(); }
    });
  }
  return qgSubjPicker;
}
function qgSubjectCode() {
  var p = qgSubjectPicker();
  if (!p) return { code: '', err: '' };
  var r = p.resolve();
  if (!r.ok) return { code: '', err: r.msg };
  var codes = r.codes ? Array.from(r.codes) : [];
  if (codes.length > 1) return { code: '', err: '一次只能选择一个数量核算科目（当前命中 ' + codes.length + ' 个）' };
  return { code: codes[0] || '', err: '' };
}
function qdSubjectPicker() {
  if (!qdSubjPicker) {
    qdSubjPicker = bindSubjectRange({
      inputId: 'qdCode', btnId: 'qdCodeBtn', filter: function (s) { return s.qty; },
      onChange: function () { refreshQd(); }
    });
  }
  return qdSubjPicker;
}
function qdSubjectCode() {
  var p = qdSubjectPicker();
  if (!p) return { code: '', err: '' };
  var r = p.resolve();
  if (!r.ok) return { code: '', err: r.msg };
  var codes = r.codes ? Array.from(r.codes) : [];
  if (codes.length > 1) return { code: '', err: '一次只能选择一个数量核算科目（当前命中 ' + codes.length + ' 个）' };
  return { code: codes[0] || '', err: '' };
}
function refreshQg() {
  var month = periodRangeValue('qgPeriod', currentPeriod());
  var r = qgSubjectCode();
  renderQg(r.code, month, r.err);
}
function renderQg(code, month, err) {
  var tb = $('qgBody'); tb.innerHTML = '';
  if (err) { emptyRow(tb, 12, err); return; }
  if (!code || !month) { emptyRow(tb, 12, '请选择数量核算科目与期间'); return; }
  var d = S.detailLedger(code, month);
  if (!d || !d.rows.length) { emptyRow(tb, 12, '本期无发生额'); return; }
  var dr = 0, cr = 0, qdr = 0, qcr = 0;
  d.rows.forEach(function (r) { dr += num(r.dr); cr += num(r.cr); qdr += num(r.qtyDr); qcr += num(r.qtyCr); });
  var last = d.rows[d.rows.length - 1];
  var tr = document.createElement('tr');
  tr.innerHTML = '<td>' + month + '</td><td>本期合计</td>' +
    qtyCells(qdr, dr) + qtyCells(qcr, cr) +
    '<td>' + last.dir + '</td>' + qtyCells(qdr - qcr, last.bal);
  tb.appendChild(tr);
}
function refreshQd() {
  var month = periodRangeValue('qdPeriod', currentPeriod());
  var r = qdSubjectCode(); // 明细账页使用自己的科目选择器（qdCode）
  renderQd(r.code, month, r.err);
}
function renderQd(code, month, err) {
  var tb = $('qdBody'); tb.innerHTML = '';
  if (err) { emptyRow(tb, 13, err); return; }
  if (!code || !month) { emptyRow(tb, 13, '请选择数量核算科目与期间'); return; }
  var d = S.detailLedger(code, month);
  if (!d || !d.rows.length) { emptyRow(tb, 13, '本期无发生额'); return; }
  var qbal = 0;
  d.rows.forEach(function (r) {
    qbal += num(r.qtyDr) - num(r.qtyCr);
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + r.date + '</td><td>' + r.word + '-' + r.no + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(r.summary) + '">' + escHtml(r.summary) + '</td>' +
      qtyCells(r.qtyDr, r.dr) + qtyCells(r.qtyCr, r.cr) +
      '<td>' + r.dir + '</td>' + qtyCells(qbal, r.bal);
    tb.appendChild(tr);
  });
}

/* ===================== 核算项目明细账 / 余额表 / 组合表 ===================== */
function auxTypes() { return S.auxTypes ? S.auxTypes() : []; }
function fillAuxTypeSelect(sel) {
  sel.innerHTML = '';
  var list = auxTypes();
  if (!list.length) { sel.innerHTML = '<option value="">（未启用核算项目）</option>'; return; }
  list.forEach(function (t) {
    var o = document.createElement('option'); o.value = t.key; o.textContent = t.name;
    sel.appendChild(o);
  });
}
function fillAuxItemSelect(sel, typeKey) {
  sel.innerHTML = '<option value="">全部</option>';
  (S.auxItems ? S.auxItems(typeKey) : []).forEach(function (it) {
    var o = document.createElement('option'); o.value = it.id; o.textContent = it.name;
    sel.appendChild(o);
  });
}
function refreshAx() {
  periodRangeValue('axPeriod', currentPeriod());
  safeFillAuxType($('axType'));
  safeFillAuxItem($('axItem'), $('axType').value);
  // 类别切换联动重填项目下拉（幂等绑定，避免重复监听）
  var axTypeSel = $('axType');
  if (axTypeSel && !axTypeSel.dataset.linked) {
    axTypeSel.addEventListener('change', function () {
      safeFillAuxItem($('axItem'), $('axType').value);
      renderAx();
    });
    axTypeSel.dataset.linked = '1';
  }
  renderAx();
}
function renderAx() {
  var tb = $('axBody'); tb.innerHTML = '';
  var month = periodRangeValue('axPeriod', currentPeriod());
  var rows = S.auxLedger ? S.auxLedger($('axType').value, $('axItem').value, month) : [];
  if (!rows.length) { emptyRow(tb, 8, '当前账套未启用核算项目，或本期无相关发生额'); return; }
  rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var axSubj = r.code + ' ' + r.name;
    tr.innerHTML = '<td>' + r.date + '</td><td>' + r.word + '-' + r.no + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(r.summary) + '">' + escHtml(r.summary) + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(axSubj) + '">' + escHtml(axSubj) + '</td>' +
      '<td class="ta-r mono">' + money(r.dr) +
      '</td><td class="ta-r mono">' + money(r.cr) + '</td><td>' + r.dir + '</td><td class="ta-r mono">' + money(r.bal) + '</td>';
    tb.appendChild(tr);
  });
}
function refreshAb() {
  periodRangeValue('abPeriod', currentPeriod());
  safeFillAuxType($('abType'));
  renderAb();
}
function renderAb() {
  var tb = $('abBody'); tb.innerHTML = '';
  var month = periodRangeValue('abPeriod', currentPeriod());
  var rows = S.auxBalance ? S.auxBalance($('abType').value, month) : [];
  if (!rows.length) { emptyRow(tb, 8, '当前账套未启用核算项目，或本期无相关余额'); return; }
  rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var abSubj = r.code + ' ' + r.name;
    tr.innerHTML = '<td class="cell-ellipsis" title="' + escAttr(r.itemName) + '">' + escHtml(r.itemName) + '</td>' +
      '<td class="cell-ellipsis" title="' + escAttr(abSubj) + '">' + escHtml(abSubj) + '</td>' +
      '<td class="ta-r mono">' + money(r.obDr) + '</td><td class="ta-r mono">' + money(r.obCr) +
      '</td><td class="ta-r mono">' + money(r.dr) + '</td><td class="ta-r mono">' + money(r.cr) +
      '</td><td class="ta-r mono">' + money(r.endDr) + '</td><td class="ta-r mono">' + money(r.endCr) + '</td>';
    tb.appendChild(tr);
  });
}
function refreshAc() {
  periodRangeValue('acPeriod', currentPeriod());
  renderAc();
}
function renderAc() {
  var tb = $('acBody'); tb.innerHTML = '';
  var month = periodRangeValue('acPeriod', currentPeriod());
  var rows = S.auxCombine ? S.auxCombine($('acMode').value, month) : [];
  if (!rows.length) { emptyRow(tb, 7, '当前账套未启用核算项目，无组合数据'); return; }
  rows.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td class="cell-ellipsis" title="' + escAttr(r.label) + '">' + escHtml(r.label) + '</td>' +
      '<td class="ta-r mono">' + money(r.obDr) +
      '</td><td class="ta-r mono">' + money(r.obCr) + '</td><td class="ta-r mono">' + money(r.dr) +
      '</td><td class="ta-r mono">' + money(r.cr) + '</td><td class="ta-r mono">' + money(r.endDr) +
      '</td><td class="ta-r mono">' + money(r.endCr) + '</td>';
    tb.appendChild(tr);
  });
}

export {
  refreshGl, refreshDl, refreshMl, refreshQg, refreshQd, refreshAx, refreshAb, refreshAc
};
