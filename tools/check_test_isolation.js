'use strict';
/* 测试数据隔离护栏（2026-09-19）
 *
 * 【背景】tools/test_import_e2e.js 与 test_book_manage_e2e.js 曾把 Storage 的 mock 直接指向
 * 真实账套目录 $HOME/Library/Application Support/添钰财务/books，而这两个 e2e 里有
 * deleteBook（unlinkSync 删文件）、restoreBookState（覆盖账套）等破坏性操作。
 * 只因本机没有 default.json、switchBook 先行失败，才一直没酿成事故 —— 这是运气不是安全。
 * 现已改用 tools/e2e_sandbox.js（临时目录 + 路径硬校验）。
 *
 * 【本脚本做什么】扫描 tools/ 下的脚本，凡是「指向真实数据目录」且「对该目录有写操作」的，
 * 一律判为不合格并退出码 1。只读访问（如跨报表核对类脚本读真账套做比对）允许，只作提示列出。
 *
 * 用法：node tools/check_test_isolation.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// 真实数据目录的特征串
const REAL_MARK = /添钰财务|tianyufinance/i;
// 对磁盘有破坏性的操作
const WRITE_OPS = /\b(writeFileSync|unlinkSync|rmSync|renameSync|appendFileSync|mkdirSync|copyFileSync|truncateSync)\s*\(/;
// 允许只读的操作（出现这些不代表违规）
const READ_OPS = /\b(readFileSync|readdirSync|existsSync|statSync)\s*\(/;

/* 白名单：脚本确实会"经过"真实数据根目录，但**只读账套、写的是导出产物目录**，
 * 不碰 books/ 下的任何文件。红线是账套本身（books/），不是整个应用数据目录 ——
 * 导出报表本来就要落到磁盘，属产品功能而非测试副作用。 */
const ALLOWED = ['tools/export_statement.js'];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const files = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter(f => f.endsWith('.js'))
  // 沙箱模块本身以"拒绝真实目录"为职责，注释里必然出现特征串（已剥离注释），无需排查
  .filter(f => f !== 'e2e_sandbox.js')
  .map(f => path.join(ROOT, 'tools', f));

const bad = [];
const readonly = [];

files.forEach(function (f) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  if (!REAL_MARK.test(src)) return;              // 根本没提真实目录
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (ALLOWED.indexOf(rel) >= 0) { readonly.push(rel + '（白名单：只读账套，写导出产物目录）'); return; }
  if (WRITE_OPS.test(src)) {
    bad.push(rel + '  —— 既指向真实数据目录，又含写操作（' +
      (src.match(WRITE_OPS) ? RegExp.lastMatch.replace(/\s*\($/, '') : '') + '）');
  } else if (READ_OPS.test(src)) {
    readonly.push(rel);
  }
});

console.log('测试数据隔离检查（禁止脚本写真实账套目录）');
console.log('  扫描 tools/*.js 共 ' + files.length + ' 个');
console.log('');

if (readonly.length) {
  console.log('  只读访问真实账套目录（允许，用于跨报表核对等只读比对）：');
  readonly.forEach(function (r) { console.log('    · ' + r); });
  console.log('');
}

if (bad.length) {
  console.log('★ 以下脚本会写真实数据目录，必须改用 tools/e2e_sandbox.js：');
  bad.forEach(function (b) { console.log('  · ' + b); });
  console.log('');
  console.log('  修法：const sb = require("./e2e_sandbox.js").create("tag");');
  console.log('        const sh = require("./e2e_sandbox.js").install(Storage, sb);');
  process.exit(1);
}

console.log('✓ 无脚本会写真实账套目录 —— 数据隔离完好');
process.exit(0);
