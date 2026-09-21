#!/usr/bin/env node
'use strict';
/* ============================================================
 * 金蝶原账套 ↔ ty 当前账套：逐科目、逐期、逐字段金额对比
 *
 * 【为什么要做这个】此前所有对账都是「ty 内部各口径之间」（利润表 ↔ 结转 ↔ 总账），
 *   看不见「导入转换」环节引入的偏差。本脚本直接拿金蝶 .ais 的 GLBal
 *   （金蝶自己的权威科目余额）与 ty 的 generalLedger 逐科目逐期比，容差 0.01 元。
 *
 * 【软删除如何解释】ty 侧的所有「活动凭证」入口都排除软删除凭证，金蝶侧没有这个概念，
 *   故两者的差异应当【恰好等于】软删除凭证的影响。脚本自动算出该影响并归类：
 *     · 差异 ≡ 软删除影响            → 可解释（维护者主动删除，非缺陷）
 *     · 有差异但不等于软删除影响     → 需人工核查（怀疑导入/计算缺陷）
 *
 * 【对比字段（金蝶 GLBal ↔ ty generalLedger）】
 *   期初余额 FBegBal   ↔ obDr - obCr      （借方为正 signed，两边同口径）
 *   本期借方 FDebit    ↔ periodDr
 *   本期贷方 FCredit   ↔ periodCr
 *   期末余额 FEndBal   ↔ endDr - endCr
 *   本年借方 FYtdDebit ↔ ytdDr
 *   本年贷方 FYtdCredit↔ ytdCr
 *
 * 用法：node tools/verify_vs_ais.js [.ais路径] [账套JSON路径]
 * ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path');

/* ---------- 解析参数 ---------- */
// 【血泪教训】本机可能存在同一账套的多份 .ais 副本（如 Desktop 与 Downloads），
//   其中较旧的那份可能缺少最新月份的结转凭证，拿它对比会凭空造出「余额差异」的假象。
//   故默认在候选位置中自动选取 **mtime 最新** 的那份。
function pickNewestAis() {
  const cands = [];
  const list = [
    '/Users/chen/Desktop',
    '/Users/chen/Downloads/金蝶账套 ais',
    '/Users/chen/Downloads'
  ];
  list.forEach(function (d) {
    try {
      if (!fs.existsSync(d)) return;
      fs.readdirSync(d).forEach(function (f) {
        if (!/\.ais$/i.test(f)) return;
        const p = path.join(d, f);
        try { cands.push({ p: p, t: fs.statSync(p).mtimeMs }); } catch (e) { }
      });
    } catch (e) { }
  });
  cands.sort(function (a, b) { return b.t - a.t; });
  return cands.length ? cands[0].p : null;
}
const AIS = process.argv[2] || pickNewestAis() || '/Users/chen/Desktop/添钰来客_2026年_金蝶KIS格式.ais';
let BOOK = process.argv[3] || null;
if (!BOOK) {
  const h = os.homedir();
  const dir = process.platform === 'darwin' ? path.join(h, 'Library', 'Application Support', '添钰财务', 'books')
    : process.platform === 'win32' ? path.join(h, 'AppData', 'Roaming', '添钰财务', 'books')
      : path.join(h, '.local', 'share', '添钰财务', 'books');
  try {
    const f = fs.readdirSync(dir).filter(function (x) { return x.endsWith('.json') && x.indexOf('.bak') < 0; }).sort();
    if (f.length) BOOK = path.join(dir, f[0]);
  } catch (e) { }
}
if (!fs.existsSync(AIS)) { console.log('跳过：找不到 .ais → ' + AIS); process.exit(0); }
if (!BOOK || !fs.existsSync(BOOK)) { console.log('跳过：找不到 ty 账套 JSON'); process.exit(0); }

const R = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
const num = function (v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const EPS = 0.01;

/* ---------- 1. 读金蝶 GLBal ---------- */
global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) { }
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
const MDBReader = global.MDBReader.default;

const RAW_BOOK = fs.readFileSync(BOOK, 'utf8');
const BOOK_OBJ = JSON.parse(RAW_BOOK);
const START = ((BOOK_OBJ.company || {}).startMonth) || '2026-01';

// 期间号(1~12) → 'YYYY-MM'（以 ty 账套启用月为基准）
function mapPeriod(p) {
  const sp = START.split('-'); const sy = +sp[0] || 2026, sm = +sp[1] || 1;
  const total = (sy * 12 + (sm - 1)) + (p - 1);
  const y = Math.floor(total / 12), m = (total % 12) + 1;
  return y + '-' + ('0' + m).slice(-2);
}

console.log('金蝶原账套：' + path.basename(AIS));
console.log('ty 账套　　：' + path.basename(BOOK) + '   （启用月 ' + START + '）');
console.log('');

const reader = new MDBReader(fs.readFileSync(AIS));
const tableNames = reader.getTableNames();
if (tableNames.indexOf('GLBal') < 0) { console.log('该 .ais 无 GLBal 表，无法对比'); process.exit(0); }
const balRows = reader.getTable('GLBal').getData() || [];

// kis[month][code] = { beg, debit, credit, ytdD, ytdC, end }
const kis = {};
balRows.forEach(function (r) {
  if (String(r.FCyID || '').trim() !== '*' || String(r.FObjID || '').trim() !== '*') return;
  const code = String(r.FAcctID || '').trim();
  if (!code || code === '*') return;
  const rp = parseInt(r.FPeriod || 0, 10) || 0;
  if (!rp) return;
  const m = rp > 999 ? (String(rp).slice(0, 4) + '-' + String(rp).slice(4, 6)) : mapPeriod(rp);
  if (!/^\d{4}-\d{2}$/.test(m)) return;
  kis[m] = kis[m] || {};
  kis[m][code] = {
    beg: R(num(r.FBegBal)), debit: R(num(r.FDebit)), credit: R(num(r.FCredit)),
    ytdD: R(num(r.FYtdDebit)), ytdC: R(num(r.FYtdCredit)), end: R(num(r.FEndBal))
  };
});

/* ---------- 2. 读 ty 侧（用 store 计算总账） ---------- */
global.localStorage = { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } };
global.document = { getElementById: function () { return null; }, addEventListener: function () { }, querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
global.__TAURI__ = {}; if (typeof global.isTauri === 'undefined') global.isTauri = false;
try { global.navigator = { userAgent: 'node' }; } catch (e) { }
global.fetch = function () { return Promise.reject(new Error('no net')); };
require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;
S.persist = function () { }; S.save = function () { return Promise.resolve(); };
S.addLog = function () { }; S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) { global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); }; }
S.state = JSON.parse(RAW_BOOK); S.bookId = '__VSAIS__'; S._glCache = {};
if (S.normalizeState) S.normalizeState();

/* ---------- 3. 软删除凭证的影响（金蝶含、ty 不含）---------- */
// delImpact[month][code] = { dr, cr }  ← 软删除凭证的发生额
const delImpact = {};
(S.state.vouchers || []).forEach(function (v) {
  if (v.deleted !== 'y') return;
  const m = String(v.date || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return;
  delImpact[m] = delImpact[m] || {};
  (v.entries || []).forEach(function (e) {
    const c = String(e.code);
    delImpact[m][c] = delImpact[m][c] || { dr: 0, cr: 0 };
    delImpact[m][c].dr += num(e.dr); delImpact[m][c].cr += num(e.cr);
  });
});
let delTotalAmt = 0;
Object.keys(delImpact).forEach(function (m) {
  Object.keys(delImpact[m]).forEach(function (c) { delTotalAmt += delImpact[m][c].dr + delImpact[m][c].cr; });
});

/* ---------- 4. 逐期逐科目对比 ---------- */
const months = Object.keys(kis).sort();

/* ---------- 配对校验：.ais 与 ty 账套必须同期同账套 ---------- */
// 【为什么需要】本机常有多份 .ais（2024 / 2025 / 2026 各一份）与多个账套（单年 / 多年合并）。
//   两者由各自逻辑自动挑选，期间范围未必对得上 —— 典型误配：拿「2026 单年 .ais」比
//   「2025+2026 合并账套」，逐月比对会凭空产出上千项差异（实测 7885 项），全是误报。
//   故先校验首期：不一致直接跳过，而不是输出一堆无意义的差异。
//   需要跨年比对时，请显式传参指定配套的 .ais 与账套。
const bookStart = (S.state.company && S.state.company.startMonth) || '';
// 账套实际有凭证的最晚月份（.ais 侧用 GLBal 的期间，账套侧没有等价表，用凭证推）
let bookLast = '';
(S.state.vouchers || []).forEach(function (v) {
  if (v.deleted === 'y') return;
  const vm = String(v.date || '').slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(vm) && vm > bookLast) bookLast = vm;
});
const aisFirst = months[0] || '', aisLast = months[months.length - 1] || '';
if (bookStart && months.length && (aisFirst !== bookStart || (bookLast && aisLast !== bookLast))) {
  console.log('跳过：.ais 与 ty 账套不是同一期间范围，逐月比对无意义。');
  console.log('      .ais 期间 ' + aisFirst + ' ~ ' + aisLast
    + '   vs   账套 ' + (bookStart || '?') + ' ~ ' + (bookLast || '?'));
  console.log('      （首期相同但末期不同，多半是「单年 .ais」配上了「多年合并账套」）');
  console.log('      如需比对，请显式指定两者：node tools/verify_vs_ais.js <.ais> <账套.json>');
  process.exit(0);
}
console.log('金蝶有余额数据的期间：' + months.join(', '));
console.log('软删除凭证影响：' + (delTotalAmt ? (R(delTotalAmt) + '（元·借贷合计，期间 ' + Object.keys(delImpact).join(',') + '）') : '无'));

// 【旧版导入账套 → 发生额列不参与比对】
// 旧版导入把金蝶红字「借 -1,724.85」改写成「贷 +1,724.85」（见 js/kis-import.js 历史实现），
// 于是「本期/本年累计发生额」按**借贷双方合计**列示，而金蝶 GLBal 是**净额**（红字抵减借方），
// 两者必然不等 —— 实测各月差 -1,724.85 / -162 / -14.27，恰为各笔红冲金额，与此前利润表
// 口径问题同源。该改写是**信息破坏性**的，已无法从账套内还原（红冲与真实反方向业务无法区分），
// 故旧账套的发生额列本就不该与金蝶一致 —— 这是「已知且不可逆」的，不是缺陷。
// 因此：旧账套只严格比对【余额列】（beg/end，不受影响）；发生额列跳过并明确提示。
// 用新版重新导入（meta.redStyle === 'native'）后，本判断自动失效，恢复全字段严格比对。
const BOOK_META = (BOOK_OBJ && BOOK_OBJ.meta) || {};
const LEGACY_RED_STYLE = !!BOOK_META.importedAt && BOOK_META.redStyle !== 'native';
if (LEGACY_RED_STYLE) {
  console.log('⚠ 本账套为旧版方式导入（红字被转写成反方向）→ 发生额列口径与金蝶不同，'
    + '本次只严格比对余额列；重新导入后自动恢复全字段比对。');
}
console.log('');

const FIELDS = [
  ['beg', function (r) { return R(num(r.obDr) - num(r.obCr)); }, '期初余额'],
  ['debit', function (r) { return R(num(r.periodDr)); }, '本期借方'],
  ['credit', function (r) { return R(num(r.periodCr)); }, '本期贷方'],
  ['end', function (r) { return R(num(r.endDr) - num(r.endCr)); }, '期末余额'],
  ['ytdD', function (r) { return R(num(r.ytdDr)); }, '本年借方'],
  ['ytdC', function (r) { return R(num(r.ytdCr)); }, '本年贷方']
];

let totalChecked = 0, totalDiff = 0, totalExplained = 0, totalUnexplained = 0;
const unexplainedDetail = [];

months.forEach(function (m) {
  const gl = S.generalLedger(m);
  const byCode = {};
  gl.forEach(function (r) { byCode[String(r.code)] = r; });
  const kisM = kis[m];

  const codeSeen = {};
  Object.keys(kisM).forEach(function (c) { codeSeen[c] = 1; });
  Object.keys(byCode).forEach(function (c) { codeSeen[c] = 1; });

  const issues = [];
  Object.keys(codeSeen).forEach(function (c) {
    const k = kisM[c] || { beg: 0, debit: 0, credit: 0, end: 0, ytdD: 0, ytdC: 0 };
    const t = byCode[c] || { obDr: 0, obCr: 0, periodDr: 0, periodCr: 0, endDr: 0, endCr: 0, ytdDr: 0, ytdCr: 0 };
    const del = (delImpact[m] || {})[c] || { dr: 0, cr: 0 };
    FIELDS.forEach(function (f) {
      // 旧版导入账套：跳过「发生额」四列（本期借/贷、本年借/贷），理由见 LEGACY_RED_STYLE 说明。
      // 余额两列 beg/end 不受红字口径影响，仍正常严格比对。
      if (LEGACY_RED_STYLE
        && (f[0] === 'debit' || f[0] === 'credit' || f[0] === 'ytdD' || f[0] === 'ytdC')) return;
      const kv = k[f[0]], tv = f[1](t), label = f[2];
      const d = R(kv - tv);
      if (Math.abs(d) < EPS) return;
      totalChecked++; totalDiff++;
      // 软删除影响是否恰好解释该差异？
      let expected = null;
      if (f[0] === 'debit') expected = R(del.dr);
      else if (f[0] === 'credit') expected = R(del.cr);
      else if (f[0] === 'end') expected = R(del.dr - del.cr);
      else if (f[0] === 'ytdD') expected = R(del.dr);
      else if (f[0] === 'ytdC') expected = R(del.cr);
      const explained = expected !== null && Math.abs(d - expected) < EPS;
      if (explained) totalExplained++;
      else {
        totalUnexplained++;
        issues.push('   ' + c + ' ' + label + '：金蝶 ' + kv + ' / ty ' + tv + ' 差 ' + d
          + (expected !== null ? '（软删除只能解释 ' + expected + '）' : ''));
      }
    });
  });
  if (issues.length) {
    console.log('✗ ' + m + ' 存在无法用软删除解释的差异（' + issues.length + ' 项）：');
    issues.slice(0, 14).forEach(function (x) { console.log(x); });
    unexplainedDetail.push(m);
    console.log('');
  }
});

console.log('─'.repeat(70));
console.log('对比期间数：' + months.length + '　差异项：' + totalDiff
  + '　（其中软删除可解释：' + totalExplained + '）');
if (totalUnexplained === 0) {
  console.log('✅ 全部差异均可由「软删除凭证」解释 —— ty 与金蝶原账套金额一致 ✓');
} else {
  console.log('❌ 有 ' + totalUnexplained + ' 项差异无法用软删除解释（期间：' + unexplainedDetail.join(',') + '）← 需人工核查');
}
process.exit(totalUnexplained === 0 ? 0 : 1);
