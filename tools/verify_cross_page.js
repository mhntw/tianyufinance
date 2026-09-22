#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_cross_page.js —— 【显示层】跨页 / 屏幕↔导出 一致性
 *
 * 【为什么需要】
 *   本项目的取数层（store.generalLedger）已被 verify_vs_ais.js 证明与金蝶 GLBal
 *   逐科目、逐期、逐字段 100% 一致。但缺陷仍能出现在用户眼前 —— 因为**显示层**
 *   长期无人校验：同一个余额在总账 / 明细账 / 多栏账 / 科目余额表里被各自换算，
 *   屏幕与 Excel 导出又各写一份。2026-09 实际发生过：
 *     · 总账用「实际方向+正数」→「贷 2,000.12」，明细账用「科目正常方向+符号」
 *       →「借 -2,000.12」，同一笔余额两页反号；
 *     · 明细账导出与它自己的屏幕反号；总账导出漏了期初余额列；
 *     · 科目余额表「隐藏零行」判据漏了本年累计，把 5801 所得税费用（本年 527.93）藏掉。
 *   以上全部「取数正确、显示错误」—— 42 个既有脚本一个都抓不到。
 *
 * 【本脚本的判据：一个余额只允许有一个答案】
 *   把页面**实际渲染出来的文本**读回来，断言：
 *     A. 屏幕上的一行，与导出的同一行，逐格一致（含"某行在一侧缺失"）；
 *     B. 从显示值「反推」出的余额净额，必须等于取数层的 endDr - endCr；
 *        · 总账/明细账：净额 = 方向列为「借」? +金额 : -金额（方向列=科目正常方向）
 *        · 科目余额表：净额 = 期末借方列 - 期末贷方列
 *     C. 同一科目同一期末，各页反推出的净额必须彼此相等。
 *   B/C 合起来即「零心算可读」的机械化定义：读者不需要知道任何隐含约定，
 *   就能从任一张表读出同一个余额。
 *
 * 【实现方式】不复制口径，而是**真实加载页面模块源码**（Ledger.js / TrialBalance.js），
 *   在极简 DOM mock 下驱动 renderGl / exportGl / renderTb / exportTb，
 *   读回真实渲染结果。口径一旦分叉，这里立刻报错 —— 不依赖任何人对口径的理解。
 *
 * 用法：node tools/verify_cross_page.js [账套.json]
 * 退出码：0 = 通过；1 = 存在不一致；无账套样本时跳过（exit 0，CI 友好）
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ---------- 0. 定位真实账套（只挑「有凭证」的，空账套只会产出噪声） ---------- */
function booksDirPath() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', '添钰财务', 'books');
  return path.join(h, '.local', 'share', '添钰财务', 'books');
}
function pickBooks(explicit) {
  const dir = booksDirPath();
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.indexOf('.bak') < 0).sort(); }
  catch (e) { return { error: '跳过：读不到账套目录 ' + dir }; }
  const out = [];
  names.forEach(function (f) {
    const p = path.join(dir, f);
    let o = null;
    try { o = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return; }
    out.push({ p: p, file: f, obj: o, vouchers: (o.vouchers || []).length, subjects: (o.subjects || []).length });
  });
  if (explicit) {
    const one = out.filter(b => path.resolve(b.p) === path.resolve(explicit))[0];
    if (!one) return { error: '跳过：指定的账套不存在 → ' + explicit };
    return { books: [one] };
  }
  const usable = out.filter(b => b.vouchers > 0 && b.subjects > 10);
  if (!usable.length) return { error: '跳过：找不到含凭证的账套（' + dir + '）' };
  return { books: usable };
}

/* ---------- 1. 极简 DOM mock（够 renderGl / renderTb 用） ---------- */
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '', value: '', checked: false,
    disabled: false, title: '', href: '', textContent: '', style: {}, dataset: {},
    children: [], childNodes: [], parentNode: null, _html: '',
    offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0, offsetLeft: 0,
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    // ⚠ 关键：子元素要按 **标签名包裹** 后拼进父容器 html。
    //   浏览器的 table/tbody.innerHTML 里，<tr> 元素的内容是带 <tr> 标签出现的；
    //   若只拼子元素的 innerHTML（丢掉外层标签），再从容器 innerHTML 解析行就会一无所获。
    //   本脚本第一版正是栽在这里：屏幕侧解析结果为空 → 报出数千条"屏幕缺失"假警报。
    //   （教训与 verify_vs_ais 的"配错账套"同源：检查工具自身的缺陷 = 满屏假警报 = 网废掉。）
    appendChild(c) {
      this.children.push(c); this.childNodes.push(c);
      if (c) {
        c.parentNode = this;
        if (typeof c.innerHTML === 'string') {
          const t = String(c.tagName || '').toLowerCase();
          this._html += t ? ('<' + t + '>' + c.innerHTML + '</' + t + '>') : c.innerHTML;
        }
      }
      return c;
    },
    append() { for (let i = 0; i < arguments.length; i++) this.appendChild(arguments[i]); },
    insertBefore(c) {
      this.children.unshift(c);
      if (c && typeof c.innerHTML === 'string') {
        const t = String(c.tagName || '').toLowerCase();
        this._html = (t ? ('<' + t + '>' + c.innerHTML + '</' + t + '>') : c.innerHTML) + this._html;
      }
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove() { }, setAttribute() { }, removeAttribute() { }, getAttribute() { return null; },
    getAttributeNames() { return []; },
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; },
    focus() { }, blur() { }, click() { if (typeof this.onclick === 'function') this.onclick(); }, scrollIntoView() { },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v == null ? '' : v);
      if (el._html === '') { el.children.length = 0; el.childNodes.length = 0; }
    },
    configurable: true
  });
  return el;
}
const EL = {};
function getEl(id) {
  if (!EL[id]) {
    const e = mkEl('div');
    e.id = id;
    // 默认态：不隐藏零行（与账套 param 对齐在装载时再设）；期间输入框给空串
    EL[id] = e;
  }
  return EL[id];
}
global.document = {
  getElementById: getEl,
  createElement: function (t) { return mkEl(t); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  addEventListener: function () { }, removeEventListener: function () { },
  body: mkEl('body'), head: mkEl('head'), documentElement: mkEl('html'),
  createTextNode: function (t) { return { textContent: t }; }
};
global.window = global;

/* ---------- 2. 通用 helper（纯格式化函数，实现与 app.js 同语义） ---------- */
const num = function (v) { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const round2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
const money = function (v) {
  const n = Number(v) || 0;
  return (n < 0 ? '-' : '') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
const esc = function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};
let CUR_MONTH = '';
const U = { num: num, money: money, round2: round2, esc: esc };
const TOASTS = [];
const H = {
  $: getEl, money: money, esc: esc, escHtml: esc, num: num, round2: round2,
  absFmt: function (v) { return money(Math.abs(Number(v) || 0)); },
  signed: function (v) { return money(v); }, moneyRed: function (v) { return money(v); },
  currentPeriod: function () { return CUR_MONTH; },
  lastClosedPeriod: function () { return ''; },
  periodRangeValue: function () { return CUR_MONTH; },
  periodRangeValues: function () { return { start: CUR_MONTH, end: CUR_MONTH }; },
  formatPeriod: function (m) { return String(m || ''); },
  todayStr: function () { return '2026-09-22'; }, nowTimeStr: function () { return '00:00:00'; },
  bookKey: function () { return 'V'; },
  showToast: function (msg, kind) { TOASTS.push({ msg: msg, kind: kind }); },
  openModal: function () { }, closeModal: function () { },
  rptHeadPartsHtml: function () { return ''; }
};
globalThis.__TY_HELPERS__ = H;

/* ---------- 3. 加载真实 store ---------- */
const mem = {};
global.localStorage = {
  getItem: function (k) { return (k in mem) ? mem[k] : null; },
  setItem: function (k, v) { mem[k] = String(v); },
  removeItem: function (k) { delete mem[k]; }
};
global.__TAURI__ = {};
if (typeof global.isTauri === 'undefined') global.isTauri = false;
try { global.navigator = { userAgent: 'node' }; } catch (e) { }
global.fetch = function () { return Promise.reject(new Error('no network')); };
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;
S.persist = function () { };
S.addLog = function () { };
S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); };
globalThis.__TY_EXPORT__ = { store: S, util: U };

/* ---------- 4. 加载账簿页面模块源码（真实口径，不复制） ---------- */
// 页面模块是 ESM。为在 Node 里**真实执行**其口径代码，只改写 import/export 语法：
//   import → 从注入表取（依赖都是 UI 组件，与本次校验的口径无关）
//   export → 去掉（函数在间接 eval 的全局作用域里可直接引用）
// 关键：只动语法、不动任何口径逻辑 —— 否则就不再是"检查真实代码"了。
function stripEsm(src) {
  return src
    .replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"];?[ \t]*$/gm, function (_m, names) {
      return names.split(',').map(function (n) { return n.trim(); }).filter(Boolean)
        .map(function (n) { return 'var ' + n + ' = (globalThis.__XP_IMPORTS__ || {})[' + JSON.stringify(n) + '];'; })
        .join('\n');
    })
    .replace(/^\s*export\s*\{[\s\S]*?\};?[ \t]*$/gm, '/* export block removed */')
    .replace(/^\s*export\s+function/gm, 'function')
    .replace(/^\s*export\s+(const|let|var|default)/gm, '$1');
}
globalThis.__XP_IMPORTS__ = {
  bindSubjectPicker: function () { return { refresh: function () { } }; },
  createSubjectTree: function () { return { render: function () { }, refresh: function () { }, setCurrent: function () { } }; },
  updatePeriodRangeTrigger: function () { }
};

// 【自检注入】--selftest 模式下，故意把两类**真实发生过的**显示层缺陷种回源码，
// 要求本脚本必须把它们报出来（见文件末尾 runSelftest）。
const SELFTEST = process.argv.indexOf('--selftest') >= 0;
// 每条注入声明它作用于哪个源文件（'ledger' | 'report'），由 inject() 分发。
// ⚠ 靶点会随实现重构而失效 —— 这本身就是有价值的信号：自检会明确报「靶点未命中」，
//    强制维护者同步更新靶点，而不是让网悄悄失效（2026-09-22 口径收口到
//    store.displayBalance 后，总账那条靶点即按新形态更新过一次）。
const INJECTS = [
  { src: 'ledger', desc: '总账余额符号口径（模拟 1012 在总账被反号）',
    from: 'var endDir = _end.dir, endSigned = _end.amount;',
    to: 'var endDir = _end.dir, endSigned = Math.abs(_end.amount);' },
  { src: 'ledger', desc: '总账隐藏零行判据（模拟 5801 所得税费用被误藏）',
    from: 'if (hideZero && !glFilterCodes && S.isZeroLedgerRow(r)) return;',
    to: 'if (hideZero && !glFilterCodes && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0) return;' },
  { src: 'ledger', desc: '明细账导出与屏幕反号（模拟导出侧漏改口径）',
    from: 'var obView = S.displayBalance(num(d.obDr) - num(d.obCr), s.normal);',
    to: 'var obView = S.displayBalance(-(num(d.obDr) - num(d.obCr)), s.normal);' },
  { src: 'report', desc: '报表屏幕/导出不同源（模拟导出漏收集一组数据）',
    from: 'const aRows = collect(G.assetCurrent).concat(collect(G.assetNonCurrent));',
    to: 'const aRows = collect(G.assetCurrent);' },
  { src: 'tb', desc: '科目余额表隐藏零行判据（模拟 5801 在余额表被误藏）',
    from: 'if (hideZero && S.isZeroLedgerRow(r)) return;',
    to: 'if (hideZero && r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 && r.balance === 0) return;' }
];
function inject(src, tag) {
  if (!SELFTEST) return src;
  INJECTS.filter(function (x) { return x.src === tag; }).forEach(function (inj) {
    if (src.indexOf(inj.from) < 0) {
      console.log('❌ 自检失败：注入靶点未命中（源码已变动，请更新自检靶点）→ ' + inj.desc);
      process.exit(1);
    }
    src = src.split(inj.from).join(inj.to);
  });
  return src;
}
let LEDGER_SRC = inject(stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'pages', 'ledger', 'Ledger.js'), 'utf8')), 'ledger');
(0, eval)(LEDGER_SRC + '\n;globalThis.__LEDGER_API__ = function(){' +
  'return { renderGl: renderGl, exportGl: exportGl, renderDl: renderDl, exportDl: exportDl,' +
  ' renderMl: renderMl, dlSubjectCodes: dlSubjectCodes,' +
  ' get dlCurCode(){return dlCurCode;}, set dlCurCode(v){dlCurCode=v;},' +
  ' get glFilterCodes(){return glFilterCodes;}, set glFilterCodes(v){glFilterCodes=v;},' +
  ' refreshGl: refreshGl };};');
const L = globalThis.__LEDGER_API__();

const TB_SRC = inject(stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'pages', 'ledger', 'TrialBalance.js'), 'utf8')), 'tb');
(0, eval)(TB_SRC + '\n;globalThis.__TB_API__ = function(){' +
  'return { renderTb: renderTb, exportTb: exportTb, buildAllExpanded: buildAllExpanded,' +
  ' get tbExpanded(){return tbExpanded;}, set tbExpanded(v){tbExpanded=v;} };};');
const TB = globalThis.__TB_API__();

// 报表页（资产负债 / 利润 / 现金流量 / 应交税金）—— 4 对 render/export 同源双实现，
// 与账簿页一样属于「同一口径写两遍」的结构性风险，必须一并进网。
const RPT_SRC = inject(stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'pages', 'report', 'Report.js'), 'utf8')), 'report');
(0, eval)(RPT_SRC + '\n;globalThis.__RPT_API__ = function(){' +
  'return { renderBs: renderBs, renderPl: renderPl, renderCf: renderCf, renderTx: renderTx,' +
  ' exportBs: exportBs, exportPl: exportPl, exportCf: exportCf, exportTx: exportTx };};');
const RPT = globalThis.__RPT_API__();

/* ---------- 5. 导出捕获（mock XLSX + safeExport） ---------- */
let CAP = null;
globalThis.XLSX = {
  utils: {
    book_new: function () { return { SheetNames: [], Sheets: {} }; },
    aoa_to_sheet: function (rows) { return { __rows: rows }; },
    book_append_sheet: function (wb, ws, name) { wb.__last = { ws: ws, name: name }; }
  }
};
globalThis.__safeExportExcel = function (wb, fname) {
  CAP = { rows: (wb.__last && wb.__last.ws && wb.__last.ws.__rows) || [], name: fname };
};

/* ---------- 6. 解析渲染结果 ---------- */
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
// 从容器 innerHTML 解析出「行 → 单元格文本数组」
function rowsOf(containerId) {
  const html = String(getEl(containerId).innerHTML || '');
  const out = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = tdRe.exec(m[1]))) cells.push(decode(String(c[1]).replace(/<[^>]*>/g, '')).trim());
    if (cells.length) out.push(cells);
  }
  return out;
}
const amt = function (s) { const t = String(s == null ? '' : s).replace(/,/g, '').trim(); return t === '' ? 0 : num(t); };
const eqAmt = function (a, b) { return Math.abs(a - b) < 0.005; };

/* ---------- 7. 逐账套逐期检查 ---------- */
let FAIL = 0, CHECKED = 0;
// 覆盖率计数：证明各张表**确实被驱动过** —— 全绿只有在"确实跑了"的前提下才算数
// （verify_vs_ais 曾长期输出绿色，实则是在拿金蝶数据比空账套，故这里把覆盖显式打出来）
const COV = { gl: 0, tb: 0, dl: 0, ml: 0, rpt: 0, perUsed: 0, perTotal: 0 };
const DETAIL = [];
function fail(msg) { FAIL++; if (DETAIL.length < 24) DETAIL.push(msg); }

function checkBook(bk) {
  console.log('');
  console.log('===== 账套：' + (bk.obj.company && bk.obj.company.name || bk.file) + '（' + bk.file + '）=====');
  S.state = JSON.parse(JSON.stringify(bk.obj));
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  S.bookId = '__XP__';
  S.state.param = S.state.param || {};
  S.state.param.bookHideZero = false;         // 与下面 checkbox 保持一致

  const months = (S.allMonths ? S.allMonths() : []) || [];
  // 期间采样：**必须覆盖每个年度**，而不是原来的"最近 3 期"。
  // 【为什么】账套是多年合并导入（添钰来客 2025-03 起 18 个月、绅蓝之星 2024-04 起 29 个月），
  //   只取最后 3 期 → 历年的「年初余额 / 年结 / 本年累计衔接」整段落在显示层检查之外。
  //   采样规则：首期 + 末期 + 每年首期 + 每年末月 —— 跨年边界正是最易出错、最该检查的位置。
  //   加 --all-periods 可逐期全跑（耗时随期间数线性增长）。
  const use = (function () {
    if (process.argv.indexOf('--all-periods') >= 0) return months.slice();
    const want = {};
    if (months.length) { want[months[0]] = 1; want[months[months.length - 1]] = 1; }
    const years = {};
    months.forEach(function (m) { years[String(m).slice(0, 4)] = 1; });
    Object.keys(years).forEach(function (y) {
      const ofYear = months.filter(function (m) { return String(m).slice(0, 4) === y; });
      if (ofYear.length) { want[ofYear[0]] = 1; want[ofYear[ofYear.length - 1]] = 1; }
    });
    return Object.keys(want).sort();
  })();
  if (!use.length) { console.log('  无期间，跳过'); return; }
  COV.perUsed += use.length; COV.perTotal += months.length;
  // 采样范围必须显式打出来 —— 否则又是一次"悄悄只测了一部分"（本脚本此前正是如此）
  console.log('  检查期间 ' + use.length + '/' + months.length + ' 期：' + use.join(', ')
    + (use.length < months.length ? '　（加 --all-periods 可逐期全跑）' : '　（全期间）'));

  use.forEach(function (m) {
    CUR_MONTH = m;
    COV.gl++; COV.tb++;          // 本期间将依次驱动 总账 / 科目余额表
    // 屏/导两侧的开关必须一致：展开全部（覆盖子科目）、不隐藏零行
    ['glHideZero', 'tbHideZero'].forEach(function (id) { getEl(id).checked = false; });
    ['glExpandAll', 'tbExpandAll'].forEach(function (id) { getEl(id).checked = true; });
    getEl('glPeriod').value = m; getEl('tbPeriod').value = m; getEl('tbPeriodEnd').value = m;

    /* --- A1. 总账：屏幕 vs 导出（逐行逐格 + 行集合） --- */
    const glBody = getEl('glBody'); glBody.innerHTML = '';
    L.glFilterCodes = null;
    try { L.renderGl(m); } catch (e) { fail('[' + m + '] renderGl 抛错：' + e.message); return; }
    CAP = null;
    try { L.exportGl(); } catch (e) { fail('[' + m + '] exportGl 抛错：' + e.message); return; }
    const glScr = rowsOf('glBody');
    const glExp = CAP ? CAP.rows.slice(1) : [];
    compareGl(m, glScr, glExp);

    /* --- A2. 科目余额表：屏幕 vs 导出 --- */
    const tbBody = getEl('tbBody'); tbBody.innerHTML = '';
    TB.tbExpanded = TB.buildAllExpanded();
    try { TB.renderTb(m); } catch (e) { fail('[' + m + '] renderTb 抛错：' + e.message); return; }
    CAP = null;
    try { TB.exportTb(); } catch (e) { fail('[' + m + '] exportTb 抛错：' + e.message); return; }
    const tbScr = rowsOf('tbBody');
    const tbExp = CAP ? CAP.rows.slice(1) : [];
    compareTb(m, tbScr, tbExp);

    /* --- A2b. 隐藏零行：勾选后只允许藏「真零行」（5801 类缺陷的唯一触发条件） --- */
    checkHideZero(m);

    /* --- B/C. 跨页「余额还原净额」必须唯一，且等于取数层 endDr-endCr --- */
    crossCheck(m, glScr, tbScr);

    /* --- A3. 明细账：屏幕 vs 导出（逐行逐格）+ 余额还原 --- */
    pickLedgerCodes(m, 6).forEach(function (code) {
      COV.dl++;
      L.dlCurCode = code;
      const dlBody = getEl('dlBody'); dlBody.innerHTML = '';
      try { L.renderDl({ start: m, end: m }); }
      catch (e) { fail('[' + m + '] renderDl(' + code + ') 抛错：' + e.message); return; }
      const scr = rowsOf('dlBody');
      CAP = null;
      try { L.exportDl(); }
      catch (e) { fail('[' + m + '] exportDl(' + code + ') 抛错：' + e.message); return; }
      const exp = CAP ? CAP.rows.slice(1) : [];
      compareDl(m, code, scr, exp);
      verifyDlNet(m, code, scr);
    });
    L.dlCurCode = null;

    /* --- A4. 多栏账：滚动余额与期末余额还原（无导出，只校验与取数层一致） --- */
    pickParentCodes(m, 3).forEach(function (code) {
      COV.ml++;
      const body = getEl('mlBody'); body.innerHTML = '';
      getEl('mlHead').innerHTML = '';
      try { L.renderMl(code, m, ''); }
      catch (e) { fail('[' + m + '] renderMl(' + code + ') 抛错：' + e.message); return; }
      verifyMlNet(m, code, rowsOf('mlBody'));
    });

    /* --- A5. 报表页：屏幕 vs 导出（逐行逐格） --- */
    driveReport(m, '资产负债表', 'bsBody', 'bsPeriodEnd', RPT.renderBs, RPT.exportBs);
    driveReport(m, '利润表', 'plBody', 'plPeriodEnd', RPT.renderPl, RPT.exportPl);
    driveReport(m, '现金流量表', 'cfBody', 'cfPeriodEnd', RPT.renderCf, RPT.exportCf);
    driveReport(m, '应交税金明细表', 'txBody', 'txPeriodEnd', RPT.renderTx, RPT.exportTx);
  });
}

/* ---------- 7b. 隐藏零行：勾选后只允许藏「真零行」 ----------
 * 【为什么必须单独跑这一遍】5801 所得税费用的缺陷**只在勾选「隐藏零行」时才暴露**
 *   （期初 0、本期 0、期末 0，只有本年累计 527.93）。而本脚本此前一律把开关关掉再比，
 *   等于把已知缺陷的触发条件排除在测试之外 —— 典型的"绿灯但没测到"（假绿）。
 * 不变量（对 总账 / 科目余额表 的【屏幕】与【导出】四处同时成立）：
 *   ① 关掉开关时四侧都必须渲染出**全部**科目（否则说明另有过滤在掉行，后续判断失去前提）；
 *   ② 打开后 on ⊆ off，且 off\on 里每个科目都必须满足 S.isZeroLedgerRow()（藏的都是真零行）；
 *   ③ 同一张表的屏幕与导出科目集合必须完全相同（否则就是"一侧藏、一侧不藏"的分叉）；
 *   ④ 「5801 类」（四项全 0、仅本年累计非 0）在打开开关后必须仍然在。
 */
const HZ = { passes: 0, hidden: 0, onlyYtd: 0 };
function codeSetOf(rows) {
  const set = {}; let cur = '';
  rows.forEach(function (cells) {
    // 总账续行只有 6 列，其第 0 列是**期间**（'2026-08'）—— 若当成科目编码，会把当前科目串覆盖成 '202608'。
    if (!cells || cells.length < 8) return;
    const c = cleanCode(cells[0]);
    if (c) cur = c;
    if (cur) set[cur] = 1;
  });
  return set;
}
function subjNameOf(c) {
  try { const s = S.subject(c); return (s && s.name) || ''; } catch (e) { return ''; }
}
function checkHideZero(m) {
  const glRows = S.generalLedger(m) || [];
  const isZero = {};
  glRows.forEach(function (r) { isZero[String(r.code)] = S.isZeroLedgerRow(r); });
  // 「5801 类」：期初/本期/期末全 0，只有本年累计非 0 —— 老判据的盲区
  const onlyYtd = glRows.filter(function (r) {
    return r.obDr === 0 && r.obCr === 0 && r.periodDr === 0 && r.periodCr === 0 &&
      r.balance === 0 && (r.ytdDr !== 0 || r.ytdCr !== 0);
  }).map(function (r) { return String(r.code); });

  function pass(hide) {
    // 三处开关必须同步：账套参数 + 两个页内复选框。否则就是在比"两种条件"，结论无意义。
    S.state.param.bookHideZero = hide;
    ['glHideZero', 'tbHideZero'].forEach(function (id) { getEl(id).checked = hide; });
    ['glExpandAll', 'tbExpandAll'].forEach(function (id) { getEl(id).checked = true; });

    getEl('glBody').innerHTML = '';
    L.glFilterCodes = null;
    L.renderGl(m);
    const glScr = codeSetOf(rowsOf('glBody'));
    CAP = null; L.exportGl();
    const glExp = codeSetOf(CAP ? CAP.rows.slice(1) : []);

    getEl('tbBody').innerHTML = '';
    TB.tbExpanded = TB.buildAllExpanded();
    TB.renderTb(m);
    const tbScr = codeSetOf(rowsOf('tbBody'));
    CAP = null; TB.exportTb();
    const tbExp = codeSetOf(CAP ? CAP.rows.slice(1) : []);
    return { glScr: glScr, glExp: glExp, tbScr: tbScr, tbExp: tbExp };
  }

  const off = pass(false), on = pass(true);
  HZ.passes++;
  HZ.onlyYtd += onlyYtd.length;

  // ① 关掉开关时四侧都必须是全量科目
  CHECKED++;
  [['glScr', '总账屏幕'], ['glExp', '总账导出'], ['tbScr', '科目余额表屏幕'], ['tbExp', '科目余额表导出']].forEach(function (p) {
    const miss = glRows.filter(function (r) { return !off[p[0]][String(r.code)]; }).map(function (r) { return String(r.code); });
    if (miss.length) fail('[' + m + '] ' + p[1] + '：未勾选隐藏零行时仍缺 ' + miss.length + ' 个科目（另有过滤在掉行，测试前提不成立）→ 如 ' + miss.slice(0, 4).join('/'));
  });

  // ③ 同表屏幕与导出必须同集合
  [['glScr', 'glExp', '总账'], ['tbScr', 'tbExp', '科目余额表']].forEach(function (p) {
    const a = on[p[0]], b = on[p[1]];
    CHECKED++;
    Object.keys(a).forEach(function (c) {
      if (!b[c]) fail('[' + m + '] 隐藏零行：' + p[2] + '「' + c + ' ' + subjNameOf(c) + '」屏幕有、导出无（两侧判据分叉）');
    });
    Object.keys(b).forEach(function (c) {
      if (!a[c]) fail('[' + m + '] 隐藏零行：' + p[2] + '「' + c + ' ' + subjNameOf(c) + '」导出有、屏幕无（两侧判据分叉）');
    });
  });

  // ② 只能减少行，且被藏掉的必须是真零行
  [['glScr', '总账屏幕'], ['glExp', '总账导出'], ['tbScr', '科目余额表屏幕'], ['tbExp', '科目余额表导出']].forEach(function (p) {
    const o = off[p[0]], n = on[p[0]];
    CHECKED++;
    Object.keys(n).forEach(function (c) {
      if (!o[c]) fail('[' + m + '] ' + p[1] + '：勾选隐藏零行后「' + c + ' ' + subjNameOf(c) + '」反而多出来了（隐藏逻辑异常）');
    });
    Object.keys(o).forEach(function (c) {
      if (n[c]) return;
      if (!isZero[c]) {
        fail('[' + m + '] ' + p[1] + '：勾选隐藏零行后「' + c + ' ' + subjNameOf(c) + '」被误藏，但它有发生额'
          + '（期初/本期/期末/本年累计非全 0）← 这正是 5801 所得税费用 那类缺陷');
      }
    });
  });
  HZ.hidden += Object.keys(off.glScr).length - Object.keys(on.glScr).length;

  // ④ 「5801 类」科目必须仍在
  onlyYtd.forEach(function (c) {
    if (!off.glScr[c]) return;               // 关掉开关时就没有 → 属 ① 的问题，此处不重复报
    if (!on.glScr[c]) fail('[' + m + '] 总账屏幕：只有本年累计发生额的科目「' + c + ' ' + subjNameOf(c) + '」被隐藏零行误藏（5801 类）');
    if (!on.tbScr[c]) fail('[' + m + '] 科目余额表屏幕：只有本年累计发生额的科目「' + c + ' ' + subjNameOf(c) + '」被隐藏零行误藏（5801 类）');
  });

  // 复位：后续检查一律按"不隐藏零行"进行（与本循环主体一致）
  S.state.param.bookHideZero = false;
  ['glHideZero', 'tbHideZero'].forEach(function (id) { getEl(id).checked = false; });
}

// 总账行视图：屏幕里科目编码/名称是 rowspan（首行 8 td，后两行仅 6 td），导出行恒 8 列。
// 但两边「期间 / 摘要 / 借 / 贷 / 方向 / 余额」都固定在**后 6 列**，故从右取 6 列即可对齐；
// 科目编码则用「遇到非空即更新」向下传递（rowspan 与空串两种写法都覆盖）。
// 科目编码常被树形展开三角（▸/▾）、缩进空白等装饰字符包裹 → 只取编码本体
function cleanCode(s) { return String(s == null ? '' : s).replace(/[^0-9A-Za-z]/g, ''); }

function glRowView(cells) {
  const n = cells.length;
  if (n < 6) return null;
  const t = cells.slice(n - 6);
  return {
    period: String(t[0] || '').trim(), seg: String(t[1] || '').trim(),
    dr: t[2], cr: t[3], dir: String(t[4] || '').trim(), bal: t[5],
    // 只有「含科目列的整行」（屏幕首行 / 导出的每一行）第 0 列才是科目编码。
    // 屏幕续行只有 6 列，其第 0 列是**期间** —— 若误当编码，就会把当前科目串覆盖掉，
    // 报出满屏「屏幕缺失」假警报（本脚本第二版即栽在此）。
    code: (n >= 8) ? cleanCode(cells[0]) : ''
  };
}
function indexGl(rows) {
  const out = {};
  let cur = '';
  rows.forEach(function (c) {
    const v = glRowView(c);
    if (!v) return;
    if (v.code) cur = v.code;
    if (cur) out[cur + '|' + v.seg] = v;
  });
  return out;
}
function compareGl(m, scr, exp) {
  // 键 = 科目编码 + 摘要；屏幕与导出必须同集合、同行、同格
  const sc = indexGl(scr), ex = indexGl(exp);
  const keys = {};
  Object.keys(sc).forEach(function (k) { keys[k] = 1; });
  Object.keys(ex).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).forEach(function (k) {
    CHECKED++;
    const a = sc[k], b = ex[k];
    const who = k.replace('|', ' ');
    if (!a) { fail('[' + m + '] 总账「' + who + '」导出行存在、屏幕缺失（同条件下一侧被隐藏）'); return; }
    if (!b) { fail('[' + m + '] 总账「' + who + '」屏幕有行、导出缺失（同条件下一侧被隐藏）'); return; }
    if (!eqAmt(amt(a.dr), amt(b.dr))) fail('[' + m + '] 总账 ' + who + ' 借方不一致：屏「' + a.dr + '」导「' + b.dr + '」');
    if (!eqAmt(amt(a.cr), amt(b.cr))) fail('[' + m + '] 总账 ' + who + ' 贷方不一致：屏「' + a.cr + '」导「' + b.cr + '」');
    if (a.dir !== b.dir) fail('[' + m + '] 总账 ' + who + ' 方向列不一致：屏「' + a.dir + '」导「' + b.dir + '」');
    if (!eqAmt(amt(a.bal), amt(b.bal))) fail('[' + m + '] 总账 ' + who + ' 余额不一致：屏「' + a.bal + '」导「' + b.bal + '」');
    if (a.period !== b.period) fail('[' + m + '] 总账 ' + who + ' 期间列不一致：屏「' + a.period + '」导「' + b.period + '」');
  });
}

function compareTb(m, scr, exp) {
  const norm = function (cells) { return { code: cleanCode(cells[0]), cells: cells }; };
  const sc = {}, ex = {};
  scr.forEach(function (c) { const r = norm(c); if (r.code) sc[r.code] = r; });
  exp.forEach(function (c) { const r = norm(c); if (r.code) ex[r.code] = r; });
  const keys = {};
  Object.keys(sc).forEach(function (k) { keys[k] = 1; });
  Object.keys(ex).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).forEach(function (k) {
    CHECKED++;
    const a = sc[k], b = ex[k];
    if (!a) { fail('[' + m + '] 余额表科目 ' + k + ' 导出行存在、屏幕缺失'); return; }
    if (!b) { fail('[' + m + '] 余额表科目 ' + k + ' 屏幕有行、导出缺失'); return; }
    for (let i = 2; i <= 9; i++) {
      if (!eqAmt(amt(a.cells[i]), amt(b.cells[i]))) {
        fail('[' + m + '] 余额表 ' + k + ' 第' + i + '列不一致：屏「' + a.cells[i] + '」导「' + b.cells[i] + '」');
      }
    }
  });
}

/* ---------- 报表页（表格式）的驱动与比对 ---------- */
// 报表与账簿不同：屏幕把标题/表头渲染在 <table> 之外（setRptHead 注入抬头块），
// 导出则把表头作为首行写进工作表。因此比对前需先剔除导出侧的"列名行"。
const RPT_HEAD_RE = /行次|期末余额|年初余额|本期金额|本年累计|项目|资产|负债和所有者权益|税额|税目/;
function driveReport(m, label, bodyId, endId, doRender, doExport) {
  COV.rpt++;
  getEl(bodyId).innerHTML = '';
  getEl(endId).value = m;
  try { doRender(m); } catch (e) { fail('[' + m + '] ' + label + ' 屏幕渲染抛错：' + e.message); return; }
  const scr = rowsOf(bodyId);
  CAP = null;
  try { doExport(); } catch (e) { fail('[' + m + '] ' + label + ' 导出抛错：' + e.message); return; }
  if (!CAP) { fail('[' + m + '] ' + label + ' 导出未产出内容（safeExport 未被调用）'); return; }
  compareReport(m, label, scr, CAP.rows);
}
function compareReport(m, label, scr, exp) {
  const nonEmpty = function (rows) {
    return rows.filter(function (c) { return c.some(function (t) { return String(t == null ? '' : t).trim() !== ''; }); });
  };
  const a = nonEmpty(scr);
  // 导出侧剔除表头行（含列名的行）——它们对应屏幕的表格外抬头块
  const b = nonEmpty(exp).filter(function (c) {
    const txt = c.join('|');
    if (RPT_HEAD_RE.test(txt) && c.filter(function (t) { return /^-?[\d,]+(\.\d+)?$/.test(String(t).trim()); }).length < 2) return false;
    return true;
  });
  CHECKED += Math.max(1, Math.min(a.length, b.length));   // 行级计数：避免"零行也算过"
  if (!a.length) {
    fail('[' + m + '] ' + label + ' 屏幕未渲染出任何数据行（驱动可能失败）—— 本项断言不可信');
  }
  if (a.length !== b.length) {
    fail('[' + m + '] ' + label + ' 行数不一致：屏幕 ' + a.length + ' 行 / 导出 ' + b.length + ' 行'
      + '（屏首行「' + (a[0] ? a[0].slice(0, 4).join('|') : '') + '」　导首行「' + (b[0] ? b[0].slice(0, 4).join('|') : '') + '」）');
  }
  const n = Math.min(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 3; i++) {
    const x = a[i], y = b[i], len = Math.max(x.length, y.length);
    for (let j = 0; j < len; j++) {
      const xt = String(x[j] == null ? '' : x[j]).trim(), yt = String(y[j] == null ? '' : y[j]).trim();
      if (xt === yt) continue;
      if (eqAmt(amt(xt), amt(yt)) && /^-?[\d,]+(\.\d+)?$/.test(xt) && /^-?[\d,]+(\.\d+)?$/.test(yt)) continue;
      shown++;
      fail('[' + m + '] ' + label + ' 第 ' + (i + 1) + ' 行第 ' + (j + 1) + ' 列不一致：屏「' + xt + '」导「' + yt + '」');
      break;
    }
  }
}

/* ---------- 明细账 / 多栏账 的驱动辅助 ---------- */
// 挑「本月有发生额」的科目做样本：均匀取样以覆盖不同代码段（资产/负债/损益）
function pickLedgerCodes(month, n) {
  const gl = S.generalLedger(month) || [];
  const hit = gl.filter(function (r) { return r.periodDr !== 0 || r.periodCr !== 0; })
    .map(function (r) { return String(r.code); });
  const out = [];
  const step = Math.max(1, Math.floor(hit.length / n));
  for (let i = 0; i < hit.length && out.length < n; i += step) out.push(hit[i]);
  return out;
}
// 挑「有下级 **且本月有发生额**」的科目 —— 多栏账必须是非明细科目才能分栏，
// 而本期无发生额的科目页面本就显示「暂无数据」（正确行为，不该当缺陷报）。
function pickParentCodes(month, n) {
  const subs = S.subjects() || [];
  const gl = S.generalLedger(month) || [];
  const hasAct = {};
  gl.forEach(function (r) { if (r.periodDr !== 0 || r.periodCr !== 0) hasAct[String(r.code)] = 1; });
  const out = [];
  subs.forEach(function (s) {
    const c = String(s.code);
    let isParent = false, childAct = false;
    subs.forEach(function (t) {
      const tc = String(t.code);
      if (tc === c || tc.length <= c.length || tc.indexOf(c) !== 0) return;
      isParent = true;
      if (hasAct[tc]) childAct = true;
    });
    if (isParent && (hasAct[c] || childAct)) out.push(c);
  });
  return out.slice(0, n);
}
// 从「方向列 + 余额列」反推「借正贷负」净额 —— 这就是**读者视角**：
// 不需要知道任何隐含约定，只看方向与金额两格，就能读出余额在哪一方、多少钱。
// 四种账簿（总账/明细账/多栏账/余额表）最终都必须通过这一关，否则就存在分叉。
function netFromDirBal(dir, bal) {
  const d = String(dir == null ? '' : dir).trim();
  if (!d || d === '平') return 0;
  return (d === '借') ? amt(bal) : -amt(bal);
}
// 明细账行视图：屏幕 7 列（日期/凭证字号/摘要/借/贷/方向/余额）；
// 导出 9 列（前两列是科目编码/名称）。屏幕另有「科目分组头行」（仅 1 个 td），需剔除。
function dlRowView(cells, exported) {
  const off = exported ? 2 : 0;
  if (cells.length < off + 7) return null;
  return {
    date: String(cells[off + 0] || '').trim(), seg: String(cells[off + 2] || '').trim(),
    dr: cells[off + 3], cr: cells[off + 4],
    dir: String(cells[off + 5] || '').trim(), bal: cells[off + 6]
  };
}
function indexDl(rows, exported) {
  const out = [];
  rows.forEach(function (c) { const v = dlRowView(c, exported); if (v) out.push(v); });
  return out;
}
function compareDl(m, code, scr, exp) {
  const a = indexDl(scr, false), b = indexDl(exp, true);
  CHECKED++;
  if (a.length !== b.length) {
    fail('[' + m + '] 明细账 ' + code + ' 行数不一致：屏幕 ' + a.length + ' 行 / 导出 ' + b.length + ' 行（同条件下一侧被隐藏或多出）');
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    const who = code + ' ' + x.date + ' ' + x.seg;
    if (x.seg !== y.seg) fail('[' + m + '] 明细账 ' + code + ' 第 ' + (i + 1) + ' 行行序错位：屏「' + x.seg + '」导「' + y.seg + '」');
    if (!eqAmt(amt(x.dr), amt(y.dr))) fail('[' + m + '] 明细账 ' + who + ' 借方不一致：屏「' + x.dr + '」导「' + y.dr + '」');
    if (!eqAmt(amt(x.cr), amt(y.cr))) fail('[' + m + '] 明细账 ' + who + ' 贷方不一致：屏「' + x.cr + '」导「' + y.cr + '」');
    if (x.dir !== y.dir) fail('[' + m + '] 明细账 ' + who + ' 方向列不一致：屏「' + x.dir + '」导「' + y.dir + '」');
    if (!eqAmt(amt(x.bal), amt(y.bal))) fail('[' + m + '] 明细账 ' + who + ' 余额不一致：屏「' + x.bal + '」导「' + y.bal + '」');
  }
}
// 明细账余额还原：期初余额行 → 期初净额；本期合计/本年累计 → 期末净额
function verifyDlNet(m, code, scr) {
  const r = (S.generalLedger(m) || []).filter(function (x) { return String(x.code) === code; })[0];
  if (!r) return;
  const rows = indexDl(scr, false);
  const chk = function (seg, truth, label) {
    const v = rows.filter(function (x) { return x.seg === seg; })[0];
    if (!v) { fail('[' + m + '] 明细账 ' + code + ' 缺少「' + seg + '」行'); return; }
    CHECKED++;
    const net = round2(netFromDirBal(v.dir, v.bal));
    if (!eqAmt(net, truth)) {
      fail('[' + m + '] ' + code + ' ' + r.name + ' 明细账' + label + '反推 ' + net.toFixed(2)
        + ' ≠ 取数层 ' + truth.toFixed(2) + '（行：方向「' + v.dir + '」余额「' + v.bal + '」）');
    }
  };
  chk('期初余额', round2(r.obDr - r.obCr), '期初余额');
  chk('本期合计', round2(r.endDr - r.endCr), '期末余额');
  chk('本年累计', round2(r.endDr - r.endCr), '期末余额');
}
// 多栏账余额还原：期初行 → 期初净额；本期合计/本年累计两行 → 期末净额
// （原实现曾把「本期发生额净额」当期末余额用，此断言正是为盯住这类错误）
function verifyMlNet(m, code, scr) {
  const r = (S.generalLedger(m) || []).filter(function (x) { return String(x.code) === code; })[0];
  if (!r) return;
  const rows = scr.filter(function (c) { return c.length >= 7; });
  // 本期无发生额 → 页面显示「暂无数据」，无可校验内容（这是正确行为，不是缺陷）
  if (!rows.length) return;
  const chk = function (seg, truth, label) {
    const c = rows.filter(function (x) { return String(x[2] || '').trim() === seg; })[0];
    if (!c) { fail('[' + m + '] 多栏账 ' + code + ' 缺少「' + seg + '」行'); return; }
    CHECKED++;
    const net = round2(netFromDirBal(c[5], c[6]));
    if (!eqAmt(net, truth)) {
      fail('[' + m + '] ' + code + ' ' + r.name + ' 多栏账' + label + '反推 ' + net.toFixed(2)
        + ' ≠ 取数层 ' + truth.toFixed(2) + '（行：方向「' + c[5] + '」余额「' + c[6] + '」）');
    }
  };
  chk('期初余额', round2(r.obDr - r.obCr), '期初余额');
  chk('本期合计', round2(r.endDr - r.endCr), '期末余额');
  chk('本年累计', round2(r.endDr - r.endCr), '期末余额');
}

// 反推净额：总账期望「方向列为借 → +金额，否则 -金额」（方向列承载科目正常方向）
function netFromGl(v) {
  if (!v) return 0;
  if (!v.dir || v.dir === '平') return 0;              // 余额为 0（或空）
  const bal = amt(v.bal);
  return v.dir === '借' ? bal : -bal;
}
// 反推净额：余额表期望「期末借方列 - 期末贷方列」
function netFromTb(cells) { return amt(cells[8]) - amt(cells[9]); }

function crossCheck(m, glScr, tbScr) {
  const glMap = {};   // code → 期末余额视图（取「本期合计」行）
  let cur = '';
  glScr.forEach(function (c) {
    const v = glRowView(c);
    if (!v) return;
    if (v.code) cur = v.code;
    if (cur && v.seg === '本期合计') glMap[cur] = v;
  });
  const tbMap = {};
  tbScr.forEach(function (c) { const code = cleanCode(c[0]); if (code) tbMap[code] = c; });

  const gl = S.generalLedger(m);
  const byCode = {};
  gl.forEach(function (r) { byCode[String(r.code)] = r; });

  Object.keys(glMap).forEach(function (code) {
    const r = byCode[code];
    if (!r) return;
    CHECKED++;
    const truth = round2(r.endDr - r.endCr);          // 取数层（已与金蝶 100% 一致）
    const g = round2(netFromGl(glMap[code]));
    if (!eqAmt(g, truth)) {
      fail('[' + m + '] ' + code + ' ' + r.name + ' 总账显示值反推 ' + g.toFixed(2)
        + ' ≠ 取数层期末 ' + truth.toFixed(2) + '（行：方向「' + glMap[code].dir + '」余额「' + glMap[code].bal + '」）');
    }
    const t = tbMap[code];
    if (t) {
      const tn = round2(netFromTb(t));
      if (!eqAmt(tn, truth)) {
        fail('[' + m + '] ' + code + ' ' + r.name + ' 余额表显示值反推 ' + tn.toFixed(2)
          + ' ≠ 取数层期末 ' + truth.toFixed(2) + '（行：期末借「' + t[8] + '」期末贷「' + t[9] + '」）');
      }
      if (!eqAmt(tn, g)) {
        fail('[' + m + '] ' + code + ' ' + r.name + ' 跨页不一致：总账反推 ' + g.toFixed(2)
          + ' vs 余额表反推 ' + tn.toFixed(2));
      }
    }
  });
}

/* ---------- 8. 主流程 ---------- */
// 只把非 `--` 开头的参数当账套路径（否则 --selftest 会被误当路径 → "指定的账套不存在"）
const POS = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; });
const r = pickBooks(POS[0] || null);
if (r.error) { console.log(r.error); process.exit(0); }
console.log('跨页一致性检查（显示层）：' + r.books.length + ' 个账套');
r.books.forEach(checkBook);

console.log('');
console.log('─'.repeat(70));
console.log('覆盖：总账×' + COV.gl + '　余额表×' + COV.tb + '　明细账×' + COV.dl + '　多栏账×' + COV.ml
  + '　报表×' + COV.rpt + '（按"账套×期间"计）');
// 期间覆盖率必须打出来：全绿只有在"该查的期间都查过"的前提下才算数
console.log('期间覆盖：' + COV.perUsed + '/' + COV.perTotal + '（账套×期间）'
  + (COV.perUsed < COV.perTotal ? '　⚠ 未逐期全跑，跨年边界已覆盖；如需全量请加 --all-periods' : '　✓ 全期间'));
// 隐藏零行这一遍必须显式打出覆盖与"确实藏过行"的证据：否则"全绿"可能只是因为
// 这段根本没被驱动过（verify_vs_ais 就曾长期输出绿色，实则拿金蝶数据比一个空账套）。
console.log('隐藏零行：开关开/关对照 ' + HZ.passes + ' 次；勾选后共隐藏 ' + HZ.hidden + ' 行；'
  + '其中「仅本年累计非 0」科目 ' + HZ.onlyYtd + ' 次 —— 均已确认未被误藏 ✓');
console.log('断言项：' + CHECKED + '　不一致：' + FAIL);
if (FAIL) {
  console.log('不一致明细（最多 24 条）：');
  DETAIL.forEach(function (x) { console.log('  ✗ ' + x); });
  console.log('');
  console.log('❌ 显示层存在口径分叉：同一余额在不同页面/屏幕与导出之间不一致 ← 需修复');
  process.exit(1);
}
console.log('✅ 总账 / 科目余额表 的屏幕与导出逐格一致，且显示值均可还原为取数层余额 ✓');
if (!SELFTEST && !runSelftest()) process.exit(1);
process.exit(0);

/* ---------- 9. 自检：证明这张网真的能抓到显示层缺陷 ----------
 * 【为什么必须自检】检查工具自身出 bug 时，输出的要么是满屏假警报、要么是一片绿，
 *   而两者都会让人不再看它 —— verify_vs_ais 就这样空转了不知多久（拿金蝶数据比空账套，
 *   稳定报 700+ 项假差异，被当成"老问题"）。「检查者无人检查」是本次事故的根因之一。
 *   故每次运行都以子进程注入两类**已知的**显示层缺陷（正是 2026-09 真实发生过的），
 *   要求本脚本必须把它们报出来；报不出来即判定本网失效，直接失败。
 */
function runSelftest() {
  const r = require('child_process').spawnSync(process.execPath, [__filename, '--selftest'],
    { cwd: ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const hit = /不一致：(\d+)/.exec(out);
  const n = hit ? parseInt(hit[1], 10) : 0;
  if (r.status !== 1 || n <= 0) {
    console.log('❌ 自检未通过：注入的已知显示层缺陷未被检出（不一致=' + n + '）→ 本检查网已失效，不可信');
    console.log(out.trim().split('\n').slice(-6).join('\n'));
    return false;
  }
  console.log('✅ 自检通过：注入的 ' + INJECTS.length + ' 类显示层缺陷均被检出（' + n + ' 项）—— 这张网是活的 ✓');
  return true;
}
