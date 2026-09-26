'use strict';
/* ============================================================
 * run-all.js —— 回归自检的**唯一入口**
 *
 * 【为什么需要】此前 tools/ 下有 50+ 个脚本，没有统一入口：
 *   · 开发者要记住跑哪些、手动 for 循环；
 *   · CI 里更是干脆一个都不跑 —— 于是 2 个测试长期失败而无人察觉
 *     （2026-09-19 才被发现并修复）。测试写了不跑，等于没写。
 *
 * 本脚本只收「无参数、可独立运行」的四类脚本：
 *   test_*.js    单元/集成测试
 *   verify_*.js  不变量与跨模块一致性验证
 *   check_*.js   静态契约检查（源码层面的规则）
 *   sim_*.js     模拟记账验证（在真实账套副本上记账；无账套时自行跳过）
 *
 * 刻意**不**收录：
 *   _diag_*.js     诊断脚本，需按场景手工传参（且已被 .gitignore 忽略）
 *   audit_*.js     审计报告类，面向具体账套数据，输出非 pass/fail
 *   export_*.js    导出工具，有副作用
 *
 * 【sim_*.js 为什么可以进 CI】它们依赖本机存在账套，但脚本内已做
 * 「无账套即打印说明并返回 0」的处理 —— CI（ubuntu-latest）无账套时自动跳过，
 * 不会把「环境缺样本」误报成「测试失败」。本机有账套时会真正执行。
 *
 * 【两层执行（2026-09-21 新增）】
 *   全量 42 个里，sim_book(28s) + sim_replay(18s) 两个就占了约 68% 的时间，
 *   而其余 39 个合计仅约 21s。软件趋于定型、改动变少后，
 *   每次改动都等 67s 并不划算 —— 故提供 --quick 跳过这个深度层。
 *
 * 用法：
 *   node tools/run-all.js                 全部跑一遍（发版前 / CI 用，约 67s）
 *   node tools/run-all.js --quick         跳过 sim_ 深度层（日常改动后，约 21s）
 *   node tools/run-all.js --quiet         仅输出汇总与失败项
 *   （--quick 与 --quiet 可同时使用）
 *
 * 退出码：0 = 全部通过；1 = 有失败（供 CI 作为门禁使用）
 * ⚠ 注意：CI 始终跑【全量】—— --quick 只是给本机日常改动提速，不放宽门禁。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const QUICK = process.argv.includes('--quick');   // 跳过深度层（sim_*），见头部说明

const ALL = fs.readdirSync(__dirname)
  .filter(n => /^(test|verify|check|sim)_.*\.js$/.test(n))
  .sort();
// 深度层 = sim_*：在真实账套副本上模拟记账，最全面也最慢（约 47s）
const scripts = QUICK ? ALL.filter(n => !/^sim_/.test(n)) : ALL;
const skipped = QUICK ? ALL.filter(n => /^sim_/.test(n)) : [];

let pass = 0, fail = 0, skipCount = 0;
const failures = [];
const skips = [];
const t0 = Date.now();

console.log('回归自检（' + scripts.length + ' 个脚本'
  + (QUICK ? '，--quick 已跳过 ' + skipped.length + ' 个深度层' : '') + '）');
console.log('─'.repeat(58));
if (skipped.length) {
  console.log('  已跳过深度层：' + skipped.join('、'));
  console.log('  → 改核心记账逻辑、或发版前，请跑全量（不带 --quick）');
  console.log('─'.repeat(58));
}

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
  /* 【2026-09-26】"跳过"必须与"通过"分开统计（本次假绿治理的第一刀）。
     背景：约一半脚本在没有账套 / 没有 .ais / 没有 ~/Downloads 样本时，会打印"跳过：…"并 exit 0；
     而这里原先把 exit 0 一律记 pass —— 于是干净环境（尤其 CI）下"全绿"几乎不含任何真实校验。
     判据：退出码为 0 **且** 输出里有"跳过："**且** 输出里没有任何断言通过标记。
     （只看片段性的"跳过（该 .ais 无 GLBal 表）"不算 —— 那种脚本仍有断言在跑。） */
  const hasPassMark = /\d+ 项断言|项断言全部通过|结果：|通过 \d+ \/ 失败 \d+|全部通过|✓ 通过/.test(out);
  /* 跳过标记：只认「跳过」出现在**行首**或**行尾**的场合 —— 脚本的跳过提示就是这两种形态：
       「跳过：找不到 .ais → …」「跳过（该 .ais 无 GLBal 表）」「✗ 未找到金蝶科目文件，跳过」
     ⚠ 不能只判「输出里含跳过」：正文与被打印的代码片段里也会出现这两个字 ——
       实测 check_html_escape 打印的问题代码里就有「按编码跳过重复」，于是被误判成"跳过"。 */
  const isSkip = ok && !hasPassMark && /(^|\n)\s*[✗·\-]?\s*跳过[：:（(]|跳过\s*$/m.test(out);
  if (ok && isSkip) {
    skipCount++;
    skips.push(name);
    if (!QUIET) {
      const why = (out.match(/跳过[：:][^\n]*/) || [''])[0].replace(/^跳过[：:]\s*/, '').slice(0, 42);
      console.log('  ⊘ ' + name.padEnd(36) + String(ms + 'ms').padStart(8) + '   跳过（未校验）：' + why);
    }
  } else if (ok) {
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
if (skips.length) {
  console.log('跳过（本次未做任何校验，**不等于通过**）：');
  skips.forEach(n => console.log('  ⊘ ' + n));
  console.log('  → 这些脚本需要真实账套 / .ais 样本；要真正跑到它们，请在本机（有账套）跑全量。');
  console.log('');
}
console.log('通过 ' + pass + ' / 跳过 ' + skipCount + ' / 失败 ' + fail + '   耗时 ' + secs + 's');
process.exit(fail ? 1 : 0);
