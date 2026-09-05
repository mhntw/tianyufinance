// 凭证 id 稳定性与引用完整性验证（严重缺陷回归）
//
// 原缺陷：addVoucher 用「V+时间戳」生成 id，而 ensureVoucherIds()（账套加载时执行）
//         把 id 强制改写为 word-no。两者口径不一致 → 凭证 id 在刷新/重载后变化，
//         导致出纳流水/报销单/原始凭证等按 voucherId 记录的引用全部失效
//         （表现为：出纳流水已生成凭证，刷新后「已生成凭证」保护失效、流水可被随意删改，
//           出纳账与总账脱节）。
//
// 修复：① addVoucher 与 ensureVoucherIds 统一用 _calcVoucherId(word, no, month)
//       ② id 含月份（word-no@YYYY-MM）：凭证号按月编号，跨月同号是不同凭证，
//          不可判为重号。真实账套（添钰来客 371 张）存在 58 个跨月重复 word-no 印证。
//
// 附：凭证断号行为符合金蝶规范 —— 删除中间凭证产生断号，新凭证继续往后编（不复用已删号），
//     断号由会计人员用「凭证整理」手动补齐（不可撤销）。verify: 不复用已删号。
// 用法：node tools/verify_voucher_id.js
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
    { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true }
  ];
  S.state.vouchers = [];
  S.state.closedPeriods = [];
  S.state.openingBalances = {};
  S.state.bankAccounts = [{ id: 'A1', code: 'A001', name: '银行账户', subjectCode: '1002', openingBalance: 0, enabled: true }];
  S.state.cashJournals = [];
  S.state.param = { voucherWord: '记' };
}
function addV(d, n) {
  return S.addVoucher({ word: '记', date: d, summary: n, entries: [{ code: '1001', dr: 10, cr: 0 }, { code: '6001', dr: 0, cr: 10 }] });
}

console.log('=== 1. 凭证 id 含月份，跨月同号不冲突 ===');
baseState();
for (let i = 1; i <= 3; i++) addV('2026-03-0' + i, '3月v' + i);
for (let i = 1; i <= 3; i++) addV('2026-04-0' + i, '4月v' + i);
const ids = S.state.vouchers.map((v) => v.id);
ck(ids[0] === '记-1@2026-03', '3月首张 id = 记-1@2026-03（实际 ' + ids[0] + '）');
ck(ids[3] === '记-1@2026-04', '4月首张 id = 记-1@2026-04（实际 ' + ids[3] + '）');
ck(ids[0] !== ids[3], '跨月同号 id 不同（修复前会被判重号加 -2 后缀）');
ck(new Set(ids).size === ids.length, '6 张凭证 id 全部唯一（' + ids.length + ' 张）');

console.log('\n=== 2. 重载（ensureVoucherIds）后 id 不变 ===');
const before = S.state.vouchers.map((v) => v.id);
S.ensureVoucherIds();
const after = S.state.vouchers.map((v) => v.id);
ck(JSON.stringify(before) === JSON.stringify(after), 'ensureVoucherIds 后 id 全部不变（修复前会被改写）');
// 连续两次重载仍稳定
S.ensureVoucherIds();
ck(JSON.stringify(before) === JSON.stringify(S.state.vouchers.map((v) => v.id)), '连续重载两次 id 仍稳定');

console.log('\n=== 3. 出纳流水引用凭证后，重载引用不失效 ===');
baseState();
const rj = S.addCashJournal({ accountId: 'A1', date: '2026-04-10', summary: '收客房款', direction: 'dr', amount: 500 });
const gj = S.genJournalVoucher(rj.rec.id);
ck(gj.ok, '出纳流水生成凭证成功');
const vid = gj.voucher.id;
ck(S.state.cashJournals[0].voucherId === vid, '流水记录了 voucherId = ' + vid);
S.ensureVoucherIds(); // 模拟刷新
const stillThere = S.state.vouchers.filter((v) => v.id === vid)[0];
ck(!!stillThere, '重载后凭证 id 仍为 ' + vid + '（引用可定位）');
ck(S.state.cashJournals[0].voucherId === vid, '流水的 voucherId 仍指向有效凭证');
// 关键：保护必须仍生效（修复前刷新后保护失效，流水可被随意删改）
const rr = S.removeCashJournal(S.state.cashJournals[0].id);
ck(!rr.ok, '重载后「已生成凭证」保护仍生效（修复前失效）：' + (rr.msg || ''));

console.log('\n=== 4. 凭证号不复用已删号（符合金蝶断号规范）===');
baseState();
for (let i = 1; i <= 5; i++) addV('2026-05-0' + i, 'v' + i);
const v3 = S.state.vouchers.filter((v) => v.no === 3)[0];
S.removeVoucher(v3.id);
const nosAfterDel = S.state.vouchers.filter((v) => v.deleted !== 'y').map((v) => v.no).sort();
ck(nosAfterDel.join(',') === '1,2,4,5', '删除 no=3 后产生断号（' + nosAfterDel.join(',') + '）');
const nv = addV('2026-05-09', '新凭证');
ck(nv.no === 6, '新增凭证号为 6（继续往后编，不复用已删的 3）');
ck(S.state.vouchers.filter((v) => v.deleted !== 'y' && v.no === 3).length === 0, '已删的 3 号未被复用（软删后不在用）');

console.log('\n=== 5. 真实账套：重载后 id 稳定（无重号污染）===');
const BOOKS = path.resolve(process.env.HOME, 'Library/Application Support/添钰财务/books');
if (fs.existsSync(BOOKS)) {
  fs.readdirSync(BOOKS).filter((f) => /\.json$/.test(f)).forEach((f) => {
    S.state = JSON.parse(fs.readFileSync(path.join(BOOKS, f), 'utf8'));
    if (S.state.schemaVersion == null) S.state.schemaVersion = S.SCHEMA_VERSION;
    S.normalizeState();
    // 注意：真实账套原有 id 为旧格式（如「记-1」），首次 ensureVoucherIds 会做一次性
    // 规范化为含月份的新格式。判据应为「规范化后第二次起稳定」（引用不失效的真正标准），
    // 而非首次就相等。
    S.ensureVoucherIds();
    const b1 = (S.state.vouchers || []).map((v) => v.id).join(',');
    S.ensureVoucherIds();
    const b2 = (S.state.vouchers || []).map((v) => v.id).join(',');
    ck(b1 === b2, f.slice(0, 20) + '… 规范化后重载 id 稳定（' + (S.state.vouchers || []).length + ' 张）');
    const uniq = new Set((S.state.vouchers || []).map((v) => v.id));
    ck(uniq.size === (S.state.vouchers || []).length, f.slice(0, 20) + '… 凭证 id 全部唯一（' + uniq.size + '/' + (S.state.vouchers || []).length + '）');
  });
} else { ck(true, '账套目录不存在，跳过真实账套校验'); }

console.log('\n============================');
console.log(bad === 0 ? '全部通过：凭证 id 稳定唯一、引用不失效、断号符合规范' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
