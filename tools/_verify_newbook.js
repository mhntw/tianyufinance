#!/usr/bin/env node
/* _verify_newbook.js — 场景 2「新建公司账套」全流程数据层验证（内存，persist no-op）
 * 链路：新建空账套 → 录期初(借贷平) → 连续 7 个月逐月录凭证 → 逐期「结转+结账」→
 *        检查各月试算/资产负债表恒等/现金流勾稽与期末账户、本年利润累计。
 * 语义要点：
 *   - balanceSheet 已将未结转净利并入「未分配利润」，故任何月份 totalAsset == totalAll 恒等；
 *   - closePeriod 对 warn 项（vat/surTax 测算提示）需 force 确认 = 结账页用户二次确认，测试传 force:true。
 */
'use strict';
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

let bad = 0;
const ck = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

// 1. 新建空账套
S.state = {};
S.normalizeState();
ck(S.state.vouchers.length === 0 && S.state.subjects.length > 40, '新建账套：默认科目模板就绪（' + S.state.subjects.length + ' 个科目）');

// 2. 建账期初（借贷平）
S.setOpening('1002', 300000, 0, 0, 0, 0);   // 银行存款 借 30 万
S.setOpening('2202', 0, 120000, 0, 0, 0);   // 应付账款 贷 12 万
S.setOpening('3001', 0, 180000, 0, 0, 0);   // 实收资本 贷 18 万
ck(S.openingBalanceCheck().balanced === true, '期初录入后借贷平衡（30万 = 12万 + 18万）');

// 3. 连续 7 个月逐月录凭证：每月客房收入 8 万 + 费用 3 万
MONTHS.forEach(m => {
  const d1 = m + '-15', d2 = m + '-25';
  S.addVoucher({ word: '记', date: d1, entries: [
    { code: '1002', name: '银行存款', summary: '客房收入', dr: 80000, cr: 0 },
    { code: '5001', name: '主营业务收入', summary: '客房收入', dr: 0, cr: 80000 } ] });
  S.addVoucher({ word: '记', date: d2, entries: [
    { code: '5601', name: '销售费用', summary: '费用支出', dr: 30000, cr: 0 },
    { code: '1002', name: '银行存款', summary: '费用支出', dr: 0, cr: 30000 } ] });
});
ck(S.state.vouchers.length === MONTHS.length * 2, '录入 ' + MONTHS.length + ' 个月 × 2 = ' + S.state.vouchers.length + ' 张凭证');

// 4. 中间态逐月核对（在结账前验证报表口径）
let plOk = true, bsOk = true, cfOk = true, tbOk = true;
MONTHS.forEach(m => {
  const pl = S.profitStatement(m);
  if (Math.abs(num(pl.netProfit) - 50000) > 0.01) plOk = false;               // 当月净利 5 万
  const bs = S.balanceSheet(m);
  if (Math.abs(num(bs.totalAsset) - num(bs.totalAll)) > 0.01) bsOk = false;  // 未结转净利已并入权益 → 恒等
  const cf = S.cashFlow(m);
  if (Math.abs(num(cf.ending) - num(cf.opening) - (num(cf.operating) + num(cf.investing) + num(cf.financing) + num(cf.exchange))) > 0.01) cfOk = false;
  const gl = S.generalLedger(m);
  let dr = 0, cr = 0;
  gl.forEach(r => { if (r.code.length <= 4) { dr += num(r.endDr); cr += num(r.endCr); } });
  if (Math.abs(dr - cr) > 0.01) tbOk = false;
});
ck(plOk, '利润表逐月净利润 = 5 万（收入-费用口径正确）');
ck(bsOk, '资产负债表逐月恒等（未结转净利并入未分配利润后 totalAsset=totalAll）');
ck(cfOk, '现金流量表逐月勾稽（期末=期初+净变动）');
ck(tbOk, '总账逐月试算平衡');

// 5. 逐期「结转 + 结账」（force 确认 warn 项），验证幂等与顺序约束
let carryBad = 0, closeBad = 0;
MONTHS.forEach(m => {
  const rc = S.carryForwardProfit(m);
  if (!(rc.ok === true && Math.abs(num(rc.net) - 50000) < 0.01)) carryBad++;
  if (S.carryForwardProfit(m).ok !== false) { /* 二次结转应被拒 */ carryBad++; }
  const rr = S.closePeriod(m, { force: true });
  if (rr.ok !== true) closeBad++;
  if (S.isPeriodClosed(m) !== true) closeBad++;
});
ck(carryBad === 0, '每月结转成功且二次结转均被拒（幂等）');
ck(closeBad === 0, '7 个月逐期结账全部成功（含跨月顺序约束）');
ck(S.closePeriod(MONTHS[5]).ok === false, '重复结账被拒（已结账）');

// 6. 结账后不变量
const gl7 = S.generalLedger('2026-07');
let dr = 0, cr = 0;
gl7.forEach(x => { if (x.code.length <= 4) { dr += num(x.endDr); cr += num(x.endCr); } });
ck(Math.abs(dr - cr) < 0.01, '结账后总账仍平衡');
const bs7 = S.balanceSheet('2026-07');
ck(Math.abs(num(bs7.totalAsset) - num(bs7.totalAll)) < 0.01, '结账后资产负债表恒等');
const p3103 = gl7.filter(x => x.code === '3103')[0];
ck(p3103 && Math.abs((num(p3103.endCr) - num(p3103.endDr)) - 50000 * MONTHS.length) < 0.01,
  '本年利润累计 = 5 万 × 7 月 = ' + (50000 * MONTHS.length) + '（连续结转累计正确）');
const g1002 = gl7.filter(x => x.code === '1002')[0];
ck(Math.abs((num(g1002.endDr) - num(g1002.endCr)) - (300000 + (80000 - 30000) * MONTHS.length)) < 0.01,
  '银行存款期末 = 期初 30 万 + 净流入 ' + ((80000 - 30000) * MONTHS.length) + ' = ' + (300000 + (80000 - 30000) * MONTHS.length));

// 7. 反结账约束：仅最近期可反结
ck(S.reopenPeriod('2026-07', 'test').ok === true, '反结账最近期 2026-07 成功（可回归修改）');
// 7 已移除后最近期为 06；反结 05 应被拒（非最近期）
ck(S.reopenPeriod('2026-05', 'test').ok === false, '反结账非最近期（2026-05）被拒（仅最近期可反结）');

console.log('\n' + (bad === 0 ? '✅ 场景2「新建公司账套」全流程数据层验证通过' : '❌ ' + bad + ' 处不符'));
process.exit(bad === 0 ? 0 : 1);
