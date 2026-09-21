#!/usr/bin/env node
'use strict';
/* ============================================================
 * 删除科目（S.removeSubject）验证
 *
 * 【背景】科目编码是凭证与期初余额的引用键，科目表此前「只增不减」：
 *         既不能改编码（编辑时输入框禁用、updateSubject 从不改 code），
 *         也不能删除（removeSubject 于 2026-09-10 随重构移除）。
 *         于是「刚建错、还没用过」的科目无法修正，只能永远留在表里。
 *
 * 【本脚本验证的约定】
 *   · 未使用（无凭证引用、无期初余额）的科目 → 允许删除，并连带删除其全部下级；
 *   · 已使用的科目 → 一律拒绝（删除会使历史凭证指向不存在的科目，账就断了）；
 *   · 不存在的科目 → 返回失败。
 *
 * 【安全】全程操作【内存副本】：persist / saveBook 等全部 mock 为空，
 *   物理上不可能落盘；结束比对源文件 MD5，证明账套未被改动。
 *   无账套环境（如 CI）自动跳过，返回 0，不计为失败。
 *
 * 用法：node tools/test_remove_subject.js
 * ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

function booksDir() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', '添钰财务', 'books');
  return path.join(h, '.local', 'share', '添钰财务', 'books');
}

let BOOK_FILE = null;
try {
  const d = booksDir();
  if (fs.existsSync(d)) {
    const f = fs.readdirSync(d).filter(function (x) { return x.endsWith('.json') && x.indexOf('.bak') < 0; }).sort();
    if (f.length) BOOK_FILE = path.join(d, f[0]);
  }
} catch (e) { /* 探测失败即视为无账套 */ }
if (!BOOK_FILE) {
  console.log('跳过：未找到账套（' + booksDir() + '）——本脚本在真实账套副本上验证，无账套环境自动跳过。');
  process.exit(0);
}

const RAW = fs.readFileSync(BOOK_FILE, 'utf8');
const MD5_BEFORE = crypto.createHash('md5').update(RAW).digest('hex');
console.log('账套：' + BOOK_FILE);

/* ---------- 浏览器环境 mock ---------- */
global.window = global;
global.localStorage = { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } };
global.document = {
  getElementById: function () { return null; }, addEventListener: function () { },
  querySelector: function () { return null; }, querySelectorAll: function () { return []; }
};
global.__TAURI__ = {};
if (typeof global.isTauri === 'undefined') global.isTauri = false;
try { global.navigator = { userAgent: 'node' }; } catch (e) { /* 已有只读内置 */ }
global.fetch = function () { return Promise.reject(new Error('no network')); };

require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;

/* ---------- 封死写盘 ---------- */
S.persist = function () { };
S.save = function () { return Promise.resolve(); };
S.addLog = function () { };
S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) {
  global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); };
  global.Storage.saveBackup = function () { return Promise.resolve({ ok: true }); };
}

/* ---------- 载入内存副本 ---------- */
S.state = JSON.parse(RAW);
S.bookId = '__SIM_NEVER_SAVE__';
S._glCache = {};
if (S.normalizeState) S.normalizeState();

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
}
// 找一个真实账套里不存在的 4 位编码，避免与既有科目冲突
function freeCode() {
  for (var c = 9901; c <= 9999; c++) { if (!S.subject(String(c))) return String(c); }
  return null;
}

console.log('\n【1】未使用的科目可删除');
var c1 = freeCode();
var n0 = S.subjects().length;
var r1 = S.addSubject(c1, '测试待删科目', 'asset', null);
ok(r1 && r1.ok, '新增测试科目 ' + c1);
ok(S.subjects().length === n0 + 1, '科目数 +1');
var d1 = S.removeSubject(c1);
ok(d1 && d1.ok, '删除成功');
ok(d1 && d1.removed === 1, 'removed = 1（实为 ' + (d1 && d1.removed) + '）');
ok(!S.subject(c1), '该科目已从表中移除');
ok(S.subjects().length === n0, '科目数恢复为 ' + n0);

console.log('\n【2】连带删除全部下级');
var c2 = freeCode();
var c2kid = c2 + '01';
S.addSubject(c2, '测试父科目', 'asset', null);
var ak = S.addSubject(c2kid, '测试子科目', 'asset', null);
ok(ak && ak.ok, '新增子科目 ' + c2kid);
var d2 = S.removeSubject(c2);
ok(d2 && d2.ok, '删除父科目成功');
ok(d2 && d2.removed === 2, '连带删除 2 个（实为 ' + (d2 && d2.removed) + '）');
ok(!S.subject(c2) && !S.subject(c2kid), '父科目与子科目均已移除');

console.log('\n【3】已被凭证引用的科目拒绝删除');
var usedCode = null;
(S.state.vouchers || []).forEach(function (v) {
  if (usedCode || v.deleted === 'y') return;
  (v.entries || []).forEach(function (e) { if (!usedCode && e.code) usedCode = String(e.code); });
});
if (usedCode) {
  var before3 = S.subjects().length;
  var d3 = S.removeSubject(usedCode);
  ok(d3 && !d3.ok, '拒绝删除已用科目 ' + usedCode);
  ok(!!S.subject(usedCode), '该科目仍在表中（未被删）');
  ok(S.subjects().length === before3, '科目数未变');
} else {
  console.log('  （账套内无凭证，跳过）');
}

console.log('\n【4】有期初余额的科目拒绝删除');
var obCodes = Object.keys(S.state.openingBalances || {});
if (obCodes.length) {
  var oc = obCodes[0];
  var d4 = S.removeSubject(oc);
  ok(d4 && !d4.ok, '拒绝删除有期初余额的科目 ' + oc);
  ok(!!S.subject(oc), '该科目仍在表中（未被删）');
} else {
  console.log('  （账套内无期初余额，跳过）');
}

console.log('\n【5】不存在的科目');
var d5 = S.removeSubject('__NO_SUCH_CODE__');
ok(d5 && !d5.ok, '返回失败（不静默成功）');

console.log('\n【6】源文件未被改动');
var MD5_AFTER = crypto.createHash('md5').update(fs.readFileSync(BOOK_FILE, 'utf8')).digest('hex');
ok(MD5_BEFORE === MD5_AFTER, 'MD5 一致（全程内存副本，未落盘）');

console.log('\n──────────────────────────────────────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
