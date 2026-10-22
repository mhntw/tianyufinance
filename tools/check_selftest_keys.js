#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/check_selftest_keys.js —— 结账清单按 key 反查运行期自检 的静态卡口
 *
 * 【为什么需要】
 *   store.js 的 settleChecklist（结账清单，硬性拦截结账）与 runSelfTest（防算错自检）
 *   必须共用同一套判定，否则会出现「横幅说账不平、结账说可以结」的死锁。
 *   runSelfTest 只在不平时才 push 一条 item（absence = OK 语义），settleChecklist 靠
 *   pickSelfTestItem 找到那条 item 来定 fail/ok。
 *
 *   2026-10-22 之前，pickSelfTestItem 按**中文标签子串**反查（如 '期初余额借贷不平'）。
 *   隐患：有人只是把 runSelfTest 里的显示文案改短一点，反查就落空 → 命中 else 分支
 *   → 结账清单 report 'ok'（初始化余额试算通过）→ **期初不平的账也能结账**。
 *   这是硬门槛的静默放行，最危险的一类，且原 zero 测试守护（grep 过，tools/ 下 0 处命中）。
 *
 *   修复：runSelfTest 的 push 给每条 item 加稳定 key（openingBal / bsBal / plRef …），
 *   pickSelfTestItem 改为按 key 反查。标签文案可随意改，key 不动就不失配。
 *
 *   本卡口守住"二者 key 集合对应"这条不变量：settleChecklist 期望反查的每一个 key，
 *   runSelfTest 都必须以该 key push 过。否则立即红（含负向测试，见底部）。
 *
 * 用法：node tools/check_selftest_keys.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'js', 'store.js');
const src = fs.readFileSync(SRC, 'utf8');

// push(...) 只可能是 runSelfTest 里的助手（level 为 'error'/'warn'/'info'）。
// 末参若是纯 [A-Za-z_]+ 字符串字面量，即该项 key。
// ⚠ 不能用「逗号分隔」去切参：detail 里会嵌 yuanFmt(Math.abs(opDr - opCr)) 这种带逗号的
//   表达式，会切断正则。改为手动配对括号，再取末尾的 ', 'key')'。
function extractPushCalls(code) {
  const calls = [];
  const re = /(^|[^.\w])push\(/g;
  let m;
  while ((m = re.exec(code))) {
    const start = m.index + m[1].length;
    let depth = 0, j = code.indexOf('(', start);
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    calls.push(code.slice(start, j + 1));
  }
  return calls;
}
const expRe = /pickSelfTestItem\(\s*'([A-Za-z_]+)'\s*\)/g;

function analyze(code) {
  const pushed = [];
  extractPushCalls(code).forEach(function (call) {
    if (!/^push\(\s*'(?:error|warn|info)'/.test(call)) return;
    const tail = /,\s*'([A-Za-z_]+)'\s*\)\s*$/.exec(call);
    if (tail) pushed.push(tail[1]);
  });
  const expected = [];
  let m;
  while ((m = expRe.exec(code))) expected.push(m[1]);
  return { pushed: pushed, expected: expected };
}

function run(code, label) {
  const a = analyze(code);
  const set = new Set(a.pushed);
  const missing = a.expected.filter(k => !set.has(k));
  const bad = [];
  if (missing.length) {
    bad.push(label + '：结账清单按 key 反查 [' + missing.join(', ') + ']，但 runSelfTest 未以该 key push 对应项'
      + '（失配 → 反查落空 → 结账清单误报通过，硬门槛静默放行）');
  }
  // 期望反查的 key 也不得为空（否则等于卡口自己没取到，说明上面正则失效）
  if (!a.expected.length) bad.push(label + '：未在 settleChecklist 找到任何 pickSelfTestItem(key) 调用（正则可能失效）');
  return bad;
}

let fails = run(src, 'js/store.js');
let bad = fails.length;
fails.forEach(msg => console.error('  ✗ ' + msg));

if (bad) {
  console.error('\n✗ 自检 key 卡口未通过（' + bad + ' 项）');
  process.exit(1);
}
console.log('✓ 自检 key 卡口通过：settleChecklist 反查 key [' + analyze(src).expected.join(', ') + ']'
  + ' 均已在 runSelfTest 中以相同 key push（改文案不会失配）');

/* ---------- 负向测试：把 runSelfTest 里 openingBal 的 key 改坏，卡口必须红 ---------- */
const broken = src.replace(/,\s*'openingBal'\)/, ", 'openingBalX')");
const neg = run(broken, '（负向）篡改后的 store.js');
if (neg.length === 0) {
  console.error('  ✗ 负向测试失败：把 key 改坏后卡口仍通过 —— 卡口无效');
  process.exit(1);
}
console.log('✓ 负向测试通过：key 失配时卡口会红（' + neg.length + ' 处告警）');
process.exit(0);
