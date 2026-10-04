#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_page_domain.js —— 【显示层】页面侧「元 / 定点整数」单位域卡口
 *
 * 【为什么需要】（P10：测试网的防线缺失）
 *   金额定点化（内部金额 = 0.0001 元定点整数）把单位域收口在 store 取值层，
 *   影子对照 verify_amount_shadow.js 证明了「取数层逐位一致」，I15 只证明「字段是整数」——
 *   但两者都**不查页面有没有把整数当元用**（也不查把元当整数喂给 money()）。
 *   2026-09-30 一次性审出 8 处页面侧混用（P1–P8），每一处都能让「界面金额差 10000 倍」
 *   或「功能静默失效」，而 run-all 全绿放过 —— 因为没有任何一条断言在页面层看单位。
 *
 * 【本脚本的判据】真实加载页面模块源码（只改 import/export 语法），驱动**真实函数**，
 *   读回真实渲染结果，断言金额落在正确的单位域：
 *     A. Voucher.updateAmtTotals —— 借贷不平衡差额提示（P1：曾把「元」喂给期望整数的 money()）
 *     B. Voucher.voucherUnchanged —— 「未做修改直接跳过」（P5：两侧「整数 vs 元」恒不等，永不生效）
 *     C. Settle.renderCustomCards —— 自定义模板「未结转」额（P2：模板「元」− 已结转「整数」恒 0.00）
 *     D. app.runSearch —— 按金额搜索凭证（P4：判据 `< 0.005` 在整数域恒假，永远搜不到）
 *     E. Asset._updateHints —— 资产卡「预计残值」（P13：元值直接喂 money()，250.00 显示成 0.03）
 *   金额一旦跨错单位域，这些断言立刻红 —— 不依赖任何人对口径的理解。
 *
 * 用法：node tools/verify_page_domain.js [--selftest]
 *   --selftest：把原始缺陷形态（P1/P2/P4/P5/P13）种回源码，要求本脚本必须报红 ——
 *   证明这些断言确实拦得住，而不是"靶点漂移后悄悄变绿"。靶点未命中会显式报错。
 * 退出码：0 = 通过；1 = 存在单位域错用（或自检未捕获注入缺陷）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 极简 DOM mock（够页面模块装载与本次驱动用） ---------- */
const CACHE = {};
function el(id) {
  return {
    _id: id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false,
    style: {}, className: '', title: '', dataset: {},
    classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
    appendChild() { }, removeChild() { }, insertBefore() { }, setAttribute() { }, removeAttribute() { },
    getAttribute() { return null; }, addEventListener() { }, removeEventListener() { },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() { }, blur() { }, click() { }, scrollIntoView() { }
  };
}
function getEl(id) { if (!CACHE[id]) CACHE[id] = el(id); return CACHE[id]; }
global.document = {
  getElementById: getEl, createElement: () => el('__new__'),
  querySelector: (sel) => getEl('sel:' + sel), querySelectorAll: () => [],
  addEventListener() { }, removeEventListener() { },
  body: el('body'), head: el('head'), documentElement: el('html'),
  createTextNode: (t) => ({ textContent: t })
};
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; }
};
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;
// util 单例来自 store.js 的 global.util（AMT_SCALE / amt / yuan / money 的唯一来源）
const U = global.util || {};
S.persist = function () { };
S.addLog = function () { };
globalThis.__TY_EXPORT__ = { store: S, util: U, ACCOUNT_CLASSES: global.ACCOUNT_CLASSES };

let CUR_M = '2024-06';
globalThis.__TY_HELPERS__ = {
  $: getEl, money: U.money, esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  num: U.num, round2: U.round2, amt: U.amt, yuan: U.yuan, AMT_SCALE: U.AMT_SCALE,
  currentPeriod: () => CUR_M, lastClosedPeriod: () => CUR_M,
  periodRangeValue: () => CUR_M, periodRangeValues: () => ({ start: CUR_M, end: CUR_M }),
  formatPeriod: m => String(m == null ? '' : m), todayStr: () => '2024-06-15', nowTimeStr: () => '00:00:00',
  syncAll() { }, openModal() { }, closeModal() { }, showToast() { },
  bookScopeChanged: () => false, bookKey: () => 'DOM', S: S, U: U, monthList: U.monthList
};
// 页面模块 import 的组件 / _shared 符号在此打桩（与本次单位域校验无关，只让模块能装载）
globalThis.__XP_IMPORTS__ = Object.assign({}, globalThis.__TY_HELPERS__, {
  bindSubjectPicker: () => ({ refresh() { } }),
  createSubjectTree: () => ({ refresh() { }, setCurrent() { } }),
  updatePeriodRangeTrigger() { },
  matchSubjectCode: () => null,
  subjectFullName: c => String(c == null ? '' : c),
  goPage() { }, subjectLevel: () => 1, subjectFilter: fn => (S.subjects() || []).filter(fn)
});
/* 页面引导块已收口到 js/common/helpers.js：把它喂进 __XP_IMPORTS__（页面里的 import 会被
   stripEsm 改写成 `var H = __XP_IMPORTS__['H']`）—— 否则 H 为 undefined，页面顶层即抛错。 */
require('./harness_boot.js').installBootImports(globalThis, path.join(__dirname, '..'));

function stripEsm(src) {
  return src
    .replace(/\bimport\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*['"];?/g, function (_m, names) {
      return names.split(',').map(n => n.trim()).filter(Boolean)
        .map(n => 'var ' + n + ' = (globalThis.__XP_IMPORTS__ || {})[' + JSON.stringify(n) + '];').join('\n');
    })
    .replace(/\bimport\s+[^;]*?from\s*['"][^'"]*['"];?/g, '/* import removed */')
    .replace(/\bexport\s*\{[\s\S]*?\};?/g, '/* export removed */')
    .replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1');
}
function loadPage(rel, hookSrc, tag) {
  let src = inject(stripEsm(fs.readFileSync(path.join(ROOT, rel), 'utf8')), tag);
  src += '\n;' + hookSrc;
  (0, eval)(src);
  return globalThis.__PAGE_HOOK__;
}

/* ---------- 自检注入（--selftest）：把原始缺陷形态种回源码，要求断言报红 ---------- */
const SELFTEST = process.argv.indexOf('--selftest') >= 0;
// 【别删】每条靶点对应一次真实发生过的单位域错用；实现重构会让靶点失配 —— 那本身就是有价值的信号。
const INJECTS = [
  { tag: 'voucher', desc: 'P1 借贷差额把「元」直接喂给 money()',
    from: 'money(U.amt(Math.abs(drT - crT)))', to: 'money(Math.abs(drT - crT))' },
  { tag: 'voucher', desc: 'P5 「未做修改」比对「整数 vs 元」恒不等',
    from: 'if (num(a[i].dr) !== U.amt(num(b[i].dr))) return false;',
    to: 'if (Math.abs(num(a[i].dr) - num(b[i].dr)) > 0.005) return false;' },
  { tag: 'voucher', desc: 'P5 「未做修改」比对「整数 vs 元」恒不等（贷方）',
    from: 'if (num(a[i].cr) !== U.amt(num(b[i].cr))) return false;',
    to: 'if (Math.abs(num(a[i].cr) - num(b[i].cr)) > 0.005) return false;' },
  { tag: 'settle', desc: 'P2 模板「元」− 已结转「整数」',
    from: 'totalDr += U.amt(U.num(r.dr));', to: 'totalDr += U.num(r.dr);' },
  { tag: 'app', desc: 'P4 按金额搜索在整数域恒假',
    from: 'var kwInt = isNaN(numKw) ? null : U.amt(numKw);', to: 'var kwInt = null;' },
  { tag: 'asset', desc: 'P13 资产卡「预计残值」把「元」直接喂给 money()',
    from: 'money(U.amt(o * sr / 100))', to: 'money(o * sr / 100)' }
];
function inject(src, tag) {
  if (!SELFTEST || !tag) return src;
  INJECTS.filter(x => x.tag === tag).forEach(inj => {
    if (src.indexOf(inj.from) < 0) {
      console.log('❌ 自检失败：注入靶点未命中（源码已变动，请更新自检靶点）→ ' + inj.desc);
      process.exit(1);
    }
    src = src.split(inj.from).join(inj.to);
  });
  return src;
}
// 装一本可用账套（含科目与一张凭证），让取数路径不空跑
function installBook(vouchers) {
  S.state = {
    schemaVersion: S.SCHEMA_VERSION,
    company: { name: '单位域测试', startMonth: '2024-01' },
    subjects: [
      { code: '1001', name: '库存现金', normal: 'dr', cls: 'asset', level: 1 },
      { code: '1002', name: '银行存款', normal: 'dr', cls: 'asset', level: 1 },
      { code: '6602', name: '管理费用', normal: 'dr', cls: 'expense', level: 1 }
    ],
    openingBalances: {}, param: {}, closedPeriods: [], fixedAssets: [],
    vouchers: vouchers || []
  };
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  S.bookId = '__DOM__';
}

/* ============================================================
 * A + B、凭证页（js/pages/voucher/Voucher.js）
 * ============================================================ */
const V = loadPage('js/pages/voucher/Voucher.js', `
globalThis.__PAGE_HOOK__ = {
  updateAmtTotals: updateAmtTotals,
  voucherUnchanged: voucherUnchanged,
  setRows: function (r) { vRows = r; }
};`, 'voucher');
check(!!V, 'Voucher.js 应能加载并暴露调试钩子');

/* —— A（P1）：借贷不平衡差额提示 ——
   分录行是「元」，差额必须换算到整数域再交给 money()。
   原实现 money(Math.abs(drT - crT)) 把「元」当整数喂进去 → 1000 元显示成 0.10。 */
(function caseA() {
  installBook();
  V.setRows([
    { code: '1001', name: '库存现金', summary: '', dr: 1000, cr: 0, cashActivity: '' },
    { code: '1002', name: '银行存款', summary: '', dr: 0, cr: 0, cashActivity: '' }
  ]);
  V.updateAmtTotals();
  const tip = String(getEl('vBalanceTip').textContent || '');
  check(tip === '借贷不平衡！差 1,000.00', 'P1 借贷差额提示应为「差 1,000.00」（元）', tip);

  // 平衡时应显示「借贷平衡」
  V.setRows([
    { code: '1001', name: '库存现金', summary: '', dr: 1000, cr: 0, cashActivity: '' },
    { code: '1002', name: '银行存款', summary: '', dr: 0, cr: 1000, cashActivity: '' }
  ]);
  V.updateAmtTotals();
  check(getEl('vBalanceTip').textContent === '借贷平衡', 'P1 借贷相等时应提示「借贷平衡」',
    String(getEl('vBalanceTip').textContent));
})();

/* —— B（P5）：「未做修改直接跳过」比对 ——
   cur 是数据库中已存的凭证（定点整数），v 是 buildVoucher() 的产物（元）。
   原实现 Math.abs(整数 − 元) > 0.005 恒真 → 永远判为「有改动」→ 跳过逻辑永不生效。 */
(function caseB() {
  const cur = { word: '记', no: 1, date: '2024-02-10', attach: 0,
    entries: [{ code: '1001', summary: 's', dr: U.amt(1000), cr: 0, cashActivity: '' }], attachments: [] };
  const v = { word: '记', no: '1', date: '2024-02-10', attach: 0,
    entries: [{ code: '1001', summary: 's', dr: 1000, cr: 0, cashActivity: '' }], attachments: [] };
  check(V.voucherUnchanged(cur, v) === true, 'P5 内容一致（整数 vs 元）应判定为「未做修改」',
    String(V.voucherUnchanged(cur, v)));
  const v2 = JSON.parse(JSON.stringify(v));
  v2.entries[0].dr = 1001;      // 金额差 1 元
  check(V.voucherUnchanged(cur, v2) === false, 'P5 金额被改动应判定为「有修改」',
    String(V.voucherUnchanged(cur, v2)));
})();

/* ============================================================
 * C、期末处理页（js/pages/settle/Settle.js）
 * ============================================================ */
/* —— C（P2）：自定义模板「未结转」额 ——
   模板分录是「元」（界面预置域），已结转（已生成凭证）是「定点整数」。
   原实现 totalDr − carried 是「元 − 整数」→ 未结转额恒显示 0.00。
   本用例里 store 的 periodVouchersOfKind 被替换为固定返回值 —— 本用例校验的是**页面侧**
   的单位域换算，store 取值层已由 verify_amount_shadow.js 覆盖。 */
(function caseC() {
  const RT = loadPage('js/pages/settle/Settle.js', `
globalThis.__PAGE_HOOK__ = {
  renderCustomCards: renderCustomCards,
  setTmpl: function (l) { settleTmplList = l; },
  setMonth: function (m) { selMonth = m; }
};`, 'settle');
  check(!!RT, 'Settle.js 应能加载并暴露调试钩子');
  if (!RT) return;

  S.periodVouchersOfKind = function () {
    return [{ id: 'c1', word: '记', no: 9, entries: [{ dr: U.amt(2000), cr: 0 }] }];  // 已结转 2,000 元
  };
  RT.setMonth(CUR_M);
  RT.setTmpl([{ id: 't1', custom: true, enabled: true, preset: false, name: '摊销A', summary: '',
    template: [{ code: '6602', dr: 5000, cr: 0 }] }]);                               // 应结转 5,000 元

  const kids = [];
  const procList = {
    querySelectorAll: () => [], firstElementChild: null,
    appendChild: (c) => { kids.push(c); }, insertBefore: (c) => { kids.push(c); }
  };
  RT.renderCustomCards(procList, null);
  const html = kids.map(c => String(c.innerHTML || '')).join('\n');
  check(html.indexOf('已结转：</span><span class="val">2,000.00') >= 0, 'P2 已结转额应显示 2,000.00', html.slice(0, 200));
  check(html.indexOf('未结转：</span><span class="val">3,000.00') >= 0,
    'P2 未结转额应为 5,000 − 2,000 = 3,000.00（原实现因「元 − 整数」恒显示 0.00）', html.slice(0, 200));
})();

/* ============================================================
 * D、全局搜索（js/app.js 的 runSearch）
 * ============================================================ */
/* —— D（P4）：按金额搜索凭证 ——
   分录金额是「定点整数」，用户输入的关键字是「元」→ 必须先换算到整数域再比。
   原判据 |整数 − 元| < 0.005 恒为假 → 按金额搜索永远搜不到任何凭证。
   app.js 是单文件 IIFE，整体装载成本高；这里沿用 verify_book_scope_reset.js 的做法：
   抽出 runSearch 的**真实源码**，在受控作用域里注入其自由变量（S / U / CLS_NAME / renderSearch）。 */
(function caseD() {
  const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  function extractFn(name) {
    const i = appSrc.indexOf('function ' + name + '(');
    if (i < 0) return null;
    let d = 0;
    for (let k = appSrc.indexOf('{', i); k < appSrc.length; k++) {
      if (appSrc[k] === '{') d++;
      else if (appSrc[k] === '}') { d--; if (d === 0) return appSrc.slice(i, k + 1); }
    }
    return null;
  }
  const src = inject(extractFn('runSearch'), 'app');
  check(!!src, 'app.js 里应存在 runSearch()');
  if (!src) return;

  installBook([{ id: 'v1', date: '2024-02-10', word: '记', no: 1, deleted: '', kind: '',
    summary: '采购办公用品',
    entries: [
      { code: '6602', dr: U.amt(1000), cr: 0, summary: '采购办公用品' },
      { code: '1002', dr: 0, cr: U.amt(1000), summary: '付办公用品款' }
    ] }]);

  let captured = null;
  const runSearch = new Function('S', 'U', 'CLS_NAME', 'renderSearch',
    src + '\n;return runSearch;')(S, U, { asset: '资产', expense: '费用' },
      function (_kw, res) { captured = res; });
  check(typeof runSearch === 'function', 'runSearch 应能被装载进受控作用域');

  runSearch('1000');   // 用户按「元」输入
  check(!!captured && captured.voucher.length === 1, 'P4 按金额 1000 应搜到 1 张凭证',
    captured ? ('命中 ' + captured.voucher.length + ' 张') : 'captured=null');
  check(!!captured && captured.voucher[0] && captured.voucher[0].amount === U.amt(1000),
    'P4 命中金额应为定点整数 ' + U.amt(1000), captured && captured.voucher[0] ? String(captured.voucher[0].amount) : '');

  captured = null;
  runSearch('1234');   // 账上无此金额
  check(!!captured && captured.voucher.length === 0, 'P4 按不存在的金额 1234 应搜不到凭证',
    captured ? ('命中 ' + captured.voucher.length + ' 张') : 'captured=null');
})();

/* ============================================================
 * E、资产页（js/pages/asset/Asset.js）
 * ============================================================ */
const A = loadPage('js/pages/asset/Asset.js', `
globalThis.__PAGE_HOOK__ = { updateHints: _updateHints };
`, 'asset');
check(!!A, 'Asset.js 应能加载并暴露调试钩子');

/* —— E（P13）：资产卡「预计残值」提示 ——
   输入框是「元」（回填走 U.yuan，见该文件回填处），残值 = 原值 × 残值率% 也是「元」，
   必须先换算成内部定点整数才能交给 money()。
   原实现 `money(o * sr / 100)` 把元当整数 → 「预计残值 250.00」显示成「0.03」；
   而且元值常是整数，**不触发** money() 的非整数告警 —— 又是一处静默错。
   （2026-09-30 复核「调用点切换」时发现；P1–P8 之外的第 9 处。） */
(function caseE() {
  installBook();
  getEl('aOriginal').value = '5000';      // 元
  getEl('aSalvageRate').value = '5';      // 5%
  A.updateHints();
  check(getEl('aSalvageHint').textContent === '预计残值 250.00',
    'P13 资产卡「预计残值」应为「250.00」（元）', String(getEl('aSalvageHint').textContent));
})();

/* ---------- 汇总 ---------- */
if (SELFTEST) {
  // 自检：注入缺陷后必须报红，否则说明靶点失效或断言不覆盖 —— 那才是真正的问题
  if (fail > 0) {
    console.log('✓ 自检通过：注入 P1/P2/P4/P5/P13 原始缺陷后，本脚本报出 ' + fail + ' 项不符（断言确实拦得住）');
    process.exit(0);
  }
  console.log('❌ 自检失败：注入缺陷后断言仍全绿 —— 靶点失效或断言未覆盖该缺陷');
  process.exit(1);
}
if (fail === 0) {
  console.log('✓ ' + pass + ' 项断言全部通过 —— 页面侧金额单位域（元 / 定点整数）无错用');
  process.exit(0);
}
console.log('★ ' + fail + ' 项不符（通过 ' + pass + '）：');
fails.forEach(function (f) { console.log('  · ' + f); });
process.exit(1);