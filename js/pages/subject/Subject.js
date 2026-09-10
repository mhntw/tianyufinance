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

  // 金蝶式科目表：默认只显示一级科目，点行首箭头才逐级展开其子科目。
  // subjCollapsed: { code: true } = 该科目已收起（隐藏其直接子级；祖先收起时后级递归隐藏）
  var subjCollapsed = {};
  function refreshSubjects() { subjCollapseToLevel1(); renderSubjects(); }
  // 直接父科目映射：在给定集合内取该编码的「最长真前缀」作为父。
  // 真实账套编码层级不规整（4 位、4+2=6 位、4+3=7 位、更深混合），
  // 不能用「固定去尾 2 位」推导（会把 1002001 的父错算成 10020）。
  function subjParentMap(subjects) {
    var byCode = {};
    (subjects || []).forEach(function (s) { byCode[String(s.code)] = 1; });
    var pm = {};
    (subjects || []).forEach(function (s) {
      var c = String(s.code), best = '';
      for (var L = c.length - 1; L > 0; L--) {
        var pre = c.slice(0, L);
        if (byCode[pre]) { best = pre; break; } // 最长的存在于集合中的真前缀 = 直接父
      }
      pm[c] = best;
    });
    return pm;
  }
  // 沿父链上溯：任一祖先已收起则该行隐藏
  function subjAncestorCollapsed(pm, code) {
    var cur = code, depth = 0;
    while (cur && depth++ < 40) {
      var p = pm[cur];
      if (!p) return false;
      if (subjCollapsed[p]) return true;
      cur = p;
    }
    return false;
  }
  // 层级深度 = 到根的父链长度（真实缩进依据）
  function subjDepth(pm, code) {
    var d = 0, c = code, guard = 0;
    while (c && guard++ < 40) {
      var p = pm[c];
      if (!p) break;
      d++; c = p;
    }
    return d;
  }
  // 初始态：所有「存在直接子科目」的父级一律收起 → 只露一级
  function subjCollapseToLevel1() {
    var subs = S.subjects() || [];
    var pm = subjParentMap(subs);
    var parents = {};
    subs.forEach(function (s) {
      var p = pm[String(s.code)];
      if (p) parents[p] = 1;
    });
    subjCollapsed = parents;
  }
  /* 科目页：分类 Tab（资产/负债/共同/权益/成本/损益）+ 树形展开 + 勾选计数 */
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
      // 「隐藏停用科目」默认勾选（金蝶语义）；取消勾选才展示停用行（含启用按钮）
      if (s.enabled === false && subjShowDisabled && subjShowDisabled.checked) return false;
      // 关键词不在筛选层剔除（避免把父链祖先滤掉）——搜索态由 renderSubjects 统一控制显隐
      return true;
    });
  }
  function renderSubjects() {
    var tb = $('subjBody'); tb.innerHTML = '';
    var list = subjFiltered();
    var cashCodes = S.cashAccounts().map(function (s) { return s.code; });
    // 父链映射用全量科目（祖先判断不受当前分类过滤影响）；
    // 箭头关系依据当前列表内的直接父子关系（父子一般同属一个分类）
    var pmAll = subjParentMap(S.subjects());
    var pmList = subjParentMap(list);
    var hasKids = {};
    list.forEach(function (s) { var p = pmList[s.code]; if (p) hasKids[p] = 1; });
    // 搜索态：命中的科目 + 其整条父链都显示（无关展开开关）；未搜时由「展开所有级次」开关与折叠态决定
    var searchVisible = null;
    var swBox = $('subjSearch');
    var kwTxt = (swBox ? (swBox.value || '') : '').trim();
    if (kwTxt) {
      var q = kwTxt.toLowerCase();
      searchVisible = {};
      list.forEach(function (s) {
        var hit = String(s.code).toLowerCase().indexOf(q) >= 0 || String(s.name || '').toLowerCase().indexOf(q) >= 0;
        if (!hit) return;
        var cur = s.code, g = 0;
        searchVisible[s.code] = 1;
        while (cur && g++ < 40) { var p = pmAll[cur]; if (!p) break; searchVisible[p] = 1; cur = p; }
      });
    }
    var expandAllOn = !!($('subjExpandAll') && $('subjExpandAll').checked);
    list.forEach(function (s) {
      var aux = (s.aux || []).map(function (k) {
        var t = AUX_TYPES.filter(function (x) { return x.key === k; })[0];
        return t ? t.name : k;
      }).join('/');
      var lv = subjDepth(pmAll, s.code);
      var hidden = searchVisible
        ? !searchVisible[s.code]
        : (expandAllOn ? false : subjAncestorCollapsed(pmAll, s.code));
      // 行首箭头：有子科目可展开；末级用等宽占位保证名称对齐
      var arrow = hasKids[s.code]
        ? '<span class="subj-arrow' + (subjCollapsed[s.code] ? ' collapsed' : '') + '" data-code="' + s.code
          + '" title="' + (subjCollapsed[s.code] ? '展开下级科目' : '收起下级科目') + '">'
          + (subjCollapsed[s.code] ? '▶' : '▼') + '</span>'
        : '<span class="subj-arrow-leaf"></span>';
      var indent = '<span class="subj-indent" style="width:' + (lv * 14) + 'px"></span>';
      var tr = document.createElement('tr');
      if (hidden) tr.className = 'subj-hidden';
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="row-chk" data-code="' + s.code + '"' + (subjChecked[s.code] ? ' checked' : '') + '></td>' +
        '<td class="col-op"><a class="link-edit" data-code="' + s.code + '">编辑</a> <a class="link-toggle" data-code="' + s.code + '">' + (s.enabled === false ? '启用' : '停用') + '</a></td>' +
        '<td class="mono">' + s.code + '</td>' +
        '<td class="col-name">' + indent + arrow + '<span class="subj-name">' + s.name + (s.enabled === false ? ' <span class="tag-disabled">停用</span>' : '') + '</span></td>' +
        '<td>' + ACCOUNT_CLASSES[s.cls].name + '</td>' +
        '<td>' + ACCOUNT_CLASSES[s.cls].side + '</td>' +
        '<td>' + (aux || '<span class="muted">—</span>') + '</td>' +
        '<td>' + (s.qty ? (s.unit || '数量') : '—') + '</td>' +
        '<td>' + (cashCodes.indexOf(s.code) >= 0 ? '√' : '—') + '</td>';
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="9" class="empty-hint">暂无该类科目</td>';
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
        var parent = subj.parent ? S.subject(subj.parent) : null;
        var msg = subj.name + '（' + subj.code + '）';
        if (parent) msg += '，父科目：' + parent.name + '（' + parent.code + '）';
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
    if (e.target.classList.contains('subj-arrow')) {
      var aCode = e.target.getAttribute('data-code');
      var chkE = $('subjExpandAll');
      if (chkE && chkE.checked) {
        // 「展开所有级次」态下点箭头 = 退出全展，只收起该分支，其余保持展开（保留后续逐级操作）
        chkE.checked = false;
        subjCollapsed = {};
      }
      if (subjCollapsed[aCode]) delete subjCollapsed[aCode]; else subjCollapsed[aCode] = true;
      renderSubjects();
      return;
    }
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
  // 搜索框：输入即过滤（含父链路径展示）
  var bSubjSearch = $('subjSearch'); if (bSubjSearch) bSubjSearch.addEventListener('input', function () { renderSubjects(); });
  // 「展开所有级次」复选（金蝶语义）：勾选=显示全部级次；取消=回到一级收拢
  var bExpand = $('subjExpandAll'); if (bExpand) bExpand.addEventListener('change', function () {
    if (bExpand.checked) subjCollapsed = {};
    else subjCollapseToLevel1();
    renderSubjects();
  });
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

