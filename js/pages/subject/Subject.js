// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__KINGDEE_HELPERS__（app.js 注册）、globalThis.__KINGDEE_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

const H = globalThis.__KINGDEE_HELPERS__ || {};
const EX = globalThis.__KINGDEE_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
import { bindSubjectCombo } from '../../components/SubjectCombo.js';
import { exportTable } from '../settings/_shared.js';
// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES / AUX_TYPES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);
const AUX_TYPES = globalThis.AUX_TYPES || (EX && EX.AUX_TYPES);

  function refreshSubjects() { renderSubjects(); }
  /* 科目页：分类 Tab（资产/负债/共同/权益/成本/损益）+ 展开所有级次 + 勾选计数 */
  var subjTabCls = 'asset';   // 当前分类 Tab（默认选中「资产」）
  var subjChecked = {};       // 勾选待删科目 code 集合
  function subjFiltered() {
    return S.subjects().filter(function (s) {
      // 分类 Tab：本项目账套无「共同/成本」类科目，对应为空（如实呈现）
      if (subjTabCls === 'asset') { if (s.cls !== 'asset') return false; }
      else if (subjTabCls === 'liability') { if (s.cls !== 'liability') return false; }
      else if (subjTabCls === 'equity') { if (s.cls !== 'equity') return false; }
      else if (subjTabCls === 'pl') { if (s.cls !== 'revenue' && s.cls !== 'expense') return false; }
      else if (subjTabCls === 'cost') { if (s.cls !== 'cost') return false; }
      else if (subjTabCls === 'common') { return false; }
      // 默认隐藏停用科目；勾选「显示停用科目」才展示（含启用按钮），保证列表清爽且支持重新启用
      if (s.enabled === false && !(subjShowDisabled && subjShowDisabled.checked)) return false;
      // 展开所有级次：不勾选只显示一级科目（科目树折叠态）
      // 用 level 字段判断（兼容点分 1122.01 与段式 112201 两种层级编码）
      var lv = (s.level !== undefined) ? s.level : 0;
      if (!$('subjExpandAll').checked && lv > 0) return false;
      return true;
    });
  }
  function renderSubjects() {
    var tb = $('subjBody'); tb.innerHTML = '';
    var list = subjFiltered();
    var cashCodes = S.cashAccounts().map(function (s) { return s.code; });
    list.forEach(function (s) {
      var aux = (s.aux || []).map(function (k) {
        var t = AUX_TYPES.filter(function (x) { return x.key === k; })[0];
        return t ? t.name : k;
      }).join('/');
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="row-chk" data-code="' + s.code + '"' + (subjChecked[s.code] ? ' checked' : '') + '></td>' +
        '<td class="col-op"><a class="link-edit" data-code="' + s.code + '">编辑</a> <a class="link-toggle" data-code="' + s.code + '">' + (s.enabled === false ? '启用' : '停用') + '</a></td>' +
        '<td class="mono">' + s.code + '</td>' +
        '<td>' + s.name + (s.enabled === false ? ' <span class="tag-disabled">停用</span>' : '') + '</td>' +
        '<td>' + ACCOUNT_CLASSES[s.cls].name + '</td>' +
        '<td>' + ACCOUNT_CLASSES[s.cls].side + '</td>' +
        '<td>' + (aux || '<span class="muted">—</span>') + '</td>' +
        '<td>' + (s.qty ? (s.unit || '数量') : '—') + '</td>' +
        '<td>' + (cashCodes.indexOf(s.code) >= 0 ? '√' : '—') + '</td>';
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8" class="empty-hint">暂无该类科目</td>';
      tb.appendChild(tr);
    }
    $('subjTotalCount').textContent = list.length;
    $('subjSelCount').textContent = Object.keys(subjChecked).length;
  }
  // 编码联想：suggestOnly 模式（只提示已存在科目/父科目，不覆盖新编码输入）
  var _subCodeComboBound = false;
  // 金蝶科目 Excel 类别 → 本项目类别（对齐金蝶精斗云导出的「科目」sheet 列结构）
  var KDJ_CAT_MAP = {
    '流动资产': 'asset', '非流动资产': 'asset',
    '流动负债': 'liability', '非流动负债': 'liability',
    '所有者权益': 'equity', '成本': 'cost',
    '营业收入': 'revenue', '其他收益': 'revenue', '营业成本及税金': 'expense',
    '其他损失': 'expense', '期间费用': 'expense', '所得税': 'expense',
    '以前年度损益调整': 'expense'
  };
  // 金蝶辅助核算类别 → 本项目 aux key
  var KDJ_AUX_MAP = { '客户': 'customer', '供应商': 'supplier', '存货': 'inventory' };

  // 从金蝶导出的科目 Excel 导入科目表
  function importSubjectsFromExcel(buf, fname) {
    if (!window.XLSX) { showToast('缺少 Excel 解析库', 'error'); return; }
    var wb;
    try { wb = window.XLSX.read(buf, { type: 'array' }); } catch (e) { showToast('文件无法解析', 'error'); return; }
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = window.XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) { showToast('文件为空或格式不对', 'error'); return; }

    var ok = 0, fail = 0, errors = [];
    rows.forEach(function (r) {
      var code = String(r['编码'] || '').trim();
      var name = String(r['名称'] || '').trim();
      if (!code || !name) return; // 空行跳过
      var kdjCat = String(r['类别'] || '').trim();
      var cls = KDJ_CAT_MAP[kdjCat];
      if (!cls) {
        // 按余额方向兜底：借→资产，贷→负债（方向最可靠）
        cls = (String(r['余额方向'] || '') === '贷') ? 'liability' : 'asset';
      }
      // 辅助核算：金蝶类别名 → aux key
      var auxStr = String(r['辅助核算类别'] || '');
      var aux = [];
      if (auxStr) {
        auxStr.split(/[\/、]/).forEach(function (a) {
          var k = KDJ_AUX_MAP[a.trim()];
          if (k && aux.indexOf(k) < 0) aux.push(k);
        });
      }
      // 数量核算（外币核算字段已随外币功能下线，不再读取）
      var isQty = String(r['数量核算'] || '') === '√' || /^\d+$/.test(String(r['数量核算'] || '').trim());
      var extra = { aux: aux, qty: isQty };

      var res = S.addSubject(code, name, cls, extra);
      if (res.ok) ok++;
      else { fail++; if (errors.length < 5) errors.push(code + ' ' + name + '：' + res.msg); }
    });
    S.persist();
    renderSubjects();
    showToast(ok ? ('导入 ' + ok + ' 个科目' + (fail ? ('，跳过 ' + fail + ' 个') : '')) : '导入失败', ok ? '' : 'error');
    if (errors.length) showToast('跳过：' + errors.join('；'), 'warn');
  }

  function bindSubCodeCombo() {
    var inp = $('subCode'); if (!inp || _subCodeComboBound) return;
    _subCodeComboBound = true;
    bindSubjectCombo(inp, {
      suggestOnly: true,
      onPick: function (selCode, subj) {
        if (!subj) return;
        var parent = S.subject(selCode.slice(0, -2));
        var msg = subj.name + '（' + subj.code + '）';
        if (selCode.length >= 6 && parent) msg += '，父科目：' + parent.name + '（' + parent.code + '）';
        showToast(msg + (S.subject(inp.value) ? '，该编码已存在' : ''));
      }
    });
  }
  function openSubjectModal(code) {
    var s = code ? S.subject(code) : null;
    $('subjectModal').querySelector('.modal-title').textContent = s ? '编辑科目' : '新增科目';
    $('subCode').value = s ? s.code : '';
    $('subCode').disabled = !!s;
    $('subName').value = s ? s.name : '';
    $('subCls').value = s ? s.cls : 'asset';
    bindSubCodeCombo();
    var aux = s ? (s.aux || []) : [];
    Array.prototype.forEach.call($('subAux').querySelectorAll('input'), function (cb) {
      cb.checked = aux.indexOf(cb.value) >= 0;
    });
    $('subQty').checked = !!(s && s.qty);
    $('subUnit').value = s ? (s.unit || '') : '';
    $('subjectModal').classList.add('show');
  }
  $('subjBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('link-toggle')) {
      var tCode = e.target.getAttribute('data-code');
      var tSub = S.subjects().filter(function (s) { return s.code === tCode; })[0];
      var disabling = !(tSub && tSub.enabled === false);
      var act = disabling ? '停用' : '启用';
      if (disabling) {
        if (!(await H.confirmAsync('确定停用科目「' + (tSub ? (tSub.code + ' ' + tSub.name) : tCode) + '」吗？\n停用后该科目及子科目不能再用于新增凭证，但历史凭证与余额保留。', { title: '停用科目' }))) return;
        var r = S.removeSubject(tCode);
        if (!r.ok) return showToast(r.msg, 'error');
      } else {
        var r2 = S.enableSubject(tCode);
        if (!r2.ok) return showToast(r2.msg, 'error');
      }
      delete subjChecked[tCode];
      renderSubjects(); showToast('已' + act);
    } else if (e.target.classList.contains('link-edit')) {
      openSubjectModal(e.target.getAttribute('data-code'));
    }
  });
  $('btnNewSubject').addEventListener('click', function () { openSubjectModal(null); });
  // 行勾选计数（「已选 X 条」）
  $('subjBody').addEventListener('change', function (e) {
    if (!e.target.classList.contains('row-chk')) return;
    var code = e.target.getAttribute('data-code');
    if (e.target.checked) subjChecked[code] = 1; else delete subjChecked[code];
    $('subjSelCount').textContent = Object.keys(subjChecked).length;
  });
  // 分类 Tab + 展开级次 + 隐藏禁用（6 Tab）
  Array.prototype.forEach.call($('subjTabs').querySelectorAll('.subj-tab'), function (btn) {
    btn.addEventListener('click', function () {
      subjTabCls = btn.getAttribute('data-cls');
      Array.prototype.forEach.call($('subjTabs').querySelectorAll('.subj-tab'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      renderSubjects();
    });
  });
  $('subjExpandAll').addEventListener('change', function () { renderSubjects(); });
  if ($('subjShowDisabled')) $('subjShowDisabled').addEventListener('change', function () { renderSubjects(); });
  // 工具条（新增/导入/导出/删除/打印）
  $('btnSubjImport').addEventListener('click', function () { $('subjImportFile').click(); });
  $('subjImportFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      importSubjectsFromExcel(reader.result, f.name);
      e.target.value = '';
    };
    reader.onerror = function () { showToast('读取文件失败', 'error'); e.target.value = ''; };
    reader.readAsArrayBuffer(f);
  });
  $('btnSubjExport').addEventListener('click', function () {
    // 导出科目表为 Excel：编码/名称/类别/方向/辅助核算/数量
    var rows = S.subjects().map(function (s) {
      return {
        '科目编码': s.code,
        '科目名称': s.name,
        '科目类别': (ACCOUNT_CLASSES[s.cls] || {}).name || s.cls,
        '方向': (ACCOUNT_CLASSES[s.cls] || {}).side || '',
        '辅助核算': (s.aux || []).map(function (k) {
          var t = AUX_TYPES.filter(function (x) { return x.key === k; })[0];
          return t ? t.name : k;
        }).join('/'),
        '数量核算': s.qty ? '√' : ''
      };
    });
    exportTable(rows, '会计科目');
  });
  $('btnSubjDelete').addEventListener('click', async function () {
    var codes = Object.keys(subjChecked);
    if (!codes.length) return showToast('请先勾选要停用的科目', 'error');
    if (!(await H.confirmAsync('确认停用选中的 ' + codes.length + ' 个科目？\n停用后这些科目及其子科目不能再用于新增凭证，历史凭证与余额保留。', { title: '停用科目' }))) return;
    var okCount = 0;
    codes.forEach(function (c) {
      var r = S.removeSubject(c);
      if (r.ok) { delete subjChecked[c]; okCount++; }
    });
    renderSubjects();
    showToast('已停用 ' + okCount + ' 个科目');
  });
  $('btnCloseSubject').addEventListener('click', function () { $('subjectModal').classList.remove('show'); });
  $('btnSaveSubject').addEventListener('click', function () {
    var code = $('subCode').value;
    var extra = {
      aux: Array.prototype.map.call($('subAux').querySelectorAll('input:checked'), function (cb) { return cb.value; }),
      qty: $('subQty').checked, unit: $('subUnit').value
    };
    var editing = $('subCode').disabled;
    var newCode = $('subCode').value.trim();
    // 子科目类别必须与父一致（addSubject 在 cls 为空时自动继承父）。
    // 传空字符串让父继承逻辑生效，避免财务手动选错类别。
    var isChild = !editing && newCode.length >= 6;
    var cls = isChild ? '' : $('subCls').value;
    var r = editing ? S.updateSubject(code, $('subName').value, $('subCls').value, extra)
                    : S.addSubject(newCode, $('subName').value, cls, extra);
    if (!r.ok) return showToast(r.msg, 'error');
    $('subjectModal').classList.remove('show');
    renderSubjects(); showToast(editing ? '科目已保存' : '科目已新增');
  });
export { refreshSubjects };

