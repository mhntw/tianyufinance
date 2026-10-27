#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/check_arch_boundaries.js —— 架构边界（棘轮：只许变好，不许变坏）
 *
 * 【为什么用检查脚本而不是拆文件】边界不是靠目录结构，而是靠"谁能写什么"的强制。
 *   store.js 是 6k 行的全局单例，拆成 8 个文件后文件之间照样可以互相穿透 —— 那只是
 *   制造"看起来有架构"的错觉。先把三条最贵的边界钉死，再机会式地把逻辑抽成纯函数。
 *
 * 三条边界：
 *   B1（硬性 0）落盘唯一入口：`Storage.saveBook(` 只允许出现在 js/store.js。
 *     任何页面直调都绕过写前体检与损坏熔断 —— 这是真实发生过的旁路（改名其它账套、
 *     还原后去重）。统一走 S.saveSnapshotChecked / S.persist。
 *   B2（棘轮）状态写唯一入口：js/pages、js/app.js、js/components 里直接写
 *     `S.state.x = …` 的次数只许降不许升。目标是把页面改为调 S.update(fn)，
 *     由 store 统一"写后清缓存"，根治"15 处各自清 _glCache"那类事故。
 *   B3（硬性 0）取数唯一入口：js/pages 里不得出现 `vouchers.forEach/filter/map/reduce`。
 *     所有账簿/报表取数必须经 generalLedger 派生（当前已达成，此断言防回退）。
 *
 * 用法：node tools/check_arch_boundaries.js [--write]
 *   --write  把当前计数写为新的基线（只应在计数**下降**后使用）
 * 退出码：0 = 通过；1 = 越界
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE_FILE = path.join(__dirname, '_arch_boundaries_baseline.json');
const WRITE = process.argv.includes('--write');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '_probe') walk(p, out); }
    else if (/\.js$/.test(e.name) && !/\.min\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = walk(path.join(ROOT, 'js'), []);
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const isComment = ln => /^\s*(\/\/|\*|\/\*)/.test(ln);

const b1 = [], b3 = [], b2Where = [];
let b2 = 0;

FILES.forEach(function (f) {
  const r = rel(f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach(function (ln, i) {
    if (isComment(ln)) return;
    const at = r + ':' + (i + 1);
    if (r !== 'js/store.js' && /Storage\.saveBook\s*\(/.test(ln)) b1.push(at);
    if (/^(js\/pages\/|js\/app\.js$|js\/components\/)/.test(r) &&
        /S\.state(\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=[^=]/.test(ln)) { b2++; b2Where.push(at); }
    if (/^js\/pages\//.test(r) && /\.vouchers\.(forEach|filter|map|reduce)\s*\(/.test(ln)) b3.push(at);
  });
});

let base = {};
try { base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch (e) { base = {}; }
const baseB2 = Number(base.B2 || 0);

if (WRITE) {
  fs.writeFileSync(BASE_FILE, JSON.stringify({ B2: b2 }, null, 2) + '\n', 'utf8');
  console.log('已把状态写穿透基线更新为 B2=' + b2);
}

let fail = 0;

if (b1.length) {
  fail++;
  console.log('✗ B1 落盘入口：' + b1.length + ' 处绕过 store（必须为 0）');
  b1.slice(0, 10).forEach(x => console.log('    · ' + x));
} else {
  console.log('✓ B1 落盘入口：所有写盘都经 js/store.js');
}

if (b3.length) {
  fail++;
  console.log('✗ B3 取数入口：' + b3.length + ' 处页面直接遍历凭证（必须为 0）');
  b3.slice(0, 10).forEach(x => console.log('    · ' + x));
} else {
  console.log('✓ B3 取数入口：页面全部经 generalLedger 派生');
}

if (b2 > baseB2) {
  fail++;
  console.log('✗ B2 状态写穿透：' + b2 + ' 处，超过基线 ' + baseB2 + '（新增的直接赋值）');
  b2Where.slice(baseB2).forEach(x => console.log('    · ' + x));
} else {
  console.log('✓ B2 状态写穿透：' + b2 + ' 处 ≤ 基线 ' + baseB2 + (b2 < baseB2 ? '（已下降，可跑 --write 下调基线）' : ''));
}

console.log('');
if (fail) {
  console.log('✗ 架构边界：' + fail + ' 条越界');
  process.exit(1);
}
console.log('✓ 架构边界：三条边界守住（B1=0, B3=0, B2=' + b2 + ' ≤ ' + baseB2 + '）');
process.exit(0);
