// 自 report/Extra.js 拆分（B 方案第 2 批试点）：原始凭证。只挪窝不改写。
import { $, S, money, fmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2,
  periodRangeOptions, periodRangeOptionsOri, monthsBetween, prevYearMonth, monthLabel, subjectLevel, subjectFilter, getSubjectNameByCode } from './_shared.js';
const H = globalThis.__KINGDEE_HELPERS__ || {};

var origCheckedIds = [];
var origFilter = { name: '', bigType: '', smallType: '', vouchered: '', audit: '', isInvoice: '', group: '' };
var origSiderTab = 'small';
var origTreeState = { small: { expand: true }, period: { expand: false } };

function renderOriginalTree() {
  var ul = $('origTree'); if (!ul) return;
  var list = S.originals();
  var html = '';
  if (origSiderTab === 'small') {
    var groups = [
      { name: '全部', count: list.length, sel: origFilter.smallType === '' && origFilter.bigType === '' },
      { name: '发票', count: list.filter(function (o) { return o.smallType === '差旅发票' || o.smallType === '购货发票'; }).length, cls: 'parent', sel: origFilter.bigType === '发票', children: [
        { name: '差旅发票', count: list.filter(function (o) { return o.smallType === '差旅发票'; }).length, sel: origFilter.smallType === '差旅发票' },
        { name: '购货发票', count: list.filter(function (o) { return o.smallType === '购货发票'; }).length, sel: origFilter.smallType === '购货发票' }
      ] },
      { name: '合同', count: list.filter(function (o) { return o.smallType === '合同'; }).length, sel: origFilter.bigType === '合同' }
    ];
    groups.forEach(function (g) {
      if (g.cls === 'parent') {
        var ex = origTreeState.small.expand;
        html += '<li class="tree-parent' + (ex ? ' open' : '') + (g.sel ? ' selected' : '') + '" data-name="' + esc(g.name) + '"><span class="tree-arrow">' + (ex ? '▼' : '▶') + '</span>' + esc(g.name) + '<span class="tree-count">' + g.count + '</span></li>';
        if (ex) g.children.forEach(function (c) {
          html += '<li class="tree-child' + (c.sel ? ' selected' : '') + '" data-name="' + esc(c.name) + '">' + esc(c.name) + '<span class="tree-count">' + c.count + '</span></li>';
        });
      } else {
        html += '<li class="tree-leaf' + (g.sel ? ' selected' : '') + '" data-name="' + esc(g.name) + '">' + esc(g.name) + '<span class="tree-count">' + g.count + '</span></li>';
      }
    });
  } else {
    var periods = {};
    list.forEach(function (o) { periods[o.period] = (periods[o.period] || 0) + 1; });
    var keys = Object.keys(periods).sort().reverse();
    if (!keys.length) keys = [currentPeriod() || ''];
    keys.forEach(function (p) {
      var on = (origFilter.period || currentPeriod() || '') === p;
      html += '<li class="tree-leaf' + (on ? ' selected' : '') + '" data-name="' + esc(p) + '">' + esc(p) + '<span class="tree-count">' + (periods[p] || 0) + '</span></li>';
    });
  }
  ul.innerHTML = html;
}

export function renderOriginal() {
  var tb = $('origBody'); if (!tb) return;
  if (globalThis.setRptHead) globalThis.setRptHead('origTitleRow', '原始凭证', 7, origFilter.period || currentPeriod() || '');
  tb.innerHTML = '';
  var list = S.originals();
  if (origFilter.name) list = list.filter(function (o) { return (o.name || '').indexOf(origFilter.name) >= 0; });
  if (origFilter.bigType) list = list.filter(function (o) { return o.smallType && (origFilter.bigType === '发票' ? (o.smallType === '差旅发票' || o.smallType === '购货发票') : o.smallType === '合同'); });
  if (origFilter.smallType) list = list.filter(function (o) { return o.smallType === origFilter.smallType; });
  if (origFilter.vouchered) list = list.filter(function (o) { return o.vouchered === origFilter.vouchered; });
  if (origFilter.audit) list = list.filter(function (o) { return o.audited === origFilter.audit; });
  if (origFilter.isInvoice) list = list.filter(function (o) { return o.isInvoice === origFilter.isInvoice; });
  if (origFilter.group) list = list.filter(function (o) { return o.group === origFilter.group; });

  var tot = $('origTotal'); if (tot) tot.textContent = '共 ' + list.length + ' 条';
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
    return;
  }
  list.forEach(function (o) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-id', o.id);
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" class="orig-chk" data-id="' + o.id + '"' + (origCheckedIds.indexOf(o.id) >= 0 ? ' checked' : '') + '></td>' +
      '<td class="col-op">' + ((o.vouchered === '1' || o.voucherId || o.voucherNo) ? '<span class="muted" title="已关联凭证，不可删除">已关联</span>' : '<a class="link-del" data-id="' + o.id + '" data-name="' + esc(o.name) + '">删除</a>') + '</td>' +
      '<td>' + esc(o.name) + '</td>' +
      '<td>' + esc(o.fileSize || '') + '</td>' +
      '<td>' + ((o.voucherId || o.voucherNo)
        ? '<a href="#" class="link-voucher" data-id="' + esc(o.voucherId || o.voucherNo) + '">' + esc(o.voucherNo || o.voucherId || '') + '</a>'
        : '') + '</td>' +
      '<td>' + esc(o.period) + '</td>' +
      '<td>' + esc(o.uploadTime) + '</td>';
    tb.appendChild(tr);
    var delA = tr.querySelector('.link-del');
    if (delA) delA.addEventListener('click', async function () {
      var id = this.getAttribute('data-id');
      var name = this.getAttribute('data-name') || '';
      if (!(await H.confirmAsync('确定删除原始凭证「' + name + '」？\n删除后该电子档案将从台账移除，不影响已生成的凭证。', { title: '删除原始凭证' }))) return;
      var r = S.removeOriginal(id);
      if (!r.ok) { showToast(r.msg, 'warn'); return; }
      renderOriginal(); renderOriginalTree();
    });
  });
}

// 原始凭证导出：从 store 取数（S.originals()），按当前筛选导出 Excel
function exportOrig() {
  var list = S.originals();
  if (origFilter.name) list = list.filter(function (o) { return (o.name || '').indexOf(origFilter.name) >= 0; });
  if (origFilter.bigType) list = list.filter(function (o) { return o.smallType && (origFilter.bigType === '发票' ? (o.smallType === '差旅发票' || o.smallType === '购货发票') : o.smallType === '合同'); });
  if (origFilter.smallType) list = list.filter(function (o) { return o.smallType === origFilter.smallType; });
  if (origFilter.vouchered) list = list.filter(function (o) { return o.vouchered === origFilter.vouchered; });
  if (origFilter.audit) list = list.filter(function (o) { return o.audited === origFilter.audit; });
  if (origFilter.isInvoice) list = list.filter(function (o) { return o.isInvoice === origFilter.isInvoice; });
  if (origFilter.group) list = list.filter(function (o) { return o.group === origFilter.group; });
  if (!list.length) return showToast('无数据可导出', 'warn');
  var headers = ['附件名称', '文件大小', '关联凭证', '记账期间', '上传时间'];
  var rows = [headers];
  list.forEach(function (o) {
    rows.push([
      o.name || '', o.fileSize || '', o.voucherNo || '', o.period || '', o.uploadTime || ''
    ]);
  });
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws, '原始凭证');
  __safeExportExcel(wb, '原始凭证_' + (origFilter.period || currentPeriod() || ''));
}

function bindOriginal() {
  var page = $('page-original');
  if (!page || page._origBound) return;
  page._origBound = true;
  var refresh = function () { renderOriginal(); renderOriginalTree(); };

  $('origFilterToggle').onclick = function () {
    var fold = $('origFilterFold');
    fold.style.display = fold.style.display === 'none' ? 'block' : 'none';
    $('origFilterToggle').classList.toggle('active', fold.style.display === 'block');
  };
  $('origHoldup').onclick = function () {
    var fold = $('origFilterFold');
    fold.style.display = 'none'; $('origFilterToggle').classList.remove('active');
  };


  $('origName').oninput = function () { origFilter.name = this.value.trim(); };
  $('origBigType').onchange = function () { origFilter.bigType = this.value; refresh(); };
  $('origSmallType').onchange = function () { origFilter.smallType = this.value; refresh(); };
  $('origVouched').onchange = function () { origFilter.vouchered = this.value; refresh(); };
  $('origAudit').onchange = function () { origFilter.audit = this.value; refresh(); };
  $('origIsInvoice').onchange = function () { origFilter.isInvoice = this.value; refresh(); };
  $('origGroup').onchange = function () { origFilter.group = this.value; refresh(); };
  $('btnOrigQuery').onclick = refresh;
  $('btnOrigReset').onclick = function () {
    origFilter = { name: '', bigType: '', smallType: '', vouchered: '', audit: '', isInvoice: '', group: '' };
    ['origName', 'origBigType', 'origSmallType', 'origVouched', 'origAudit', 'origIsInvoice', 'origGroup'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
    refresh();
  };

  // 注：btnOrigPrint 已带 data-print，由全局委托统一走 kdPrint()，此处不再单独绑定（避免双击/双弹）。
  $('btnOrigExport').onclick = exportOrig;

  $('origSiderTabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab'); if (!t) return;
    origSiderTab = t.getAttribute('data-tab');
    document.querySelectorAll('#origSiderTabs .tab').forEach(function (x) { x.classList.toggle('active', x === t); });
    renderOriginalTree();
  });
  $('origTree').addEventListener('click', function (e) {
    var li = e.target.closest('li'); if (!li) return;
    if (li.classList.contains('tree-parent')) {
      var nm = li.getAttribute('data-name');
      if (nm === '发票') origTreeState.small.expand = !origTreeState.small.expand;
      renderOriginalTree(); return;
    }
    var nm2 = li.getAttribute('data-name');
    if (nm2 === '全部') { origFilter.smallType = ''; origFilter.bigType = ''; }
    else if (nm2 === '发票') { origFilter.bigType = '发票'; origFilter.smallType = ''; }
    else if (nm2 === '合同') { origFilter.bigType = '合同'; origFilter.smallType = ''; }
    else { origFilter.smallType = nm2; origFilter.bigType = ''; }
    refresh();
  });

  var all = $('origCheckAll');
  if (all) all.addEventListener('change', function () {
    document.querySelectorAll('.orig-chk').forEach(function (c) {
      c.checked = all.checked;
      var id = c.getAttribute('data-id');
      if (all.checked) { if (origCheckedIds.indexOf(id) < 0) origCheckedIds.push(id); }
      else origCheckedIds = origCheckedIds.filter(function (x) { return x !== id; });
    });
  });
  $('origBody').addEventListener('change', function (e) {
    if (!e.target.classList.contains('orig-chk')) return;
    var id = e.target.getAttribute('data-id');
    if (e.target.checked) { if (origCheckedIds.indexOf(id) < 0) origCheckedIds.push(id); }
    else origCheckedIds = origCheckedIds.filter(function (x) { return x !== id; });
  });
}

/* ============================================================
 * 报表中心（报表清单 + 系统报表导航）
 * ============================================================ */
