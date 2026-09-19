'use strict';
/* ============================================================
 * run-all.js —— 回归自检的**唯一入口**
 *
 * 【为什么需要】此前 tools/ 下有 50+ 个脚本，没有统一入口：
 *   · 开发者要记住跑哪些、手动 for 循环；
 *   · CI 里更是干脆一个都不跑 —— 于是 2 个测试长期失败而无人察觉
 *     （2026-09-19 才被发现并修复）。测试写了不跑，等于没写。
 *
 * 本脚本只收「无参数、可独立运行」的三类脚本：
 *   test_*.js    单元/集成测试
 *   verify_*.js  不变量与跨模块一致性验证
 *   check_*.js   静态契约检查（源码层面的规则）
 *
 * 刻意**不**收录：
 *   _diag_*.js     诊断脚本，需按场景手工传参（且已被 .gitignore 忽略）
 *   audit_*.js     审计报告类，面向具体账套数据，输出非 pass/fail
 *   export_*.js    导出工具，有副作用
 *
 * 用法：
 *   node tools/run-all.js          全部跑一遍
 *   node tools/run-all.js --quiet  仅输出汇总与失败项
 *
 * 退出码：0 = 全部通过；1 = 有失败（供 CI 作为门禁使用）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

const scripts = fs.readdirSync(__dirname)
  .filter(n => /^(test|verify|check)_.*\.js$/.test(n))
  .sort();

let pass = 0, fail = 0;
const failures = [];
const t0 = Date.now();

console.log('回归自检（' + scripts.length + ' 个脚本）');
console.log('─'.repeat(58));

scripts.forEach(name => {
  const full = path.join(__dirname, name);
  const started = Date.now();
  let ok = true, out = '';
  try {
    out = execFileSync(process.execPath, [full], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,   // 单个脚本最多 2 分钟，避免 CI 里卡死
    });
  } catch (e) {
    ok = false;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const ms = Date.now() - started;
  if (ok) {
    pass++;
    if (!QUIET) {
      const summary = (out.match(/(结果：[^|\n]*|通过 \d+ \/ 失败 \d+|\d+ 项断言全部通过|全部通过[^\n]*)/g) || []).pop() || '';
      console.log('  ✓ ' + name.padEnd(36) + String(ms + 'ms').padStart(8) + (summary ? '   ' + summary.slice(0, 34) : ''));
    }
  } else {
    fail++;
    failures.push({ name, out });
    console.log('  ✗ ' + name.padEnd(36) + String(ms + 'ms').padStart(8));
  }
});

console.log('─'.repeat(58));
if (failures.length) {
  console.log('失败详情：');
  failures.forEach(f => {
    const tail = f.out.trim().split('\n').filter(l => /✗|Error|error|不通过|失败/.test(l)).slice(0, 4);
    console.log('  【' + f.name + '】');
    (tail.length ? tail : f.out.trim().split('\n').slice(-3)).forEach(l => console.log('    ' + l.trim().slice(0, 100)));
  });
  console.log('');
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('通过 ' + pass + ' / 失败 ' + fail + '   耗时 ' + secs + 's');
process.exit(fail ? 1 : 0);
