#!/usr/bin/env node
'use strict';
/* ============================================================
 * 跨口径对账（Cross-check）—— 专治「同一财务事实、多条算法」的不一致
 *
 * 【为什么需要】2026-09-21 查出「利润表用单边发生额、结转用净额」导致
 *   报表净利润与结转金额分叉（6/8 个月、最大 -47429.72）。这个 bug 能长期存活，
 *   是因为**原有检查全都只验证「单条路径内部自洽」**：
 *     · I1–I10：各条路径自身成立（利润表自己算得没错，只是与结转不是一回事）
 *     · audit_books.js 的「结转口径 = 利润表口径」：两边都按「净额」比较，
 *       而真实实现是「单边」—— 检查的假设与实现不符，故通过却漏报
 *     · sim_book：手算场景无红冲，单边 = 净额，看不出差别
 *   本脚本换思路：把「同一件事的不同算法」两两拿出来对，不一致就报。
 *
 * 【对账项】对每个账套、每个有凭证的期间：
 *   C1 结转凭证 3103 净额      == 排除结转凭证后的损益净额（金蝶视角的"结转=净额"）
 *   C2 利润表 netProfit        == C1（报表口径 == 结转口径）    ← 就是 I11
 *   C3 unclosedProfit          == generalLedger 损益科目余额之和（末级，防父子重复）
 *   C4 利润表「本年累计净利润」 == 3103 期末余额 + unclosedProfit
 *   C5 plSummary（首页）netProfit == profitStatement（报表）netProfit
 *   C6 balanceSheet 资产 − 负债 − 权益 == 0
 *   C7 现金流量表：期初 + Σ净额 == 期末
 *
 * 【安全】全程内存副本，persist 等一律 mock；不写盘。
 * 用法：node tools/verify_cross_check.js [账套JSON路径]
 * ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path');

function booksDir() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', '添钰财务', 'books');
  return path.join(h, '.local', 'share', '添钰财务', 'books');
}
let BF = process.argv[2] || null;
if (!BF) {
  try {
    const d = booksDir();
    if (fs.existsSync(d)) {
      const f = fs.readdirSync(d).filter(function (x) { return x.endsWith('.json') && x.indexOf('.bak') < 0; }).sort();
      if (f.length) BF = path.join(d, f[0]);
    }
  } catch (e) { }
}
if (!BF || !fs.existsSync(BF)) { console.log('跳过：未找到账套'); process.exit(0); }

const RAW = fs.readFileSync(BF, 'utf8');
global.window = global;
global.localStorage = { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } };
global.document = { getElementById: function () { return null; }, addEventListener: function () { }, querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
global.__TAURI__ = {}; if (typeof global.isTauri === 'undefined') global.isTauri = false;
try { global.navigator = { userAgent: 'node' }; } catch (e) { }
global.fetch = function () { return Promise.reject(new Error('no net')); };

require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;
S.persist = function () { }; S.save = function () { return Promise.resolve(); };
S.addLog = function () { }; S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) { global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); }; }

S.state = JSON.parse(RAW);
S.bookId = '__CROSSCHECK__';
S._glCache = {};
if (S.normalizeState) S.normalizeState();

const num = function (v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const R = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
const EPS = 0.01;

const months = Array.from(new Set((S.state.vouchers || []).filter(function (v) { return v.deleted !== 'y'; })
  .map(function (v) { return String(v.date || '').slice(0, 7); })
  .filter(function (m) { return /^\d{4}-\d{2}$/.test(m); }))).sort();

console.log('账套：' + path.basename(BF));
console.log('期间：' + months.join(', '));
console.log('');

let totalBad = 0;
const badList = [];

function chk(tag, label, got, want) {
  const d = R(got - want);
  const ok = Math.abs(d) < EPS;
  if (!ok) { totalBad++; badList.push(tag + ' ' + label); }
  return { ok: ok, d: d };
}

months.forEach(function (m) {
  const issues = [];

  // ---- C1 / C2：结转口径 vs 损益净额 vs 利润表 ----
  let carry = 0, carryN = 0;
  (S.state.vouchers || []).forEach(function (v) {
    if (v.deleted === 'y') return;
    if (String(v.date || '').slice(0, 7) !== m) return;
    const isC = /carryPL/i.test(v.kind || '');
    if (!isC) return;
    // 排除年末结转（摘要「结转本年利润」），它属于 3103→利润分配，不是当期损益结转
    if (/结转本年利润/.test(String(v.summary || ''))) return;
    carryN++;
    (v.entries || []).forEach(function (e) {
      if (String(e.code) === '3103') carry += num(e.cr) - num(e.dr);
    });
  });

  // 损益净额（排除结转凭证）—— 逐分录累加，**含非末级科目**。
  // 【为什么不能只算末级】实测绅蓝之星：部分损益直接记在一级科目 5403（其下有明细）上，
  //   只算末级会把它整笔漏掉。差异与 5403 的净影响逐月逐一吻合（2026-01 差 -8,131.21、
  //   2026-03 差 -5,428.29、2026-06 差 -9,623.57 均为该科目当月发生额），共 12 个月误报。
  //   利润表与结转都是「逐分录累加」，本就含非末级 —— 此处对齐它们。
  // 【为什么不会父子重复】逐分录累加只对每笔分录计一次，不涉及科目上下级关系；
  //   只有「按科目余额上卷」才会父子重复，故这里无需按末级过滤。
  let net = 0;
  const leaf = {};
  (S.state.subjects || []).forEach(function (s) {
    if (!S.childCodesOf(s.code).length) leaf[String(s.code)] = s;
  });
  (S.state.vouchers || []).forEach(function (v) {
    if (v.deleted === 'y') return;
    if (String(v.date || '').slice(0, 7) !== m) return;
    if ((v.entries || []).some(function (e) { return /carryPL/i.test(v.kind || ''); })) return; // 排除结转凭证
    (v.entries || []).forEach(function (e) {
      const s = S.subject(e.code);                 // 含非末级，与利润表/结转同口径
      if (!s) return;
      if (String(e.code) === '3103' || String(e.code) === '3104') return;
      if (s.cls === 'revenue') net += num(e.cr) - num(e.dr);
      else if (s.cls === 'expense') net -= num(e.dr) - num(e.cr);
    });
  });

  if (carryN > 0) {
    const c1 = chk('C1', m + ' 结转3103净额 vs 损益净额', R(carry), R(net));
    if (!c1.ok) issues.push('C1 结转=' + R(carry) + ' 净额=' + R(net) + ' 差=' + c1.d);
    try {
      const ps = R(S.profitStatement(m).netProfit);
      const c2 = chk('C2', m + ' 利润表 vs 结转', ps, R(carry));
      if (!c2.ok) issues.push('C2 利润表=' + ps + ' 结转=' + R(carry) + ' 差=' + c2.d);
      const c2b = chk('C2', m + ' 利润表 vs 损益净额', ps, R(net));
      if (!c2b.ok) issues.push('C2 利润表=' + ps + ' 净额=' + R(net) + ' 差=' + c2b.d);
    } catch (e) { issues.push('C2 调用异常 ' + e.message); }
  }

  // ---- C3：unclosedProfit vs generalLedger 损益科目余额之和 ----
  try {
    const un = R(S.unclosedProfit(m));
    const gl = S.generalLedger(m);
    let glSum = 0;
    gl.forEach(function (r) {
      // 这里走的是「科目余额上卷」，必须只取末级 —— 否则父科目余额已含子树，父子重复累加会翻倍。
      // （与上面的「逐分录累加」不同：那条不需要过滤，因为每笔分录只计一次。）
      if (!leaf[String(r.code)]) return;
      const cls = (S.subject(r.code) || {}).cls;
      if (cls === 'revenue') glSum += R(r.endCr - r.endDr);
      else if (cls === 'expense') glSum -= R(r.endDr - r.endCr);
    });
    const c3 = chk('C3', m + ' unclosedProfit vs 总账损益余额', un, R(glSum));
    if (!c3.ok) issues.push('C3 unclosed=' + un + ' 总账=' + R(glSum) + ' 差=' + c3.d);
  } catch (e) { issues.push('C3 调用异常 ' + e.message); }

  // ---- C4：利润表「本年累计净利润」 vs 3103 期末余额 + unclosedProfit ----
  try {
    const rows = S.incomeStatement(m);
    let npRow = null;
    // 【只用 id 精确匹配】用 /净利润/ 会命中多行（标题行也含该词），取到最后一行就错了。
    rows.forEach(function (r) { if (r.id === 'netProfit') npRow = r; });
    if (npRow) {
      const ytd = R(npRow.ytd);
      const gl = S.generalLedger(m);
      const r3 = gl.filter(function (x) { return String(x.code) === '3103'; })[0];
      const bal3103 = r3 ? R(r3.endCr - r3.endDr) : 0;
      const un = R(S.unclosedProfit(m));
      // 【年末：3103 的去处要补上】年末会把「本年利润 3103」结转到「利润分配 3104x（未分配利润）」，
      // 结转后 3103 归零 —— 若不补这一项，12 月的 C4 必然假报差异（实测 2025-12：利润表累计
      // 541,189.28，而 3103=0、未结转=0，差 541,189.28）。该情形此前没暴露，是因为一直拿
      // 「单年 2026 账套」跑，从未遇到 12 月。
      // 【为什么不能无条件加「3104x 本年净变化」】跨年时上年结转来的未分配利润会在次年被转走，
      //   于是 3104x 的「本年净变化」含上年分配动作 —— 实测 2026-08 得 -1,065,163.69，
      //   反而把本来成立的等式打破（3103 已有 597,776.09，无需再补）。
      //   故：只在 3103 已清零（即本年已做年末结转）时补，且只取**本年内**「3103 与 3104x
      //   同处一张凭证」的实际转账额 —— 那才是本年净利润的去处，不含往年分配。
      let distYtd = 0;
      if (Math.abs(bal3103) < 0.01) {
        const yr = m.slice(0, 4);
        (S.state.vouchers || []).forEach(function (v) {
          if (v.deleted === 'y') return;
          const vm = String(v.date || '').slice(0, 7);
          if (vm.slice(0, 4) !== yr || vm > m) return;      // 只算本年、且不晚于当期
          const es = v.entries || [];
          if (!es.some(function (e) { return String(e.code) === '3103'; })) return;
          // 【只取 3103 的借方】= 本年利润转出到未分配利润的金额。
          //   不能取该凭证里所有 3104x 的发生额：实测绅蓝之星 2025-02 记-93 / 2025-03 记-88
          //   （均为 carryPL）同时含「贷 3103」与「贷 3104006」，那是**以前年度损益调整**
          //   （363.00 + 3,793.42 = 4,156.42），并非当年利润的去处 —— 一并计入会多出该差额。
          //   真正的年末结转是「借 3103 / 贷 3104x」，故取 3103 借方即可精确对应。
          // 条件一：该凭证必须真的与未分配利润发生往来（含 3104x），否则不是"利润的去处"。
          if (!es.some(function (e) { return String(e.code).indexOf('3104') === 0; })) return;
          // 条件二：不含任何损益类科目。用于滤掉两类干扰：
          //   · 「月末结转费用」的凭证（借 3103 / 贷 各费用科目）—— 那是费用转入本年利润，
          //     实测若计入会把金额放大到 248 万级；
          //   · 「以前年度损益调整」的 carryPL 凭证（实测绅蓝之星 2025-02 记-93 / 2025-03 记-88，
          //     含损益科目，合计 4,156.42）—— 那是往年的账，不属于本年利润。
          var hasPlCls = es.some(function (e) {
            var s = S.subject(e.code);
            return s && (s.cls === 'revenue' || s.cls === 'expense' || s.cls === 'cost');
          });
          if (hasPlCls) return;
          // 取 3103 的「借 − 贷」：盈利年为「借 3103 / 贷 3104x」得正数；
          // 亏损年为「借 3104x / 贷 3103」得负数 —— 与利润表累计同号。
          // 实测绅蓝之星 2024 为亏损（记-150 贷 3103 391,367.07），只取借方会得到 0 而漏掉。
          es.forEach(function (e) {
            if (String(e.code) !== '3103') return;
            distYtd += R(num(e.dr) - num(e.cr));
          });
        });
      }
      const c4 = chk('C4', m + ' 利润表累计 vs 3103+未结转+已转未分配利润', ytd, R(bal3103 + un + distYtd));
      if (!c4.ok) issues.push('C4 利润表累计=' + ytd + ' 3103=' + bal3103 + '+未结转' + un
        + '+已转未分配利润' + R(distYtd) + '=' + R(bal3103 + un + distYtd) + ' 差=' + c4.d);
    }
  } catch (e) { issues.push('C4 调用异常 ' + e.message); }

  // ---- C5：首页 plSummary vs 报表 profitStatement ----
  try {
    const a = R(S.profitStatement(m).netProfit);
    // plSummary().netProfit 返回的是 {cur, ytd, codes, ids} 对象（不是数值），须取 .cur
    const b = R((S.plSummary(m).netProfit || {}).cur);
    const c5 = chk('C5', m + ' 首页 vs 报表净利润', b, a);
    if (!c5.ok) issues.push('C5 首页=' + b + ' 报表=' + a + ' 差=' + c5.d);
  } catch (e) { issues.push('C5 调用异常 ' + e.message); }

  // ---- C6：资产负债表恒等式 ----
  try {
    const bs = S.balanceSheet(m);
    const d = R(num(bs.totalAsset) - num(bs.totalLiability) - num(bs.totalEquity));
    const c6 = chk('C6', m + ' 资产负债表平衡', d, 0);
    if (!c6.ok) issues.push('C6 资产-负债-权益=' + d);
  } catch (e) { issues.push('C6 调用异常 ' + e.message); }

  // ---- C7：现金流量表勾稽 ----
  try {
    const cfm = S.cashFlow(m);
    // cashFlow().items 是**对象**（按项目 id 索引），不是数组；
    // 勾稽用汇总字段：期初 + 经营 + 投资 + 筹资 + 汇率 == 期末
    const calc = R(num(cfm.opening) + num(cfm.operating) + num(cfm.investing) + num(cfm.financing) + num(cfm.exchange));
    const d7 = R(calc - num(cfm.ending));
    if (Math.abs(d7) >= EPS) issues.push('C7 期初+Σ净额=' + calc + ' 期末=' + num(cfm.ending) + ' 差=' + d7);
  } catch (e) { issues.push('C7 调用异常 ' + e.message); }

  if (issues.length) {
    console.log('  ✗ ' + m);
    issues.forEach(function (x) { console.log('        ' + x); });
  }
});

console.log('');
console.log('─'.repeat(70));
if (totalBad === 0) {
  console.log('全部一致：' + months.length + ' 个期间 × 7 项对账，无差异 ✓');
} else {
  console.log('发现 ' + totalBad + ' 处不一致：');
  badList.forEach(function (x) { console.log('   · ' + x); });
}
process.exit(totalBad === 0 ? 0 : 1);
