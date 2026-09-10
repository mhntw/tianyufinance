// 科目范围选择器（对齐金蝶精斗云·云会计的科目筛选交互）
//
// 为什么不用下拉：下拉天然必须有一个选中项，于是"默认选第一个科目"就成了默认值，
// 而财务打开查凭证/明细账想看的其实是全部科目。金蝶的做法是「输入框 + 科目树按钮」，
// 输入框为空即代表全部，同时支持编码范围语法，比下拉表达力更强：
//     1001            单个科目
//     1001,1009       多个科目（逗号分隔）
//     2121-2131       科目范围（含两端及其所有下级科目）
// 见 金蝶源码/jdy_pages_distilled/format/凭证_查凭证.html:2063
//
// 依赖：全局 $、S（Store 单例）、__KINGDEE_HELPERS__

import { subjectFullName } from '../common/subject-name.js';

const $ = globalThis.$ || function (id) { return document.getElementById(id); };
const H = globalThis.__KINGDEE_HELPERS__ || {};
const esc = H.esc || function (s) { return String(s == null ? '' : s); };

// 中文逗号/顿号/空格都当作分隔符：财务手工输入时不会去切输入法
const SEP_RE = /[,，、\s]+/;

/**
 * 解析科目范围表达式。
 * @returns {{ok:boolean, codes:Set<string>|null, msg:string}}
 *   codes 为 null 表示「全部科目」（表达式为空）；ok=false 时 msg 为错误原因。
 */
function parseSubjectRange(expr, allSubjects) {
  const raw = String(expr == null ? '' : expr).trim();
  if (!raw) return { ok: true, codes: null, msg: '' };

  const all = allSubjects || [];
  // 按编码升序，范围匹配依赖顺序
  const codes = all.map(s => String(s.code)).sort();
  const hits = new Set();

  for (const token of raw.split(SEP_RE)) {
    if (!token) continue;

    // 范围：2121-2131（同时容忍中文破折号、全角连字符）
    const dash = token.match(/^(.+?)[-－—~～](.+)$/);
    if (dash) {
      const lo = dash[1].trim(), hi = dash[2].trim();
      if (!lo || !hi) return { ok: false, codes: null, msg: '范围写法不完整："' + token + '"' };
      if (lo > hi) return { ok: false, codes: null, msg: '范围起始不能大于结束："' + token + '"' };
      let n = 0;
      for (const c of codes) {
        // 字符串比较即可覆盖下级科目：'2121.01' 以 '2121' 开头，必然落在 ['2121','2131'] 内
        if (c >= lo && c <= hi) { hits.add(c); n++; }
      }
      if (!n) return { ok: false, codes: null, msg: '范围内没有科目："' + token + '"' };
      continue;
    }

    // 单码：允许只输入前缀（如 '1122' 命中 '1122' 及 '1122.01'）
    let n = 0;
    for (const c of codes) {
      if (c === token || c.indexOf(token) === 0) { hits.add(c); n++; }
    }
    if (!n) return { ok: false, codes: null, msg: '科目编码不存在："' + token + '"' };
  }

  if (!hits.size) return { ok: true, codes: null, msg: '' };
  return { ok: true, codes: hits, msg: '' };
}

/** 判断科目编码是否命中（codes 为 null 即全部命中） */
function matchSubjectCode(codes, code) {
  if (!codes) return true;
  return codes.has(String(code));
}

// ---------------------------------------------------------------
// 科目树弹层
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

function buildSubjectPop(anchor, subs, onPick, onlyParent) {
  closeSubjectPop();
  const pop = document.createElement('div');
  pop.className = 'subj-range-pop';
  Object.assign(pop.style, {
    position: 'absolute', zIndex: '9999', background: '#fff',
    border: '1px solid var(--kd-border)', borderRadius: '4px',
    boxShadow: '0 6px 20px rgba(0,0,0,.14)', width: '300px',
    fontSize: '13px', color: 'var(--kd-text)', overflow: 'hidden'
  });

  const search = document.createElement('input');
  search.placeholder = '搜索编码或名称';
  Object.assign(search.style, {
    width: '100%', boxSizing: 'border-box', border: 'none',
    borderBottom: '1px solid var(--kd-border)', outline: 'none',
    padding: '8px 10px', fontSize: '13px'
  });

  const list = document.createElement('div');
  Object.assign(list.style, { maxHeight: '280px', overflowY: 'auto' });

  function render(kw) {
    const k = String(kw || '').trim().toLowerCase();
    const rows = subs.filter(function (s) {
      if (!k) return true;
      // 与 SubjectCombo 同口径：编码 / 末级名 / 全路径名 均可命中
      return String(s.code).indexOf(k) >= 0
        || String(s.name).toLowerCase().indexOf(k) >= 0
        || String(subjectFullName(s.code, s.name)).toLowerCase().indexOf(k) >= 0;
    });
    if (!rows.length) {
      list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--kd-text-3)">'
        + (onlyParent ? '暂无非明细科目（需先维护下级科目）' : '无匹配科目') + '</div>';
      return;
    }
    list.innerHTML = rows.map(function (s) {
      return '<div class="subj-range-row" data-code="' + esc(s.code) + '" style="padding:6px 10px;cursor:pointer;'
        + 'display:flex;gap:8px;line-height:1.6">'
        + '<span style="color:var(--kd-text-3);font-variant-numeric:tabular-nums">' + esc(s.code) + '</span>'
        + '<span>' + esc(subjectFullName(s.code, s.name)) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.subj-range-row'), function (row) {
      row.addEventListener('mouseenter', function () { row.style.background = '#F2F7FD'; });
      row.addEventListener('mouseleave', function () { row.style.background = ''; });
      row.addEventListener('click', function () {
        onPick(row.getAttribute('data-code'));
        closeSubjectPop();
      });
    });
  }

  render('');
  search.addEventListener('input', function () { render(search.value); });
  pop.appendChild(search);
  pop.appendChild(list);

  // 定位：贴近输入框下沿，超出视口则上翻
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4;
  const flip = (top + pop.offsetHeight > window.innerHeight) && (r.top - pop.offsetHeight - 4 > 0);
  pop.style.left = (window.scrollX + r.left) + 'px';
  pop.style.top = (window.scrollY + (flip ? r.top - pop.offsetHeight - 4 : top)) + 'px';
  pop.style.minWidth = Math.max(r.width, 220) + 'px';
  openPop = pop;
  search.focus();
  return pop;
}

/**
 * 把「科目」下拉改造为「输入框 + 科目树按钮」。
 * @param {object} o
 *   inputId       输入框 id
 *   btnId         科目树按钮 id（可选，缺省则自动在输入框后插入）
 *   onlyParent    只列非明细科目（有下级科目的），多栏账用
 *   onChange      选中/输入变化回调
 * @returns {{value:()=>string, set:(v:string)=>void, resolve:()=>{ok,codes,msg}, error:()=>string}}
 */
export function bindSubjectRange(o) {
  const inp = $(o.inputId);
  if (!inp) return null;

  // 输入框保留用户写的表达式本身（金蝶行为），查询时再解析成科目集合
  let lastErr = '';

  function subjects() {
    let all = (typeof S !== 'undefined' && S.subjects) ? S.subjects() : [];
    // 调用方自定义过滤（如数量账只列数量核算科目）
    if (typeof o.filter === 'function') all = all.filter(o.filter);
    if (!o.onlyParent) return all;
    // 只留「有下级科目」的项：多栏账必须按下级科目分栏
    return all.filter(function (s) {
      return all.some(function (c) {
        return c.code !== s.code && String(c.code).indexOf(String(s.code)) === 0
          && String(c.code).length > String(s.code).length;
      });
    });
  }

  const btn = o.btnId ? $(o.btnId) : null;
  const trigger = btn || inp;
  trigger.classList.add('subj-range-btn');
  if (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (openPop) { closeSubjectPop(); return; }
      const subs = subjects();
      if (!subs.length) {
        lastErr = o.onlyParent
          ? '当前科目表没有非明细科目（多栏账需要有下级科目的科目）'
          : '科目表为空';
        if (typeof o.onChange === 'function') o.onChange(inp.value, lastErr);
        return;
      }
      buildSubjectPop(btn, subs, function (code) {
        inp.value = code;
        lastErr = '';
        if (typeof o.onChange === 'function') o.onChange(inp.value, '');
      }, o.onlyParent);
    });
  }

  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && typeof o.onChange === 'function') o.onChange(inp.value, '');
  });
  inp.addEventListener('change', function () {
    if (typeof o.onChange === 'function') o.onChange(inp.value, '');
  });

  return {
    value: function () { return inp.value; },
    set: function (v) { inp.value = v || ''; lastErr = ''; },
    resolve: function () {
      const r = parseSubjectRange(inp.value, subjects());
      lastErr = r.ok ? '' : r.msg;
      return r;
    },
    error: function () { return lastErr; }
  };
}

export { parseSubjectRange, matchSubjectCode, closeSubjectPop };
