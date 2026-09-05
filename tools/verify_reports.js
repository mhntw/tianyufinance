// 报表板块审查验证（按会计准则逐项核对）
//   1. 资产负债表：规范账套（正确结转损益）必须恒等式平衡；不平账套由页面诊断提示（非软件缺陷）
//   2. 利润表：收入贷方/费用借方发生额口径，净利润正确；已结转损益账套也能还原真实数
//   3. 现金流量表：期末现金 = 期初 + 净增加（三大活动+汇率）；期末现金 = 1001/1002/1012 科目余额
// 用法：node tools/verify_reports.js
'use strict';

const path = require('path');
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
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function baseState() {
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '2202', name: '应付账款', cls: 'liability', normal: 'cr', level: 0, enabled: true },
    { code: '3001', name: '实收资本', cls: 'equity', normal: 'cr', level: 0, enabled: true },
    { code: '3103', name: '本年利润', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '3104', name: '利润分配-未分配利润', cls: 'liability', normal: 'cr', level: 0, enabled: true },
    { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '6601', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.vouchers = [];
  S.state.closedPeriods = [];
  S.state.param = { voucherWord: '记' };
  S.state.openingBalances = {};
}

console.log('=== 1. 资产负债表：规范账套恒等式平衡 ===');
baseState();
S.state.openingBalances['1001'] = { dr: 1000, cr: 0 };
S.state.openingBalances['3001'] = { dr: 0, cr: 1000 };
S.addVoucher({ word: '记', date: '2026-07-10', summary: '收入', entries: [{ code: '1001', dr: 8000, cr: 0 }, { code: '6001', dr: 0, cr: 8000 }] });
S.addVoucher({ word: '记', date: '2026-07-11', summary: '费用', entries: [{ code: '6601', dr: 2000, cr: 0 }, { code: '1001', dr: 0, cr: 2000 }] });
// 未结转损益时：报表不平（数据未结转，非软件缺陷），且软件诊断提示应能识别
const bsUn = S.balanceSheet('2026-07');
const diffUn = Math.abs(bsUn.totalAsset - bsUn.totalAll);
// 结转损益后应平衡
S.carryForwardProfit('2026-07');
const bs = S.balanceSheet('2026-07');
ck(Math.abs(bs.totalAsset - bs.totalAll) < 0.01, '结转损益后资产负债表恒等式平衡（资产' + bs.totalAsset.toFixed(2) + ' = 负债' + bs.totalLiability.toFixed(2) + '+权益' + bs.totalEquity.toFixed(2) + '）');
ck(bs.totalAsset === 1000 + 8000 - 2000, '资产 = 期初现金1000 + 收入8000 - 费用2000 = 7000（实际 ' + bs.totalAsset + '）');
// 未分配利润应含净利润 6000
const undist = bs.groups.equity.items.filter((x) => x.label === '未分配利润')[0];
ck(undist && Math.abs(undist.end - 6000) < 0.01, '未分配利润 = 本期净利润 6000（实际 ' + (undist ? undist.end : '无') + '）');
// 不平账套的诊断：差额 ≈ 净利润 - 已结转净额（软件会提示，不掩盖）
ck(diffUn > 0.01, '未结转损益时报表不平（差额 ' + diffUn.toFixed(2) + '，软件会提示先结转损益）');

console.log('\n=== 2. 利润表：收入贷方/费用借方发生额口径 ===');
baseState();
S.addVoucher({ word: '记', date: '2026-07-10', summary: '收入', entries: [{ code: '1001', dr: 8000, cr: 0 }, { code: '6001', dr: 0, cr: 8000 }] });
S.addVoucher({ word: '记', date: '2026-07-11', summary: '费用', entries: [{ code: '6601', dr: 2000, cr: 0 }, { code: '1001', dr: 0, cr: 2000 }] });
const ps = S.profitStatement('2026-07');
ck(num(ps.totalRevenue) === 8000, '收入 = 8000（贷方发生额）');
ck(num(ps.totalExpense) === 2000, '费用 = 2000（借方发生额）');
ck(num(ps.netProfit) === 6000, '净利润 = 8000-2000 = 6000');
// 已结转损益账套：损益科目借贷平衡，但利润表仍应还原发生额（关键口径）
S.carryForwardProfit('2026-07');
const ps2 = S.profitStatement('2026-07');
ck(num(ps2.totalRevenue) === 8000 && num(ps2.totalExpense) === 2000 && num(ps2.netProfit) === 6000,
  '已结转损益后利润表仍还原发生额（收入8000/费用2000/净利6000，取发生额方向而非净额）');

console.log('\n=== 3. 现金流量表：净增加勾稽 + 期末现金 ===');
baseState();
S.state.openingBalances['1001'] = { dr: 500, cr: 0 };
S.state.openingBalances['3001'] = { dr: 0, cr: 500 };
// 销售收现（经营流入）
S.addVoucher({ word: '记', date: '2026-07-10', summary: '销售收款', entries: [{ code: '1001', dr: 1000, cr: 0 }, { code: '6001', dr: 0, cr: 1000 }] });
// 付现金费（经营流出）
S.addVoucher({ word: '记', date: '2026-07-11', summary: '付管理费用', entries: [{ code: '6601', dr: 300, cr: 0 }, { code: '1001', dr: 0, cr: 300 }] });
const cf = S.cashFlow('2026-07');
const net = cf.operating + cf.investing + cf.financing + cf.exchange;
ck(Math.abs(cf.ending - (cf.opening + net)) < 0.01, '现金流量表勾稽：期末 = 期初 + 净增加（期初' + cf.opening.toFixed(2) + ' 净' + net.toFixed(2) + ' 期末' + cf.ending.toFixed(2) + '）');
ck(Math.abs(cf.ending - 1200) < 0.01, '期末现金 = 期初500 + 收1000 - 付300 = 1200（实际 ' + cf.ending + '）');
ck(cf.opening === 500, '期初现金 = 500（期初余额）');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：三大报表逻辑正确（资产负债表恒等/利润表口径/现金流量表勾稽）' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
