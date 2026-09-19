#!/usr/bin/env node
/* ============================================================
 * tools/sim_replay.js —— 真实凭证「打乱顺序重放」验证
 *
 * 【目的】用**真实业务凭证**（不是人造数据）验证记账功能：
 *   把账套里已有的全部凭证【打乱顺序】，在一张空壳账套上通过
 *   addVoucher 重新录入一遍，然后比对重放结果与原始账套是否**完全一致**。
 *
 *   为什么这样测有价值：
 *   · 数据是真实的 —— 科目、金额分布、业务类型都是这家公司实际发生的；
 *   · 顺序是乱的 —— 检验软件是否「按凭证日期归属期间」而非「按录入顺序」
 *     （真实使用中用户补录、倒着录、跨月补凭证都很常见）；
 *   · 结论可判定 —— 同源数据、同一套引擎，结果必须逐科目分毫不差。
 *
 * 【安全】源账套只读；全程内存副本；persist/saveBook/addLog 全部 mock 为空；
 *         结束时比对源文件 MD5。
 *
 * 用法：
 *   node tools/sim_replay.js [账套路径] [随机种子]
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ---------- 环境 mock ---------- */
const _ls = {};
global.window = global;
global.localStorage = { getItem: k => (k in _ls ? _ls[k] : null), setItem: (k, v) => { _ls[k] = String(v); }, removeItem: k => { delete _ls[k]; } };
global.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
  addEventListener() {}
};
try { global.navigator = { userAgent: 'node' }; } catch (e) { /* Node 21+ 只读内置 */ }
global.fetch = () => Promise.reject(new Error('no network'));
if (typeof global.isTauri === 'undefined') global.isTauri = false;

/* ---------- 定位账套（只读） ---------- */
function booksDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '添钰财务', 'books');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), '添钰财务', 'books');
}
function newestBook() {
  const dir = booksDir();
  if (!fs.existsSync(dir)) { console.error('账套目录不存在：' + dir); process.exit(1); }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.bak'))
    .map(f => ({ p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!files.length) { console.error('无账套文件'); process.exit(1); }
  return files[0].p;
}

const BOOK_FILE = process.argv[2] && fs.existsSync(process.argv[2]) ? process.argv[2] : newestBook();
const SEED = Number(process.argv[3]) || 20260920;
const RAW = fs.readFileSync(BOOK_FILE, 'utf8');
const MD5_BEFORE = crypto.createHash('md5').update(RAW).digest('hex');

require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;
S.persist = function () { };
S.save = function () { return Promise.resolve(); };
S.addLog = function () { };
S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) {
  global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); };
  global.Storage.saveBackup = function () { return Promise.resolve({ ok: true }); };
}

const r2 = n => Math.round(Number(n) * 100) / 100;
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    \x1b[32mPASS\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); console.log('    \x1b[31mFAIL\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
}
function eqAmt(name, a, b) {
  const x = r2(a), y = r2(b), d = r2(x - y);
  ok(name, Math.abs(d) < 0.005, '重放 ' + x.toFixed(2) + ' / 原始 ' + y.toFixed(2) + (Math.abs(d) < 0.005 ? '' : '  差 ' + d.toFixed(2)));
}
function section(t) { console.log('\n' + t); }

/* ---------- 原始账套 ---------- */
const SRC = JSON.parse(RAW);
const srcAll = SRC.vouchers || [];
const srcAct = srcAll.filter(v => v.deleted !== 'y');
const months = [...new Set(srcAct.map(v => String(v.date || '').slice(0, 7)).filter(Boolean))].sort();

console.log('═══════════════════════════════════════════════════════════');
console.log(' 真实凭证「打乱顺序重放」验证');
console.log('═══════════════════════════════════════════════════════════');
console.log('  账套      ' + ((SRC.company && SRC.company.name) || path.basename(BOOK_FILE)));
console.log('  凭证      ' + srcAct.length + ' 张（软删 ' + (srcAll.length - srcAct.length) + ' 张不计入）');
console.log('  科目      ' + (SRC.subjects || []).length + ' 个    期初 ' + Object.keys(SRC.openingBalances || {}).length + ' 个科目');
console.log('  期间      ' + months[0] + ' ~ ' + months[months.length - 1]);
console.log('  随机种子  ' + SEED);

/* ---------- 工具 ---------- */
function snapshotLedger(month) {   // 逐科目期末净额（借正贷负）
  S._glCache = {};
  const out = {};
  S.generalLedger(month).forEach(r => { out[String(r.code)] = r2((r.dir === '借' ? 1 : -1) * num(r.balance)); });
  return out;
}
function snapshotBS(month) {
  S._glCache = {};
  const b = S.balanceSheet(month);
  return { a: r2(num(b.totalAsset)), l: r2(num(b.totalLiability)), e: r2(num(b.totalEquity)) };
}
function snapshotPL(month) {
  S._glCache = {};
  const p = S.profitStatement(month);
  return { rev: r2(num(p.totalRevenue)), exp: r2(num(p.totalExpense)), net: r2(num(p.netProfit)) };
}

/* ============================================================
 * 第 1 步：记录「原始」基准
 * ============================================================ */
section('【1】记录原始账套基准（逐月账簿 + 报表）');
S.state = SRC;
S.bookId = '__ORIG__';
S._glCache = {};
const baseLedger = {}, baseBS = {}, basePL = {};
months.forEach(m => {
  baseLedger[m] = snapshotLedger(m);
  baseBS[m] = snapshotBS(m);
  basePL[m] = snapshotPL(m);
});
const baseAll = snapshotLedger(months[months.length - 1]);
{
  let dr = 0, cr = 0;
  srcAct.forEach(v => (v.entries || []).forEach(e => { dr += num(e.dr); cr += num(e.cr); }));
  console.log('    原始借贷合计：借 ' + r2(dr).toFixed(2) + '  贷 ' + r2(cr).toFixed(2) + '  差 ' + r2(dr - cr).toFixed(2));
  ok('原始账套借贷平衡', Math.abs(dr - cr) < 0.005);
  const bs = baseBS[months[months.length - 1]];
  console.log('    期末（' + months[months.length - 1] + '）：资产 ' + bs.a.toFixed(2) + '  负债 ' + bs.l.toFixed(2) + '  权益 ' + bs.e.toFixed(2));
}

/* ============================================================
 * 第 2 步：打乱顺序
 * ============================================================ */
section('【2】把 ' + srcAct.length + ' 张凭证打乱顺序（固定种子，可复现）');
function shuffleSeeded(arr, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
}
const shuffled = shuffleSeeded(srcAct.map(v => JSON.parse(JSON.stringify(v))), SEED);
console.log('    打乱后前 10 张的原始顺序：');
shuffled.slice(0, 10).forEach((v, i) => {
  console.log('      ' + String(i + 1).padStart(3) + '.  ' + v.date + '  ' + (v.word || '记') + '-' + v.no +
    '  ' + String(v.summary || '').slice(0, 22) + (v.kind ? '  [kind=' + v.kind + ']' : ''));
});
{
  let inv = 0, tot = 0;
  for (let i = 0; i < Math.min(shuffled.length, 200); i++) {
    for (let j = i + 1; j < Math.min(shuffled.length, 200); j++) {
      tot++;
      if (String(shuffled[i].date) > String(shuffled[j].date)) inv++;
    }
  }
  console.log('    乱序程度：前 200 张里 ' + (tot ? (inv / tot * 100).toFixed(1) : 0) + '% 的相邻对日期倒置（完全有序应为 0%）');
}

/* ============================================================
 * 第 3 步：空壳账套 + 逐张重放
 * ============================================================ */
section('【3】在空壳账套（保留科目与期初、清空凭证与结账状态）上逐张重放');
S.state = JSON.parse(RAW);
S.state.vouchers = [];
S.state.closedPeriods = [];
S.state.operationLogs = [];
S.bookId = '__REPLAY__';
S._glCache = {};
if (S.normalizeState) S.normalizeState();
if (S.ensureCashFlowFields) S.ensureCashFlowFields();
console.log('    空壳就绪：科目 ' + (S.state.subjects || []).length + ' 个，凭证 0 张，已结账月 0 个');

let rejected = [];
shuffled.forEach((v, i) => {
  const nv = { word: v.word, no: v.no, date: v.date, attach: v.attach, summary: v.summary, entries: v.entries };
  if (v.kind) nv.kind = v.kind;                     // 保留结转/折旧等业务标记
  if (v.maker) nv.maker = v.maker;
  const r = S.addVoucher(nv);
  if (!r || r.ok === false) rejected.push({ i: i + 1, date: v.date, no: v.no, msg: (r && r.msg) || '未知' });
});
ok('全部凭证重放成功（' + shuffled.length + ' 张）', rejected.length === 0,
  rejected.length ? ('被拒 ' + rejected.length + ' 张，前 3：' + JSON.stringify(rejected.slice(0, 3))) : '');
ok('重放后凭证数 = 原始', (S.state.vouchers || []).length === srcAct.length,
  '重放 ' + (S.state.vouchers || []).length + ' / 原始 ' + srcAct.length);

/* ============================================================
 * 第 4 步：逐月逐科目比对
 * ============================================================ */
section('【4】逐月逐科目比对：重放结果 是否 完全还原 原始账套');
let totalCmp = 0, badCmp = [];
months.forEach(m => {
  const got = snapshotLedger(m);
  const want = baseLedger[m];
  const codes = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
  codes.forEach(c => {
    const a = r2(got[c] || 0), b = r2(want[c] || 0);
    if (Math.abs(a - b) > 0.005) badCmp.push(m + ' ' + c + ' 重放 ' + a + ' / 原始 ' + b + ' 差 ' + r2(a - b));
    totalCmp++;
  });
});
ok('全部 ' + months.length + ' 个月 × ' + (totalCmp / months.length | 0) + ' 个科目（共 ' + totalCmp + ' 项）逐项一致',
  badCmp.length === 0, badCmp.length ? ('不一致 ' + badCmp.length + ' 项，前 5：' + badCmp.slice(0, 5).join(' | ')) : '');

section('【5】逐月报表比对');
months.forEach(m => {
  const bs = snapshotBS(m), bp = baseBS[m];
  const pl = snapshotPL(m), pp = basePL[m];
  const dA = r2(bs.a - bp.a), dL = r2(bs.l - bp.l), dE = r2(bs.e - bp.e);
  const dR = r2(pl.rev - pp.rev), dN = r2(pl.net - pp.net);
  const same = Math.abs(dA) < 0.005 && Math.abs(dL) < 0.005 && Math.abs(dE) < 0.005 && Math.abs(dR) < 0.005 && Math.abs(dN) < 0.005;
  ok(m + '  资产/负债/权益/收入/净利 全部一致', same,
    '资产差 ' + dA.toFixed(2) + ' 负债差 ' + dL.toFixed(2) + ' 权益差 ' + dE.toFixed(2) +
    ' 收入差 ' + dR.toFixed(2) + ' 净利差 ' + dN.toFixed(2));
});

section('【6】期末总账逐科目比对（全 ' + Object.keys(baseAll).length + ' 个科目）');
{
  const gotAll = snapshotLedger(months[months.length - 1]);
  const bad = [];
  Object.keys(baseAll).forEach(c => {
    if (Math.abs(r2(num(gotAll[c] || 0) - num(baseAll[c]))) > 0.005) bad.push(c);
  });
  ok('期末全部科目余额与原始一致', bad.length === 0, bad.length ? ('不一致 ' + bad.length + ' 个：' + bad.slice(0, 8).join(', ')) : '');
}

/* ---------- 完整性 ---------- */
const MD5_AFTER = crypto.createHash('md5').update(fs.readFileSync(BOOK_FILE, 'utf8')).digest('hex');
section('【7】源账套完整性');
ok('源文件未被改动', MD5_BEFORE === MD5_AFTER, MD5_BEFORE === MD5_AFTER ? 'MD5 一致' : 'MD5 变了！');

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' 结果：' + (fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m') + '   PASS ' + pass + ' / FAIL ' + fail);
if (fail) { console.log(' 失败项：'); fails.forEach(f => console.log('   · ' + f)); }
console.log(' 说明：打乱顺序重放仍能完全还原原始账套，说明软件按「凭证日期」归属期间，');
console.log('       不依赖录入顺序 —— 补录、倒录、跨月补凭证都不会算错。');
console.log('═══════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
