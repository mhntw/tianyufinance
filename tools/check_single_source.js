#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/check_single_source.js —— 「口径单点化」静态卡口（基线棘轮）
 *
 * 【为什么需要】
 *   2026-09 连续两起缺陷，根因完全相同：**同一个业务口径被复制到多个消费点**。
 *     · 余额「方向 + 符号」的换算散落在 总账/明细账/多栏账/余额表/凭证提示 各处
 *       → 总账与明细账对同一笔余额反号；
 *     · 「隐藏零行」判据被内联了 4 份，其中 3 份漏了本年累计
 *       → 5801 所得税费用（本年累计 527.93）在余额表里消失。
 *   只要口径有 N 份实现，"改一处漏 N−1 处"就是必然事件，不是偶发失误。
 *   动态一致性由 verify_cross_page.js 兜底，本脚本负责**从源头堵住新增分叉**。
 *
 * 【为什么用「基线棘轮」而不是一律禁止】
 *   存量待收口的地方有几十处，一次性全禁会让门禁长期变红 → 红久了就没人看（狼来了）。
 *   故：以当前命中数为基线，**只许减少、不许增加**。收口一处就把基线调低一格，
 *   直到归零后本规则转为"零容忍"。这样门禁永远可信，改进可持续。
 *
 * 用法：
 *   node tools/check_single_source.js            # 与基线比较（超标即失败）
 *   node tools/check_single_source.js --list      # 列出全部命中位置（收口用清单）
 *   node tools/check_single_source.js --write     # 用当前命中数重写基线（仅在确有减少后使用）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const BASELINE_FILE = path.join(__dirname, '_single_source_baseline.json');

// 第三方/打包产物不扫（它们与业务口径无关）
const SKIP = [/xlsx\.full\.min\.js$/, /[\\/]mdb-reader\.js$/, /[\\/]buffer\.js$/, /[\\/]xlsx\.js$/];

// 允许持有口径的**唯一**位置：取数/数据转换层（页面只能消费）
//   · store.js       —— 取数与显示口径的唯一实现（displayBalance / splitBalance / dirName …）
//   · standards.js   —— 会计科目表等标准数据
//   · kis-import.js  —— 金蝶数据转换层：把 GLBal 的带符号期初拆成借贷两列属于**数据形态转换**，
//                       不是显示换算，故允许在此持有（它不渲染任何界面）
const ALLOW = ['js/store.js', 'js/standards.js', 'js/kis-import.js'];

const RULES = [
  {
    id: 'balance-arith',
    desc: '页面直接对余额字段做加减（换算应由 store 单点提供）',
    re: /\b(?:obDr|obCr|endDr|endCr|ytdDr|ytdCr|periodDr|periodCr)\b\s*[-+]\s*\b(?:obDr|obCr|endDr|endCr|ytdDr|ytdCr|periodDr|periodCr)\b/
  },
  {
    id: 'inline-zero-row',
    desc: '内联「零行」判据（必须调 store.isZeroLedgerRow）',
    re: /\b(?:obDr|obCr|periodDr|periodCr|ytdDr|ytdCr)\b\s*===?\s*0/
  },
  {
    id: 'dir-sign-convert',
    desc: '按科目正常方向手工换算余额符号（应由 store 单点提供）',
    re: /(?:normalDir|normal)\s*===\s*['"](?:dr|cr)['"]\s*\?/
  },
  {
    id: 'inline-dir-text',
    desc: '内联「借/贷」方向文本（方向文本应由单点产生）',
    re: /['"](?:借|贷)['"]\s*:\s*['"](?:借|贷)['"]/
  },
  {
    /* 【2026-09-26 新增类目】金额归零到分的重复实现。
       背景：2026-09-26 审查发现**两份** round2 分叉 ——
         · store.js:235 的 round2（含 -0 归一，规范版）
         · app.js 的 `Math.round(U.num(n)*100)/100`（**少了 -0 归一**，( -0 ).toLocaleString() 会显示 "-0.00"）
         · store.js carryProfitDistribute 里还内联了第三份（同样少了 -0 归一）
       三份实现改一处必漏两处，故立此规则锁死：只在 store.js（ALLOW）里出现才算合法。
       判据：`Math.round( … * 100 ) / 100`。 */
    id: 'inline-round2',
    desc: '内联金额归零（四舍五入到分）—— 必须调单点 round2（它还负责把 -0 归一成 0）',
    // ⚠ 必须允许表达式里带括号（如 `Math.round((a - b) * 100) / 100`）—— 第一版写成 `[^()]*`
    //    只匹配到最简单的 `x * 100`，把绝大多数真实命中都漏掉了（规则形同虚设）。
    re: /Math\.round\s*\(.*\*\s*100\s*\)\s*\/\s*100/
  }
];

function walk(dir, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  names.forEach(function (n) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(n) && !SKIP.some(function (r) { return r.test(p); })) out.push(p);
  });
  return out;
}

const files = walk(JS_DIR, []).sort();
const counts = {};      // id → { file → [行号…] }
RULES.forEach(function (r) { counts[r.id] = {}; });

files.forEach(function (p) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  if (ALLOW.indexOf(rel) >= 0) return;               // 取数层为口径的合法持有者
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch (e) { return; }
  lines.forEach(function (line, i) {
    const t = line.trim();
    // 跳过纯注释行：注释里讨论口径是合理的（说明性文字不该被当作实现）
    if (t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0) return;
    RULES.forEach(function (r) {
      if (r.re.test(line)) {
        counts[r.id][rel] = counts[r.id][rel] || [];
        counts[r.id][rel].push(i + 1);
      }
    });
  });
});

function totalOf(id) {
  return Object.keys(counts[id]).reduce(function (a, f) { return a + counts[id][f].length; }, 0);
}
const now = {};
RULES.forEach(function (r) { now[r.id] = totalOf(r.id); });

const LIST = process.argv.indexOf('--list') >= 0;
const WRITE = process.argv.indexOf('--write') >= 0;

if (LIST) {
  console.log('口径单点化 —— 待收口清单（共 ' + RULES.reduce(function (a, r) { return a + now[r.id]; }, 0) + ' 处）');
  console.log('─'.repeat(70));
  RULES.forEach(function (r) {
    console.log('');
    console.log('【' + r.id + '】' + r.desc + '　命中 ' + now[r.id] + ' 处');
    Object.keys(counts[r.id]).sort().forEach(function (f) {
      console.log('   ' + f + '  L' + counts[r.id][f].join(', L'));
    });
  });
  process.exit(0);
}

let BASE = null;
try { BASE = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) { BASE = null; }

if (WRITE || !BASE) {
  const payload = {
    _comment: 'check_single_source.js 基线：口径实现的当前命中数，只许减少不许增加。收口后请用 --write 下调。',
    _updated: 'auto',
    counts: now
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (!BASE) {
    console.log('已生成基线：' + path.relative(ROOT, BASELINE_FILE));
    console.log('  当前基线：' + RULES.map(function (r) { return r.id + '=' + now[r.id]; }).join('　'));
    console.log('  说明：门禁从此刻起只允许口径命中数**减少**，不允许增加。');
    console.log('  收口清单见：node tools/check_single_source.js --list');
  } else {
    console.log('已按当前命中数重写基线：' + RULES.map(function (r) { return r.id + '=' + now[r.id]; }).join('　'));
  }
  process.exit(0);
}

/* ---------- 与基线比较 ---------- */
let worse = 0, better = 0;
const lines = [];
RULES.forEach(function (r) {
  const b = (BASE.counts && typeof BASE.counts[r.id] === 'number') ? BASE.counts[r.id] : 0;
  const n = now[r.id];
  const mark = n > b ? '✗' : (n < b ? '↑' : '·');
  if (n > b) worse++;
  if (n < b) better++;
  lines.push('  ' + mark + ' ' + r.id.padEnd(18) + '当前 ' + String(n).padStart(3) + '　基线 ' + String(b).padStart(3)
    + (n > b ? '　← 新增 ' + (n - b) + ' 处口径实现！' : (n < b ? '　← 已收口 ' + (b - n) + ' 处，可 --write 下调基线' : '')));
});

console.log('口径单点化检查（只许减少，不许增加）');
console.log('─'.repeat(70));
lines.forEach(function (l) { console.log(l); });
console.log('─'.repeat(70));

if (worse) {
  console.log('❌ 有 ' + worse + ' 项口径实现数超过基线 —— 说明又出现了「同一口径多处实现」，这是分叉的前兆。');
  console.log('   正确做法：把该口径收敛到 store.js 的单点方法，页面只调用它（参考 isZeroLedgerRow）。');
  console.log('   待收口位置：node tools/check_single_source.js --list');
  process.exit(1);
}
console.log('✅ 口径实现数未增加' + (better ? '（且已有 ' + better + ' 项减少）' : '') + ' ✓');
if (better) console.log('   提示：改动确已收口，可执行 node tools/check_single_source.js --write 下调基线，把成果固化。');
process.exit(0);
