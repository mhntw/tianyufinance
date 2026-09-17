// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__TY_HELPERS__（app.js 注册）、globalThis.__TY_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。
//
// 【搜索口径 · 全站统一】确定性「字符串包含匹配 + 父级连带」，不是模糊搜索：
// - 命中条件：科目编码 或 名称 包含关键词；若上级科目命中，则其下级一并视为命中
// （等效"全路径名匹配"，所以搜「银行存款」能带出「青岛银行」等子科目）；
// - 无相似度/拼音/编辑距离/评分排序，无正则，无递归（父链上溯带层数上限），
// 因此同一关键词必得同一结果，不存在"忽多忽少"或回溯卡顿风险。

const H = globalThis.__TY_HELPERS__ || {};
const EX = globalThis.__TY_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
import { bindSubjectPicker } from '../../components/SubjectPicker.js?v=dev';
import { exportTable } from '../settings/_shared.js';
// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);

  // 科目表：默认只显示一级科目，点行首箭头才逐级展开其子科目。
  // subjExpanded: Set() = 已展开的科目编码（祖先级联：祖先不在 Set 中 → 子级隐藏）
  // 空 Set = 默认全收起（只露一级父科目）
  var subjExpanded = new Set();
  function refreshSubjects() { subjExpanded = new Set(); renderSubjects(); }
  // 层级深度 = 到根的父链长度（真实缩进依据）
  function subjDepth(pm, code) {
    var d = 0, c = String(code), guard = 0;
    while (c && guard++ < 40) {
      var p = pm[c];
      if (!p) break;
      d++; c = p;
    }
    return d;
  }
  /* 科目页：分类 Tab（资产/负债/共同/权益/成本/损益）+ 树形展开 + 勾选计数 */
  var subjTabCls = 'asset';   // 当前分类 Tab（默认选中「资产」）
  // 科目编辑弹窗：展示分类（grpCls||cls）与原始取数口径 cls，用于「没改分类就不改口径」
  var subjModalBaseCls = '';
  var subjModalShowCls = 'asset';

  function subjFiltered() {
    // 搜索态 = 全局搜索：忽略当前分类 Tab，跨全部类别匹配。
    // 否则搜索只在当前分类内生效（在「资产」页搜「管理费用」搜不到），使用不便。
    // 清空搜索框即回到当前分类浏览；切分类 Tab 会自动退出搜索（见 Tab 点击处理）。
    var searching = !!String(($('subjSearch') || {}).value || '').trim();
    return S.subjects().filter(function (s) {
      if (!searching) {
        // 分类口径：优先用导入的 grpCls（与界面一致），无则回退 cls。
        // cls 是取数口径（结转损益/报表按它取数），grpCls 是展示分类；两者分离使分类显示可独立调整、不动取数逻辑。
        var cc = s.grpCls || s.cls;
        if (subjTabCls === 'asset') { if (cc !== 'asset') return false; }
        else if (subjTabCls === 'liability') { if (cc !== 'liability') return false; }
        else if (subjTabCls === 'equity') { if (cc !== 'equity') return false; }
        else if (subjTabCls === 'pl') { if (cc !== 'revenue' && cc !== 'expense') return false; }
        else if (subjTabCls === 'cost') { if (cc !== 'cost') return false; }
        else if (subjTabCls === 'common') { return false; }
      }
      // 科目「停用」功能已整体下线（不需要的科目不用即可），故不再做启用状态过滤
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
    var pmAll = S.subjectParentMap(S.subjects());
    var pmList = S.subjectParentMap(list);
    var hasKids = {};
    list.forEach(function (s) { var p = pmList[s.code]; if (p) hasKids[p] = 1; });
    // 搜索态：命中的科目 + 其整条父链都显示（无关展开开关）；未搜时由「展开所有级次」开关与折叠态决定
    var searchVisible = null;
    var swBox = $('subjSearch');
    var kwTxt = (swBox ? (swBox.value || '') : '').trim();
    if (kwTxt) {
      var q = kwTxt.toLowerCase();
      // ① 基础命中：编码 / 末级名称包含关键字
      var hitBase = {};
      list.forEach(function (s) {
        if (String(s.code).toLowerCase().indexOf(q) >= 0 || String(s.name || '').toLowerCase().indexOf(q) >= 0) hitBase[s.code] = 1;
      });
      // ② 全路径名等效匹配：命中科目的所有下级一并视为命中
      // → 搜「银行存款」可带出「青岛银行」「建行（陈总）」等子科目（子科目全名含父名）
      list.forEach(function (s) {
        var cur = s.code, g = 0;
        while (cur && g++ < 40) {
          var p = pmAll[cur];
          if (!p) break;
          if (hitBase[p]) { hitBase[s.code] = 1; break; }
          cur = p;
        }
      });
      // ③ 命中集 + 各自父链 = 可见集（父链保证层级可读）
      searchVisible = {};
      list.forEach(function (s) {
        if (!hitBase[s.code]) return;
        var cur2 = s.code, g2 = 0;
        searchVisible[s.code] = 1;
        while (cur2 && g2++ < 40) { var p2 = pmAll[cur2]; if (!p2) break; searchVisible[p2] = 1; cur2 = p2; }
      });
    }
    // 搜索态视觉提示：分类 Tab 淡化（当前分类不参与过滤）+ 底部标注"全局搜索"
    var tabsBox = $('subjTabs');
    if (tabsBox) tabsBox.classList.toggle('subj-tabs-searching', !!kwTxt);
    var scopeTip = $('subjScopeTip');
    if (scopeTip) scopeTip.textContent = kwTxt ? '全局搜索（跨全部类别）：' : '';
    var expandAllOn = !!($('subjExpandAll') && $('subjExpandAll').checked);
    list.forEach(function (s) {
      var lv = subjDepth(pmAll, s.code);
      var hidden = searchVisible
        ? !searchVisible[s.code]
        : (expandAllOn ? false : !S.subjectVisible(s.code, subjExpanded, pmAll, false));
      // 行首箭头：用 store 公共函数统一生成 ▶▼ 文字
      var hasKidsHere = hasKids[s.code];
      var arrow = S.subjectArrowHTML(s.code, hasKidsHere, subjExpanded.has(s.code));
      var indent = S.subjectIndentHTML(lv);
      var tr = document.createElement('tr');
      if (hidden) tr.className = 'subj-hidden';
      tr.innerHTML =
        // 三角放在【科目编码列】的编码前（与科目余额表一致）；名称列只留缩进 + 名称
        '<td class="mono">' + arrow + s.code + '</td>' +
        '<td class="col-name">' + indent + '<span class="subj-name">' + s.name + '</span></td>' +
        '<td>' + (ACCOUNT_CLASSES[s.grpCls || s.cls] || ACCOUNT_CLASSES[s.cls]).name + '</td>' +
        '<td>' + (ACCOUNT_CLASSES[s.grpCls || s.cls] || ACCOUNT_CLASSES[s.cls]).side + '</td>' +
        '<td>' + (cashCodes.indexOf(s.code) >= 0 ? '✓' : '—') + '</td>' +
        '<td class="col-op"><a class="link-edit" data-code="' + s.code + '">编辑</a></td>';
      tb.appendChild(tr);
    });
    if (!list.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="empty-hint">暂无该类科目</td>';
      tb.appendChild(tr);
    }
    $('subjTotalCount').textContent = list.length;
  }
  // 编码联想：suggestOnly 模式（只提示已存在科目/父科目，不覆盖新编码输入）
  var _subCodeComboBound = false;
  // 科目 Excel 类别 → 本项目类别（对齐产品导出的「科目」sheet 列结构）
  var TY_CAT_MAP = {
    '流动资产': 'asset', '非流动资产': 'asset',
    '流动负债': 'liability', '非流动负债': 'liability',
    '所有者权益': 'equity', '成本': 'cost',
    '营业收入': 'revenue', '其他收益': 'revenue', '营业成本及税金': 'expense',
    '其他损失': 'expense', '期间费用': 'expense', '所得税': 'expense',
    '以前年度损益调整': 'expense'
  };

  // 从导出的科目 Excel 导入科目表
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
      var cls = TY_CAT_MAP[kdjCat];
      if (!cls) {
        // 按余额方向兜底：借→资产，贷→负债（方向最可靠）
        cls = (String(r['余额方向'] || '') === '贷') ? 'liability' : 'asset';
      }
      var extra = {};

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
    // 统一到唯一科目选择组件 bindSubjectPicker；仅作编码提示、不写回输入框（等价旧 suggestOnly）
    bindSubjectPicker(inp, {
      limit: 12, // 空输入/多匹配时收敛前 12 条（与旧 SubjectCombo 一致）
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
    // 类别下拉展示「展示分类」（grpCls 优先）；同时记住原始取数口径 cls 与展示值，
    // 保存时若用户没动下拉，就提交原 cls —— 否则会把展示分类写进取数口径，
    // 已有凭证的科目还会被「禁改类别」拦下（改名都保存不了）。
    $('subCls').value = s ? (s.grpCls || s.cls) : 'asset';
    subjModalBaseCls = s ? s.cls : '';
    subjModalShowCls = s ? (s.grpCls || s.cls) : 'asset';
    bindSubCodeCombo();
    // 改名提示：仅编辑已有科目时显示
    var nameTip = $('subjNameTip'); if (nameTip) nameTip.style.display = s ? '' : 'none';
    $('subjectModal').classList.add('show');
  }
  $('subjBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('subj-arrow')) {
      var aCode = e.target.getAttribute('data-code');
      var chkE = $('subjExpandAll');
      if (chkE && chkE.checked) {
        // 「展开所有级次」态下点箭头 = 退出全展，只收起该分支，其余保持展开（保留后续逐级操作）
        chkE.checked = false;
        subjExpanded = new Set();
      }
      if (subjExpanded.has(aCode)) subjExpanded.delete(aCode); else subjExpanded.add(aCode);
      renderSubjects();
      return;
    }
    if (e.target.classList.contains('link-edit')) {
      openSubjectModal(e.target.getAttribute('data-code'));
    }
  });
  $('btnNewSubject').addEventListener('click', function () { openSubjectModal(null); });
  // 分类 Tab + 展开级次 + 隐藏禁用（6 Tab）
  Array.prototype.forEach.call($('subjTabs').querySelectorAll('.subj-tab'), function (btn) {
    btn.addEventListener('click', function () {
      subjTabCls = btn.getAttribute('data-cls');
      // 切分类 = 退出全局搜索（否则搜索结果不随分类变化，容易困惑）
      var sb = $('subjSearch'); if (sb) sb.value = '';
      Array.prototype.forEach.call($('subjTabs').querySelectorAll('.subj-tab'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      renderSubjects();
    });
  });
  // 搜索框：输入即过滤（含父链路径展示）
  var bSubjSearch = $('subjSearch'); if (bSubjSearch) bSubjSearch.addEventListener('input', function () { renderSubjects(); });
  // 「展开所有级次」复选：勾选=全展开（把所有有子节点的 code 塞进 Set）；取消=回到一级收拢
  var bExpand = $('subjExpandAll'); if (bExpand) bExpand.addEventListener('change', function () {
    if (bExpand.checked) {
      // 全展开：把所有有子节点的科目编码加进 expanded Set
      var allSubs = S.subjects() || [];
      var pm = S.subjectParentMap(allSubs);
      var kids = {};
      allSubs.forEach(function (s) { var p = pm[String(s.code)]; if (p) kids[p] = 1; });
      subjExpanded = new Set(Object.keys(kids));
    } else {
      subjExpanded = new Set();
    }
    renderSubjects();
  });
  // 工具条（新增/导入/导出/打印）
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
    // 导出科目表为 Excel：编码/名称/类别/方向
    var rows = S.subjects().map(function (s) {
      return {
        '科目编码': s.code,
        '科目名称': s.name,
        '科目类别': (ACCOUNT_CLASSES[s.grpCls || s.cls] || {}).name || (s.grpCls || s.cls),
        '方向': (ACCOUNT_CLASSES[s.grpCls || s.cls] || {}).side || ''
      };
    });
    exportTable(rows, '会计科目');
  });
  $('btnCloseSubject').addEventListener('click', function () { $('subjectModal').classList.remove('show'); });
  $('btnSaveSubject').addEventListener('click', function () {
    var code = $('subCode').value;
    var extra = {};
    var editing = $('subCode').disabled;
    var newCode = $('subCode').value.trim();
    // 子科目类别必须与父一致（addSubject 在 cls 为空时自动继承父）。
    // 传空字符串让父继承逻辑生效，避免财务手动选错类别。
    var isChild = !editing && newCode.length >= 6;
    var pickedCls = $('subCls').value;
    // 编辑态：下拉未改动 → 沿用原取数口径 cls（展示分类与取数口径分离，不因展示而改口径）
    if (editing && pickedCls === subjModalShowCls) pickedCls = subjModalBaseCls;
    var cls = isChild ? '' : pickedCls;
    var r = editing ? S.updateSubject(code, $('subName').value, pickedCls, extra)
                    : S.addSubject(newCode, $('subName').value, cls, extra);
    if (!r.ok) return showToast(r.msg, 'error');
    $('subjectModal').classList.remove('show');
    renderSubjects(); showToast(editing ? '科目已保存' : '科目已新增');
  });
export { refreshSubjects };

