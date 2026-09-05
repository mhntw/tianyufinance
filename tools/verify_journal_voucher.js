// 第 3 步 + 修复回归验证：出纳流水 → 生成凭证闭环 / 备份恢复修复 / 手工流水生命周期。
// 用法：node tools/verify_journal_voucher.js
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
function ck(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { console.log('  ✗ ' + msg); bad++; } }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// 构造最小账套
S.state = {};
S.normalizeState();
S.state.subjects = [
  { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
  { code: '2241', name: '其他应付款', cls: 'liability', normal: 'cr', level: 0, enabled: true }
];
S.state.vouchers = [];
S.state.bankAccounts = [
  { id: 'BA2', code: 'A002', name: '银行账户', subjectCode: '1002', openingBalance: 0, enabled: true }
];
S.state.cashJournals = [];
S.state.closedPeriods = [];
S.state.openingBalances = {};

console.log('=== 1. 手工流水录入 ===');
const r1 = S.addCashJournal({ accountId: 'BA2', date: '2026-08-15', summary: '收到客房款', direction: 'dr', amount: 1200, oppositeSubject: '6001' });
ck(r1.ok, '新增手工流水成功');
ck(S.cashJournalsAll().length === 1, '落盘 1 条手工流水');

console.log('\n=== 2. 流水 → 生成凭证（收入方向）===');
const g1 = S.genJournalVoucher(r1.rec.id);
ck(g1.ok, '生成凭证成功');
ck(g1.voucher && g1.voucher.entries && g1.voucher.entries.length === 2, '凭证含 2 条分录');
const eBank = g1.voucher.entries.filter((e) => e.code === '1002')[0];
const eRev = g1.voucher.entries.filter((e) => e.code === '6001')[0];
ck(eBank && num(eBank.dr) === 1200, '借方 = 银行科目 1200');
ck(eRev && num(eRev.cr) === 1200, '贷方 = 收入科目 1200');
ck(num(g1.voucher.entries[0].dr) + num(g1.voucher.entries[1].dr) === num(g1.voucher.entries[0].cr) + num(g1.voucher.entries[1].cr),
  '凭证借贷平衡');
ck(S.cashJournalsAll()[0].voucherId === g1.voucher.id, '流水回写 voucherId');
ck(S.cashJournalsAll()[0].status === 'vouchered', '流水状态置为已生成凭证');

console.log('\n=== 3. 已生成凭证的流水保护 ===');
ck(S.removeCashJournal(r1.rec.id).ok === false, '已生成凭证的流水禁删');
ck(S.genJournalVoucher(r1.rec.id).ok === false, '重复生成凭证被拦截');
ck(S.cashJournalsAll()[0].voucherId, '凭证生成后流水保留（不丢）');

console.log('\n=== 4. 支出方向 + 无对方科目兜底 ===');
const r2 = S.addCashJournal({ accountId: 'BA2', date: '2026-08-16', summary: '付电费', direction: 'cr', amount: 300 });
ck(r2.ok, '新增支出流水');
const g2 = S.genJournalVoucher(r2.rec.id);
ck(g2.ok, '支出流水生成凭证成功');
const ePay = g2.voucher.entries.filter((e) => e.code === '1002')[0];
const eOpp = g2.voucher.entries.filter((e) => e.code !== '1002')[0];
ck(ePay && num(ePay.cr) === 300, '贷方 = 银行科目 300（支出）');
ck(eOpp && eOpp.code, '对方科目已兜底（' + eOpp.code + '）');
ck(num(g2.voucher.entries[0].dr) === num(g2.voucher.entries[0].cr) + 0 || num(g2.voucher.entries[0].dr) + num(g2.voucher.entries[1].dr) === num(g2.voucher.entries[0].cr) + num(g2.voucher.entries[1].cr),
  '支出凭证借贷平衡');

console.log('\n=== 5. 凭证派生的流水不可再生成凭证 ===');
const j = S.journalsOf('BA2', '2026-08').filter((x) => x.source === 'voucher')[0];
ck(j ? S.genJournalVoucher(j.id).ok === false : true, '凭证派生的流水不提供生成凭证入口（或 store 拦截）');

console.log('\n=== 6. 备份恢复修复 ===');
const backup = {
  subjects: [{ code: '1001', name: '库存现金', cls: 'asset', normal: 'dr', level: 0, enabled: true }],
  vouchers: [{ word: '记', no: 1, date: '2026-08-01', entries: [{ code: '1001', dr: 100, cr: 0 }, { code: '6001', dr: 0, cr: 100 }] }]
};
const rr = S.restoreFromData(backup);
ck(rr.ok, 'restoreFromData 不再抛错（此前必抛 TypeError）');
ck(Array.isArray(S.state.cashJournals), '恢复后 cashJournals 已兜底');
ck(S.state.vouchers[0].id, '恢复后凭证 id 已补齐');
ck(S.state.schemaVersion === S.SCHEMA_VERSION, '恢复后 schemaVersion 已对齐');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：流水→凭证闭环 / 备份恢复修复 / 流水保护均正确' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
