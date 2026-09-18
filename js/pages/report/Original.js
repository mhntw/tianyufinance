// 自 report/Extra.js 拆分（B 方案第 2 批试点）：原始凭证。只挪窝不改写。
import { $, S, money, fmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2 } from './_shared.js';
const H = globalThis.__TY_HELPERS__ || {};

var origCheckedIds = [];
var origFilter = { name: '', bigType: '', smallType: '', vouchered: '', audit: '', isInvoice: '', group: '' };
// 分页状态（2026-09-18 补）：页面上一直有「条/页」下拉与上一页/下一页按钮，
// 但 JS 从未读取过它们 —— 分页控件形同虚设、点了没反应。默认 500 条/页，与下拉框首项一致。
var _origPage = 1;
var _origPageSize = 500;
// （原左侧「附件小类」树及其渲染函数 renderOriginalTree 已于 2026-09-18 连同侧栏一并移除：
//   该树只有 5 个固定节点（全部/发票/差旅发票/购货发票/合同），筛选价值有限，且是全站唯一
//   的「侧栏 + 表格」并列结构。页面现收敛为「操作栏 + 单个表格」，筛选入口只剩操作栏的
//   附件名称搜索框。origFilter 里的 bigType/smallType 字段保留（renderOriginal 仍会读它们，
//   只是不再有 UI 去设置，值为空即不筛）。）

// 分页渲染：与费用明细账的 renderEDPagination 同一套写法，保证两页观感与行为一致
function renderOrigPagination(total) {
  var totalEl = $('origTotal');
  var pagesEl = $('origPages');
  if (!totalEl || !pagesEl) return;
  totalEl.textContent = '共 ' + total + ' 条';
  var totalPages = Math.max(1, Math.ceil(total / _origPageSize));
  if (_origPage > totalPages) _origPage = totalPages;
  var html = '';
  html += '<li class="' + (_origPage === 1 ? 'disabled' : '') + '" data-page="' + (_origPage - 1) + '" title="上一页"><button><i class="tyicon tyicon-arrow-left"></i></button></li>';
  for (var i = 1; i <= totalPages; i++) {
    html += '<li class="' + (i === _origPage ? 'active' : '') + '" data-page="' + i + '" title="' + i + '"><button>' + i + '</button></li>';
  }
  html += '<li class="' + (_origPage === totalPages ? 'disabled' : '') + '" data-page="' + (_origPage + 1) + '" title="下一页"><button><i class="tyicon tyicon-arrow-right"></i></button></li>';
  pagesEl.innerHTML = html;
}

export function renderOriginal() {
  var tb = $('origBody'); if (!tb) return;
  // 事件绑定：renderOriginal 每次进入本页、每次筛选都会被调用，而 bindOriginal 内部有
  // _origBound 守卫，所以只会真正绑定一次（与 renderExpenseDetail 里调 bindED 同一约定）。
  // ⚠️ 原先这里漏了这行 —— bindOriginal 成了从未执行过的"孤儿函数"，导致本页**全部交互失效**：
  //    过滤开关点不开、收起无效、6 个筛选下拉与查询按钮全都无反应。页面上只表现为
  //    "点了没反应"，不报错、不影响渲染，因此长期未被发现。
  bindOriginal();
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

  // 分页：先按总量重画分页条，再只渲染当前页（此前无分页，控件点了没反应）
  renderOrigPagination(list.length);
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
    return;
  }
  var _start = (_origPage - 1) * _origPageSize;
  list.slice(_start, _start + _origPageSize).forEach(function (o) {
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
      if (!(await H.confirmAsync('确认删除原始凭证「' + name + '」？\n删除后该电子档案将从台账移除，不影响已生成的凭证。', { title: '删除原始凭证' }))) return;
      var r = S.removeOriginal(id);
      if (!r.ok) { showToast(r.msg, 'warn'); return; }
      renderOriginal();
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
  // 筛选条件变化后回到第 1 页（否则会停在旧页码上看到空白）
  var refresh = function () { _origPage = 1; renderOriginal(); };

  // 「过滤」折叠面板已于 2026-09-18 按用户要求移除：其展开开关、6 个筛选下拉、查询/重置
  // 按钮一并删除。筛选入口保留两个 ——
  //   ①「附件名称」搜索框（常显，输入即写入 origFilter.name）
  //   ② 左侧「附件小类 / 记账期间」树：点击直接写 origFilter.bigType / smallType / period
  // renderOriginal 里的筛选逻辑保持不变（左侧树仍依赖它生效）。
  // 附件名称搜索（操作栏内，与打印/导出同行）：按名称筛表格数据，输入即刷新。
  // 注意它筛的是**表格**（origFilter.name → renderOriginal 的 filter），不是左侧树。
  var on = $('origName');
  if (on) on.addEventListener('input', function () {
    origFilter.name = this.value.trim();
    _origPage = 1;            // 搜索后回到第 1 页，避免停在越界页码上看到空白
    renderOriginal();
  });
  // 分页控件（此前完全没绑定，是「有元素、无 JS」的空壳）：「条/页」下拉 + 上一页/下一页/页码
  var ps = $('origPageSize');
  if (ps) ps.addEventListener('change', function () {
    _origPageSize = parseInt(this.value, 10) || 500;
    _origPage = 1;
    renderOriginal();
  });
  var pg = $('origPages');
  if (pg) pg.addEventListener('click', function (e) {
    var li = e.target.closest('li');
    if (!li || li.classList.contains('disabled') || li.classList.contains('active')) return;
    var p = parseInt(li.getAttribute('data-page'), 10);
    if (!isNaN(p)) { _origPage = p; renderOriginal(); }
  });

  // 注：btnOrigPrint 已带 data-print，由全局委托统一走 tyPrint()，此处不再单独绑定（避免双击/双弹）。
  $('btnOrigExport').onclick = exportOrig;

  // （原 #origSiderTabs 的 tab 切换绑定、以及 #origTree 的节点点击绑定，
  //   均已随侧栏与「附件小类」树一并移除，2026-09-18）

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
