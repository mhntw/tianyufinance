// SubjectTree.js —— 明细账「科目快速切换」右栏树
//
// 交互：
// - 树形层级：code 最长真前缀为父；可折叠/展开（箭头），末级无箭头
// - 搜索：数字按「编码开头」，其它按「编码/名称包含」；命中项 + 其祖先保留显示、
//   其余过滤隐藏，并直接定位（滚动）到首个命中——不做高亮染色
// - 点击任意行 → onPick(code)；当前科目行高亮，设置时自动展开父链并滚动到可见
// - 面板可整体收起为右侧窄条，状态持久化
//
// 依赖：globalThis.$
// 保持简单：DOM 一次性全量渲染（420 个科目以内无压力），显隐用 class 控制。

const $ = globalThis.$ || function (id) { return document.getElementById(id); };

/** 行命中规则：纯数字=编码开头；其它=编码包含或名称包含 */
function isHit(s, kw) {
  if (/^\d+$/.test(kw)) return String(s.code).indexOf(kw) === 0;
  return String(s.code).indexOf(kw) >= 0 || String(s.name).indexOf(kw) >= 0;
}

/**
 * 挂载科目树到容器。
 * @param opts {container, getSubjects, onPick, storageKey?}
 * @returns {{setCurrent:(code:string|null)=>void, refresh:()=>void} | null}
 */
export function createSubjectTree(opts) {
  const box = typeof opts.container === 'string' ? $(opts.container) : opts.container;
  if (!box) return null;
  const storageKey = opts.storageKey || 'dlSubjectTree';
  const st = globalThis.localStorage || { getItem: function () { return null; }, setItem: function () {} };

  // 折叠状态不持久化：每次进入都重置为「只露父级科目」（行为）。
  // 不记忆展开状态，既避免旧存储残留，也和一致（它每次打开快速切换都是父级视图）。
  let collapsed = new Set();
  // 面板整体收起/展开才持久化
  let panelClosed = (function () { try { return st.getItem(storageKey + '.closed') === '1'; } catch (e) { return false; } })();
  const saveClosed = function () { try { st.setItem(storageKey + '.closed', panelClosed ? '1' : '0'); } catch (e) {} };

  const byCode = {};      // code -> node
  const roots = [];       // 顶层节点（无父）
  const all = [];         // 渲染前序全量节点
  let kw = '';
  let curCode = null;

  /* ---------- 结构构建：先建全部占位，再挂父子，天然规避顺序问题 ---------- */
  function build() {
    Object.keys(byCode).forEach(function (k) { delete byCode[k]; });
    roots.length = 0; all.length = 0;
    const subs = (typeof opts.getSubjects === 'function' ? opts.getSubjects() : []) || [];
    subs.forEach(function (s) {
      byCode[String(s.code)] = { s: s, parent: null, kids: [], line: null };
    });
    Object.keys(byCode).forEach(function (code) {
      const n = byCode[code];
      let p = null;
      for (let i = code.length - 1; i > 0; i--) {
        if (byCode[code.slice(0, i)]) { p = byCode[code.slice(0, i)]; break; }
      }
      if (p) { n.parent = p.s.code; p.kids.push(n); } else roots.push(n);
    });
    roots.sort(order);
    Object.keys(byCode).forEach(function (c) { byCode[c].kids.sort(order); });
    function order(a, b) { return a.s.code < b.s.code ? -1 : (a.s.code > b.s.code ? 1 : 0); }
    // 默认只露父级科目（含下级的节点全部折叠）
    collapsed = new Set();
    (function mark(list) {
      list.forEach(function (n) {
        if (n.kids.length) collapsed.add(n.s.code);
        mark(n.kids);
      });
    })(roots);
  }

  /* ---------- 单行 ---------- */
  function buildLine(n) {
    const line = document.createElement('div');
    // 层级缩进走 indent-N 类（CSS 里的全站统一缩进尺度），不再依赖 css 变量 --lv
    let depth = 1;
    for (let p = n.parent; p; p = byCode[p] ? byCode[p].parent : null) depth++;
    line.className = 'dl-tn' + (n.kids.length ? ' dl-tn-parent' : '') + ' indent-' + Math.min(depth, 5);
    const arrow = document.createElement('span');
    arrow.className = 'dl-arrow';
    arrow.textContent = n.kids.length ? '▶' : '';
    arrow.style.visibility = n.kids.length ? 'visible' : 'hidden';
    n.arrowEl = arrow;
    const codeEl = document.createElement('span'); codeEl.className = 'dl-code'; codeEl.textContent = n.s.code;
    const nameEl = document.createElement('span'); nameEl.className = 'dl-name'; nameEl.textContent = n.s.name;
    line.appendChild(arrow); line.appendChild(codeEl); line.appendChild(nameEl);
    n.line = line;

    if (n.kids.length) {
      arrow.addEventListener('click', function (e) {
        e.stopPropagation();
        if (collapsed.has(n.s.code)) collapsed.delete(n.s.code); else collapsed.add(n.s.code);
        refreshVisible();
      });
    }
    line.addEventListener('click', function () {
      if (typeof opts.onPick === 'function') opts.onPick(String(n.s.code));
    });
    return line;
  }
  function renderAll() {
    body.innerHTML = ''; all.length = 0;
    function walk(list) {
      list.forEach(function (n) {
        all.push(n);
        body.appendChild(buildLine(n));
        walk(n.kids);
      });
    }
    walk(roots);
  }

  /* ---------- 显隐 / 命中 ---------- */
  function ancestorCollapsed(code) {
    let n = byCode[code];
    while (n && n.parent) {
      n = byCode[n.parent];
      if (collapsed.has(n.s.code)) return true;
    }
    return false;
  }
  function refreshVisible() {
    if (kw) {
      // 搜索态：只显示「命中项 + 其祖先」，其余过滤隐藏，并直接定位到首个命中。
      const keep = new Set();
      let firstLine = null;
      for (let i = 0; i < all.length; i++) {
        const n = all[i];
        if (!isHit(n.s, kw)) continue;
        keep.add(n.s.code);
        if (!firstLine) firstLine = n.line;
        let p = n.parent;
        while (p) { keep.add(p); p = byCode[p] ? byCode[p].parent : null; }
      }
      for (let i = 0; i < all.length; i++) {
        const n = all[i];
        n.line.classList.toggle('dl-hide', !keep.has(n.s.code));
        if (n.kids.length) n.arrowEl.textContent = '▼';
      }
      if (firstLine && firstLine.scrollIntoView) firstLine.scrollIntoView({ block: 'center' });
      return;
    }
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      n.line.classList.toggle('dl-hide', ancestorCollapsed(n.s.code));
      if (n.kids.length) n.arrowEl.textContent = collapsed.has(n.s.code) ? '▶' : '▼';
    }
  }

  /* ---------- 面板骨架 ---------- */
  box.classList.add('dl-panel');
  if (panelClosed) box.classList.add('dl-panel-closed');

  const search = document.createElement('input');
  search.className = 'dl-panel-search';
  search.placeholder = '搜编码 / 名称';
  search.addEventListener('input', function () { kw = search.value.trim(); refreshVisible(); });

  const body = document.createElement('div');
  body.className = 'dl-body';

  function setPanelClosed(v) {
    panelClosed = v; saveClosed();
    box.classList.toggle('dl-panel-closed', v);
    if (!v && curCode && byCode[curCode]) byCode[curCode].line.scrollIntoView({ block: 'center' });
  }

  const head = document.createElement('div');
  head.className = 'dl-panel-head';
  const t = document.createElement('span'); t.textContent = '快速切换';
  const minBtn = document.createElement('button');
  minBtn.type = 'button'; minBtn.className = 'dl-panel-min'; minBtn.title = '收起';
  minBtn.textContent = '»';
  head.appendChild(t); head.appendChild(minBtn);

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button'; restoreBtn.className = 'dl-panel-restore'; restoreBtn.title = '展开科目快速切换';
  restoreBtn.textContent = '«';

  box.appendChild(head);
  box.appendChild(search);
  box.appendChild(body);
  box.appendChild(restoreBtn);

  minBtn.addEventListener('click', function () { setPanelClosed(true); });
  restoreBtn.addEventListener('click', function () { setPanelClosed(false); });

  /* ---------- 对外 ---------- */
  return {
    setCurrent: function (code) {
      curCode = code ? String(code) : null;
      for (let i = 0; i < all.length; i++) {
        const n = all[i];
        const hit = n.s.code === curCode;
        if (hit) n.line.classList.add('dl-cur'); else n.line.classList.remove('dl-cur');
      }
      if (curCode && byCode[curCode]) {
        let p = byCode[curCode].parent;
        while (p) { if (collapsed.has(p)) collapsed.delete(p); p = byCode[p] ? byCode[p].parent : null; }
        refreshVisible();
        byCode[curCode].line.scrollIntoView({ block: 'center' });
      }
    },
    refresh: function () { build(); renderAll(); refreshVisible(); }
  };
}
