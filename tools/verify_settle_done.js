// 暂缓项修复验证：
//   #6  结转损益改显式幂等（原隐式幂等因 3103 计入 totalRev 而失效，重复结转真实发生）
//   #7  closePeriod 加上期已结账校验（逐期结账，禁止跳期）
//   #11 期末处理按钮期间统一跟随结账 tab 选期（selMonth，避免选 A 期操作 B 期）
// 用法：node tools/verify_settle_done.js
'use strict';

const path = require('path');
const fs = require('fs');
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;

let bad = 0;
const ck = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); bad++; } };

function baseState() {
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '3103', name: '本年利润', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '6601', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.vouchers = [];
  S.state.closedPeriods = [];
  S.state.openingBalances = {};
  S.state.param = { voucherWord: '记' };
}

console.log('=== #6. 结转损益显式幂等 ===');
baseState();
S.addVoucher({ word: '记', date: '2026-07-10', summary: '收入', entries: [{ code: '1001', dr: 8000, cr: 0 }, { code: '6001', dr: 0, cr: 8000 }] });
S.addVoucher({ word: '记', date: '2026-07-11', summary: '费用', entries: [{ code: '6601', dr: 2000, cr: 0 }, { code: '1001', dr: 0, cr: 2000 }] });
const r1 = S.carryForwardProfit('2026-07');
ck(r1.ok, '第 1 次结转成功');
const r2 = S.carryForwardProfit('2026-07');
ck(!r2.ok && /已结转|重复/.test(r2.msg || ''), '第 2 次结转被拦截（修复前重复生成第 2 张）');
ck(S.periodVouchers('2026-07').filter((v) => /结转.*损益/.test(v.summary || '')).length === 1, '结转凭证仅 1 张');
// 删除旧结转凭证后可重做
S.periodVouchers('2026-07').filter((v) => /结转.*损益/.test(v.summary || '')).forEach((v) => S.removeVoucher(v.id));
ck(S.carryForwardProfit('2026-07').ok, '删除旧凭证后可重做');
// 结转金额正确（收入8000-费用2000=净利6000）
const cj = S.periodVouchers('2026-07').filter((v) => /结转.*损益/.test(v.summary || ''))[0];
const profitEntry = cj.entries.filter((e) => e.code === '3103')[0];
ck(profitEntry && profitEntry.cr === 6000, '结转至本年利润 6000（收入8000-费用2000）');

console.log('\n=== #7. closePeriod 逐期结账（禁止跳期）===');
baseState();
S.addVoucher({ word: '记', date: '2026-03-10', summary: '3月', entries: [{ code: '1001', dr: 100, cr: 0 }, { code: '6001', dr: 0, cr: 100 }] });
S.addVoucher({ word: '记', date: '2026-04-10', summary: '4月', entries: [{ code: '1001', dr: 100, cr: 0 }, { code: '6001', dr: 0, cr: 100 }] });
// 跳期：直接结 4 月（3 月未结）应被拦
const skip = S.closePeriod('2026-04', { force: true });
ck(!skip.ok && /上一期间/.test(skip.msg || ''), '跳期结账被拦截（先结 3 月）');
// 顺序：结转损益 3 月 → 结账 3 月 → 结转 4 月 → 结账 4 月
S.carryForwardProfit('2026-03');
ck(S.closePeriod('2026-03', { force: true }).ok, '3 月顺序结账成功');
S.carryForwardProfit('2026-04');
ck(S.closePeriod('2026-04', { force: true }).ok, '4 月（上期已结）结账成功');
ck(S.state.closedPeriods.join(',') === '2026-03,2026-04', '已结账期间顺序正确');
// 3 月未结账（只结 4 月，跳期）→ 结 4 月被拦；补 3 月结账后成功（已在上方覆盖）
// 额外：仅 1 个期间时首期可直接结账（无更早期间）
baseState();
S.addVoucher({ word: '记', date: '2026-01-10', summary: '首期', entries: [{ code: '1001', dr: 50, cr: 0 }, { code: '6001', dr: 0, cr: 50 }] });
S.carryForwardProfit('2026-01');
ck(S.closePeriod('2026-01', { force: true }).ok, '仅 1 期账套首期可直接结账（无更早期间）');

console.log('\n=== #11. 期末处理按钮跟随结账 tab 选期（代码层校验）===');
const src = fs.readFileSync(path.resolve(__dirname, '../js/pages/settle/Settle.js'), 'utf8');
['btnDepVoucher', 'btnFxVoucher', 'btnCarryCost', 'btnCarryVat', 'btnAccrueSurTax', 'btnAccrueIncTax', 'btnReCarryForward', 'btnCarryYearEnd'].forEach((id) => {
  const seg = src.slice(src.indexOf("onBtn('" + id + "'"), src.indexOf("onBtn('" + id + "'") + 120);
  ck(/var month = selMonth/.test(seg), id + ' 使用 selMonth（跟随结账 tab 选期）');
});
ck(/var curMonth = month/.test(src), 'refreshSettle 中 curMonth 跟随 selMonth');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：#6结转幂等 / #7逐期结账 / #11期末处理跟随选期' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
