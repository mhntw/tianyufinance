#!/usr/bin/env node
'use strict';
/* ============================================================
 * 跨账套口径对比（直接读金蝶 .ais，完全不经过 ty）
 *
 * 【用途】验证「利润表应取净额（并排除结转凭证）」这一结论对所有账套成立，
 *        而不只是「添钰来客_2026年」这一个。
 *
 * 【原理】对每个账套、每个已结转期间，用三份数字互相印证：
 *   ① carry —— 金蝶结转凭证里「3103 本年利润」的净额（= 金蝶认可的当期净利润）
 *   ② net   —— 排除结转凭证后，损益类科目的净发生额（收入贷-借 / 费用借-贷）
 *   ③ one   —— 同上但不轧差（收入只加贷方 / 费用只加借方）。即 ty 修复前的口径。
 *
 *   预期：① === ②（金蝶自己也是一致的）；③ 仅在账套存在红冲/冲减时偏离。
 *   若 ③ 偏离而 ①=②，说明该账套同样需要「取净额」——佐证修复的普适性。
 *
 * 用法：
 *   node tools/contrast_pl_ais.js                  # 跑内置的 5 个账套
 *   node tools/contrast_pl_ais.js <a.ais> [b.ais]  # 指定文件
 * ============================================================ */
const fs = require('fs'), path = require('path');

global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) { }
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
const MDBReader = global.MDBReader.default;

const DEFAULT_FILES = [
  '/Users/chen/Downloads/金蝶账套 ais/添钰来客_2025年_金蝶KIS格式.ais',
  '/Users/chen/Downloads/金蝶账套 ais/添钰来客_2026年_金蝶KIS格式.ais',
  '/Users/chen/Downloads/金蝶账套 ais/绅蓝之星_2024年_金蝶KIS格式.ais',
  '/Users/chen/Downloads/金蝶账套 ais/绅蓝之星_2025年_金蝶KIS格式.ais',
  '/Users/chen/Desktop/绅蓝之星_2026年_金蝶KIS格式.ais'
];
const FILES = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;

const R = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
const num = function (v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
// 【必须做这一步，否则对比毫无意义】金蝶在 .ais 里用「负数借方」表示红冲，
//   此时「只取借方」天然等于净额 —— 两种口径看不出差别。
//   而 ty 导入时会把红字规范化（见 js/kis-import.js：负借=贷方、负贷=借方、双负=双正），
//   规范化之后红冲变成「反方向正数」，单边口径就会漏掉它。
//   故此处必须复刻同一规范化，才能模拟 ty 的真实数据模型。
const norm = function (e) {
  let dr = num(e.FDebit), cr = num(e.FCredit);
  if (dr < 0 && cr < 0) { dr = -dr; cr = -cr; }
  else if (dr < 0) { cr = cr - dr; dr = 0; }
  else if (cr < 0) { dr = dr - cr; cr = 0; }
  return { dr: Math.round(dr * 100) / 100, cr: Math.round(cr * 100) / 100 };
};
const acct = function (e) { return String(e.FAcctID || '').trim(); };
// ⚠️ 坑：mdb-reader 返回的 FDate 是 **Date 对象**（不是字符串）。
//   String(new Date(...)) → "Sat Jan 03 2026 08:00:00 GMT+0800"，slice(0,7) = "Sat Jan" → 正则静默失配。
//   而 console.log 打印 Date 时也显示 ISO 格式，肉眼分辨不出类型 —— 故此处必须显式转换。
const ymOf = function (v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 7);
  return String(v || '').slice(0, 7);
};

let grandBad = 0, grandChecked = 0;

FILES.forEach(function (fp) {
  if (!fs.existsSync(fp)) { console.log('\n（跳过：文件不存在）' + fp); return; }
  let rows;
  try {
    rows = new MDBReader(fs.readFileSync(fp)).getTable('GLVch').getData() || [];
  } catch (e) {
    console.log('\n（读取失败）' + path.basename(fp) + ' : ' + e.message);
    return;
  }
  console.log('\n' + '='.repeat(74));
  console.log('账套：' + path.basename(fp) + '   分录行 ' + rows.length);
  console.log('='.repeat(74));

  const live = rows.filter(function (r) { return r.FDeleted !== true && acct(r); });
  // 按 FSerialNum 分组 = 一张凭证
  const byVch = {};
  live.forEach(function (r) { const k = String(r.FSerialNum); (byVch[k] = byVch[k] || []).push(r); });

  // ① 找结转凭证（含 3103），并借此判定哪些是损益科目及其类别
  const per = {};
  Object.keys(byVch).forEach(function (k) {
    const es = byVch[k];
    const has3103 = es.some(function (e) { return acct(e) === '3103'; });
    const has3104 = es.some(function (e) { return acct(e) === '3104'; });
    const isYearEnd = es.some(function (e) { return /结转本年利润/.test(String(e.FExp || '')); });
    // 含 3103 = 结转损益。但须排除两类「非当期损益结转」的凭证，否则 ①（3103 净额）会混入
    // 全年累计、与当期损益②对不上，造成"金蝶自身不一致"的误报：
    //   ① 摘要「结转本年利润」（3103→利润分配，实测**不含 3104**，故不能只靠 3104 判断）；
    //   ② 含 3104 的凭证（3103→3104 变体）。
    if (!has3103 || has3104 || isYearEnd) return;
    const m = ymOf(es[0].FDate);
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    per[m] = per[m] || { carry: 0, plSubs: {} };
    es.forEach(function (e) {
      const c = acct(e), _v = norm(e), dr = _v.dr, cr = _v.cr;
      if (c === '3103') { per[m].carry += cr - dr; return; }
      // 结转时「借 收入科目 / 贷 3103」→ 借方出现的是收入；「借 3103 / 贷 费用」→ 贷方出现的是费用
      if (dr > 0.005) per[m].plSubs[c] = 'rev';
      else if (cr > 0.005) per[m].plSubs[c] = 'exp';
    });
  });

  const months = Object.keys(per).sort();
  if (!months.length) { console.log('  未发现结转凭证（含 3103 的凭证），无法对比。'); return; }

  // ②③ 遍历非结转凭证，算净额与单边
  const net = {}, one = {};
  months.forEach(function (m) { net[m] = 0; one[m] = 0; });
  Object.keys(byVch).forEach(function (k) {
    const es = byVch[k];
    if (es.some(function (e) { return acct(e) === '3103'; })) return; // 排除结转凭证
    const m = ymOf(es[0].FDate);
    const p = per[m];
    if (!p) return;
    es.forEach(function (e) {
      const kind = p.plSubs[acct(e)];
      if (!kind) return;
      const _v = norm(e), dr = _v.dr, cr = _v.cr;
      // 净利润 = 收入净额 − 费用净额。费用必须【取负号】，否则收入与费用同向相加。
      if (kind === 'rev') { net[m] += cr - dr; one[m] += cr; }
      else { net[m] -= dr - cr; one[m] -= dr; }
    });
  });

  console.log('  期间      金蝶结转①      损益净额②      损益单边③    ①-②      ③-②');
  let bad = 0, drift = 0;
  months.forEach(function (m) {
    const c = R(per[m].carry), n = R(net[m]), o = R(one[m]);
    const d1 = R(c - n), d2 = R(o - n);
    const okCarry = Math.abs(d1) < 0.01;
    if (!okCarry) bad++;
    if (Math.abs(d2) >= 0.01) drift++;
    grandChecked++;
    if (!okCarry) grandBad++;
    console.log('  ' + m + '  ' + String(c).padStart(13) + '  ' + String(n).padStart(13) + '  ' +
      String(o).padStart(13) + '  ' + String(d1).padStart(8) + '  ' + String(d2).padStart(10) +
      (okCarry ? '' : '   ← ①≠②【异常】') + (Math.abs(d2) >= 0.01 ? '  [有红冲]' : ''));
  });
  const driftSum = R(months.reduce(function (a, m) { return a + (one[m] - net[m]); }, 0));
  console.log('  ── 小结：①≠② 的月份 ' + bad + '/' + months.length +
    (bad ? '（金蝶自身不一致，需人工看）' : '（金蝶结转与净额完全一致 ✓）'));
  console.log('           ③≠② 的月份 ' + drift + '/' + months.length +
    (drift ? '（存在红冲/冲减 → 单边口径会偏，合计偏 ' + driftSum + '）' : '（无红冲，两口径相同）'));
});

console.log('\n' + '='.repeat(74));
console.log('总校验期间数：' + grandChecked + '    其中「金蝶结转 ≠ 损益净额」：' + grandBad +
  (grandBad === 0 ? '  ✓ 全部一致' : '  ← 需人工核查'));
