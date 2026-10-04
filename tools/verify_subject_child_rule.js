#!/usr/bin/env node
/* ============================================================================
 * 「子科目」判定规则的回归（2026-10-04 新增）
 *
 * 【为什么立】原 js/pages/home/Home.js 的 isChildOf 要求"长度差 ≥2"，
 * 那是在假设科目编码是 4→6→8 的偶数位；而绅蓝之星是金蝶风格**不等长**编码
 * （4 位 69 / 6 位 7 / **7 位 326** / 9 位 17），于是漏判 `22210102`（销项税额）
 * 属于 `2221010` —— 数据里 parent 字段写得明明白白。纯前缀规则则与 parent 字段
 * 声明的 341 / 351 对父子关系**零偏差**（对照脚本实测）。
 *
 * 【两条判据】
 *  ① 单元：单点 U.isChildCode 的语义（自身不算/非前缀不算/不等长要算/带点要算/空父级为假）；
 *  ② 真实账套不变式：每个科目**声明的 parent** 都必须满足 isChildCode(parent, code)
 *     —— 这条才是当初能自动发现"差≥2 漏判"的判据；无账套时跳过并说明（**跳过 ≠ 通过**）。
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, skipped = 0;
function ck(ok, name, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '　→ ' + detail : '')); }
}

/* ---------- 取单点实现（按源码提取；整文件 eval store.js 需要一整套浏览器环境） ---------- */
const storeSrc = fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8');
function extract(name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(storeSrc);
  if (!m) throw new Error('store.js 里找不到 ' + name);
  let depth = 0, end = -1;
  for (let j = storeSrc.indexOf('{', m.index); j < storeSrc.length; j++) {
    if (storeSrc[j] === '{') depth++;
    else if (storeSrc[j] === '}') { depth--; if (!depth) { end = j; break; } }
  }
  return (0, eval)('(' + storeSrc.slice(m.index, end + 1) + ')');
}

console.log('子科目判定规则测试：');
const isChildCode = extract('isChildCode');

/* ---------- ① 单元语义 ---------- */
ck(isChildCode('2221010', '22210102') === true,
  '不等长父子的真实案例：2221010 ↳ 22210102 必须为真（旧"差≥2"实现正是在此漏判）');
ck(isChildCode('1002', '100201') === true, '常规偶数位：1002 ↳ 100201 为真');
ck(isChildCode('1002', '1002') === false, '自身不算下级');
ck(isChildCode('1002', '1003') === false, '同长度不同编码不算下级');
ck(isChildCode('1002', '999999') === false, '非前缀不算下级');
ck(isChildCode('1002', '1002.01') === true, '带点编码：1002 ↳ 1002.01 为真');
ck(isChildCode('1122.03', '1122.0301') === true, '带点层级再下一级为真');
ck(isChildCode('', '1001') === false, '空父级一律为假（避免把一切当成子级）');
ck(isChildCode(null, '1001') === false, '父级为 null 为假');
ck(isChildCode('1002', '') === false, '子级为空为假');
ck(isChildCode('100', '1002') === true, '前缀更短也算（是否同层级由调用方语义决定，单点只判前缀+更长）');

/* ---------- ② 真实账套不变式 ---------- */
function booksDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '添钰财务', 'books');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), '添钰财务', 'books');
}
const dir = booksDir();
let files = [];
try { files = fs.readdirSync(dir).filter(f => /\.json$/.test(f) && !/\.bak/.test(f)); } catch (e) { files = []; }

if (!files.length) {
  skipped++;
  console.log('  ⊘ 真实账套不变式：未找到账套目录（' + dir + '）—— 跳过，**不等于通过**');
} else {
  const legacyChild = function (p, c) {   // 旧的"差≥2"规则，仅用于对照报告
    if (c.length <= p.length) return false;
    if (c.indexOf(p + '.') === 0) return true;
    if (p.indexOf('.') < 0 && c.indexOf('.') < 0) return c.indexOf(p) === 0 && (c.length - p.length) >= 2;
    return false;
  };
  files.forEach(function (f) {
    let book;
    try { book = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
    const subs = book.subjects || (book.state && book.state.subjects) || [];
    const declared = subs.filter(s => s.parent);
    const bad = declared.filter(s => !isChildCode(String(s.parent), String(s.code)));
    const legacyMiss = declared.filter(s => !legacyChild(String(s.parent), String(s.code)));
    ck(bad.length === 0,
      '真实账套 ' + f.slice(0, 14) + '…：' + declared.length + ' 对声明父子关系全部满足 U.isChildCode',
      bad.slice(0, 3).map(s => s.code + '（parent=' + s.parent + '）').join('、'));
    console.log('      （对照：旧"差≥2"规则在此账套漏判 ' + legacyMiss.length + ' 对'
      + (legacyMiss.length ? '，例：' + legacyMiss.slice(0, 3).map(s => s.code + ' ↳ ' + s.parent).join('；') : '') + '）');
  });
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败' + (skipped ? ', ' + skipped + ' 跳过' : ''));
process.exit(fail ? 1 : 0);
