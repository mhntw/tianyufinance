// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__KINGDEE_HELPERS__（app.js 注册）、globalThis.__KINGDEE_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

const H = globalThis.__KINGDEE_HELPERS__ || {};
const EX = globalThis.__KINGDEE_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const esc = H.esc;
import { bindSubjectCombo } from '../../components/SubjectCombo.js';
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const safeFillPeriod = H.safeFillPeriod;
const syncAll = H.syncAll;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES / AUX_TYPES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);
const AUX_TYPES = globalThis.AUX_TYPES || (EX && EX.AUX_TYPES);

  /* ============================================================
   * 固定资产
   * ============================================================ */
  /* 固定资产卡片（ykj-page1：过滤条 / 工具条 / 左树(类别+部门)+右表） */
  var _assetPage = 1, _assetPageSize = 500, _assetFiltered = [];
  var _assetCatSel = '';        // 左树选中的类别 code（''=全部）
  var _assetDeptSel = '';       // 左树选中的部门 code（''=全部）
  function _catName(code) {
    var c = assetCats().filter(function (x) { return x.code === code; })[0];
    return c ? c.name : (code || '');
  }
  // 左侧栏：金蝶 table-left-box(资产类别树) + bottom-box(部门树)，各含「全部」根节点
  function _buildAssetTree(ulId, selCode, onPick) {
    var ul = $(ulId); if (!ul) return;
    ul.innerHTML = '';
    ul.appendChild(_assetTreeRoot('全部', selCode === '', onPick));
  }
  function _assetTreeRoot(name, selected, onPick) {
    var li = document.createElement('li');
    li.className = 'orig-tree-parent' + (selected ? ' selected' : '');
    li.innerHTML = '<span class="tree-arrow"></span>' + name;
    li.addEventListener('click', function () { onPick(''); });
    return li;
  }
  function _assetTreeLeaf(name, selected, onPick, code) {
    var li = document.createElement('li');
    li.className = 'orig-tree-child' + (selected ? ' selected' : '');
    li.innerHTML = name;
    li.addEventListener('click', function () { onPick(code); });
    return li;
  }
  function renderAssetTree() {
    _buildAssetTree('assetCatTree', _assetCatSel, function (code) { _assetCatSel = code; _assetPage = 1; renderAssetTree(); renderAssets(); });
    assetCats().forEach(function (c) {
      $('assetCatTree').appendChild(_assetTreeLeaf(c.name, c.code === _assetCatSel, function (code) { _assetCatSel = code; _assetPage = 1; renderAssetTree(); renderAssets(); }, c.code));
    });
    _buildAssetTree('assetDeptTree', _assetDeptSel, function (code) { _assetDeptSel = code; _assetPage = 1; renderAssetTree(); renderAssets(); });
    (S.state.depts || []).forEach(function (d) {
      $('assetDeptTree').appendChild(_assetTreeLeaf(d.name, d.code === _assetDeptSel, function (code) { _assetDeptSel = code; _assetPage = 1; renderAssetTree(); renderAssets(); }, d.code));
    });
  }
  function refreshAssets() {
    var ap = $('aPeriod'); if (ap && !ap.value) ap.value = currentPeriod();
    var fc = $('fCategory'); if (fc && fc.options.length <= 1) assetCats().forEach(function (c) { var o = document.createElement('option'); o.value = c.code; o.textContent = c.name; fc.appendChild(o); });
    var fd = $('fDept'); if (fd && fd.options.length <= 1 && S.state.depts) S.state.depts.forEach(function (d) { var o = document.createElement('option'); o.value = d.code; o.textContent = d.name; fd.appendChild(o); });
    renderAssetTree();
    renderAssets();
  }
  function _assetFilterList() {
    var code = ($('fCode').value || '').trim();
    var name = ($('fName').value || '').trim();
    var cat = $('fCategory').value || _assetCatSel;
    var dept = $('fDept').value || _assetDeptSel;
    var method = $('fMethod').value;
    var status = $('fStatus').value;
    var addVch = $('fAddVch').value;
    var cleanVch = $('fCleanVch').value;
    var showCleaned = $('fShowCleaned').checked || $('fShowCleanedTop').checked;
    var acqS = $('fAcqStart').value, acqE = $('fAcqEnd').value;
    var entS = ($('fEntryStart').value || '').trim(), entE = ($('fEntryEnd').value || '').trim();
    var clnS = ($('fCleanStart').value || '').trim(), clnE = ($('fCleanEnd').value || '').trim();
    return S.state.fixedAssets.filter(function (fa) {
      if (code && (fa.code || '').indexOf(code) < 0) return false;
      if (name && (fa.name || '').indexOf(name) < 0) return false;
      if (cat && fa.category !== cat) return false;
      if (dept && fa.dept !== dept) return false;
      if (method && fa.method !== method) return false;
      if (status && fa.status !== status) return false;
      if (addVch === '1' && !fa.addVoucher) return false;
      if (addVch === '0' && fa.addVoucher) return false;
      if (cleanVch === '1' && !fa.cleanVoucher) return false;
      if (cleanVch === '0' && fa.cleanVoucher) return false;
      if (acqS && (fa.acqDate || '') < acqS) return false;
      if (acqE && (fa.acqDate || '') > acqE) return false;
      if (entS && (fa.entryPeriod || '') < entS) return false;
      if (entE && (fa.entryPeriod || '') > entE) return false;
      if (clnS && (fa.cleanPeriod || '') < clnS) return false;
      if (clnE && (fa.cleanPeriod || '') > clnE) return false;
      if (!showCleaned && fa.status === '清理') return false;
      return true;
    });
  }
  function renderAssets() {
    _assetFiltered = _assetFilterList();
    var tb = $('assetBody'); tb.innerHTML = '';
    var total = _assetFiltered.length;
    var pages = Math.max(1, Math.ceil(total / _assetPageSize));
    if (_assetPage > pages) _assetPage = pages;
    var start = (_assetPage - 1) * _assetPageSize;
    var slice = _assetFiltered.slice(start, start + _assetPageSize);
    slice.forEach(function (fa) {
      var md = S.assetMonthlyDepr(fa);
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="aChk" data-id="' + fa.id + '"></td>' +
        '<td><a class="link-edit" data-asset-edit="' + fa.id + '">编辑</a> <a class="link-copy" data-copy="' + fa.id + '">复制</a> <a class="link-del" data-del="' + fa.id + '">删除</a> ' +
        (fa.status === '清理'
          ? '<a class="link-unclean" data-unclean="' + fa.id + '">取消清理</a>'
          : '<a class="link-clean" data-clean="' + fa.id + '">清理</a>') + '</td>' +
        '<td class="mono">' + (fa.code || '') + '</td>' +
        '<td>' + (fa.name || '') + '</td>' +
        '<td>' + _catName(fa.category) + '</td>' +
        '<td>' + (fa.dept || '') + '</td>' +
        '<td>' + (fa.acqDate || '') + '</td>' +
        '<td>' + (fa.entryPeriod || '') + '</td>' +
        '<td class="ta-r mono">' + money(fa.original) + '</td>' +
        '<td class="ta-r mono">' + money(fa.accumDeprBegin) + '</td>' +
        '<td class="ta-r mono">' + money(fa.accumDepr) + '</td>' +
        '<td class="ta-r mono">' + money(md) + '</td>' +
        '<td class="ta-c">' + (fa.life ? fa.life + '年' : '') + '</td>' +
        '<td class="ta-c">' + (fa.periodUsed || '') + '</td>' +
        '<td class="ta-r mono">' + money(fa.salvage) + '</td>' +
        '<td class="ta-r mono">' + (num(fa.salvageRate)).toFixed(2) + '</td>' +
        '<td class="ta-r mono">' + money(fa.impairment) + '</td>' +
        '<td class="ta-r mono">' + money(fa.netValueBegin) + '</td>' +
        '<td class="ta-r mono">' + money(fa.netValueEnd) + '</td>' +
        '<td>' + (fa.method || '') + '</td>' +
        '<td>' + (fa.status || '正常') + '</td>' +
        '<td class="ta-r">' + (fa.qty || '') + '</td>' +
        '<td>' + (fa.spec || '') + '</td>' +
        '<td>' + (fa.location || '') + '</td>' +
        '<td>' + (fa.user || '') + '</td>' +
        '<td>' + (fa.cleanPeriod || '') + '</td>' +
        '<td class="mono">' + (fa.addVoucher || '') + '</td>' +
        '<td class="mono">' + (fa.cleanVoucher || '') + '</td>' +
        '<td class="mono">' + (fa.impairVoucher || '') + '</td>' +
        '<td class="mono">' + (fa.otherVoucher || '') + '</td>' +
        '<td>' + (fa.memo || '') + '</td>';
      tb.appendChild(tr);
    });
    // 合计行
    var foot = $('assetFoot'); foot.innerHTML = '';
    if (total > 0) {
      var sOrig = 0, sB = 0, sE = 0, sM = 0, sS = 0, sI = 0, sNB = 0, sNE = 0;
      _assetFiltered.forEach(function (fa) {
        sOrig += num(fa.original); sB += num(fa.accumDeprBegin); sE += num(fa.accumDepr);
        sM += S.assetMonthlyDepr(fa); sS += num(fa.salvage); sI += num(fa.impairment);
        sNB += num(fa.netValueBegin); sNE += num(fa.netValueEnd);
      });
      var trf = document.createElement('tr');
      trf.innerHTML = '<td></td><td>合计</td><td colspan="6"></td>' +
        '<td class="ta-r mono">' + money(sOrig) + '</td>' +
        '<td class="ta-r mono">' + money(sB) + '</td>' +
        '<td class="ta-r mono">' + money(sE) + '</td>' +
        '<td class="ta-r mono">' + money(sM) + '</td>' +
        '<td></td><td></td>' +
        '<td class="ta-r mono">' + money(sS) + '</td>' +
        '<td></td>' +
        '<td class="ta-r mono">' + money(sI) + '</td>' +
        '<td class="ta-r mono">' + money(sNB) + '</td>' +
        '<td class="ta-r mono">' + money(sNE) + '</td>' +
        '<td colspan="12"></td>';
      foot.appendChild(trf);
    }
    $('assetCount').textContent = '共 ' + total + ' 条';
    $('aPageNo').textContent = _assetPage;
    var pages = Math.max(1, Math.ceil(total / _assetPageSize));
    $('aPrev').parentNode.classList.toggle('disabled', _assetPage <= 1);
    $('aNext').parentNode.classList.toggle('disabled', _assetPage >= pages);
  }
  // 工具条
  $('btnNewAsset').addEventListener('click', function () { _openAssetModal(null); });
  // 左树（类别/部门）点击筛选已在 renderAssetTree 内绑定
  // 过滤条：点击「过滤」展开/收起面板
  $('assetFilterToggle').addEventListener('click', function () {
    var b = $('assetFilterFold'); b.style.display = b.style.display === 'none' ? 'block' : 'none';
  });
  $('assetFilterHoldup').addEventListener('click', function () { $('assetFilterFold').style.display = 'none'; });
  // 顶部「显示已清理资产」与折叠区同步
  $('fShowCleanedTop').addEventListener('change', function () { $('fShowCleaned').checked = this.checked; _assetPage = 1; renderAssets(); });
  $('fShowCleaned').addEventListener('change', function () { $('fShowCleanedTop').checked = this.checked; _assetPage = 1; renderAssets(); });
  $('btnAssetFilterReset').addEventListener('click', function () {
    ['fCode','fName','fEntryStart','fEntryEnd','fCleanStart','fCleanEnd','fAcqStart','fAcqEnd'].forEach(function (id){ $(id).value=''; });
    $('fCategory').value=''; $('fDept').value=''; $('fMethod').value=''; $('fStatus').value=''; $('fAddVch').value=''; $('fCleanVch').value='';
    $('fShowCleaned').checked=false; $('fShowCleanedTop').checked=false;
    _assetCatSel=''; _assetDeptSel=''; renderAssetTree();
    _assetPage = 1; renderAssets();
  });
  $('btnAssetFilterQuery').addEventListener('click', function () { _assetPage = 1; renderAssets(); });
  $('btnAssetExport').addEventListener('click', function () {
    if (!_assetFiltered.length) return showToast('当前无可导出的卡片', 'error');
    var wb = KinDee.buildAssetWorkbook(_assetFiltered);
    __safeExportExcel(wb, '固定资产卡片_' + currentPeriod())
      .then(function (path) { window.__fileSaveBridge.toastExported(path); })
      .catch(function (e) { showToast('导出失败：' + (e && e.message || e), 'error'); });
  });
  $('btnAssetImport').addEventListener('click', function () {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xlsx,.xls';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(e.target.result, { type: 'array' });
          var list = KinDee.parseAssetWorkbook(wb);
          if (!list.length) return showToast('未解析到有效卡片（需含编码/名称/原值）', 'error');
          list.forEach(function (fa) { S.addFixedAsset(fa); });
          renderAssets(); syncAll();
          showToast('已导入 ' + list.length + ' 张卡片');
        } catch (err) { showToast('导入失败：' + err.message, 'error'); }
      };
      reader.readAsArrayBuffer(f);
    };
    inp.click();
  });
  $('btnAssetBatch').addEventListener('click', function (e) {
    e.stopPropagation();
    var m = $('assetBatchMenu'); if (m) m.hidden = !m.hidden;
  });
  $('assetBatchMenu').addEventListener('click', async function (e) {
    var a = e.target.closest('a[data-batch]');
    if (!a) return;
    var act = a.getAttribute('data-batch');
    var checked = [].slice.call(document.querySelectorAll('.aChk:checked')).map(function (c) { return c.getAttribute('data-id'); });
    $('assetBatchMenu').hidden = true;
    if (!checked.length) return showToast('请先勾选要操作的卡片', 'error');
    if (act === 'clean') {
      var m2 = $('aPeriod').value || currentPeriod();
      if (!(await H.confirmAsync('已勾选 ' + checked.length + ' 张卡片，确认批量清理（清理期间 ' + m2 + '）？', { title: '批量清理' }))) return;
      checked.forEach(function (id) { S.cleanFixedAsset(id, m2); });
      renderAssets(); syncAll();
      showToast('已批量清理 ' + checked.length + ' 张');
    } else {
      if (!(await H.confirmAsync('已勾选 ' + checked.length + ' 张卡片，确认批量删除？\n已计提折旧/已清理的卡片将无法删除。', { title: '批量删除' }))) return;
      var delOk = 0, delFail = 0;
      checked.forEach(function (id) { var r = S.removeFixedAsset(id); if (r.ok) delOk++; else delFail++; });
      renderAssets(); syncAll();
      showToast('已删除 ' + delOk + ' 张' + (delFail ? '，' + delFail + ' 张因已折旧/清理未删' : ''));
    }
  });
  document.addEventListener('click', function (e) {
    var m = $('assetBatchMenu');
    if (m && !m.hidden && !e.target.closest('#btnAssetBatch') && !e.target.closest('#assetBatchMenu')) m.hidden = true;
  });
  $('btnAssetGenVoucher').addEventListener('click', function () {
    var month = $('aPeriod').value || currentPeriod();
    // 勾选已清理且未生成清理凭证的卡片 → 一键生成清理凭证；否则计提折旧
    var cleanIds = [].slice.call(document.querySelectorAll('.aChk:checked')).map(function (c) { return c.getAttribute('data-id'); })
      .filter(function (id) {
        var fa = S.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
        return fa && fa.status === '清理' && !fa.cleanVoucher;
      });
    if (cleanIds.length) {
      var rc = S.genCleanVoucher(cleanIds, month);
      if (!rc.ok) return showToast(rc.msg, 'error');
      showToast('已生成清理凭证 ' + rc.voucher.word + '-' + rc.voucher.no);
      renderAssets(); syncAll();
      return;
    }
    var r = S.depreciateMonth(month);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已生成折旧凭证 ' + r.voucher.word + '-' + r.voucher.no);
    renderAssets(); syncAll();
  });
  $('aPrev').addEventListener('click', function () { if (_assetPage > 1) { _assetPage--; renderAssets(); } });
  $('aNext').addEventListener('click', function () {
    var pages = Math.max(1, Math.ceil(_assetFiltered.length / _assetPageSize));
    if (_assetPage < pages) { _assetPage++; renderAssets(); }
  });
  $('aPageSize').addEventListener('change', function () { _assetPageSize = num($('aPageSize').value); _assetPage = 1; renderAssets(); });
  $('aCheckAll').addEventListener('change', function (e) { document.querySelectorAll('.aChk').forEach(function (c) { c.checked = e.target.checked; }); });
  $('assetBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('link-del')) {
      var delId = e.target.getAttribute('data-del');
      var delA = S.state.fixedAssets.filter(function (x) { return x.id === delId; })[0];
      if (!(await H.confirmAsync('确定删除固定资产卡片「' + (delA ? delA.name : '') + '」吗？', { title: '删除资产卡片' }))) return;
      var dr = S.removeFixedAsset(delId);
      if (!dr.ok) return showToast(dr.msg, 'error');
      renderAssets(); showToast('已删除卡片');
    } else if (e.target.classList.contains('link-edit')) {
      _openAssetModal(e.target.getAttribute('data-asset-edit'));
    } else if (e.target.classList.contains('link-copy')) {
      _copyAsset(e.target.getAttribute('data-copy'));
    } else if (e.target.classList.contains('link-clean')) {
      var cid = e.target.getAttribute('data-clean');
      var cf = S.state.fixedAssets.filter(function (x) { return x.id === cid; })[0];
      if (!cf) return;
      var cm = $('aPeriod').value || currentPeriod();
      if (!(await H.confirmAsync('确定清理「' + cf.name + '」吗？\n清理期间：' + cm + '\n清理后该卡片状态变为「已清理」，可在「显示已清理资产」中查看，并可一键生成清理凭证。', { title: '清理资产' }))) return;
      S.cleanFixedAsset(cid, cm);
      renderAssets(); syncAll();
      showToast('已清理：' + cf.name + '（清理期间 ' + cm + '）');
    } else if (e.target.classList.contains('link-unclean')) {
      var r = S.cancelCleanFixedAsset(e.target.getAttribute('data-unclean'));
      if (!r.ok) return showToast(r.msg, 'error');
      renderAssets(); syncAll();
      showToast('已取消清理');
    }
  });
  // 「复制」= 以原卡为基础生成新卡片：打开新增弹窗预填字段，编码清空重填、状态类字段复位
  function _copyAsset(id) {
    var fa = S.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
    if (!fa) return;
    _openAssetModal(id);
    $('aCode').value = '';
    $('aStatus').value = '正常';
    $('aCleanPeriod').value = '';
    $('assetModal').setAttribute('data-asset-id', '');
    showToast('已按「' + fa.name + '」预填新卡片，请修改编码后保存');
  }
  // 固定资产表单的 7 个科目选择：统一用共享组件 SubjectCombo（输入框+联想）。
  // 每个下拉带各自的前缀过滤（如固定资产只列 16 开头）。首次绑定一次（dataset 守卫），
  // 之后 _openAssetModal 只回填 value，避免每次打开重复挂监听。
  var _acctCombos = {
    aFaAcct: /^16/, aAccDeprAcct: /^1602/, aDeprFeeAcct: /^5[0-9]/, aCleanAcct: /^1606/,
    aPurchaseAcct: /^1[0-9]/, aTaxAcct: /^2221/, aImpairAcct: /^1[0-9]/
  };
  function _bindAcctCombos() {
    Object.keys(_acctCombos).forEach(function (id) {
      var inp = $(id); if (!inp || inp.dataset.comboBound) return;
      inp.dataset.comboBound = '1';
      bindSubjectCombo(inp, {
        filter: function (s) { return _acctCombos[id].test(s.code); }
      });
    });
  }
  // fa 对象字段名（faAcctId/accDeprAcct/...）与 input id（aFaAcct/...）不同，需显式映射
  var _acctFieldMap = {
    aFaAcct: 'faAcctId', aAccDeprAcct: 'accDeprAcct', aDeprFeeAcct: 'deprFeeAcct',
    aCleanAcct: 'cleanAcct', aPurchaseAcct: 'purchaseAcct', aTaxAcct: 'taxAcct', aImpairAcct: 'impairAcct'
  };
  function _setAcctCombos(fa) {
    Object.keys(_acctFieldMap).forEach(function (id) {
      var inp = $(id); if (inp) inp.value = (fa && fa[_acctFieldMap[id]]) || '';
    });
  }
  // 月折旧额联动：录入原值/残值率/期数后自动计算（form_perDepreciation）
  function _calcMonthDepr() {
    var o = U.num($('aOriginal').value), r = U.num($('aSalvageRate').value), m = U.num($('aLife').value);
    if (!o || !m) { $('aMonthDepr').value = ''; return; }
    $('aMonthDepr').value = ((o * (1 - r / 100)) / m).toFixed(2);
  }
  function _openAssetModal(id) {
    // 填充类别下拉（仅一次）
    var ac = $('aCategory');
    if (ac && ac.options.length <= 1) {
      var fa = id ? S.state.fixedAssets.filter(function (x) { return x.id === id; })[0] : null;
      // 新增时只列启用类别；编辑时额外补回该卡片当前类别（即使已停用，避免历史回填丢失）
      assetCats().forEach(function (c) {
        if (c.enabled === false && !(fa && fa.category === c.code)) return;
        var o = document.createElement('option'); o.value = c.code; o.textContent = c.name + (c.enabled === false ? '（停用）' : ''); ac.appendChild(o);
      });
    }
    // 科目选择统一为联想输入（SubjectCombo 组件，带前缀过滤）
    _bindAcctCombos();
    var fa = id ? S.state.fixedAssets.filter(function (x) { return x.id === id; })[0] : null;
    $('aCode').value = fa ? (fa.code || '') : '';
    $('aName').value = fa ? (fa.name || '') : '';
    _setAcctCombos(fa); // 回填 7 个科目（input 的 .value）
    $('aDept').value = fa ? (fa.dept || '') : '';
    $('aAcq').value = fa ? (fa.acqDate || '') : '';
    $('aOriginal').value = fa ? fa.original : '';
    $('aMethod').value = fa ? (fa.method || '平均年限法') : '平均年限法';
    $('aSalvageRate').value = fa ? fa.salvageRate : '';
    $('aLife').value = fa ? (fa.life * 12) : 60;    // 存储为年，表单显示月
    $('aPeriodUsed').value = fa ? (fa.periodUsed || 0) : 0;
    $('aAccumDeprBegin').value = fa ? fa.accumDeprBegin : 0;
    $('aYearDepr').value = fa ? (fa.yearDepr || 0) : 0;
    $('aQty').value = fa ? (fa.qty || 1) : 1;
    $('aCategory').value = fa ? (fa.category || '') : '';
    $('aSpec').value = fa ? (fa.spec || '') : '';
    $('aLocation').value = fa ? (fa.location || '') : '';
    $('aUser').value = fa ? (fa.user || '') : '';
    $('aEntryPeriod').value = fa ? (fa.entryPeriod || '') : currentPeriod();
    $('aImpairment').value = fa ? fa.impairment : 0;
    $('aStatus').value = fa ? (fa.status || '正常') : '正常';
    $('aCleanPeriod').value = fa ? (fa.cleanPeriod || '') : '';
    $('aMemo').value = fa ? (fa.memo || '') : '';
    _calcMonthDepr();
    $('assetModal').setAttribute('data-asset-id', id || '');
    $('assetModal').classList.add('show');
  }
  // 收集表单为卡片对象
  function _collectAsset() {
    return {
      code: $('aCode').value, name: $('aName').value, faAcctId: $('aFaAcct').value, dept: $('aDept').value,
      acqDate: $('aAcq').value, original: U.num($('aOriginal').value), accDeprAcct: $('aAccDeprAcct').value,
      method: $('aMethod').value, deprFeeAcct: $('aDeprFeeAcct').value, cleanAcct: $('aCleanAcct').value,
      purchaseAcct: $('aPurchaseAcct').value, taxAcct: $('aTaxAcct').value, impairAcct: $('aImpairAcct').value, salvageRate: $('aSalvageRate').value,
      life: U.num($('aLife').value) / 12, periodUsed: U.num($('aPeriodUsed').value),
      accumDeprBegin: U.num($('aAccumDeprBegin').value), yearDepr: U.num($('aYearDepr').value),
      qty: U.num($('aQty').value), category: $('aCategory').value, spec: $('aSpec').value,
      location: $('aLocation').value, user: $('aUser').value, entryPeriod: $('aEntryPeriod').value,
      impairment: U.num($('aImpairment').value), status: $('aStatus').value,
      cleanPeriod: $('aCleanPeriod').value, memo: $('aMemo').value,
      salvage: U.num($('aOriginal').value) * U.num($('aSalvageRate').value) / 100
    };
  }
  $('btnCloseAsset').addEventListener('click', function () { $('assetModal').classList.remove('show'); });
  ['aOriginal', 'aSalvageRate', 'aLife'].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener('input', _calcMonthDepr);
  });
  function _saveAsset(mode) {
    var fa = _collectAsset();
    // 必填校验（对齐卡片新增窗 required-mark 字段）
    if (!fa.code) return showToast('请填写资产编码', 'error');
    if (!fa.name) return showToast('请填写资产名称', 'error');
    if (!fa.faAcctId) return showToast('请选择固定资产科目', 'error');
    if (!fa.dept) return showToast('请填写使用部门', 'error');
    if (!fa.acqDate) return showToast('请选择开始使用日期', 'error');
    if (!fa.original) return showToast('请填写原值', 'error');
    if (!fa.accDeprAcct) return showToast('请选择累计折旧科目', 'error');
    if (!fa.method) return showToast('请选择折旧方法', 'error');
    if (!fa.deprFeeAcct) return showToast('请选择折旧费用科目', 'error');
    if (!fa.cleanAcct) return showToast('请选择资产清理科目', 'error');
    if (!fa.purchaseAcct) return showToast('请选择资产购入对方科目', 'error');
    if (fa.salvageRate === '' || fa.salvageRate === undefined) return showToast('请填写残值率%', 'error');
    if (!fa.life) return showToast('请填写预计使用期数(月)', 'error');
    if (fa.periodUsed === '' || fa.periodUsed === undefined) return showToast('请填写已折旧期间', 'error');
    if (fa.accumDeprBegin === '' || fa.accumDeprBegin === undefined) return showToast('请填写期初累计折旧', 'error');
    if (!fa.yearDepr && fa.yearDepr !== 0) return showToast('请填写本年已折旧', 'error');
    if (!fa.qty) return showToast('请填写数量', 'error');
    var editId = $('assetModal').getAttribute('data-asset-id');
    if (editId) { S.updateFixedAsset(editId, fa); showToast('卡片已更新'); }
    else { S.addFixedAsset(fa); showToast('卡片已保存'); }
    if (mode === 'add') { _openAssetModal(''); return; } // 保存并新增：清空再开
    if (mode === 'copy') { $('aCode').value = ''; _openAssetModal(''); $('assetModal').setAttribute('data-asset-id', ''); return; } // 保存并复制：清空编码再开
    $('assetModal').classList.remove('show');
    renderAssets(); syncAll();
  }
  $('btnSaveAsset').addEventListener('click', function () { _saveAsset('close'); });
  $('btnSaveCopyAsset').addEventListener('click', function () { _saveAsset('copy'); });
  $('btnSaveAddAsset').addEventListener('click', function () { _saveAsset('add'); });

  function refreshDas() {
    var sInp = $('dasPeriodStart'), eInp = $('dasPeriodEnd');
    var def = currentPeriod();
    if (sInp && eInp) {
      sInp.value = sInp.value || def;
      eInp.value = eInp.value || def;
      if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__('dasPeriodStart', 'dasPeriodEnd');
    }
    var month = eInp ? eInp.value : def;
    renderDas(month);
    if (globalThis.setRptHead) globalThis.setRptHead('dasTitleRow', '折旧汇总表', 11, month);
  }
  function dasMonth() { var e = $('dasPeriodEnd'); return e ? e.value : currentPeriod(); }
  ['dasPeriodStart', 'dasPeriodEnd'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('change', function () { renderDas(dasMonth()); });
  });
  // btnDasPrint 已加 data-print，由全局委托统一走 kdPrint()。
  $('btnDasExport').addEventListener('click', function () {
    var month = dasMonth();
    var rows = _assetDeprRows(month, { showCleaned: $('dasShowCleaned').checked });
    if (!rows.length) return showToast('当前期间无可导出数据', 'error');
    var headers = ['类别', '编码', '名称', '部门', '原值', '期初累计折旧', '本月折旧', '本年折旧额', '期末累计折旧', '期末减值准备', '期末净值'];
    var data = rows.map(function (r) {
      return [_catName(r.cat), r.code, r.name, r.dept, r.orig.toFixed(2), r.accumBegin.toFixed(2), r.monthDepr.toFixed(2),
        r.yearDepr.toFixed(2), r.accumEnd.toFixed(2), r.impair.toFixed(2), r.netEnd.toFixed(2)];
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers].concat(data)), '折旧汇总表');
    __safeExportExcel(wb, '折旧汇总表_' + month);
  });
  function _assetDeprRows(month, opts) {
    opts = opts || {};
    var y = month ? month.slice(0, 4) : currentPeriod().slice(0, 4);
    var rows = S.state.fixedAssets.filter(function (fa) {
      if (!opts.showCleaned && fa.status === '清理') return false;
      return true;
    }).map(function (fa) {
      var md = S.assetMonthlyDepr(fa);
      // 本年折旧额：当年 1 月至当前期，按应计月份数近似（直线法每月相等）
      var m0 = y + '-01';
      var periodMonths = month ? (U.monthsBetween(m0, month) + 1) : 0;
      var yearDepr = md * periodMonths;
      var accumEnd = num(fa.accumDepr);
      var netEnd = num(fa.original) - accumEnd - num(fa.impairment);
      return {
        fa: fa,
        monthDepr: md,
        yearDepr: yearDepr,
        accumBegin: num(fa.accumDeprBegin),
        accumEnd: accumEnd,
        netEnd: netEnd,
        orig: num(fa.original),
        impair: num(fa.impairment),
        cat: fa.category || '', catName: _catName(fa.category), dept: fa.dept || '', code: fa.code || '', name: fa.name || ''
      };
    });
    return rows;
  }
  function renderDas(month) {
    var byDept = $('dasByDept').checked, showCleaned = $('dasShowCleaned').checked;
    if ($('dasMonthTh')) $('dasMonthTh').textContent = (month || currentPeriod()) + '折旧';
    var rows = _assetDeprRows(month, { showCleaned: showCleaned });
    // 按类别（或部门）分组，保持插入顺序
    var groups = {}, order = [];
    rows.forEach(function (r) {
      var k = byDept ? ('部门:' + r.dept) : r.catName;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    var tb = $('dasBody'); tb.innerHTML = '';
    var tot = { orig: 0, ab: 0, md: 0, yd: 0, ae: 0, im: 0, ne: 0 };
    order.forEach(function (k) {
      var g = groups[k];
      var sub = { orig: 0, ab: 0, md: 0, yd: 0, ae: 0, im: 0, ne: 0 };
      g.forEach(function (r) {
        sub.orig += r.orig; sub.ab += r.accumBegin; sub.md += r.monthDepr; sub.yd += r.yearDepr;
        sub.ae += r.accumEnd; sub.im += r.impair; sub.ne += r.netEnd;
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + (byDept ? '' : esc(r.catName)) + '</td>' +
          '<td>' + esc(r.code) + '</td>' +
          '<td>' + esc(r.name) + '</td>' +
          '<td>' + (byDept ? esc(r.dept) : '') + '</td>' +
          '<td class="ta-r mono">' + money(r.orig) + '</td>' +
          '<td class="ta-r mono">' + money(r.accumBegin) + '</td>' +
          '<td class="ta-r mono">' + money(r.monthDepr) + '</td>' +
          '<td class="ta-r mono">' + money(r.yearDepr) + '</td>' +
          '<td class="ta-r mono">' + money(r.accumEnd) + '</td>' +
          '<td class="ta-r mono">' + money(r.impair) + '</td>' +
          '<td class="ta-r mono">' + money(r.netEnd) + '</td>';
        tb.appendChild(tr);
        tot.orig += r.orig; tot.ab += r.accumBegin; tot.md += r.monthDepr; tot.yd += r.yearDepr;
        tot.ae += r.accumEnd; tot.im += r.impair; tot.ne += r.netEnd;
      });
      // 同类别内末尾小计行（deprService 小计行结构）
      var lab = document.createElement('tr');
      lab.className = 'subtotal-row';
      lab.innerHTML = '<td></td><td></td><td>' + (byDept ? esc(k.replace('部门:', '')) : '小计') + '</td><td></td>' +
        '<td class="ta-r mono">' + money(sub.orig) + '</td>' +
        '<td class="ta-r mono">' + money(sub.ab) + '</td>' +
        '<td class="ta-r mono">' + money(sub.md) + '</td>' +
        '<td class="ta-r mono">' + money(sub.yd) + '</td>' +
        '<td class="ta-r mono">' + money(sub.ae) + '</td>' +
        '<td class="ta-r mono">' + money(sub.im) + '</td>' +
        '<td class="ta-r mono">' + money(sub.ne) + '</td>';
      tb.appendChild(lab);
    });
    // 合计
    var foot = $('dasFoot'); foot.innerHTML = '';
    var trf = document.createElement('tr');
    trf.innerHTML = '<td>合计</td><td></td><td></td><td></td>' +
      '<td class="ta-r mono">' + money(tot.orig) + '</td>' +
      '<td class="ta-r mono">' + money(tot.ab) + '</td>' +
      '<td class="ta-r mono">' + money(tot.md) + '</td>' +
      '<td class="ta-r mono">' + money(tot.yd) + '</td>' +
      '<td class="ta-r mono">' + money(tot.ae) + '</td>' +
      '<td class="ta-r mono">' + money(tot.im) + '</td>' +
      '<td class="ta-r mono">' + money(tot.ne) + '</td>';
    foot.appendChild(trf);
  }
  $('btnDepreciateAll').addEventListener('click', function () {
    // 期间输入框已拆为 dasPeriodStart / dasPeriodEnd（见 dasMonth()），
    // 旧的 dasPeriod 元素不存在，直接 .value 会抛 TypeError。
    var month = dasMonth();
    var r = S.depreciateMonth(month);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已计提折旧，生成凭证 ' + r.voucher.word + '-' + r.voucher.no);
    renderDas(month); syncAll();
  });

  function refreshDad() {
    var sInp = $('dadPeriodStart'), eInp = $('dadPeriodEnd');
    var def = currentPeriod();
    if (sInp && eInp) {
      sInp.value = sInp.value || def;
      eInp.value = eInp.value || def;
      if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__('dadPeriodStart', 'dadPeriodEnd');
    }
    var month = eInp ? eInp.value : def;
    renderDad(month);
    if (globalThis.setRptHead) globalThis.setRptHead('dadTitleRow', '折旧明细表', 11, month);
  }
  function dadMonth() { var e = $('dadPeriodEnd'); return e ? e.value : currentPeriod(); }
  ['dadPeriodStart', 'dadPeriodEnd'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('change', function () { renderDad(dadMonth()); });
  });
  // btnDadPrint 已加 data-print，由全局委托统一走 kdPrint()。
  $('btnDadExport').addEventListener('click', function () {
    var month = dadMonth();
    var rows = _assetDeprRows(month, { showCleaned: $('dadShowCleaned').checked });
    if (!rows.length) return showToast('当前期间无可导出数据', 'error');
    var headers = ['类别', '编码', '名称', '部门', '原值', '期初累计折旧', '本月折旧', '本年折旧额', '期末累计折旧', '期末减值准备', '期末净值'];
    var data = rows.map(function (r) {
      return [_catName(r.cat), r.code, r.name, r.dept, r.orig.toFixed(2), r.accumBegin.toFixed(2),
        r.monthDepr.toFixed(2), r.yearDepr.toFixed(2), r.accumEnd.toFixed(2), r.impair.toFixed(2), r.netEnd.toFixed(2)];
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers].concat(data)), '折旧明细表');
    __safeExportExcel(wb, '折旧明细表_' + month);
  });
  function renderDad(month) {
    var showCleaned = $('dadShowCleaned').checked, showChange = $('dadShowChange').checked;
    if ($('dadMonthTh')) $('dadMonthTh').textContent = (month || currentPeriod()) + '折旧';
    var rows = _assetDeprRows(month, { showCleaned: showCleaned });
    var tb = $('dadBody'); tb.innerHTML = '';
    var tot = { orig: 0, ab: 0, md: 0, yd: 0, ae: 0, im: 0, ne: 0 };
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + _catName(r.cat) + '</td>' +
        '<td class="mono">' + r.code + '</td>' +
        '<td>' + r.name + '</td>' +
        '<td>' + r.dept + '</td>' +
        '<td class="ta-r mono">' + money(r.orig) + '</td>' +
        '<td class="ta-r mono">' + money(r.accumBegin) + '</td>' +
        '<td class="ta-r mono">' + money(r.monthDepr) + '</td>' +
        '<td class="ta-r mono">' + money(r.yearDepr) + '</td>' +
        '<td class="ta-r mono">' + money(r.accumEnd) + '</td>' +
        '<td class="ta-r mono">' + money(r.impair) + '</td>' +
        '<td class="ta-r mono">' + money(r.netEnd) + '</td>';
      tb.appendChild(tr);
      Object.keys(tot).forEach(function (key) { tot[key] += r[key]; });
    });
    var foot = $('dadFoot'); foot.innerHTML = '';
    var trf = document.createElement('tr');
    trf.innerHTML = '<td colspan="4">合计</td>' +
      '<td class="ta-r mono">' + money(tot.orig) + '</td>' +
      '<td class="ta-r mono">' + money(tot.ab) + '</td>' +
      '<td class="ta-r mono">' + money(tot.md) + '</td>' +
      '<td class="ta-r mono">' + money(tot.yd) + '</td>' +
      '<td class="ta-r mono">' + money(tot.ae) + '</td>' +
      '<td class="ta-r mono">' + money(tot.im) + '</td>' +
      '<td class="ta-r mono">' + money(tot.ne) + '</td>';
    foot.appendChild(trf);
    // 显示变动信息（"显示变动信息"勾选时额外列出变动记录摘要）
    if (showChange) {
      var acl = buildAssetChangeLog(month);
      acl.forEach(function (r) {
        var trc = document.createElement('tr');
        trc.className = 'change-row';
        trc.innerHTML = '<td colspan="11" class="muted">' + r.period + ' ' + r.name + ' 变动项:' + r.item + ' 由[' + r.before + ']变为[' + r.after + ']</td>';
        tb.appendChild(trc);
      });
    }
  }

  /* 资产类别：系统预置 6 类（平均年限法），可编辑 */
  function assetCats() {
    if (!S.state.assetCats) {
      S.state.assetCats = [
        { code: '001', name: '房屋、建筑物',   method: '平均年限法', life: 30, salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
        { code: '002', name: '机器机械生产设备', method: '平均年限法', life: 10, salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
        { code: '003', name: '器具、工具、家具', method: '平均年限法', life: 5,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
        { code: '004', name: '运输工具',       method: '平均年限法', life: 4,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
        { code: '005', name: '电子设备',       method: '平均年限法', life: 3,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true },
        { code: '006', name: '其他固定资产',   method: '平均年限法', life: 5,  salvage: 5, asset: '1601', depr: '1602', memo: '', enabled: true }
      ];
    }
    return S.state.assetCats;
  }
  function renderAssetCategory() {
    var tb = $('catBody'); tb.innerHTML = '';
    assetCats().forEach(function (c, i) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="catChk" data-i="' + i + '"></td>' +
        '<td><a class="link-edit" data-cat="' + i + '">编辑</a> <a class="link-toggle" data-catdel="' + i + '">' + (c.enabled === false ? '启用' : '停用') + '</a></td>' +
        '<td class="mono">' + c.code + '</td>' +
        '<td>' + c.name + (c.enabled === false ? ' <span class="tag-disabled">停用</span>' : '') + '</td>' +
        '<td>' + c.method + '</td>' +
        '<td class="ta-r">' + c.life + ' 年</td>' +
        '<td class="ta-r">' + c.salvage + '%</td>' +
        '<td class="mono">' + c.asset + '</td>' +
        '<td class="mono">' + c.depr + '</td>' +
        '<td>' + c.memo + '</td>';
      tb.appendChild(tr);
    });
  }
  function refreshAssetCategory() { renderAssetCategory(); }
  $('btnResetCat').addEventListener('click', async function () {
    if (!(await H.confirmAsync('恢复默认资产类别将覆盖当前已自定义的类别与折旧参数，确定继续？', { title: '恢复默认类别' }))) return;
    S.state.assetCats = null; renderAssetCategory(); showToast('已恢复默认类别');
  });
  $('btnNewCat').addEventListener('click', function () { _openCatModal(-1); });
  $('btnDelCat').addEventListener('click', async function () {
    var checked = [].slice.call(document.querySelectorAll('.catChk:checked')).map(function (c) { return num(c.getAttribute('data-i')); });
    if (!checked.length) return showToast('请先勾选要停用的类别', 'error');
    if (!(await H.confirmAsync('确定停用选中的 ' + checked.length + ' 个资产类别？\n停用后新增资产不能再选该类，历史资产类别保留。', { title: '停用资产类别' }))) return;
    var list = assetCats();
    checked.forEach(function (i) { if (list[i]) list[i].enabled = false; });
    S.state.assetCats = list; renderAssetCategory(); showToast('已停用'); syncAll();
  });
  $('catBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('link-toggle')) {
      var i = num(e.target.getAttribute('data-catdel'));
      var cat = assetCats()[i];
      var disabling = !(cat && cat.enabled === false);
      if (disabling) {
        if (!(await H.confirmAsync('确定停用资产类别「' + (cat ? cat.name : '') + '」？', { title: '停用资产类别' }))) return;
      }
      cat.enabled = disabling ? false : true;
      renderAssetCategory(); showToast(disabling ? '已停用' : '已启用'); syncAll();
    } else if (e.target.classList.contains('link-edit')) {
      _openCatModal(num(e.target.getAttribute('data-cat')));
    }
  });
  function _openCatModal(idx) {
    var c = idx >= 0 ? assetCats()[idx] : null;
    $('catModal').setAttribute('data-idx', idx);
    $('catCode').value = c ? c.code : '';
    $('catName').value = c ? c.name : '';
    $('catMethod').value = c ? c.method : '平均年限法';
    $('catLife').value = c ? c.life : 5;
    $('catSalvage').value = c ? c.salvage : 5;
    $('catAsset').value = c ? c.asset : '1601';
    $('catDepr').value = c ? c.depr : '1602';
    $('catMemo').value = c ? c.memo : '';
    $('catModal').classList.add('show');
  }
  $('btnCloseCat').addEventListener('click', function () { $('catModal').classList.remove('show'); });
  $('btnSaveCat').addEventListener('click', function () {
    var idx = num($('catModal').getAttribute('data-idx'));
    var c = {
      code: $('catCode').value, name: $('catName').value, method: $('catMethod').value,
      life: U.num($('catLife').value), salvage: U.num($('catSalvage').value),
      asset: $('catAsset').value, depr: $('catDepr').value, memo: $('catMemo').value,
      enabled: (idx >= 0 ? (assetCats()[idx] && assetCats()[idx].enabled !== false) : true)
    };
    if (!c.code || !c.name) return showToast('请填写类别编码与名称', 'error');
    var list = assetCats();
    if (idx >= 0) list[idx] = c; else list.push(c);
    S.state.assetCats = list;
    $('catModal').classList.remove('show');
    renderAssetCategory(); syncAll(); showToast('类别已保存');
  });

  /* 资产变动记录：基于固定资产卡片生成「新增/录入」变动行 */
  function buildAssetChangeLog(month) {
    return S.state.fixedAssets.filter(function (fa) {
      return !month || (fa.acqDate && fa.acqDate.slice(0, 7) === month);
    }).map(function (fa) {
      return {
        code: fa.code, name: fa.name, item: '资产录入', before: '—', after: '新增（原值 ' + money(fa.original) + '）',
        period: fa.acqDate ? fa.acqDate.slice(0, 7) : '', user: '系统', time: fa.acqDate || ''
      };
    });
  }
  function refreshAssetChangeLog() {
    var sInp = $('aclPeriodStart'), eInp = $('aclPeriodEnd');
    var def = currentPeriod();
    if (sInp && eInp) {
      sInp.value = sInp.value || def;
      eInp.value = eInp.value || def;
      if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__('aclPeriodStart', 'aclPeriodEnd');
    }
    var month = eInp ? eInp.value : def;
    renderAssetChangeLog(month);
    if (globalThis.setRptHead) globalThis.setRptHead('aclTitleRow', '资产变动记录', 8, month);
  }
  function aclMonth() { var e = $('aclPeriodEnd'); return e ? e.value : currentPeriod(); }
  ['aclPeriodStart', 'aclPeriodEnd'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('change', function () { renderAssetChangeLog(aclMonth()); });
  });
  // btnAclPrint 已加 data-print，由全局委托统一走 kdPrint()。
  $('btnAclExport').addEventListener('click', function () {
    var month = aclMonth();
    var rows = buildAssetChangeLog(month);
    if (!rows.length) return showToast('当前期间无可导出数据', 'error');
    var headers = ['资产编码', '名称', '变动项', '变动前', '变动后', '变动期间', '修改人', '变动时间'];
    var data = rows.map(function (r) {
      return [r.code, r.name, r.item, r.before, r.after, r.period, r.user, r.time];
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers].concat(data)), '资产变动记录');
    __safeExportExcel(wb, '资产变动记录_' + month);
  });
  function renderAssetChangeLog(month) {
    var tb = $('aclBody'); tb.innerHTML = '';
    var rows = buildAssetChangeLog(month);
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="8" class="empty-hint">暂无变动记录</td></tr>';
      return;
    }
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + r.code + '</td><td>' + r.name + '</td><td>' + r.item + '</td>' +
        '<td>' + r.before + '</td><td>' + r.after + '</td><td class="mono">' + r.period + '</td>' +
        '<td>' + r.user + '</td><td class="mono">' + r.time + '</td>';
      tb.appendChild(tr);
    });
  }

  /* 折旧凭证：显示已生成的计提折旧凭证，支持一键计提 */
  // 本期已生成的「计提折旧」凭证。按 v.kind 结构识别（与 store 结账检查同口径），
  // 覆盖资产页生成的「计提折旧」与期末模板生成的「计提xxxx期固定资产折旧」。
  // 原实现按摘要正则匹配，对金蝶导入凭证（无 v.summary）恒不命中。
  function deprVchOf(month) {
    if (!S.periodVouchersOfKind) return [];
    return S.periodVouchersOfKind(month, S.VOUCHER_KINDS.DEPR);
  }
  // 折旧凭证页顶部提示随本期计提状态动态切换（对齐 bs-wip 数据驱动风格）
  function updateDvTip(month) {
    var tip = $('dvTip');
    if (!tip) return;
    var dup = deprVchOf(month);
    if (dup.length) {
      var nos = dup.map(function (v) { return (v.word || '记') + '-' + v.no; }).join('、');
      tip.className = 'k-tip warn';
      tip.textContent = '本期已生成折旧凭证（' + nos + '），重复点击「生成折旧凭证」将再次生成，请先删除原凭证后再生成。';
    } else {
      tip.className = 'k-tip info';
      tip.textContent = '点击「生成折旧凭证」按当前期间计提折旧并生成凭证。';
    }
  }
  function refreshAssetDeprVoucher() {
    var m = currentPeriod();
    var dv = $('dvPeriod'); if (dv) { dv.textContent = '当前期间：' + m; dv.setAttribute('data-period', m); }
    renderAssetDeprVoucher(m);
  }
  function renderAssetDeprVoucher(month) {
    var tb = $('dvBody'); tb.innerHTML = '';
    updateDvTip(month);
    // 折旧凭证页与卡片同款 31 列，列出参与当前期间计提的资产卡片
    var rows = S.state.fixedAssets.filter(function (fa) {
      return fa.original > 0 && fa.status !== '清理';
    });
    var tot = { orig: 0, ab: 0, ae: 0, md: 0, s: 0, im: 0, nb: 0, ne: 0 };
    rows.forEach(function (fa) {
      var md = S.assetMonthlyDepr(fa);
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="dvChk"></td>' +
        '<td><a class="link-del" data-dv="' + fa.id + '">生成</a></td>' +
        '<td class="mono">' + (fa.code || '') + '</td>' +
        '<td>' + (fa.name || '') + '</td>' +
        '<td>' + _catName(fa.category) + '</td>' +
        '<td>' + (fa.dept || '') + '</td>' +
        '<td>' + (fa.acqDate || '') + '</td>' +
        '<td>' + (fa.entryPeriod || '') + '</td>' +
        '<td class="ta-r mono">' + money(fa.original) + '</td>' +
        '<td class="ta-r mono">' + money(fa.accumDeprBegin) + '</td>' +
        '<td class="ta-r mono">' + money(fa.accumDepr) + '</td>' +
        '<td class="ta-r mono">' + money(md) + '</td>' +
        '<td class="ta-c">' + (fa.life ? fa.life + '年' : '') + '</td>' +
        '<td class="ta-c">' + (fa.periodUsed || '') + '</td>' +
        '<td class="ta-r mono">' + money(fa.salvage) + '</td>' +
        '<td class="ta-r mono">' + num(fa.salvageRate).toFixed(2) + '</td>' +
        '<td class="ta-r mono">' + money(fa.impairment) + '</td>' +
        '<td class="ta-r mono">' + money(fa.netValueBegin) + '</td>' +
        '<td class="ta-r mono">' + money(fa.netValueEnd) + '</td>' +
        '<td>' + (fa.method || '') + '</td>' +
        '<td>' + (fa.status || '正常') + '</td>' +
        '<td class="ta-r">' + (fa.qty || '') + '</td>' +
        '<td>' + (fa.spec || '') + '</td>' +
        '<td>' + (fa.location || '') + '</td>' +
        '<td>' + (fa.user || '') + '</td>' +
        '<td>' + (fa.cleanPeriod || '') + '</td>' +
        '<td class="mono">' + (fa.addVoucher || '') + '</td>' +
        '<td class="mono">' + (fa.cleanVoucher || '') + '</td>' +
        '<td class="mono">' + (fa.impairVoucher || '') + '</td>' +
        '<td class="mono">' + (fa.otherVoucher || '') + '</td>' +
        '<td>' + (fa.memo || '') + '</td>';
      tb.appendChild(tr);
      tot.orig += num(fa.original); tot.ab += num(fa.accumDeprBegin); tot.ae += num(fa.accumDepr);
      tot.md += md; tot.s += num(fa.salvage); tot.im += num(fa.impairment);
      tot.nb += num(fa.netValueBegin); tot.ne += num(fa.netValueEnd);
    });
    var foot = $('dvFoot'); foot.innerHTML = '';
    if (rows.length) {
      var trf = document.createElement('tr');
      trf.innerHTML = '<td></td><td>合计</td><td colspan="6"></td>' +
        '<td class="ta-r mono">' + money(tot.orig) + '</td>' +
        '<td class="ta-r mono">' + money(tot.ab) + '</td>' +
        '<td class="ta-r mono">' + money(tot.ae) + '</td>' +
        '<td class="ta-r mono">' + money(tot.md) + '</td>' +
        '<td></td><td></td>' +
        '<td class="ta-r mono">' + money(tot.s) + '</td>' +
        '<td></td>' +
        '<td class="ta-r mono">' + money(tot.im) + '</td>' +
        '<td class="ta-r mono">' + money(tot.nb) + '</td>' +
        '<td class="ta-r mono">' + money(tot.ne) + '</td>' +
        '<td colspan="12"></td>';
      foot.appendChild(trf);
    }
  }
  // 折旧凭证页「导出」：复用卡片 31 列导出（折旧凭证页工具条含导出）
  $('btnDvExport').addEventListener('click', function () {
    if (!S.state.fixedAssets.length) return showToast('当前无可导出的资产', 'error');
    var wb = KinDee.buildAssetWorkbook(S.state.fixedAssets);
    __safeExportExcel(wb, '折旧凭证_' + currentPeriod())
      .then(function (path) { window.__fileSaveBridge.toastExported(path); })
      .catch(function (e) { showToast('导出失败：' + (e && e.message || e), 'error'); });
  });
  // 折旧凭证页「批量操作」：勾选后批量删除（与卡片页一致）
  $('btnDvBatch').addEventListener('click', async function () {
    var checked = [].slice.call(document.querySelectorAll('.dvChk:checked')).map(function (c) {
      return c.closest('tr').querySelector('[data-dv]').getAttribute('data-dv');
    });
    if (!checked.length) return showToast('请先勾选要操作的卡片', 'error');
    if (!(await H.confirmAsync('已勾选 ' + checked.length + ' 张卡片，确认批量删除？', { title: '批量删除' }))) return;
    checked.forEach(function (id) { S.removeFixedAsset(id); });
    var dv = $('dvPeriod');
    renderAssetDeprVoucher(dv ? dv.getAttribute('data-period') : currentPeriod()); syncAll();
    showToast('已批量删除 ' + checked.length + ' 张');
  });
  // 折旧凭证参数设置弹层
  $('btnDeprVchSetting').addEventListener('click', function () {
    var accD = S.subjectRole ? S.subjectRole('ACC_DEPR') : null;
    var feeD = S.subjectRole ? S.subjectRole('DEPR_FEE') : null;
    var s = S.state.deprVchSetting || { voucherType: '记', deprSubject: accD ? accD.code : '1602', expenseSubject: feeD ? feeD.code : '5602', category: '收益和损失分开结转' };
    $('dvsVoucherType').value = s.voucherType || '记';
    $('dvsDeprSubject').value = s.deprSubject || (accD ? accD.code : '1602');
    $('dvsExpenseSubject').value = s.expenseSubject || (feeD ? feeD.code : '5602');
    $('dvsCategory').value = s.category || '收益和损失分开结转';
    $('deprVchSettingModal').classList.add('show');
  });
  $('btnCloseDvs').addEventListener('click', function () { $('deprVchSettingModal').classList.remove('show'); });
  $('btnSaveDvs').addEventListener('click', function () {
    S.state.deprVchSetting = {
      voucherType: $('dvsVoucherType').value, deprSubject: $('dvsDeprSubject').value,
      expenseSubject: $('dvsExpenseSubject').value, category: $('dvsCategory').value
    };
    $('deprVchSettingModal').classList.remove('show');
    showToast('折旧凭证参数已保存'); syncAll();
  });
  $('btnAccrueDepr').addEventListener('click', function () {
    var m = currentPeriod();
    // 结账守卫：折旧同样不允许写入已结账期间（与期末处理「生成折旧凭证」depreciateMonth 一致）
    if (S.isPeriodClosed(m)) return showToast('本期已结账，不能生成折旧凭证，请先反结账', 'error');
    var s = S.state.deprVchSetting || {};
    // 折旧科目：配置或准则角色默认（old:1602/5602；2013:1602/6602），科目表缺失给明确提示而非悬空入账
    var accS = s.deprSubject ? S.subjectRole('ACC_DEPR', s.deprSubject) : (S.subjectRole ? S.subjectRole('ACC_DEPR') : null);
    var feeS = s.expenseSubject ? S.subjectRole('DEPR_FEE', s.expenseSubject) : (S.subjectRole ? S.subjectRole('DEPR_FEE') : null);
    if (!accS || !feeS) return showToast('科目表缺少「累计折旧/管理费用」科目，请先在科目页添加后重试', 'error');
    var deprSubj = accS.code;
    var expSubj = feeS.code;
    var word = s.voucherType || '记';
    var total = 0;
    S.state.fixedAssets.forEach(function (fa) { if (fa.original && fa.status !== '清理') total += S.assetMonthlyDepr(fa); });
    if (total <= 0) { showToast('本期无需计提折旧'); return; }
    // 已生成「计提折旧」凭证则防止重复生成（已在 dvTip 动态提示提醒，此处再拦截防止误操作）
    if (deprVchOf(m).length) { showToast('本期已生成折旧凭证（' + deprVchOf(m).map(function (v) { return (v.word || '记') + '-' + v.no; }).join('、') + '），请先删除原凭证后再生成。'); return; }
    var v = {
      word: word, num: (S.state.vouchers || []).length + 1, date: U.lastDay(m),
      entries: [
        { code: expSubj, summary: '计提折旧', dr: +total.toFixed(2), cr: 0, subjectName: S.subject(expSubj) ? S.subject(expSubj).name : '' },
        { code: deprSubj, summary: '计提折旧', dr: 0, cr: +total.toFixed(2), subjectName: S.subject(deprSubj) ? S.subject(deprSubj).name : '' }
      ]
    };
    S.addVoucher(v);
    renderAssetDeprVoucher(m);
    showToast('已生成折旧凭证：' + word + '-' + v.num + '，金额 ' + money(total));
    syncAll();
  });

  /* ============================================================
   * 折旧宿主（page-asset-depr）：页内 Tab 收敛
   * 折旧凭证 / 折旧汇总表 / 折旧明细表 / 变动记录
   * 子面板渲染映射到既有刷新函数，仅切换可见子面板不改变账务逻辑。
   * ============================================================ */
  var _deprSubRenders = {
    voucher: refreshAssetDeprVoucher,
    sum: refreshDas,
    detail: refreshDad,
    change: refreshAssetChangeLog
  };
  var _deprSubLabels = { voucher: '折旧凭证', sum: '折旧汇总表', detail: '折旧明细表', change: '变动记录' };
  // 刷新宿主时保持/回退到当前激活子面板（缺省 voucher）
  function refreshAssetDeprHost() {
    var pending = globalThis.__assetDeprPending;
    globalThis.__assetDeprPending = null;
    var tabs = $('assetDeprTabs');
    if (!tabs) return;
    var active = tabs.querySelector('.asset-subtab.active');
    var sub = pending || (active ? active.getAttribute('data-sub') : 'voucher');
    showAssetDeprSub(sub);
  }
  // goPage 旧键直达兼容：asset-depr-voucher/sum/detail/change → 宿主指定子面板
  globalThis.__goAssetDeprSub = function (sub) {
    globalThis.__assetDeprPending = sub;
    if (globalThis.goPage) globalThis.goPage('asset-depr', true);
  };
  // 切换页内子面板 + 触发对应子视图渲染（幂等）
  function showAssetDeprSub(sub) {
    var tabs = $('assetDeprTabs'); if (!tabs) return;
    var all = [].slice.call(tabs.querySelectorAll('.asset-subtab'));
    all.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-sub') === sub); });
    [].slice.call(document.querySelectorAll('#page-asset-depr > .asset-sub')).forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-sub') === sub);
    });
    if (_deprSubRenders[sub]) _deprSubRenders[sub]();
  }
  // tab 点击切换
  (function () {
    var tabs = $('assetDeprTabs');
    if (!tabs) return;
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.asset-subtab');
      if (btn) showAssetDeprSub(btn.getAttribute('data-sub'));
    });
  })();

  /* 固定资产卡片页工具条「资产类别」弹窗入口（原独立页收敛为页内弹窗） */
  (function () {
    var opener = $('btnAssetCatMgr');
    if (opener) opener.addEventListener('click', function () {
      renderAssetCategory();
      var m = $('assetCatListModal');
      if (m) m.classList.add('show');
    });
    var closer = $('btnCloseAssetCatList');
    if (closer) closer.addEventListener('click', function () {
      var m = $('assetCatListModal');
      if (m) m.classList.remove('show');
    });
  })();

export {
  refreshAssets, refreshDas, refreshDad, refreshAssetCategory, refreshAssetChangeLog, refreshAssetDeprVoucher,
  refreshAssetDeprHost, showAssetDeprSub
};

