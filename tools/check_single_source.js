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
    // ⚠⚠ 2026-10-04 **第二次同源失效**：`* 100` 后要允许 1~2 个收尾括号 —— 原判据只认单个 `)`，
    //    于是 `Math.round((x * 100)) / 100`（多包一层括号）**判据抓不到**（实测：
    //    Voucher.js 打印页 voucherSheetMoney 就是这么写的，基线却记 0 处，规则形同虚设）。
    //    收紧后实测全库仅 store.js:237 / kis-import.js:923（均 ALLOW）命中，非 ALLOW 违规 0 处。
    re: /Math\.round\s*\(.*\*\s*100\s*\){1,2}\s*\/\s*100/
  },
  {
    /* 【2026-09-30 新增类目】结转损益状态的**分叉判定**。
       背景：「孤立结转凭证」缺陷的根因不是某处算错，而是**同一个状态被两个消费方各自下结论** ——
         · 结账检查（settleChecklist）只看「本期损益净额是否为零」→ 答「未结转，请先结转」；
         · 结转入口（carryForwardProfit）只看「有没有结转凭证」→ 答「已结转，请勿重复」。
       两句提示互斥，用户按第一句去点必然失败（新建账套与导入账套都会出现）。
       现已收敛为单点四态 store.carryForwardStatus()。本规则锁死"不再长出第二份判定"：
       页面不得自己调 periodProfitNet / carryForwardState，也不得自己按 CARRY_PL 过滤凭证
       来判「是否已结转」—— 一律经 carryForwardStatus()。
       （注意：取数仍只在 store.js 里做；本规则管的是**状态判定**，不是取数。
         kindVs/periodVouchersOfKind 用于折旧、结转成本等**其它** kind 是允许的，
         故只在同一行同时出现 CARRY_PL 时才命中。）
       动因与配套断言：verify_invariants.js 的 I13/I14、test_newbook_fuzz.js 的「状态→出口」契约表。 */
    id: 'carry-state-fork',
    desc: '页面自行判定「结转损益状态」（必须用 store.carryForwardStatus 单点四态）',
    re: /(?:periodProfitNet|carryForwardState)\s*\(|(?:periodVouchersOfKind|kindVs)\s*\([^)]*CARRY_PL/
  },
  {
    /* 【2026-09-30 新增类目】金额显示在页面自行格式化到分（金额定点化配套）。
       定点化后，金额的显示单点是 store.money()：入参是**内部定点整数**，输出 2 位千分位，
       并且会断言入参是整数（收到「元」时显式告警 —— 把"差 10000 倍"从静默错误变成可见告警）。
       页面若自行 `U.yuan(x).toFixed(2)`，等于绕过这个单点：少了千分位、少了整数断言，
       更把「整数 ↔ 元」这个单位边界重新摊回页面 —— 一旦有人写成 `x.toFixed(2)`（漏掉
       U.yuan），输出就是放大 10000 倍的金额，而且不报错。
       与 inline-round2 同一思路：存量按基线棘轮收敛，新增即红。 */
    id: 'inline-fixed2',
    desc: '页面自行把金额格式化到 2 位（应走单点 money/U.money：千分位 + 整数断言都在那里）',
    re: /U\.yuan\s*\(.*\)\s*\.toFixed\s*\(\s*2\s*\)/
  },
  {
    /* 【2026-09-30 新增类目】金额定点比例的**内联实现**（10000）。
       比例（1 元 = 10000 个最小单位）只能有一处定义：store.js 的 AMT_SCALE + 换算函数
       amt()/yuan()。页面里再出现裸 10000 参与金额换算，就是「第二份比例」—— 比例一旦调整
       （例如 4 位改 6 位），这些点会静默分叉，症状正是最难查的"金额差 10000 倍"。
       判据只认**参与运算**的 10000（*、/、比较、|| 兜底）：
         · `var GROUP_BASE = 10000`（中文大写按万分组）、`LIFE_SCALE = 10000`（年限保留 4 位）
           这类**命名常量声明**不算 —— 它们与金额比例无关，已各自命名以示区别；
         · `100000` 等更长数字不算（\b 边界已排除）。
       store.js 本身在 ALLOW 里 —— 它是比例的合法持有者。 */
    id: 'inline-amt-scale',
    desc: '内联金额定点比例 10000（应走单点 AMT_SCALE / amt() / yuan()）',
    re: /[*/]\s*10000\b|\b10000\s*[*/]|\|\|\s*10000\b|(?:<=?|>=?)\s*10000\b/
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
  try { lines = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
  /* 先抹掉块注释（斜杠+星号 到 星号+斜杠，可跨行），把非换行字符换成等量空白以保留行号，
     否则「注释里讨论口径」会被当成实现 —— 实测误报：Settle.js 的块注释里写了「1/10000」
     这类说明文字，会被 inline-amt-scale 判成内联比例。行注释仍按下方"整行以双斜杠开头"跳过。 */
  lines = lines.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); }).split('\n');
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
