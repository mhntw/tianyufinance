// 科目联想输入（统一"选单个科目"的交互，对齐「输入框+下拉」）
//
// 适用范围：
// - 录凭证分录科目
// - 固定资产/结账模板等「配置默认科目」的下拉
// 统一后：输入编码前缀或名称即时联想，点选/回车写回，加子科目后自动适配。
//
// 用法：bindSubjectCombo(inputEl, { onPick(code, subject), filter: fn })
// - filter 可限定科目范围（如固定资产只列 16 开头）
// - 返回 { setCode(code), close() }
//
// 依赖：全局 $、S（Store 单例）、__TY_HELPERS__（取 esc）、window、document

import { subjectFullName } from '../common/subject-name.js';

const H = globalThis.__TY_HELPERS__ || {};
const esc = H.esc || function (s) { return String(s == null ? '' : s); };

function bindSubjectCombo(input, opts) {
  if (!input) return null;
  opts = opts || {};
  var pop = null, activeRow = -1, lastQuery = '';

  // 实时取科目表（不缓存快照）：用户新建子科目后，正在编辑的输入框联想列表立即包含新科目，
  // 无需重新绑定。与 SubjectRangePicker 的实时读取保持一致。
  function subjects() {
    var all = (typeof S !== 'undefined' && S.subjects) ? S.subjects() : [];
    // 科目「停用」功能已下线：不再按启用状态过滤，所有科目均可联想选择
    if (typeof opts.filter === 'function') all = all.filter(opts.filter);
    return all;
  }

  function close() {
    if (pop) { pop.remove(); pop = null; activeRow = -1; }
    if (window.__subjComboActive && window.__subjComboActive.pop === pop) window.__subjComboActive = null;
  }

  function matchList(kw) {
    var subs = subjects();
    var k = String(kw || '').trim().toLowerCase();
    if (!k) return subs.slice(0, 12); // 空输入显示前几个，方便直接点选
    return subs.filter(function (s) {
      // 除「编码前缀 / 末级名」外，再按「全路径名」匹配：
      // 搜「银行存款」「其他应收款」等父级名也能命中其下级科目（下拉显示的正是全名）。
      // 确定性字符串包含匹配（非模糊搜索：无相似度/评分/正则），结果稳定可预期。
      var full = subjectFullName(s.code, s.name).toLowerCase();
      return String(s.code).toLowerCase().indexOf(k) === 0
        || String(s.name).toLowerCase().indexOf(k) >= 0
        || full.indexOf(k) >= 0;
    }).slice(0, 12);
  }

  function open() {
    close();
    var r = input.getBoundingClientRect();
    pop = document.createElement('div');
    pop.className = 'subj-combo-pop';
    pop.style.cssText = 'position:absolute;z-index:9999;background:#fff;border:1px solid var(--ty-border);'
      + 'border-radius:4px;box-shadow:0 6px 20px rgba(0,0,0,.14);max-height:240px;overflow-y:auto;'
      + 'min-width:' + Math.max(r.width, 200) + 'px;font-size:12.5px;color:var(--ty-text);';
    pop.style.left = (window.scrollX + r.left) + 'px';
    pop.style.top = (window.scrollY + r.bottom + 2) + 'px';
    document.body.appendChild(pop);
    render();
  }

  function render() {
    if (!pop) return;
    var rows = matchList(input.value);
    if (!rows.length) {
      pop.innerHTML = '<div style="padding:10px 12px;color:var(--ty-text-3)">无匹配科目</div>';
      activeRow = -1;
      return;
    }
    pop.innerHTML = rows.map(function (s, i) {
      return '<div class="subj-combo-row' + (i === activeRow ? ' active' : '') + '" data-code="' + esc(s.code) + '">'
        + '<span class="m" style="color:var(--ty-text-3);font-variant-numeric:tabular-nums;margin-right:8px">' + esc(s.code) + '</span>'
        + '<span>' + esc(subjectFullName(s.code, s.name)) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(pop.querySelectorAll('.subj-combo-row'), function (row, i) {
      row.addEventListener('mouseenter', function () { activeRow = i; render(); });
      row.addEventListener('mousedown', function (e) {
        e.preventDefault(); // 避免 input 失焦先于 click
        pick(row.getAttribute('data-code'));
      });
    });
  }

  function pick(code) {
    var s = null;
    // 用全量科目查找，保证编辑已有凭证时历史科目值也能匹配显示
    var all = (typeof S !== 'undefined' && S.subjects) ? S.subjects() : [];
    all.some(function (x) { if (String(x.code) === String(code)) { s = x; return true; } return false; });
    // suggestOnly 模式（新增科目编码联想）：只回传所选科目信息，不写回 input——
    // 因为输入的是「新编码」，点选已有科目仅作提示（如确认父科目、避免重复），不覆盖输入。
    if (!opts.suggestOnly) input.value = String(code);
    close();
    if (typeof opts.onPick === 'function') opts.onPick(code, s);
  }

  // 点击/聚焦即展开：「点科目格弹出选择」，无需先打字（空输入显示前12个科目）。
  // 用 ensureOpen 而非每次重新 open，避免选中后焦点仍在输入框时重复建浮层。
  function ensureOpen() { if (!pop) open(); }
  input.addEventListener('focus', ensureOpen);
  input.addEventListener('click', ensureOpen);
  input.addEventListener('input', function () { lastQuery = input.value; open(); render(); });
  input.addEventListener('keydown', function (e) {
    if (!pop) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeRow = Math.min(activeRow + 1, matchList(input.value).length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeRow = Math.max(activeRow - 1, 0); render(); }
    else if (e.key === 'Enter') {
      if (activeRow >= 0) { e.preventDefault(); var row = pop.querySelectorAll('.subj-combo-row')[activeRow]; if (row) pick(row.getAttribute('data-code')); }
    } else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', function () { setTimeout(close, 150); });

  // 全局：点 input 外部关闭浮层。用「单点全局委托 + 当前活跃浮层引用」避免每次
  // bindSubjectCombo 都往 document 挂监听（录凭证每次重渲染都会重绑，累积监听器会泄漏）。
  if (!window.__subjComboGlobalBound) {
    window.__subjComboGlobalBound = true;
    document.addEventListener('mousedown', function (e) {
      var cur = window.__subjComboActive;
      if (cur && cur.pop && !cur.pop.contains(e.target) && e.target !== cur.input) cur.close();
    });
  }
  window.__subjComboActive = { pop: pop, input: input, close: close };

  return { setCode: function (code) { input.value = String(code == null ? '' : code); }, close: close };
}

export { bindSubjectCombo };
