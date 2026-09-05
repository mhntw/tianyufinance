// 诊断：①利润表明细汇总翻倍根因 ②资产负债表不平衡根因（只读）
'use strict';
const fs = require('fs');
const path = require('path');
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null, addEventListener() {} };
global.window = global;
global.__TAURI__ = {}; global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

const BOOK_DIR = path.resolve(process.env.HOME, 'Library/Application Support/心中有数/books');
const target = process.argv[2] || '添钰来客_合并_20260903_1788445713063.json';
S.state = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, target), 'utf8'));
S.bookId = target;
S.normalizeState(); S.ensureVoucherIds(); S.ensureCashFlowFields && S.ensureCashFlowFields();
S._glCache = {};

console.log('账套：' + target);

/* ---- ① 利润表科目父子结构 ---- */
const subs = S.state.subjects || [];
const codes = subs.map((s) => String(s.code));
function hasChild(c) { return codes.some((o) => o !== c && o.indexOf(c) === 0); }
const rev = subs.filter((s) => s.cls === 'revenue');
const exp = subs.filter((s) => s.cls === 'expense');
console.log('\n【利润表科目】收入 ' + rev.length + ' 个 / 费用 ' + exp.length + ' 个');
console.log('  收入类：');
rev.forEach((s) => console.log('    ' + s.code + ' ' + s.name + (hasChild(s.code) ? '   ←有下级' : '')));
console.log('  费用类（仅列有下级或前 25 个）：');
exp.filter((s) => hasChild(s.code)).forEach((s) => console.log('    ' + s.code + ' ' + s.name + '   ←有下级'));

/* ---- ② 某月利润表明细 vs 总额 ---- */
const months = [];
(S.state.vouchers || []).forEach((v) => { const m = (v.date || '').slice(0, 7); if (m && months.indexOf(m) < 0) months.push(m); });
months.sort();
const mm = process.argv[3] || months[months.length - 1];
console.log('\n【' + mm + ' 利润表明细（cur 列）】');
const pl = S.profitStatement(mm);
let sr = 0, se = 0;
(pl.items || []).forEach((it) => {
  if (it._cls === 'revenue') sr += num(it.cur); else se += num(it.cur);
});
(pl.items || []).filter((x) => num(x.cur) !== 0).slice(0, 30).forEach((it) => {
  console.log('    ' + it._cls + ' ' + it.code + ' ' + it.name + ' = ' + num(it.cur).toFixed(2) + (hasChild(it.code) ? '  ←父科目(含子目上卷)' : ''));
});
console.log('  明细汇总 收入=' + sr.toFixed(2) + ' 费用=' + se.toFixed(2));
console.log('  接口总额 收入=' + pl.totalRevenue.toFixed(2) + ' 费用=' + pl.totalExpense.toFixed(2) + ' 净利=' + pl.netProfit.toFixed(2));

/* ---- ③ 资产负债表差额 vs 损益净额 ---- */
console.log('\n【资产负债表平衡诊断】格式：月 | 资产-(负债+权益)差额 | 收入-费用 | 差异');
months.forEach((m) => {
  const bs = S.balanceSheet(m);
  const diff = num(bs.totalAsset) - num(bs.totalAll);
  // 损益净额 = 损益类科目期末净额（收入贷-借，费用借-贷）
  let net = 0;
  const gl = S.generalLedger(m);
  const leaf = codes.filter((c) => !codes.some((o) => o !== c && o.indexOf(c) === 0));
  const leafSet = {}; leaf.forEach((c) => { leafSet[c] = 1; });
  gl.forEach((r) => {
    if (!leafSet[String(r.code)]) return;
    if (r.cls === 'revenue') net += num(r.endCr) - num(r.endDr);
    else if (r.cls === 'expense') net += num(r.endDr) - num(r.endCr);
  });
  const gap = diff - net;
  console.log('  ' + m + ' | 差额=' + diff.toFixed(2) + ' | 损益净额=' + net.toFixed(2) + ' | 差=' + gap.toFixed(2));
});

/* ---- ④ 未分配利润项目取数 ---- */
console.log('\n【权益组明细（最后期间 ' + mm + '）】');
const bs = S.balanceSheet(mm);
(bs.groups.equity.items || []).forEach((it) => {
  if (num(it.end) !== 0 || /未分配|本年/.test(it.label)) console.log('    ' + it.label + ' 期末=' + num(it.end).toFixed(2) + ' 年初=' + num(it.year).toFixed(2));
});
