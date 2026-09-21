#!/usr/bin/env node
'use strict';
/* ============================================================
 * check_helper_deps.js —— 全局桥（__TY_HELPERS__）依赖检查
 *
 * 【为什么要这个脚本】
 *   架构：app.js（传统 IIFE，先执行）把 helper 挂到 globalThis.__TY_HELPERS__，
 *         页面模块（ESM，后加载）再从该全局对象取依赖。
 *   这是【隐式依赖 + 加载顺序依赖】—— 某个名字没挂上时不会在启动时报错，
 *   只在用户点到那个功能时才崩，属于最难发现的一类问题。
 *
 *   【前科】Opening.js 曾用 H.exportTable，但该名字从未挂上全局，
 *   用户点「期初导出」直接抛错；后来改成 ESM import 才修好（见该文件注释）。
 *   本脚本要防的正是这一类：让「漏挂一个 helper」在回归阶段就暴露，
 *   而不是等用户点到才发现。
 *
 * 【为什么不干脆全部改成 ESM import】
 *   app.js 是 IIFE（非模块、无 export），页面不可能 import 它。
 *   真要改必须先把 helper 从 app.js 抽成独立的 js/common/*.js —— 那是重构，
 *   适合增量进行（项目已在走这条路，如 common/subject-name.js）。
 *   本脚本是「立刻见效的低成本防线」，与迁移并不冲突。
 *
 * 【判定分级】
 *   ✗ 失败（退出码 1）：引用了 H.xxx，该名字既未注册、且在本文件无任何降级保护
 *                      —— 用户点到必崩
 *   ⚠ 提示（不影响退出码）：
 *       a. 未注册但有降级（H.x || … / if (H.x) / typeof H.x）
 *          —— 能跑，但降级分支的口径可能与别处不一致
 *       b. __TY_HELPERS__ 已注册但全项目零引用 —— 可能是死代码，可清理
 *
 * 【扫描范围】只扫自有 ESM 模块（js/pages · js/components · js/common），
 *   刻意排除 mdb-reader / xlsx / buffer 等第三方库 —— 它们内部也有 `H.` 变量名，
 *   纳入会全部误报。
 *
 * 用法：node tools/check_helper_deps.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const fails = [];
const warns = [];

/* ---------------- 收集 __TY_HELPERS__ 已注册的名字 ---------------- */
const registered = new Set();
(function () {
  const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  // ① 对象字面量里注册的：`globalThis.__TY_HELPERS__ = { a: pick(a), b: pick(b), … }`
  const blk = /globalThis\.__TY_HELPERS__\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(appSrc);
  if (blk) {
    const re = /([A-Za-z_$][\w$]*)\s*:/g; let m;
    while ((m = re.exec(blk[1]))) registered.add(m[1]);
  }
  // ② 之后追加注册的：`globalThis.__TY_HELPERS__.tyPrint = tyPrint;`
  const re2 = /globalThis\.__TY_HELPERS__\.([A-Za-z_$][\w$]*)\s*=/g; let m2;
  while ((m2 = re2.exec(appSrc))) registered.add(m2[1]);
})();

/* ---------------- 扫描范围 ---------------- */
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.js$/.test(d.name) && !/\.min\./.test(d.name)) out.push(p);
  });
  return out;
}
const FILES = walk(path.join(ROOT, 'js', 'pages'))
  .concat(walk(path.join(ROOT, 'js', 'components')))
  .concat(walk(path.join(ROOT, 'js', 'common')));

/* ---------------- 逐个文件分析 ---------------- */
// 已注册但无人引用的（疑似死代码）
const unused = new Set(registered);

// 整行注释（含块注释的 * 行）直接跳过
function isCommentLine(line) { return /^\s*(\/\/|\/\*|\*)/.test(line); }
// 剥离行尾注释 —— 只认【不在引号内】的 //，避免误伤 'http://' 之类。
// 【踩过的坑】Opening.js 的注释写着「此前 H.exportTable 未挂全局」，
//   那是对【已修复问题】的说明、并非代码引用；若不剥离注释，
//   会被当成现存断裂而误报 —— 等于把修好的问题报成还没修。
function stripComment(line) {
  var inS = null;
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (inS) { if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '/' && line.charAt(i + 1) === '/') return line.slice(0, i);
  }
  return line;
}

FILES.forEach(function (file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(ROOT, file);

  // 本文件里「有降级保护」的名字：H.x || … / if (H.x) / typeof H.x
  const guarded = new Set();
  lines.forEach(function (rawLine) {
    if (isCommentLine(rawLine)) return;
    const line = stripComment(rawLine);
    let m;
    const g1 = /H\.([A-Za-z_$][\w$]*)\s*(?:\|\||\?)/g;
    while ((m = g1.exec(line))) guarded.add(m[1]);
    const g2 = /if\s*\(\s*H\.([A-Za-z_$][\w$]*)/g;
    while ((m = g2.exec(line))) guarded.add(m[1]);
    const g3 = /typeof\s+H\.([A-Za-z_$][\w$]*)/g;
    while ((m = g3.exec(line))) guarded.add(m[1]);
  });

  // 本文件里对 H.xxx 的引用（每个名字只记首次出现，避免刷屏）
  const refs = new Map();
  lines.forEach(function (rawLine, i) {
    if (isCommentLine(rawLine)) return;
    const line = stripComment(rawLine);
    let m;
    const re = /\bH\.([A-Za-z_$][\w$]*)/g;
    while ((m = re.exec(line))) {
      const name = m[1];
      if (registered.has(name)) { unused.delete(name); continue; }   // 已注册，正常
      if (refs.has(name)) continue;
      // text 用原文（含注释），便于人工一眼看懂上下文
      refs.set(name, { line: i + 1, text: rawLine.trim().slice(0, 92), guarded: guarded.has(name) });
    }
  });

  refs.forEach(function (info, name) {
    const tag = rel + ':' + info.line;
    if (info.guarded) {
      warns.push(tag + '  引用 H.' + name + '（未注册，但有降级保护）\n            ' + info.text);
    } else {
      fails.push(tag + '  引用 H.' + name + '（未注册且无降级 → 用户点到必崩）\n            ' + info.text);
    }
  });
});

/* ---------------- 输出 ---------------- */
console.log('════ 全局桥依赖检查（check_helper_deps.js）════');
console.log('');
console.log('  __TY_HELPERS__ 已注册 ' + registered.size + ' 项；扫描自有 ESM 模块 ' + FILES.length + ' 个');
console.log('');

if (warns.length) {
  console.log('⚠ 提示 ' + warns.length + ' 处「未注册但有降级」（不影响退出码）：');
  warns.forEach(function (w) { console.log('   · ' + w); });
  console.log('');
}
if (unused.size) {
  const list = Array.from(unused).sort();
  console.log('⚠ 已注册但【经 H.xxx 方式】零引用（' + list.length + ' 项）：' + list.join('、'));
  console.log('   注：本项只统计 H.xxx 用法，并非一定是死代码 ——');
  console.log('     · tyPrint 等由页面直接走 globalThis / window 调用；');
  console.log('     · escHtml 等恰好与页面局部变量同名（页面实际写的是 const escHtml = H.esc）。');
  console.log('');
}
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 处「未注册且无降级」：');
  fails.forEach(function (f) { console.log('   · ' + f); });
  console.log('');
  console.log('结果：FAIL —— 存在会崩溃的依赖断裂。请先在 app.js 注册，或改为 ESM import。');
  process.exit(1);
}
console.log('结果：PASS —— 所有 H.xxx 引用均已注册，或已有降级保护。');
process.exit(0);
