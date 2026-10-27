#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/check_duplicate_keys.js —— 对象字面量重复键检查
 *
 * 【为什么需要】JS 对象字面量里同名键**后者静默覆盖前者**：不报错、不警告、看不出来。
 *   store.js 的全局单例 S 有 180+ 个方法，一旦重名，就等于"某个方法永远不生效"，
 *   而且调用方毫无察觉。2026-10-27 真实发生过一次：新增的 setParam 覆盖了既有的同名
 *   方法，表现为"测试断言突然红，但代码看着完全正常"。
 *
 * 检查范围：js/store.js 的 S 对象（depth=1 的键）。其余模块按需加入 FILES。
 * 用法：node tools/check_duplicate_keys.js
 * 退出码：0 = 无重复；1 = 有重复
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['js/store.js'];

let fail = 0;

FILES.forEach(function (relFile) {
  const file = path.join(ROOT, relFile);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
    console.log('✗ 读取失败：' + relFile);
    fail++;
    return;
  }

  const m = src.match(/(?:const|var|let) S = \{/);   // 全局单例的对象字面量起点
  if (!m) {
    console.log('✗ ' + relFile + ' 里找不到 `S = {`');
    fail++;
    return;
  }

  const start = m.index + m[0].length - 1;       // 指向 '{'
  let depth = 0;
  const seen = Object.create(null);
  const dups = [];
  let line = src.slice(0, start).split('\n').length;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') line++;
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;

    /* 在 depth=1 且处于行首缩进位置时取键名：^\s{4}key: */
    if (ch === '\n') {
      const rest = src.slice(i + 1, i + 200);
      const km = rest.match(/^ {4}([A-Za-z_$][\w$]*)\s*:/);
      if (km) {
        const k = km[1];
        if (seen[k]) dups.push({ key: k, first: seen[k], dup: line + 1 });
        else seen[k] = line + 1;
      }
    }
  }

  const total = Object.keys(seen).length;
  if (dups.length) {
    fail++;
    console.log('✗ ' + relFile + '：' + dups.length + ' 个重复键（后者会静默覆盖前者）');
    dups.forEach(d => console.log('    · ' + d.key + '  首次 L' + d.first + '，重复 L' + d.dup));
  } else {
    console.log('✓ ' + relFile + '：' + total + ' 个键，无重复');
  }
});

console.log('');
if (fail) {
  console.log('✗ 重复键检查：' + fail + ' 个文件有问题');
  process.exit(1);
}
console.log('✓ 重复键检查：通过');
process.exit(0);
