// 统一科目选择组件（全站唯一的「选科目」弹层实现）
//
// 交互：输入框为空 = 全部科目；点/聚焦输入框即弹出科目列表，输入编码或名称即时联想，点选/回车写回。
// 空输入不默认选中任何科目（避免原生下拉「默认选第一个科目」的问题），更贴合财务「想看全部」的习惯。
// 全站统一复用 bindSubjectPicker：录凭证、总账、多栏账、数量账、查凭证、结账模板、固定资产、新增科目编码。
//
// 依赖：全局 S（Store 单例）、__TY_HELPERS__

import { subjectFullName } from '../common/subject-name.js';

const H = globalThis.__TY_HELPERS__ || {};
const esc = H.esc || function (s) { return String(s == null ? '' : s); };

/** 判断科目编码是否命中（codes 为 null 即全部命中） */
function matchSubjectCode(codes, code) {
  if (!codes) return true;
  return codes.has(String(code));
}

// ---------------------------------------------------------------
// 科目选择弹层
// ---------------------------------------------------------------
let openPop = null;

function closeSubjectPop() {
  if (openPop) {
    openPop.remove();
    openPop = null;
  }
}

document.addEventListener('mousedown', function (e) {
  if (!openPop) return;
  // 点浮层内部或触发按钮都不关闭（按钮自己处理 toggle）
  if (openPop.contains(e.target) || e.target.closest('.subj-range-btn')) return;
  closeSubjectPop();
});

function buildSubjectPop(anchor, subs, onPick, opts) {
  opts = opts || {};
  const onlyParent = !!opts.onlyParent;
  const limit = opts.limit | 0;         // >0 时最多渲染这么多行（长列表收敛，避免一屏几百项）
  const bareInput = !!opts.bareInput;   // 无内置搜索框，搜索由外部输入框驱动
  const filterInput = opts.filterInput || null; // 外部输入框（bareInput=true 时用）
  closeSubjectPop();
  const pop = document.createElement('div');
  pop.className = 'subj-range-pop';
  pop._anchor = anchor; // 记录触发元素：bindSubjectPicker 以此判断「本输入框的弹层是否正开着」
  Object.assign(pop.style, {
    position: 'fixed', zIndex: '9999', background: '#fff',
    border: '1px solid var(--ty-border)', borderRadius: '4px',
    boxShadow: '0 6px 20px rgba(0,0,0,.14)', width: '300px',
    fontSize: '13px', color: 'var(--ty-text)', overflow: 'hidden'
  });

  const search = bareInput ? null : (function () {
    const s = document.createElement('input');
    s.placeholder = '搜索编码或名称';
    Object.assign(s.style, {
      width: '100%', boxSizing: 'border-box', border: 'none',
      borderBottom: '1px solid var(--ty-border)', outline: 'none',
      padding: '8px 10px', fontSize: '13px'
    });
    return s;
  })();

  const list = document.createElement('div');
  Object.assign(list.style, { maxHeight: '280px', overflowY: 'auto' });

  let rows = [];     // 当前可见科目（与渲染行一一对应）
  let active = -1;   // 键盘高亮行索引（-1 表示无）

  function applyHighlight() {
    const items = list.querySelectorAll('.subj-range-row');
    Array.prototype.forEach.call(items, function (el, i) {
      el.style.background = (i === active) ? '#E6F0FB' : '';
    });
    const cur = items[active];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function setActive(i) {
    const n = rows.length;
    if (!n) { active = -1; return; }
    if (i < 0) i = n - 1;              // 上越界循环到末行
    if (i >= n) i = 0;                // 下越界循环到首行
    active = i;
    applyHighlight();
  }

  function render(kw) {
    const k = String(kw || '').trim().toLowerCase();
    rows = subs.filter(function (s) {
      if (!k) return true;
      return String(s.code).indexOf(k) >= 0
        || String(s.name).toLowerCase().indexOf(k) >= 0
        || String(subjectFullName(s.code, s.name)).toLowerCase().indexOf(k) >= 0;
    });
    if (limit > 0) rows = rows.slice(0, limit);
    if (!rows.length) {
      list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--ty-text-3)">'
        + (onlyParent ? '暂无非明细科目（需先维护下级科目）' : '无匹配科目') + '</div>';
      active = -1;
      return;
    }
    list.innerHTML = rows.map(function (s) {
      return '<div class="subj-range-row" data-code="' + esc(s.code) + '" style="padding:6px 10px;cursor:pointer;'
        + 'display:flex;gap:8px;line-height:1.6">'
        + '<span style="color:var(--ty-text-3);font-variant-numeric:tabular-nums">' + esc(s.code) + '</span>'
        + '<span>' + esc(subjectFullName(s.code, s.name)) + '</span></div>';
    }).join('');
    active = 0;
    Array.prototype.forEach.call(list.querySelectorAll('.subj-range-row'), function (row, idx) {
      row.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 保焦点
      row.addEventListener('mouseenter', function () { setActive(idx); });
      row.addEventListener('click', function () {
        onPick(row.getAttribute('data-code'));
        closeSubjectPop();
      });
    });
    applyHighlight();
  }

  render(bareInput && filterInput ? filterInput.value : '');
  if (search) search.addEventListener('input', function () { render(search.value); });
  if (filterInput) {
    // 外部输入框驱动过滤 + 键盘导航：↑↓ 移动高亮、Enter 选中、Esc 关闭
    filterInput._subjPopRender = render;
    filterInput.addEventListener('keydown', function (e) {
      if (openPop !== pop) return;       // 仅当本弹层打开时接管，关闭后让网格导航生效
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter') {
        if (active >= 0 && rows[active]) {
          e.preventDefault();
          e.stopPropagation();           // 阻止 vRows 的 Enter 跳转抢走焦点
          onPick(rows[active].code);
          closeSubjectPop();
        }
      } else if (e.key === 'Escape') { closeSubjectPop(); }
    });
  }
  if (search) pop.appendChild(search);
  pop.appendChild(list);

  // 定位：贴近触发元素下沿，超出视口则上翻
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4;
  const popH = 280 + (search ? 36 : 0) + 4;
  const flip = (top + popH > window.innerHeight) && (r.top - popH - 4 > 0);
  pop.style.left = r.left + 'px';
  pop.style.top = (flip ? r.top - popH - 4 : top) + 'px';
  pop.style.minWidth = Math.max(r.width, 220) + 'px';
  openPop = pop;
  if (search) search.focus();
  return pop;
}

/**
 * 给输入框绑定「弹层选科目」交互（录凭证专用，扁平列表 + 外部输入驱动搜索）。
 * @param {HTMLInputElement} input 科目编码输入框
 * @param {object} opts { getSubjects, onPick }
 *   getSubjects: () => Subject[]   取科目列表
 *   onPick: (code) => void         选中回调（写回输入框/触发更新）
 */
export function bindSubjectPicker(input, opts) {
  if (!input) return;
  opts = opts || {};
  const getSubjects = opts.getSubjects || function () {
    return (typeof S !== 'undefined' && S.subjects) ? S.subjects() : [];
  };
  const onPick = opts.onPick || function () {};
  const onlyParent = !!opts.onlyParent;
  const limit = opts.limit | 0;
  const filterFn = (typeof opts.filter === 'function') ? opts.filter : null;
  const btn = opts.btnId ? document.getElementById(opts.btnId) : null;
  // 输入框与触发按钮都算「触发器」：外部点击判定遇到它们不关闭弹层。
  // 关键修复——此前只有 btn 加了该类，录凭证的科目输入框没加，导致「点一下输入框本身」
  // 就被全局 mousedown 判为「点到外面」而关闭弹层，随后被 isOpen 逻辑挡住再也打不开。
  input.classList.add('subj-range-btn');
  if (btn) btn.classList.add('subj-range-btn');

  // 科目预处理：自定义过滤 + 仅非明细科目（多栏账需要父科目分栏）
  function pickSubjects() {
    let all = getSubjects();
    if (filterFn) all = all.filter(filterFn);
    if (onlyParent) {
      all = all.filter(function (s) {
        return all.some(function (c) {
          return c.code !== s.code && String(c.code).indexOf(String(s.code)) === 0
            && String(c.code).length > String(s.code).length;
        });
      });
    }
    return all;
  }

  // 本输入框对应的弹层当前是否正开着：以弹层自身记录的 anchor 为准，不用布尔 flag。
  // 外部点击 / 切到别的输入框只要关掉了弹层（openPop 被清或换人），这里立刻视为已关闭，
  // 于是下一次点击/输入必然能重新打开——从根本上消除「点了没反应」的状态卡死。
  function isMine() { return !!openPop && openPop._anchor === input; }

  function doOpen() {
    if (isMine()) return; // 已经是本输入框的弹层，无需重建（避免重复建浮层）
    buildSubjectPop(input, pickSubjects(), function (code) {
      // 回传科目对象（供「新增科目编码」等仅提示场景展示父科目）；是否写回 input 由调用方的 onPick 决定
      var s = null, all = getSubjects() || [];
      for (var i = 0; i < all.length; i++) { if (String(all[i].code) === String(code)) { s = all[i]; break; } }
      onPick(code, s);
    }, { bareInput: true, filterInput: input, onlyParent: onlyParent, limit: limit });
  }
  function doClose() { closeSubjectPop(); }

  input.addEventListener('focus', doOpen);
  input.addEventListener('click', doOpen);
  // 触发按钮：再次点击切换关闭（输入框点击/聚焦只打开，不关闭，便于继续输入）
  if (btn) btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isMine()) doClose(); else doOpen();
  });
  input.addEventListener('input', function () {
    // 已打开 → 仅按当前内容过滤；已关闭（例如刚点过外部）→ 重新打开并过滤。
    // 修复「输入科目编码不显示科目」：此前只渲染已存在弹层，弹层被关后就写进了脱离 DOM 的列表。
    if (isMine() && input._subjPopRender) input._subjPopRender(input.value);
    else doOpen();
  });
  input.addEventListener('blur', function () {
    // 延迟关闭：点选行时 mousedown 已 preventDefault 保焦点，不会触发 blur；
    // 真正离开（Tab/点外部）再关。只关「本输入框的」弹层，避免误关刚为别的框打开的弹层。
    setTimeout(function () {
      if (openPop && openPop._anchor === input && document.activeElement !== input) closeSubjectPop();
    }, 150);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSubjectPop(); }
  });
}

export { matchSubjectCode };
