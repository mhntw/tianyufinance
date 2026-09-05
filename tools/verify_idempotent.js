// 幂等性回归验证（财务软件大忌：重复操作导致重复记账）
//   1.（原期末调汇段已随功能下线移除，见下方注释）
//   2. 结转损益摘要正则：UI 用的 /结转.*损益/ 能匹配 store 生成的「结转2026-03损益」
//      （修复前 UI 用 /结转损益/ 匹配不上，导致「重新结转」功能失效、结账页恒显未结转）
//   3. 折旧：同月重复调用不再重复计提
//   4. 反结账：使用反结账 tab 自己的期间变量（代码层校验，见 Settle.js）
// 用法：node tools/verify_idempotent.js
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
    { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '100201', name: '银行-美元户', cls: 'asset', normal: 'dr', level: 0, enabled: true, foreign: true, adjust: true, currency: 'USD' },
    { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
    { code: '3103', name: '本年利润', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '5602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '6603', name: '财务费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.vouchers = [];
  S.state.bankAccounts = [];
  S.state.bankStatements = [];
  S.state.cashJournals = [];
  S.state.closedPeriods = [];
  S.state.openingBalances = {};
  S.state.currencies = [
    { code: 'RMB', name: '人民币', rate: 1, base: true },
    { code: 'USD', name: '美元', rate: 7.2 }
  ];
  S.state.fixedAssets = [];
}

// 注：原「=== 1. 期末调汇幂等」整段已随期末调汇功能下线（2026-09-01）移除——
// store.js 已无 exchangeAdjust 方法，原段调用必抛 TypeError 中断脚本。
// 本脚本现只保留结转损益幂等/摘要相关断言。见 CHANGELOG 2026-09-05。

console.log('\n=== 2. 结转损益摘要正则（修复前 UI 匹配不上）===');
baseState();
// 本期有损益：收入 5000、费用 2000
S.addVoucher({ word: '记', date: '2026-03-10', summary: '收入', entries: [{ code: '1002', dr: 5000, cr: 0 }, { code: '6001', dr: 0, cr: 5000 }] });
S.addVoucher({ word: '记', date: '2026-03-11', summary: '费用', entries: [{ code: '6602', dr: 2000, cr: 0 }, { code: '1002', dr: 0, cr: 2000 }] });
const rc = S.carryForwardProfit('2026-03');
ck(rc.ok, '结转损益成功');
const cv = S.periodVouchers('2026-03').filter((v) => /结转/.test(v.summary || '') && /损益/.test(v.summary || ''))[0];
ck(!!cv, '能取到结转损益凭证');
const summary = cv ? cv.summary : '';
ck(/^结转.*损益$/.test(summary), '摘要格式为「结转<月份>损益」（实际：' + summary + '）');
// 修复后的 UI 正则 /结转.*损益/ 能匹配
ck(/结转.*损益/.test(summary), '修复后正则 /结转.*损益/ 能匹配（修复前 /结转损益/ 匹配不上）');
// 修复前的旧正则确实匹配不上（证明缺陷真实存在）
ck(!/结转损益/.test(summary), '修复前正则 /结转损益/ 确实匹配不上（印证原缺陷）');
// 重新结转：UI 用的正则能找到旧凭证并删除
const oldCarry = S.periodVouchers('2026-03').filter((v) => /结转.*损益/.test(v.summary || ''));
ck(oldCarry.length === 1, '重新结转能定位到旧结转凭证（修复前为 0，导致功能失效）');

console.log('\n=== 3. 折旧同月幂等（修复前同月重复计提）===');
baseState();
S.state.fixedAssets = [{
  id: 'FA1', name: '空调', original: 12000, salvage: 600, life: 5,
  acqDate: '2026-01-15', status: '在用',
  depField: 'depTotal', deprExpenseCode: '5602', deprAccumCode: '1602'
}];
const d1 = S.depreciateMonth('2026-03');
ck(d1.ok, '3月首次计提折旧成功');
const depCnt1 = S.periodVouchers('2026-03').filter((v) => /折旧/.test(v.summary || '')).length;
// 重复调用 3 次
let depBlocked = 0;
for (let i = 0; i < 3; i++) {
  const r = S.depreciateMonth('2026-03');
  if (!r.ok) depBlocked++; // 被拦截（本月无资产需计提 或 已结账等）
}
const depCnt2 = S.periodVouchers('2026-03').filter((v) => /折旧/.test(v.summary || '')).length;
ck(depCnt2 === depCnt1, '重复计提 3 次后折旧凭证数不变（' + depCnt1 + ' → ' + depCnt2 + '，修复前会成倍增加）');
// 下月可正常计提
const d2 = S.depreciateMonth('2026-04');
const depCnt4 = S.periodVouchers('2026-04').filter((v) => /折旧/.test(v.summary || '')).length;
ck(depCnt4 >= 1, '下月（4月）仍可正常计提折旧');

console.log('\n=== 4. 反结账期间变量（代码层校验）===');
const fs = require('fs');
const settleSrc = fs.readFileSync(path.resolve(__dirname, '../js/pages/settle/Settle.js'), 'utf8');
const reopenFn = settleSrc.slice(settleSrc.indexOf("onBtn('btnReopenPeriod'"), settleSrc.indexOf("onBtn('btnReopenPeriod'") + 500);
ck(/var month = selReopenMonth;/.test(reopenFn), '反结账使用 selReopenMonth（修复前误用 selMonth）');
ck(!/var month = selMonth;/.test(reopenFn), '反结账不再误用 selMonth');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：结转损益摘要/折旧幂等，反结账期间变量正确' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
