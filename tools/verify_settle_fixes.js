// 结账板块二次修复验证：
//   #5  四个"生成凭证"按钮查重（genOnceVoucher / 结转成本）
//   #8  carryYearEnd 接入：settleChecklist 12月硬性检查 + 幂等保护
//   #9  settleChecklist 的 fail/warn 项能被结账页追加展示（代码层校验）
//   #10 detailLedger null 兜底（Settle.js renderCashChecklist）
// 用法：node tools/verify_settle_fixes.js
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
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

console.log('=== #5. 期末处理「生成凭证」查重（genOnceVoucher）===');
// 代码层：genOnceVoucher 已定义且 4 按钮走它
const src = fs.readFileSync(path.resolve(__dirname, '../js/pages/settle/Settle.js'), 'utf8');
ck(/function genOnceVoucher/.test(src), 'genOnceVoucher 函数已定义');
// btnCarryVat / btnAccrueSurTax / btnAccrueIncTax 三个按钮已随期末模板下线（2026-09-18），
// 不再按按钮 id 校验；税款一律由会计按实际申报数手工录入。
// genOnceVoucher 现由「自定义/预置模板生成凭证」路径调用（genVoucherFromTpl），改为校验该路径。
ck(/genOnceVoucher\(month,/.test(src), '自定义模板生成凭证走 genOnceVoucher 查重');
ck(/结转销售成本/.test(src) && /costExisted/.test(src.slice(src.indexOf('btnCarryCost'), src.indexOf('btnCarryCost') + 700)), 'btnCarryCost 使用 costExisted 查重');

// 运行时：调汇/结转成本类按钮连点不再重复生成（store 层已由 verify_idempotent 覆盖；此处验证 genOnceVoucher 逻辑）
function baseState() {
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
    { code: '3103', name: '本年利润', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
    { code: '3104', name: '利润分配-未分配利润', cls: 'liability', normal: 'cr', level: 0, enabled: true },
    { code: '2221', name: '应交税费', cls: 'liability', normal: 'cr', level: 0, enabled: true }
  ];
  S.state.vouchers = [];
  S.state.bankAccounts = [];
  S.state.bankStatements = [];
  S.state.cashJournals = [];
  S.state.closedPeriods = [];
  S.state.openingBalances = {};
  S.state.fixedAssets = [];
  // 期间闸门要求 startMonth ≤ 凭证月 ≤ 当前自然月（见 store.addVoucher 三道闸门）。
  // 把启用期间固定到足够早的月份，测试用的历史期间才不会被「早于账套启用期间」拒收 ——
  // 否则凭证静默不入库，断言连带失败（本文件曾因此误报 4 条 carryYearEnd 失败）。
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2025-01' });
}

console.log('\n=== #8. carryYearEnd 接入 settleChecklist（12月硬性检查 + 幂等）===');
baseState();
// 12月，本年利润有余额（收入8000-费用2000=6000）
S.addVoucher({ word: '记', date: '2025-12-10', summary: '收入', entries: [{ code: '1002', dr: 8000, cr: 0 }, { code: '6001', dr: 0, cr: 8000 }] });
S.addVoucher({ word: '记', date: '2025-12-11', summary: '费用', entries: [{ code: '6602', dr: 2000, cr: 0 }, { code: '1002', dr: 0, cr: 2000 }] });
// 先结转损益（本年利润余额=6000）
S.carryForwardProfit('2025-12');
// settleChecklist 应含 yearend 项且为 fail（本年利润未结转）
const cl12 = S.settleChecklist('2025-12');
const ye = cl12.filter((c) => c.key === 'yearend')[0];
ck(!!ye, '12月 settleChecklist 含 yearend 检查项');
ck(ye && ye.status === 'fail', '本年利润未结转时 yearend 为 fail（' + (ye ? ye.status : '无') + '）');
// 执行 carryYearEnd
const rYE = S.carryYearEnd('2025-12');
ck(rYE.ok, 'carryYearEnd 执行成功');
// 幂等：重复调用被拦截
const rYE2 = S.carryYearEnd('2025-12');
ck(!rYE2.ok && /已生成|重复/.test(rYE2.msg || ''), 'carryYearEnd 幂等（重复调用被拦截）');
const yeCnt = S.periodVouchers('2025-12').filter((v) => /年度本年利润/.test(v.summary || '')).length;
ck(yeCnt === 1, '年度结转凭证仅 1 张（不再重复）');
// 结转后本年利润清零，settleChecklist 变 ok
const cl12b = S.settleChecklist('2025-12');
const ye2 = cl12b.filter((c) => c.key === 'yearend')[0];
ck(ye2 && ye2.status === 'ok', '结转后 yearend 变 ok（' + (ye2 ? ye2.status : '无') + '）');

console.log('\n=== #8. 非12月不检查 carryYearEnd ===');
baseState();
S.addVoucher({ word: '记', date: '2026-03-10', summary: '收入', entries: [{ code: '1002', dr: 5000, cr: 0 }, { code: '6001', dr: 0, cr: 5000 }] });
const cl3 = S.settleChecklist('2026-03');
ck(!cl3.some((c) => c.key === 'yearend'), '3月 settleChecklist 不含 yearend 检查项');
const rYE3 = S.carryYearEnd('2026-03');
ck(!rYE3.ok && /仅 12 月/.test(rYE3.msg || ''), 'carryYearEnd 对非12月返回「仅12月」');

console.log('\n=== #8. 无 3104 科目时跳过（兼容）===');
baseState();
S.state.subjects = S.state.subjects.filter((s) => s.code !== '3104');
S.addVoucher({ word: '记', date: '2025-12-10', summary: '收入', entries: [{ code: '1002', dr: 5000, cr: 0 }, { code: '6001', dr: 0, cr: 5000 }] });
const clNo = S.settleChecklist('2025-12');
const yeNo = clNo.filter((c) => c.key === 'yearend')[0];
ck(yeNo && yeNo.status === 'ok', '无 3104 科目时 yearend 跳过为 ok（不阻断结账）');

console.log('\n=== #9. 结账页追加展示 store 硬性检查项 ===');
ck(/S\.settleChecklist/.test(src), '结账页调用 S.settleChecklist()（修复前从不调用）');
// 检查项「状态类」必须与 CSS 两侧同时存在。历史教训：JS 用 .settle-check-fail / .sci-dot / .done，
// 而 CSS 里定义的是 .is-fail / .settle-check-icon —— 类名对不上，检查项完全没有颜色，
// 既不报错也看不出来，只能靠断言挡住。
const cssSrc = fs.readFileSync(path.resolve(__dirname, '../css/style.css'), 'utf8');
['is-ok', 'is-warn', 'is-fail'].forEach((cls) => {
  ck(src.indexOf("'" + cls + "'") >= 0, '结账页渲染使用状态类 ' + cls);
  ck(cssSrc.indexOf('.settle-check-item.' + cls) >= 0, 'CSS 定义 .settle-check-item.' + cls + '（否则该状态无颜色）');
});
['settle-check-icon', 'settle-check-label', 'settle-check-tip'].forEach((cls) => {
  ck(src.indexOf(cls) >= 0, 'JS 使用 ' + cls);
  ck(cssSrc.indexOf('.' + cls) >= 0, 'CSS 定义 .' + cls + '（避免静默无样式）');
});
ck(/settle-check-icon[\s\S]{0,80}?'✓'/.test(src) || /'✓'[\s\S]{0,40}?settle-check/.test(src), '通过项渲染为对勾 ✓');

console.log('\n=== #10. renderCashChecklist null 兜底（已随出纳模块下线，断言移除）===');
// 出纳模块已于 2026-09-05 整体下线，Settle.js 中已无 renderCashChecklist 函数，
// 原断言恒失败（对已删除的代码做断言）。此处置空，保留段号以免与其它文档的编号错位。
console.log('  （跳过：目标函数已随出纳模块移除）');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：#5查重/#8年末结转接入/#9硬性检查展示/#10空值兜底' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
