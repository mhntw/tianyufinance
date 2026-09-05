#!/usr/bin/env node
/* _perf_stress.js — 大数据量性能压测（合成账套，内存，persist no-op）
 * 模拟多年高并发录入的账套规模（默认 1 万张凭证），测量关键报表/结账入口耗时，
 * 给出投产可用性参考。用法：node tools/_perf_stress.js [凭证数=10000]
 */
'use strict';
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const N = parseInt(process.argv[2] || '10000', 10);
const t0 = Date.now();

// 建科目（约 60 个：资产/负债/权益/损益 各带若干子目）
const codes = ['1001', '1002', '1012', '1122', '1123', '1221', '1401', '1402', '1403', '1405',
  '1601', '1602', '2202', '2211', '2221', '2241', '3001', '3103', '3104', '5001', '5002',
  '5051', '5301', '5401', '5402', '5403', '5601', '5602', '6602'];
const names = { asset: ['库存现金', '银行存款', '其他货币资金', '应收账款', '预付账款', '其他应收款', '材料采购', '在途物资', '原材料', '库存商品', '固定资产', '累计折旧'],
  liability: ['应付账款', '应付职工薪酬', '应交税费', '其他应付款'], equity: ['实收资本', '本年利润', '利润分配'],
  revenue: ['主营业务收入', '其他业务收入', '其他业务成本', '营业外收入'], expense: ['主营业务成本', '其他业务成本', '税金及附加', '销售费用', '管理费用', '财务费用'] };
const clsOf = { '1001': 'asset', '1002': 'asset', '1012': 'asset', '1122': 'asset', '1123': 'asset', '1221': 'asset', '1401': 'asset', '1402': 'asset', '1403': 'asset', '1405': 'asset', '1601': 'asset', '1602': 'asset', '2202': 'liability', '2211': 'liability', '2221': 'liability', '2241': 'liability', '3001': 'equity', '3103': 'equity', '3104': 'equity', '5001': 'revenue', '5002': 'revenue', '5051': 'revenue', '5301': 'revenue', '5401': 'expense', '5402': 'expense', '5403': 'expense', '5601': 'expense', '5602': 'expense', '6602': 'expense' };
S.state = {}; S.normalizeState();
S.state.subjects = codes.map(c => ({ code: c, name: names[clsOf[c]].shift(), cls: clsOf[c], normal: (clsOf[c] === 'asset' || clsOf[c] === 'expense') ? 'dr' : 'cr' }));
S.state.vouchers = [];
S.state.closedPeriods = [];
S.state.openingBalances = {};
S._glCache = {};

// 合成凭证：跨 24 个月，每张 2-4 条分录、借贷平衡
const months = [];
for (let mi = 0; mi < 24; mi++) { const y = 2024 + Math.floor(mi / 12); months.push(y + '-' + String((mi % 12) + 1).padStart(2, '0')); }
const rev = codes.filter(c => clsOf[c] === 'revenue');
const exp = codes.filter(c => clsOf[c] === 'expense');
const asst = codes.filter(c => clsOf[c] === 'asset' || clsOf[c] === 'liability');
let seed = 42;
function rnd(n) { seed = (seed * 9301 + 49297) % 233280; return Math.floor(seed / 233280 * n); }
for (let i = 0; i < N; i++) {
  const m = months[i % months.length];
  const isRev = rnd(2) === 0;
  const amt = 100 + rnd(90000);
  const e = [];
  if (isRev) {
    const r = rev[rnd(rev.length)];
    e.push({ code: '1002', name: '银行存款', summary: 's', dr: 0, cr: amt }); // 简化：收入挂银行贷
    e.push({ code: r, name: 'r', summary: 's', dr: amt, cr: 0 });
  } else {
    const x = exp[rnd(exp.length)];
    const a = asst[rnd(asst.length)];
    if (rnd(2)) { e.push({ code: a, name: 'a', summary: 's', dr: 0, cr: amt }); e.push({ code: x, name: 'x', summary: 's', dr: amt, cr: 0 }); }
    else { e.push({ code: '1002', name: '银行存款', summary: 's', dr: 0, cr: amt }); e.push({ code: x, name: 'x', summary: 's', dr: amt, cr: 0 }); }
  }
  S.state.vouchers.push({ id: 'v' + i, word: '记', no: i + 1, date: m + '-' + String((i % 28) + 1).padStart(2, '0'), status: 'audited', deleted: 'n', summary: '合成凭证' + i, entries: e });
}
const tGen = Date.now() - t0;
console.log('合成账套：' + N + ' 张凭证（' + (N * 2) + ' 分录 / ' + months.length + ' 个月）  生成耗时 ' + tGen + 'ms');

const lastM = months[months.length - 1];
function timeIt(label, fn) {
  const a = Date.now();
  const r = fn();
  const ms = Date.now() - a;
  console.log('  ' + label.padEnd(46) + ms + ' ms');
  return r;
}
console.log('\n=== 性能（' + N + ' 张凭证） ===');
const gl = timeIt('generalLedger(' + lastM + ')', () => S.generalLedger(lastM));
timeIt('profitStatement(' + lastM + ')', () => S.profitStatement(lastM));
timeIt('balanceSheet(' + lastM + ')', () => S.balanceSheet(lastM));
timeIt('cashFlow(' + lastM + ')', () => S.cashFlow(lastM));
timeIt('settleChecklist(' + lastM + ')', () => S.settleChecklist(lastM));
timeIt('detailLedger 现金/银行/主营成本', () => ['1001', '1002', '5401'].forEach(c => S.detailLedger(c, lastM)));
timeIt('carryForwardProfit(' + lastM + ')（结转）', () => S.carryForwardProfit(lastM));
timeIt('taxDetail(' + lastM + ')', () => S.taxDetail(lastM));

console.log('\n=== 内存 ===');
console.log('  vouchers 数组项约 ' + (S.state.vouchers.length) + ' 张');
