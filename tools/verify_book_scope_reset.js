#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_book_scope_reset.js —— 「切换账套时，各页模块级状态是否复位」验证
 *
 * 【为什么需要】2026-09-26 审查发现：切换账套后，页面模块里那些「记住上次所见」的模块级状态
 *   不会自己复位，于是一部分界面继续显示**上一本账套**的数据。这类错数**不报错**，
 *   是自查最难发现的一类。当时已修（app.js 提供单点 bookScopeChanged，各页在刷新入口复位），
 *   但**此前没有任何脚本覆盖它**：
 *     · verify_gl_cache.js 只覆盖 store 层 _glCache 的切换隔离；
 *     · test_book_manage_e2e.js 只覆盖 switchBook 的落盘/元数据；
 *     · 页面级模块状态**零覆盖** —— 于是"改回去"不会有任何红灯。
 *   本脚本就是补这个空白：直接加载**真实页面模块源码**，模拟切账套，断言状态被复位。
 *
 * 【两条相反的断言，缺一不可】只断言"换账套会复位"是不够的 ——
 *   若把守卫写成"每次刷新都复位"，用户当次选的科目/期间会被反复清掉，功能直接坏掉。
 *   故每个页面都成对断言：
 *     ① 同一账套内多次刷新 → 用户的选择**必须保留**；
 *     ② 换了账套刷新 → 上一本的状态**必须清掉**。
 *
 * 【本脚本测的是真代码】把 js/pages/** 的源码加载进 Node（只改 import/export 语法 + 尾部挂调试钩子），
 *   `bookScopeChanged` 也是从 js/app.js 源码里**抽出来的真实实现**，不是复刻。
 *
 * 用法：node tools/verify_book_scope_reset.js
 * ============================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 宽松 DOM mock（页面模块在 Node 里跑得动即可） ---------- */
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const CACHE = {};
function el(id) {
  return { _id: id, innerHTML: '', innerText: '', textContent: '', value: '', checked: false, hidden: false,
    style: {}, className: '', title: '', options: [], selectedIndex: 0,
    dataset: {}, children: [], parentNode: null, firstChild: null, offsetWidth: 0, offsetHeight: 0,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, removeChild() {}, insertBefore() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, querySelector: () => el('q'), querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {}, click() {}, remove() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }) };
}
function getEl(id) { if (!CACHE[id]) CACHE[id] = el(id); return CACHE[id]; }
global.document = { getElementById: getEl, querySelector: () => el('q'), querySelectorAll: () => [],
  createElement: () => el('new'), addEventListener() {}, body: el('body'), documentElement: el('html') };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;

require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;
const U = global.U || global.util || {};
global.U = U;
const NUM = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const MONEY = n => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let CUR_M = '2026-02';
global.__TY_EXPORT__ = { store: S, util: U, ACCOUNT_CLASSES: global.ACCOUNT_CLASSES };

/* ============================================================
 * 一、从 js/app.js 抽取**真实**的 bookScopeChanged 实现
 *   （不复制逻辑：直接摘函数源码 + 它依赖的 _bookScopeSeen 与 bookKey，在受控作用域里跑）
 * ============================================================ */
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
function extractFn(name) {
  const i = appSrc.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let d = 0, j = appSrc.indexOf('{', i);
  for (let k = j; k < appSrc.length; k++) {
    if (appSrc[k] === '{') d++;
    else if (appSrc[k] === '}') { d--; if (d === 0) return appSrc.slice(i, k + 1); }
  }
  return null;
}
const srcFn = extractFn('bookScopeChanged');
const srcSeen = (appSrc.match(/var _bookScopeSeen = \{\};/) || [])[0];
check(!!srcFn, 'app.js 里应存在 bookScopeChanged()（切账套重置的单点实现）');
check(!!srcSeen, 'app.js 里应存在 _bookScopeSeen（记账套的已见标识）');
// app.js 的判据必须复用既有 bookKey()（bookId + 会计年度起始月），不得只比 bookId
check(!!srcFn && /bookKey\(\)/.test(srcFn),
  'bookScopeChanged 的判据应复用 bookKey()（含会计年度起始月），不得自己写一遍比较',
  srcFn ? srcFn.split('\n').filter(l => /bookKey|bookId/.test(l)).join(' / ') : '');

let BOOK = 'A|2024-01';
function bookKey() { return BOOK; }          // 测试用的「账套身份」来源（真实实现里是 app.js 的 bookKey）
let bookScopeChanged = function () { return false; };
if (srcFn && srcSeen) {
  try {
    /* 用 new Function 把「app.js 的真实源码文本」装进受控作用域：bookKey 以**参数**注入
       （app.js 里它是同作用域函数，此处只需提供等价的账套身份来源）。
       ⚠ 不可改用间接 eval —— 那样源码在**全局**作用域求值、读不到本文件的 bookKey，
         抛错被 catch 吞掉后静默退化成「永不复位」：所有"换账套应复位"的断言会**全部误绿**
         （首版就是这么栽的，靠 C 组那条"数量相同也要重建树"才暴露出来 —— 别删那条）。 */
    const factory = new Function('bookKey', srcSeen + '\n' + srcFn + '\nreturn bookScopeChanged;');
    bookScopeChanged = factory(bookKey);
  } catch (e) {
    console.log('⚠ 抽取 app.js 的 bookScopeChanged 失败：' + e.message);
    bookScopeChanged = function () { return false; };
  }
}
check(bookScopeChanged('__probe__') === true,
  '应能取到真实的 bookScopeChanged 实现（首次调用应为 true；若这里是 false，说明抽取失败、后续断言会误绿）');

/* 语义断言：同账套 false、换账套 true、首次 true */
(function semantics() {
  BOOK = 'A|2024-01';
  const f = bookScopeChanged;
  check(f('k1') === true, 'bookScopeChanged 首次调用应为 true（初始化视为需要置一次初值）');
  check(f('k1') === false, '同一账套内再次调用应为 false（用户当次的选择必须保留）');
  BOOK = 'B|2024-01';
  check(f('k1') === true, '换账套后同一 key 应为 true（这正是各页复位的触发条件）');
  check(f('k1') === false, '换账套后第二次调用应恢复 false（不得每次刷新都复位）');
  check(f('k2') === true, '新 key 首次调用应为 true（不同页各自记）');
  BOOK = 'A|2025-01';
  check(f('k1') === true,
    '会计年度起始月变了也应视为账套变化（bookKey 含起始月，默认期间会随之变）');
  BOOK = 'A|2024-01';
})();

/* ---------- 通用装载器：把页面模块源码加载进 Node（只改 import/export + 尾部挂钩子） ---------- */
function stripEsm(src) {
  return src
    // ⚠ 必须支持**跨行** import（ExpenseDetail.js 的 import 花括号跨两行）——首版锚了行首行尾，漏掉它
    .replace(/\bimport\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*['"];?/g, function (_m, names) {
      return names.split(',').map(n => n.trim()).filter(Boolean)
        .map(n => 'var ' + n + ' = (globalThis.__XP_IMPORTS__ || {})[' + JSON.stringify(n) + '];').join('\n');
    })
    .replace(/\bimport\s+[^;]*?from\s*['"][^'"]*['"];?/g, '/* import removed */')
    .replace(/\bexport\s*\{[\s\S]*?\};?/g, '/* export removed */')
    .replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1');
}
global.__XP_IMPORTS__ = {};   // 具体内容在 __TY_HELPERS__ 之后就位（见下）
function loadPage(rel, hookSrc) {
  let src = stripEsm(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  src += '\n;' + hookSrc;
  (0, eval)(src);
  return globalThis.__PAGE_HOOK__;
}
global.__TY_HELPERS__ = {
  $: getEl, money: MONEY, esc: s => String(s == null ? '' : s), showToast() {},
  // 这些必须给全：页面里普遍写成 `H.x ? H.x() : 本地同名()`，缺了就会走到不存在的全局分支而抛错
  todayStr: () => '2026-09-26', nowTimeStr: () => '2026-09-26 10:00:00',
  formatPeriod: m => String(m == null ? '' : m), lastClosedPeriod: () => CUR_M,
  absFmt: n => (n == null ? '' : String(n)), signed: n => (n < 0 ? '-' : '') + String(Math.abs(n == null ? 0 : n)),
  moneyRed: n => String(n), openModal() {}, closeModal() {},
  currentPeriod: () => CUR_M, periodRangeValue: () => CUR_M, periodRangeValues: () => ({ start: CUR_M, end: CUR_M }),
  syncAll() {}, S: S, U: U, num: NUM, round2: n => { const v = Number(n) || 0; const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; },
  bookKey: bookKey, bookScopeChanged: function (k) { return bookScopeChanged(k); }
};
/* 页面模块 import 的其余符号（组件 / _shared）在此打桩 —— 只让模块能装载与刷新，
   本脚本断言的是「状态是否复位」，不涉及这些桩的内部行为。 */
Object.assign(global.__XP_IMPORTS__, global.__TY_HELPERS__, {
  createSubjectTree: function () { return { refresh() {}, setCurrent() {}, destroy() {}, setData() {} }; },
  updatePeriodRangeTrigger: function () {},
  bindSubjectPicker: function () { return { refresh() {} }; },
  bindPeriodPicker: function () { return { refresh() {} }; },
  matchSubjectCode: function () { return null; },
  subjectFullName: function (c) { return String(c == null ? '' : c); },
  goPage: function () {},
  absFmt: function (n) { return n == null ? '' : String(n); },
  monthList: (U && U.monthList) || function () { return []; },
  prevYearMonth: function (m) { return m; },
  monthLabel: function (m) { return String(m == null ? '' : m); },
  subjectLevel: function () { return 1; },
  subjectFilter: function (fn) { return (S.subjects() || []).filter(fn); }
});

/* 放一本「A 账套」，含科目与凭证，让各页渲染走真实取数 */
function installBook(name) {
  S.state = {
    schemaVersion: S.state && S.state.schemaVersion,
    company: { name: name, startMonth: '2024-01' },
    subjects: [
      { code: '1001', name: '库存现金', normal: 'dr', cls: 'asset', level: 1 },
      { code: '1002', name: '银行存款', normal: 'dr', cls: 'asset', level: 1 },
      { code: '2202', name: '应付账款', normal: 'cr', cls: 'liability', level: 1 }
    ],
    openingBalances: {}, param: {}, closedPeriods: [], fixedAssets: [],
    vouchers: [{ id: 'v1', date: '2026-02-10', word: '记', no: 1, deleted: '', summary: '测试',
      entries: [{ code: '1001', dr: 100, cr: 0, summary: '测试' }, { code: '1002', dr: 0, cr: 100, summary: '测试' }] }]
  };
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  S.bookId = name;
}

/* ============================================================
 * 二、明细账 / 总账 / 多栏账（js/pages/ledger/Ledger.js）
 * ============================================================ */
(function ledger() {
  installBook('A');
  const L = loadPage('js/pages/ledger/Ledger.js', `
globalThis.__PAGE_HOOK__ = {
  refreshGl: refreshGl, refreshDl: refreshDl, refreshMl: refreshMl,
  get dlCurCode() { return dlCurCode; }, set dlCurCode(v) { dlCurCode = v; },
  get dlTree() { return dlTree; }, set dlTree(v) { dlTree = v; },
  get dlTreeSig() { return dlTreeSig; }, set dlTreeSig(v) { dlTreeSig = v; },
  get dlAutoFirstDone() { return dlAutoFirstDone; }, set dlAutoFirstDone(v) { dlAutoFirstDone = v; },
  get glFilterCodes() { return glFilterCodes; }, set glFilterCodes(v) { glFilterCodes = v; },
  get glJumpHl() { return glJumpHl; }, set glJumpHl(v) { glJumpHl = v; },
  get mlCurCode() { return mlCurCode; }, set mlCurCode(v) { mlCurCode = v; }
};`);
  check(!!L, 'Ledger.js 应能加载并暴露调试钩子');

  // —— 同一账套内：用户选的科目/过滤必须保留 ——
  BOOK = 'A|2024-01';
  L.refreshGl(); L.refreshDl(); L.refreshMl();      // 初始化（各自首次会复位一次，正常）
  L.dlCurCode = '1002'; L.glFilterCodes = new Set(['1001']); L.glJumpHl = true; L.mlCurCode = '2202';
  L.dlTreeSig = 'sig-A'; L.dlAutoFirstDone = true;
  L.refreshGl(); L.refreshDl(); L.refreshMl();
  check(L.dlCurCode === '1002', '同一账套内刷新：明细账当前科目应保留（不得每次刷新都清）', '实际 ' + L.dlCurCode);
  check(L.glFilterCodes instanceof Set && L.glFilterCodes.has('1001'),
    '同一账套内刷新：总账科目过滤应保留', '实际 ' + (L.glFilterCodes ? L.glFilterCodes.size : null));
  check(L.glJumpHl === true, '同一账套内刷新：总账跳转高亮应保留');
  check(L.mlCurCode === '2202', '同一账套内刷新：多栏账当前科目应保留', '实际 ' + L.mlCurCode);

  // —— 换账套：上一本的选择必须**失效** ——
  //   ⚠ 判据不能写成"必须为 null"。首版这么写，误报 2 条：
  //     · refreshDl 紧接着会为新账套**自动定位**首个发生科目 → dlCurCode 变成新值（这是对的）；
  //     · 科目树随即用新账套的科目**重建** → dlTree 又是一个对象（这也是对的）。
  //   故用哨兵对象比对「是否还是旧账套那一份」，而不是比 null。
  // 哨兵必须是**看起来合法的树对象**（有 refresh/setCurrent）：
  // 否则守卫一旦失效，源码会在哑对象上抛 TypeError 把整个脚本炸掉 —— 那也是"红"，
  // 但只能看到一句 TypeError，看不出是哪条约定被破坏。给合法壳子才能报出人话。
  function fakeTree(tag) { return { tag: tag, refresh() {}, setCurrent() {}, destroy() {} }; }
  BOOK = 'B|2024-01';
  var treeA = fakeTree('A 账套的科目树');
  L.dlTree = treeA;
  L.refreshGl(); L.refreshDl(); L.refreshMl();
  check(L.dlCurCode !== '1002',
    '换账套：明细账当前科目不得沿用旧账套的 code（新账套无此 code 时会显示空表/异常）', '实际 ' + L.dlCurCode);
  check(L.glFilterCodes === null,
    '换账套：总账科目过滤应清空（否则新账套总账被旧过滤裁掉行）', '实际 ' + (L.glFilterCodes ? L.glFilterCodes.size + ' 个' : 'null'));
  check(L.glJumpHl === false, '换账套：总账跳转高亮应清除');
  check(L.mlCurCode === null, '换账套：多栏账当前科目应清空', '实际 ' + L.mlCurCode);
  check(L.dlTree !== treeA, '换账套：明细账科目树必须重建（旧树列的是旧账套科目）');

  // —— 关键回归：两账套「发生科目**数量相同**、编码不同」也必须重建树 ——
  //   原实现只比数量（dlTreeSig = 发生科目数），数量相同就认定"树没变"、完全不重建。
  installBook('C');
  S.state.subjects = [{ code: '5001', name: '生产成本', normal: 'dr', cls: 'cost', level: 1 },
                      { code: '1001', name: '库存现金', normal: 'dr', cls: 'asset', level: 1 }];
  S.state.vouchers = [{ id: 'v9', date: '2026-02-11', word: '记', no: 9, deleted: '', summary: 'x',
    entries: [{ code: '5001', dr: 50, cr: 0, summary: 'x' }, { code: '1001', dr: 0, cr: 50, summary: 'x' }] }];
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  BOOK = 'C|2024-01';
  var treeB = fakeTree('B 账套的科目树');
  L.dlTree = treeB;
  L.dlTreeSig = 2;   // 刻意设成与新账套的发生科目数（5001/1001 两个）相同 —— 旧实现据此判定"不用重建"
  L.refreshDl();
  check(L.dlTree !== treeB,
    '换账套且发生科目数量相同：科目树也必须重建（旧实现只比科目数量 → 会继续列旧账套科目）');
})();

/* ============================================================
 * 三、录凭证（js/pages/voucher/Voucher.js）
 * ============================================================ */
(function voucher() {
  installBook('A');
  const V = loadPage('js/pages/voucher/Voucher.js', `
globalThis.__PAGE_HOOK__ = {
  refreshVoucher: refreshVoucher,
  get vRows() { return vRows; }, set vRows(v) { vRows = v; },
  get vEditId() { return vEditId; }, set vEditId(v) { vEditId = v; }
};`);
  check(!!V, 'Voucher.js 应能加载并暴露调试钩子');
  if (!V) return;
  BOOK = 'A|2024-01';
  V.refreshVoucher();
  // 模拟用户正在编辑一张凭证（属于 A 账套）
  V.vRows = [{ code: '1001', dr: 100, cr: 0 }, { code: '1002', dr: 0, cr: 100 }];
  V.vEditId = 'old-voucher-of-A';
  V.refreshVoucher();   // 同一账套内刷新（如保存后）
  check(V.vEditId === 'old-voucher-of-A' && V.vRows.length === 2,
    '同一账套内刷新：正在编辑的凭证不得被清掉（否则用户录一半被清空）',
    'vEditId=' + V.vEditId + ' 行数=' + V.vRows.length);
  BOOK = 'B|2024-01';
  V.refreshVoucher();
  check(!V.vEditId || V.vRows.length === 0,
    '换账套：正在编辑的凭证表单必须复位（否则旧账套分录残留在新账套，一保存就是错账）',
    'vEditId=' + V.vEditId + ' 行数=' + (V.vRows || []).length);
})();

/* ============================================================
 * 四、结账（js/pages/settle/Settle.js）
 * ============================================================ */
(function settle() {
  installBook('A');
  const T = loadPage('js/pages/settle/Settle.js', `
globalThis.__PAGE_HOOK__ = {
  refreshSettle: refreshSettle,
  get selMonth() { return selMonth; }, set selMonth(v) { selMonth = v; },
  get selReopenMonth() { return selReopenMonth; }, set selReopenMonth(v) { selReopenMonth = v; },
  get newTplRows() { return newTplRows; }, set newTplRows(v) { newTplRows = v; },
  get editingCustomId() { return editingCustomId; }, set editingCustomId(v) { editingCustomId = v; }
};`);
  check(!!T, 'Settle.js 应能加载并暴露调试钩子');
  if (!T) return;
  BOOK = 'A|2024-01';
  T.refreshSettle();
  T.selMonth = '2025-06'; T.selReopenMonth = '2025-05';   // 用户在 A 账套选的历史期
  T.newTplRows = [{ code: '1002', dir: 'dr' }]; T.editingCustomId = 'tpl-of-A';   // 用户正在编辑的结转模板
  T.refreshSettle();                                      // 同一账套内刷新：以上都不得被清
  check(T.newTplRows.length === 1 && T.editingCustomId === 'tpl-of-A',
    '同一账套内刷新：编辑中的自定义结转模板不得被清（否则用户编到一半被清空）',
    '模板行 ' + T.newTplRows.length + ' / 编辑 id ' + T.editingCustomId);
  BOOK = 'B|2024-01';
  T.refreshSettle();
  check(T.selMonth === CUR_M,
    '换账套：结账选期应回到新账套当前期（否则新账套该月有凭证时不会自动回退，显示上一本所选期）',
    '实际 ' + T.selMonth + ' 期望 ' + CUR_M);
  check(T.selReopenMonth === CUR_M,
    '换账套：反结账选期应回到新账套当前期（此处原先完全没有回退逻辑）',
    '实际 ' + T.selReopenMonth + ' 期望 ' + CUR_M);
  check(T.newTplRows.length === 0 && T.editingCustomId === null,
    '换账套：编辑中的自定义结转模板必须复位（否则模板行会带着旧账套科目保存进新账套）',
    '模板行 ' + T.newTplRows.length + ' / 编辑 id ' + T.editingCustomId);
})();

/* ============================================================
 * 五、费用明细表（js/pages/report/ExpenseDetail.js）
 * ============================================================ */
(function expenseDetail() {
  installBook('A');
  const E = loadPage('js/pages/report/ExpenseDetail.js', `
globalThis.__PAGE_HOOK__ = {
  refresh: refreshExpenseDetail,
  get edState() { return edState; },
  get edExportData() { return edExportData; }, set edExportData(v) { edExportData = v; }
};`);
  check(!!E, 'ExpenseDetail.js 应能加载并暴露调试钩子');
  if (!E) return;
  BOOK = 'A|2024-01';
  E.refresh();
  E.edState.expanded.add('6602'); E.edState.page = 7; E.edExportData = { stale: true };
  E.refresh();   // 同一账套内刷新
  // 只断言**展开集**。edState.page 会被「页数夹逼」改写（源文件里 page > totalPages 即夹到末页），
  //   mock 环境下总页数恒为 1 → 页码必为 1，拿它断言"保留"是**假断言**（首版如此，已删）。
  check(E.edState.expanded.has('6602'),
    '同一账套内刷新：手动展开集应保留（不得每次刷新都清）', '展开数=' + E.edState.expanded.size);
  BOOK = 'B|2024-01';
  E.refresh();
  check(E.edState.expanded.size === 0,
    '换账套：手动展开集应清空（里面是旧账套的科目编码，新账套多半没有）',
    '剩余 ' + E.edState.expanded.size);
  /* ⚠ 此处**刻意不**断言 edExportData：
     refreshExpenseDetail 每次都会重算并重新赋值 edExportData，所以"换了账套后它是不是新对象"
     两种情况下都成立 —— 那是**假断言**，留着只会给虚假的安心。
     该守卫的正确性由下方静态卡口（ExpenseDetail.js 在刷新入口调用 bookScopeChanged('ed')）保证。 */
})();

/* ============================================================
 * 六、静态卡口：守卫是**被真的接上**的（而非只写在注释里）
 * ============================================================ */
(function wiring() {
  const pages = [
    ['js/pages/ledger/Ledger.js', ['gl', 'dl', 'ml']],
    ['js/pages/voucher/Voucher.js', ['voucher']],
    ['js/pages/settle/Settle.js', ['settle']],
    ['js/pages/report/ExpenseDetail.js', ['ed']]
  ];
  pages.forEach(function (p) {
    const src = fs.readFileSync(path.join(ROOT, p[0]), 'utf8');
    check(/const\s+bookScopeChanged\s*=/.test(src), p[0] + ' 应取用 bookScopeChanged（取自 helpers，含 fallback）');
    p[1].forEach(function (k) {
      const re = new RegExp('bookScopeChanged\\(\\s*[\'"]' + k + '[\'"]\\s*\\)');
      check(re.test(src), p[0] + ' 应在刷新入口调用 bookScopeChanged("' + k + '") 做复位');
    });
  });
  /* ⚠ 反向约定（防止后来者"顺手补齐"）：**不得**把科目选择器句柄置 null 当作"换账套复位" ——
     bindSubjectPicker 有幂等保护（在元素 dataset 打标记），已绑过再调会**直接 return undefined**，
     句柄再也拿不回来；而它的 getSubjects 是实时读 S.subjects()，本就不会留旧账套的科目。
     （本约定源自一次真实返工：多栏账那处初版就写了 `mlSubjPicker = null`，随后被查出是错的。） */
  [['js/pages/ledger/Ledger.js', 'mlSubjPicker'], ['js/pages/voucher/Voucher.js', 'qSubjPicker']]
    .forEach(function (p) {
      const src = fs.readFileSync(path.join(ROOT, p[0]), 'utf8');
      const n = (src.match(new RegExp(p[1] + '\\s*=\\s*null', 'g')) || []).length;
      check(n === 1, p[0] + ' 只应有「声明处」一次 ' + p[1] + ' = null —— 不得在换账套复位里再置 null'
        + '（重绑会直接 return undefined，句柄拿不回来）', '实测出现 ' + n + ' 次');
    });
  // 结账页的守卫必须复位「编辑中的自定义结转模板」（否则模板行带旧账套科目保存进新账套）
  (function () {
    const src = fs.readFileSync(path.join(ROOT, 'js/pages/settle/Settle.js'), 'utf8');
    const i = src.indexOf("bookScopeChanged('settle')");
    const seg = i < 0 ? '' : src.slice(i, i + 600);
    check(/newTplRows\s*=\s*\[\]/.test(seg) && /editingCustomId\s*=\s*null/.test(seg),
      'Settle 的换账套复位里应清 newTplRows / editingCustomId（编辑中的模板属上一本账套）');
  })();

  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  check(/bookScopeChanged\s*:\s*pick\(bookScopeChanged\)/.test(app),
    'app.js 应把 bookScopeChanged 挂到 __TY_HELPERS__（页面才拿得到）');
  check(/'expense-detail'\s*:\s*renderVia\('ExpenseDetail'\)/.test(app),
    'PAGE_REFRESHERS 应含 expense-detail（否则停在该页切账套时整页不重渲染，显示上一本账套数）');
})();

/* ---------- 汇总 ---------- */
if (fail) {
  console.log('❌ 切账套状态复位：' + fail + ' 项不符（通过 ' + pass + '）');
  fails.forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(1);
}
console.log('✅ 切账套状态复位：' + pass + ' 项通过（页面模块级状态在同账套内保留、换账套即复位）');
