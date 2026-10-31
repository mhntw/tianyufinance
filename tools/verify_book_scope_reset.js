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
 * 【2026-10-14 定稿】守卫**只保留一套语义**（app.js 的单点 bookScopeChanged）。
 *   当天两起报障（点凭证字号进来是空白凭证 / 点科目编码跳错科目）一度被当成"守卫不够用"，
 *   加了一套 bookChanged + registerBookReset/runBookResets 的机制（换账套时 app.js 主动复位），
 *   结果把 2 行的**顺序**问题上升成跨 6 个文件的机制，还引入了"换账套后凭证字号为空"的新缺陷 —— 已整体回滚。
 *   真实根因是**跳转入口顺序写反**：先设状态、后切页时，切页同步触发的刷新里的复位会清掉刚设好的状态。
 *   修法是"先切页、再设状态"（见 Voucher.loadVoucherToEdit / Ledger.__dlJumpTo，以及下方 jumpOrder 卡口）。
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
/* 【反向约定 2026-10-14】守卫**只保留一套语义**。
   两起跳转缺陷（凭证字号进来空白凭证 / 科目编码跳错科目）的根因是**跳转入口顺序写反**，
   修法是"先切页、再设状态"（见下方 jumpOrder 卡口），**不是**给守卫加第二套语义、
   也不是加"换账套时主动复位"的注册表 —— 那种机制化改法（2026-10-14 曾实现并返工）
   把 2 行顺序问题上升成跨 6 个文件的机制，反而引入了新的时序缺陷（换账套后凭证字号为空）。
   故这里断言 app.js 里**不存在**那些机制，防止将来又绕回去。 */
check(!/function bookChanged\(/.test(appSrc) && !/function runBookResets\(/.test(appSrc)
  && !/_bookResetHooks/.test(appSrc),
  'app.js 不应再出现 bookChanged / runBookResets / _bookResetHooks 这类第二套守卫机制（跳转顺序已解决根因）');

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
  }
}
check(bookScopeChanged('__probe__') === true,
  '应能取到真实的 bookScopeChanged 实现（首次调用应为 true；若这里是 false，说明抽取失败、后续断言会误绿）');

/* 语义断言：单点守卫就一套语义 —— 首次调用即 true（供"复位值取当下动态值"的调用点，如结账页），
   同一账套内后续调用 false（用户当次的选择必须保留），换账套后再次 true。 */
(function semantics() {
  BOOK = 'A|2024-01';
  const f = bookScopeChanged;
  check(f('s1') === true, 'bookScopeChanged 首次调用应为 true（复位值取当下动态值的调用点靠它对齐当期）');
  check(f('s1') === false, '同一账套内再次调用应为 false（用户当次的选择必须保留）');
  BOOK = 'B|2024-01';
  check(f('s1') === true, '换账套后同一 key 应为 true（这正是各页复位的触发条件）');
  check(f('s1') === false, '换账套后第二次调用应恢复 false（不得每次刷新都复位）');
  check(f('s2') === true, '新 key 首次调用也应为 true（不同页各自记，互不影响）');
  // 同一本书、会计年度起始月不同 → 必须算作换账套（bookKey 含起始月，默认期间会随之变）；
  // 只比 bookId 的实现会在这里返回 false，这条就是防它退化。
  BOOK = 'A|2024-01';
  check(f('s3') === true, '新 key 首次调用应为 true（为下一条做基准）');
  BOOK = 'A|2025-01';
  check(f('s3') === true,
    '同书但会计年度起始月变了，也必须视为账套变化（判据必须复用含起始月的 bookKey）');
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
/* 分页器（common/pager.js）用真实源码装载：页面模块 import 它，缺了页面直接报
   "renderPager is not a function"。不在此重写一份页码逻辑（那是自己验自己）。 */
(function () {
  let src = stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'common', 'pager.js'), 'utf8'));
  (0, eval)(src + '\n;globalThis.__XP_IMPORTS__.renderPager = renderPager;');
})();
function loadPage(rel, hookSrc) {
  /* 页面引导块已收口到 js/common/helpers.js：装载页面源码前先把它喂进 __XP_IMPORTS__
     （页面里的 import 会被 stripEsm 改写成 `var H = __XP_IMPORTS__['H']`）；
     幂等，重复调用无害。见 tools/harness_boot.js 的说明。 */
  require('./harness_boot.js').installBootImports(global, path.join(__dirname, '..'));
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
  openModal() {}, closeModal() {},
  currentPeriod: () => CUR_M, periodRangeValue: () => CUR_M, periodRangeValues: () => ({ start: CUR_M, end: CUR_M }),
  syncAll() {}, S: S, U: U, num: NUM, round2: n => { const v = Number(n) || 0; const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; },
  // 页面模块取的就是这一个守卫（抽取到的 app.js 真实实现）；
  // 包一层是为了让页面拿到的是**抽取后**的实现（顶层 bookScopeChanged 变量可能已被替换）。
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

  /* —— 本次运行**首次**进明细账就点科目跳转（用户报障的主场景）——
     __dlJumpTo 的约定是「先切页、再设状态」：切页同步触发的 refreshDl 里 bookScopeChanged('dl')
     首次为 true，会把 dlCurCode 复位、并可能自动定位到编码最小的发生科目；但随后本入口把目标科目
     写上并重绘，复位结果被覆盖 → 最终停在该科目。
     修复前顺序写反（先设 dlCurCode 再 goPage），复位/自动定位发生在最后 → 点 1002 却看到 1001。
     ⚠ 壳里 global.goPage 未定义 → __dlJumpTo 会静默不跳转、断言变成假绿，
       故装上复刻 app.js 行为的桩（切页 + 调本页刷新）。 */
  global.goPage = function () { L.refreshDl(); };
  globalThis.__dlJumpTo('1002');
  check(L.dlCurCode === '1002',
    '首次进明细账即点科目跳转：必须停在该科目（顺序写反会被复位清掉 → 自动定位到编码最小的科目）',
    '实际 ' + L.dlCurCode);
  global.goPage = undefined;   // 后续断言按需各自装桩

  // —— 同一账套内：用户选的科目/过滤必须保留 ——
  BOOK = 'A|2024-01';
  L.refreshGl(); L.refreshDl(); L.refreshMl();      // 进页面（首次会复位 = 回到初始态，随后才设值）
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

  /* —— 换账套后跳转（另一条路径：换账套时该页未激活，没被它自己的刷新碰到）——
     这里没有"换账套时 app.js 主动复位"的机制（那是 2026-10-14 被回滚的过度设计）：
     陈旧状态由**跳转时切页触发的刷新**清掉 —— 复位发生在设状态之前，故最终仍是目标科目。 */
  installBook('A');            // 1001 库存现金 / 1002 银行存款，两科目都有发生额
  BOOK = 'D|2024-01';
  L.refreshDl();               // 记录 D 账套
  BOOK = 'E|2024-01';          // 换账套（本页此刻未激活，没人刷新它）
  L.dlCurCode = '1002'; L.glFilterCodes = new Set(['1001']); L.mlCurCode = '2202';   // 上一本的残留

  const prevGoPage = global.goPage;
  global.goPage = function () { L.refreshDl(); };
  var staleTreeE = fakeTree('E 之前那一份科目树');
  L.dlTree = staleTreeE;
  globalThis.__dlJumpTo('1002');
  global.goPage = prevGoPage;
  check(L.dlCurCode === '1002',
    '换账套后从总账点科目编码跳明细账：必须停在该科目（顺序写反会被复位改成编码最小的科目）',
    '实际 ' + L.dlCurCode);
  /* 反向确认：这次切页触发的刷新**确实**认出了换账套并复位过 ——
     否则上面那条可能只是"陈旧值恰好等于目标科目"而蒙对（跳转入口最后一定会写目标科目，
     单看 dlCurCode 无法区分"复位后重设"与"压根没复位"）。科目树是否被作废重建能区分两者。 */
  check(L.dlTree !== staleTreeE,
    '跳转切页触发的刷新里，上一本账套的科目树必须被作废重建（否则说明换账套复位没发生，上面那条是蒙对的）');
})();

/* ============================================================
 * 三、录凭证（js/pages/voucher/Voucher.js）
 * ============================================================ */
(function voucher() {
  installBook('A');
  const V = loadPage('js/pages/voucher/Voucher.js', `
globalThis.__PAGE_HOOK__ = {
  refreshVoucher: refreshVoucher,
  loadVoucherToEdit: loadVoucherToEdit,
  get vRows() { return vRows; }, set vRows(v) { vRows = v; },
  get vEditId() { return vEditId; }, set vEditId(v) { vEditId = v; }
};`);
  check(!!V, 'Voucher.js 应能加载并暴露调试钩子');
  if (!V) return;

  /* —— 本次运行**首次**进凭证页就点凭证字号跳转（报障的主场景）——
     loadVoucherToEdit 的约定是「先切页、再设状态」：切页同步触发的 refreshVoucher 里
     bookScopeChanged('voucher') 首次为 true → resetVoucherEdit 把表单清成 4 行空白；
     但随后本入口才写 vEditId / 分录行，复位结果被覆盖 → 用户看到的是他要的那张凭证。
     修复前顺序写反 → 复位发生在最后 → 点凭证字号进来是一张空白凭证。
     ⚠ 壳里给 H 的 goPage 是空桩 → 必须装复刻 app.js 行为的桩（切页 + 调本页刷新）。 */
  const stubGoFirst = global.__TY_HELPERS__.goPage;
  global.__TY_HELPERS__.goPage = function () { V.refreshVoucher(); };
  S.state.vouchers = [{ id: 'v-first', date: '2026-02-12', word: '记', no: 1, deleted: '', summary: '首次跳转',
    entries: [{ code: '1001', dr: 300, cr: 0, summary: '首次跳转' },
              { code: '1002', dr: 0, cr: 300, summary: '首次跳转' }] }];
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  V.loadVoucherToEdit('v-first');
  check(V.vEditId === 'v-first' && (V.vRows || []).some(function (r) { return r.code === '1001'; }),
    '首次进凭证页即点凭证字号跳转：表单不得被复位成空白凭证',
    'vEditId=' + V.vEditId + ' 行=' + JSON.stringify((V.vRows || []).map(function (r) { return r.code || '空'; })));
  global.__TY_HELPERS__.goPage = stubGoFirst;
  V.vRows = []; V.vEditId = null;    // 清现场，继续后面的断言

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

  /* —— 换账套后进凭证页：表单必须被**重新初始化**（用户 2026-10-14 报障：看不到凭证字号）——
     换账套时的复位与空白初始化都在 refreshVoucher 的入口守卫里同步完成：
     bookScopeChanged('voucher') 为 true → resetVoucherEdit() → 4 行空白 + 凭证字/号都填上。
     （曾经把复位拆成"换账套那一刻只作废状态、渲染留给进页面"的两段式，那是被回滚的机制化改法：
     一旦中途抛错就留下"有分录行但凭证号为空"的半初始化现场，本页根本没有兜底分支去救它。） */
  BOOK = 'C|2024-01';
  V.refreshVoucher();                                     // 换账套后进凭证页
  check(V.vRows.length === 4 && V.vEditId === null,
    '换账套后进凭证页：应重新初始化空白凭证（4 行）', 'vRows=' + V.vRows.length);
  const wEl = global.__TY_HELPERS__.$('vWord'), nEl = global.__TY_HELPERS__.$('vNo');
  check(!!wEl && wEl.value === '记',
    '换账套后凭证字下拉必须有值（空 = 用户报的「看不到凭证字号」）', 'vWord=' + (wEl && wEl.value));
  check(!!nEl && String(nEl.value) !== '',
    '换账套后凭证号必须有值（空 = 用户报的「看不到凭证字号」）', 'vNo=' + (nEl && nEl.value));

  /* —— 换账套后跳转载入已有凭证（另一条路径：换账套时凭证页未激活）——
     跳转入口「先切页」触发的 refreshVoucher 认出换账套、清成空白表单，
     随后 loadVoucherToEdit 才写入目标凭证 —— 顺序保证最终看到的是那张凭证。 */
  const prevGoPage = global.__TY_HELPERS__.goPage;
  global.__TY_HELPERS__.goPage = function () { V.refreshVoucher(); };
  installBook('D');
  S.state.vouchers = [{ id: 'v-d', date: '2026-02-10', word: '记', no: 3, deleted: '', summary: '跳转测试',
    entries: [{ code: '1001', dr: 700, cr: 0, summary: '跳转测试' },
              { code: '1002', dr: 0, cr: 700, summary: '跳转测试' }] }];
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  BOOK = 'D|2024-01';
  V.loadVoucherToEdit('v-d');
  check(V.vEditId === 'v-d',
    '换账套后点凭证字号跳转：必须载入该凭证（vEditId 被清 = 用户看到的「空白凭证」）',
    'vEditId=' + V.vEditId);
  check((V.vRows || []).some(function (r) { return r.code === '1001'; }),
    '换账套后点凭证字号跳转：该凭证的分录行必须还在（被 resetVoucherEdit 清成 4 行空行即空白凭证）',
    '行=' + JSON.stringify((V.vRows || []).map(function (r) { return r.code || '空'; })));
  global.__TY_HELPERS__.goPage = prevGoPage;
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
  /* 守卫是**单点**的：app.js 的 bookScopeChanged（见其定义处注释）挂在 __TY_HELPERS__，
     各页取用 + 在刷新入口按 key 复位。用哪个 key 是各页自己的事；页面**不得**再写一套账套判据。 */
  const pages = [
    ['js/pages/ledger/Ledger.js', ['gl', 'dl', 'ml']],
    ['js/pages/voucher/Voucher.js', ['voucher']],
    ['js/pages/report/ExpenseDetail.js', ['ed']],
    ['js/pages/settle/Settle.js', ['settle']]
  ];
  pages.forEach(function (p) {
    const src = fs.readFileSync(path.join(ROOT, p[0]), 'utf8');
    // fallback 必须返回 false（= 不重置）：写成 true 会把用户当次录的内容每次刷新都清掉
    check(/const\s+bookScopeChanged\s*=\s*H\.bookScopeChanged\s*\|\|\s*function\s*\(\s*\)\s*\{\s*return false;\s*\}/.test(src),
      p[0] + ' 应取 app.js 的单点守卫 bookScopeChanged（fallback 必须「不重置」）');
    p[1].forEach(function (k) {
      const re = new RegExp('bookScopeChanged\\(\\s*[\'"]' + k + '[\'"]\\s*\\)');
      check(re.test(src), p[0] + ' 应在刷新入口调用 bookScopeChanged("' + k + '") 做复位');
    });
  });
  /* 【根因卡口 2026-10-14】跳转入口必须「先切页、再设状态」——
     两起跳转缺陷（凭证字号进来空白凭证 / 科目编码跳错科目）的真实根因就是顺序写反：
     先设状态、后切页时，切页**同步**触发的刷新里的账套复位会把刚设好的状态清掉，随后
     本页的"空白初始化 / 首次自动定位"接管，用户看到的就是空白凭证 / 编码最小的科目。
     顺序对了，复位结果被后续赋值覆盖，两种账套情形都正确，不需要任何"跳过复位"的补丁。
     这里按源码位置断言顺序，防止"顺手整理"时把两行调换回去。 */
  [
    ['js/pages/voucher/Voucher.js', 'function loadVoucherToEdit(',
      'openVoucherPage();', 'vEditId = v.id;'],
    ['js/pages/ledger/Ledger.js', 'globalThis.__dlJumpTo = function (',
      "goPage('detail-ledger')", 'dlCurCode = String(code);']
  ].forEach(function (j) {
    const src = fs.readFileSync(path.join(ROOT, j[0]), 'utf8');
    const i0 = src.indexOf(j[1]);
    const iPage = i0 < 0 ? -1 : src.indexOf(j[2], i0);     // 切页
    const iState = i0 < 0 ? -1 : src.indexOf(j[3], i0);    // 设状态
    check(i0 >= 0 && iPage >= 0 && iState >= 0 && iPage < iState,
      j[0] + '：跳转入口必须"先切页、再设状态"（' + j[2] + ' 要在 ' + j[3] + ' 之前）—— '
      + '顺序写反，切页触发的复位就会清掉刚设好的状态',
      '切页@' + iPage + ' 设状态@' + iState);
  });
  /* 反向约定：**不得**再给单个跳转入口加"本次跳过复位"的补丁 ——
     根因（跳转入口顺序写反）已由"先切页、再设状态"的约定消除；
     补丁不仅多余，还会让下一个改这段的人以为问题仍在。 */
  ['js/pages/voucher/Voucher.js', 'js/pages/ledger/Ledger.js'].forEach(function (f) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(!/keepLoadedVoucher|keepDlCodeOnce/.test(src),
      f + ' 不得再引入"跳转期间跳过复位"的补丁（根因已修）');
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
