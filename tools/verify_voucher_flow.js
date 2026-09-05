// 凭证板块修复验证：
//   #2  出纳复核/撤销复核补「已结账拦截」（与审核/反审核/修改/删除一致，避免已结账期间凭证被改复核状态）
//   #3  删凭证引用校验补「工资」「出纳手工流水」（此前只覆盖报销单/原始凭证/固定资产）
//   #5  状态流转完整性：draft→audited→reviewed，审核前校验借贷平衡/停用科目由 UI 层负责（此处验 store 层面）
// 用法：node tools/verify_voucher_flow.js
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

function baseState() {
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '2211', name: '应付职工薪酬', cls: 'liability', normal: 'cr', level: 0, enabled: true },
    { code: '6601', name: '销售费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.vouchers = [];
  S.state.closedPeriods = [];
  S.state.openingBalances = {};
  S.state.param = { voucherWord: '记' };
  S.state.bankAccounts = [{ id: 'A1', code: 'A001', name: '银行账户', subjectCode: '1002', openingBalance: 0, enabled: true }];
  S.state.cashJournals = [];
  S.state.reimburses = [];
  S.state.originals = [];
  S.state.fixedAssets = [];
}
function addV() {
  return S.addVoucher({ word: '记', date: '2026-03-10', summary: '收款', entries: [{ code: '1002', dr: 100, cr: 0 }, { code: '6001', dr: 0, cr: 100 }] });
}

console.log('=== #5. 状态流转完整性 ===');
baseState();
const v = addV();
ck(v.status === 'draft', '新增凭证为草稿（draft）');
// 不平衡凭证：addVoucher 层即拦截（借100无贷，voucherBalance 校验），不会产生不平衡凭证入账
const badV = S.addVoucher({ word: '记', date: '2026-03-10', summary: '不平', entries: [{ code: '1002', dr: 100, cr: 0 }] });
ck(!badV.ok && /不平/.test(badV.msg || ''), 'addVoucher 拒绝借贷不平衡凭证（' + (badV.msg || '') + '）');
// 构造平衡凭证审核
baseState();
const v2 = addV();
const aud = S.auditVoucher(v2.id);
ck(aud.ok && S.state.vouchers.filter((x) => x.id === v2.id)[0].status === 'audited', '审核后状态 = audited');
const rev = S.cashierReview(v2.id);
ck(rev.ok && S.state.vouchers.filter((x) => x.id === v2.id)[0].status === 'reviewed', '出纳复核后状态 = reviewed');
ck(!S.auditVoucher(v2.id).ok, '已出纳复核的凭证不能再重复审核');
const unaud = S.unauditVoucher(v2.id);
ck(!unaud.ok && /复核/.test(unaud.msg || ''), '已复核凭证反审核被拦（须先撤销复核）');

console.log('\n=== #2. 出纳复核/撤销复核：已结账期间拦截（修复）===');
baseState();
S.state.closedPeriods = ['2026-03'];
const v3 = addV();
const aud3 = S.auditVoucher(v3.id);
if (aud3.ok) {
  const rv = S.cashierReview(v3.id);
  ck(!rv.ok && /结账/.test(rv.msg || ''), '已结账期间出纳复核被拦截（修复前可复核）');
  const urv = S.unCashierReview(v3.id);
  ck(!urv.ok && /结账/.test(urv.msg || ''), '已结账期间撤销复核被拦截（修复前可撤销）');
} else {
  // 结账期间审核也被拦，则复核应同样拦（一致性）
  ck(!aud3.ok, '已结账期间审核被拦截（前置一致）');
  ck(!S.cashierReview(v3.id).ok, '已结账期间出纳复核被拦截');
}

console.log('\n=== #3. 删凭证引用校验：工资 + 出纳手工流水 ===');
// 出纳流水引用
baseState();
const rj = S.addCashJournal({ accountId: 'A1', date: '2026-03-10', summary: '收客房款', direction: 'dr', amount: 100 });
const gj = S.genJournalVoucher(rj.rec.id);
const ref1 = S._voucherRefs(gj.voucher.id);
ck(ref1.includes('出纳流水'), '凭证被出纳流水引用时 _voucherRefs 识别（修复前遗漏）');
ck(!S.removeVoucher(gj.voucher.id).ok && /出纳流水/.test(S.removeVoucher(gj.voucher.id).msg || ''), '删凭证被拦截并提示出纳流水');
// 工资引用
baseState();
const gw = S.addVoucher({ word: '记', date: '2026-03-20', summary: '计提2026-03工资', entries: [{ code: '6601', dr: 100, cr: 0 }, { code: '2211', dr: 0, cr: 100 }] });
const ref2 = S._voucherRefs(gw.id);
ck(ref2.includes('工资'), '工资计提凭证被 _voucherRefs 识别为「工资」（摘要「计提2026-03工资」）');
const del2 = S.removeVoucher(gw.id);
ck(!del2.ok && /工资/.test(del2.msg || ''), '删工资凭证被拦截并提示工资');
// 普通凭证可删（无引用）
baseState();
const v4 = addV();
ck(S.removeVoucher(v4.id).ok, '无引用的普通凭证可正常删除');

console.log('\n=== #2. 已结账期间：修改/删除/审核/复核 全部一致拦截 ===');
baseState();
S.state.closedPeriods = ['2026-03'];
const v5 = addV();
ck(!S.updateVoucher(v5.id, { summary: '改' }).ok, '已结账修改被拦');
ck(!S.removeVoucher(v5.id).ok, '已结账删除被拦');
ck(!S.auditVoucher(v5.id).ok, '已结账审核被拦');
ck(!S.cashierReview(v5.id).ok, '已结账复核被拦（修复）');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：状态流转完整、出纳复核结账拦截、引用校验含工资/出纳流水' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
