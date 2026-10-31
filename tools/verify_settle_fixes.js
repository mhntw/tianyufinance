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
/* 【2026-10-31 字符来源统一后调整】JS 不再输出 ✓ 字符（只输出 is-ok/is-warn/is-fail 状态类），
   字符由 CSS 按状态给 —— 所以这里断言两件事：JS 用 is-ok 表达"通过"，CSS 把 is-ok 映射成 ✓。
   只断言 JS 里出现 ✓ 会变成"测试逼着字符回流到模板字符串"，与单一来源原则相反。 */
ck(/is-ok/.test(src), '通过项用 is-ok 状态类表达（JS 不写字符）');
ck(/\.settle-check-item\.is-ok \.settle-check-icon::before[\s\S]{0,40}content:\s*'✓'/.test(cssSrc),
  'CSS 把 is-ok 映射为对勾 ✓');

console.log('\n=== #10. renderCashChecklist null 兜底（已随出纳模块下线，断言移除）===');
// 出纳模块已于 2026-09-05 整体下线，Settle.js 中已无 renderCashChecklist 函数，
// 原断言恒失败（对已删除的代码做断言）。此处置空，保留段号以免与其它文档的编号错位。
console.log('  （跳过：目标函数已随出纳模块移除）');

/* 汇总与退出码统一放在**文件末尾**：下面的 tplSummary / #11 断言失败同样要让脚本变红。
   （此前 exitCode 写在这里，其后 IIFE 里的 ck() 失败不影响退出码 —— 报了 ✗ 却仍 exit 0。） */

/* ============================================================
 * 结转模板摘要的 {month} 占位符替换
 *
 * 【背景】实测账套里存在摘要为「计提{month}固定资产折旧」的折旧凭证 ——
 * 看着像模板没生效。实际是该占位符在历史版本中从未被替换，修复后新增的凭证已正常；
 * 那条是修复前生成的历史数据（全账套仅 1 张）。
 *
 * 【为什么这里可以直接提取函数】tplSummary 是纯函数（只依赖 String.replace），
 * 没有 DOM / 全局依赖，所以能安全地抠出来单独验证 —— 不像那些依赖链复杂、
 * 一改就静默失效的渲染函数。
 * ============================================================ */
(function () {
  const src = fs.readFileSync(path.resolve(__dirname, '../js/pages/settle/Settle.js'), 'utf8');
  const m = src.match(/function tplSummary\s*\([^)]*\)\s*\{/);
  if (!m) { ck(false, '能在 Settle.js 中找到 tplSummary'); return; }
  let i = src.indexOf('{', m.index), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  const tplSummary = new Function(src.slice(m.index, end + 1) + '; return tplSummary;')();

  ck(tplSummary({ summaryText: '计提{month}固定资产折旧' }, '2026-08') === '计提2026-08固定资产折旧',
    '{month} 被替换为实际期间');
  ck(tplSummary({ summaryText: '{month}结转{month}' }, '2026-08') === '2026-08结转2026-08',
    '多个 {month} 全部替换（非只换首个）');
  ck(tplSummary({ summary: '结转{month}损益' }, '2026-01') === '结转2026-01损益',
    'summaryText 缺省时回退到 summary');
  ck(tplSummary({ name: '计提折旧' }, '2026-01') === '计提折旧',
    '两者都缺省时回退到 name');
  ck(tplSummary({ summaryText: '计提{month}折旧' }, '') === '计提折旧',
    'month 为空时替换为空串（不留下 {month} 字面量）');
  ck(tplSummary(null, '2026-01') === '', 'null 模板返回空串（不抛错）');
  ck(!/\{month\}/.test(tplSummary({ summaryText: '计提{month}固定资产折旧' }, '2026-08')),
    '结果中不再残留 {month} 字面量');
})();

/* ============================================================
 * #11 结转损益卡片的「已结转 / 未结转」金额口径（2026-10-21 修复的防复发断言）
 *
 * 【历史缺陷】旧实现把 3103 的借方与贷方**绝对值相加**当「已结转」。separate 模式
 *   （贷收入 / 借费用 两张凭证）下得到的是「收入结转额 + 费用结转额」——
 *   会计上没有对应科目，且它恒 ≥ |净利润|，于是「未结转」被永远截成 0.00。
 *   实测添钰 2025-08：卡片显示 1,161,539.86，真实净额 525,305.58。
 * 【现在】已结转 = Σ(3103 贷−借)，与 carryForwardProfit 生成口径一致；亏损月为负数（保号）。
 * 【为什么用抽取函数 + mock 而不是复刻】复刻两行算法等于没测；这里跑的是 Settle.js 里的真函数。
 * ============================================================ */
(function () {
  const settleSrc = fs.readFileSync(path.resolve(__dirname, '../js/pages/settle/Settle.js'), 'utf8');
  const m = settleSrc.match(/function renderSettleProfitCard\s*\([^)]*\)\s*\{/);
  if (!m) { ck(false, '能在 Settle.js 中找到 renderSettleProfitCard'); return; }
  let i = settleSrc.indexOf('{', m.index), depth = 0, end = -1;
  for (let j = i; j < settleSrc.length; j++) {
    if (settleSrc[j] === '{') depth++;
    else if (settleSrc[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  const U = global.util;   // store 把 amt/yuan/money/AMT_SCALE 挂在这里（js/store.js:5822 global.util）
  function run(netProfitRaw, entries, targetCode) {
    const els = {
      profitDone: { textContent: '' },
      profitTodo: { textContent: '' },
      cardProfit: { cls: {}, classList: { toggle(k, v) { els.cardProfit.cls[k] = v; } } }
    };
    const $ = (id) => els[id] || null;
    // settleProfitTargetCode：卡片统计的目标科目（模板配置 > 科目角色 > 3103）—— 缺了它会直接抛错
    const Sx = {
      carryForwardStatus: () => ({ vouchers: entries.length ? [{ entries: entries }] : [] }),
      settleProfitTargetCode: () => targetCode || '3103'
    };
    const fn = new Function('$', 'U', 'S', 'money', 'round2',
      settleSrc.slice(m.index, end + 1) + '; return renderSettleProfitCard;')($, U, Sx, U.money, U.round2);
    fn({ netProfit: netProfitRaw }, '2026-08');
    return els;
  }
  const AMT = U.AMT_SCALE;   // 1 元 = 10000 单位

  // ① 盈利月：净利润 100 元，结转凭证 3103 贷 100 元
  let el = run(100 * AMT, [{ code: '3103', dr: 0, cr: 100 * AMT }]);
  ck(el.profitDone.textContent === '100.00', '已结转=净额（' + el.profitDone.textContent + '）');
  ck(el.profitTodo.textContent === '0.00', '结转后未结转=0.00（' + el.profitTodo.textContent + '）');

  // ② 亏损月：净利润 -50 元，结转凭证 3103 借 50 元 —— 必须保号
  el = run(-50 * AMT, [{ code: '3103', dr: 50 * AMT, cr: 0 }]);
  ck(el.profitDone.textContent === '-50.00', '亏损月已结转保号（' + el.profitDone.textContent + '）');
  ck(el.profitTodo.textContent === '0.00', '亏损月结转后未结转=0.00（' + el.profitTodo.textContent + '）');

  // ③ 未结转：净利润 100 元、无结转凭证 —— 旧实现在这里恒显 0.00
  el = run(100 * AMT, []);
  ck(el.profitDone.textContent === '0.00', '未结转时已结转=0.00（' + el.profitDone.textContent + '）');
  ck(el.profitTodo.textContent === '100.00', '未结转时未结转=净利润（' + el.profitTodo.textContent + '）');

  // ④ separate 两张凭证：3103 贷 120 / 借 20 —— 净额 100，不是 140
  el = run(100 * AMT, [{ code: '3103', dr: 0, cr: 120 * AMT }, { code: '3103', dr: 20 * AMT, cr: 0 }]);
  ck(el.profitDone.textContent === '100.00', '两张凭证按净额合计（' + el.profitDone.textContent + '，旧实现为 140.00）');

  // ⑤ 目标科目被重映射（3103 → 4103）：统计必须跟着目标科目走，不能硬编码 3103
  el = run(80 * AMT, [{ code: '4103', dr: 0, cr: 80 * AMT }], '4103');
  ck(el.profitDone.textContent === '80.00', '重映射目标科目后已结转仍正确（' + el.profitDone.textContent + '）');
  ck(el.profitTodo.textContent === '0.00', '重映射后未结转=0.00（' + el.profitTodo.textContent + '）');

  // ⑤b 反向：凭证里出现 3103 但目标科目是 4103 —— 不得把 3103 误算进已结转
  el = run(80 * AMT, [{ code: '3103', dr: 0, cr: 80 * AMT }], '4103');
  ck(el.profitDone.textContent === '0.00', '目标为 4103 时不计 3103（' + el.profitDone.textContent + '）');
})();

/* ============================================================
 * #13 年结凭证识别：未分配利润是「明细科目」时也必须识别出来
 *
 * 【历史缺陷】_detectVoucherKind 的 hasRole() 只做精确编码匹配，而真实账套的未分配利润
 *   几乎总是明细科目（3104006 / 310415）。实测两本账套共 3 张年结凭证恒为 undefined：
 *   添钰 2025-12 记-63、绅蓝 2024-12 记-150、绅蓝 2025-12 记-67。后果是
 *   结账清单把「已结转」显示成「本年利润无余额，无需结转」、12 月利润分配被
 *   「请先结转本年利润」误挡、carryYearEnd 幂等保护失效（可重复生成年结凭证）。
 * 【为什么用合成凭证】断言要固定的正是「父级角色 + 明细分录」这个结构，
 *   与真实账套的具体编码无关；真实账套那一侧由 tools/_probe_kind_census.js 人工比对。
 * ============================================================ */
console.log('\n=== #13. 年结凭证识别（未分配利润为明细科目）===');
baseState();
// 3103 必须是权益类：baseState 里为了跑结转损益把它标成 revenue，那会让 hasPL 恒真、
// 所有凭证先被规则 1 抢成 carryPL，本用例就测不到规则 2。
S.state.subjects.filter((s) => s.code === '3103')[0].cls = 'equity';
S.state.subjects.push({ code: '3104006', name: '未分配利润', cls: 'equity', normal: 'cr', level: 1, enabled: true });
const K2 = S.VOUCHER_KINDS;
ck(S.voucherKind({ entries: [{ code: '3103', dr: 100000, cr: 0 }, { code: '3104006', dr: 0, cr: 100000 }] }) === K2.CARRY_YE,
  '盈利年结（借3103 / 贷3104006）识别为 carryYE');
ck(S.voucherKind({ entries: [{ code: '3104006', dr: 50000, cr: 0 }, { code: '3103', dr: 0, cr: 50000 }] }) === K2.CARRY_YE,
  '亏损年结（借3104006 / 贷3103）识别为 carryYE');
ck(S.voucherKind({ entries: [{ code: '6001', dr: 0, cr: 100000 }, { code: '3103', dr: 0, cr: 100000 }] }) === K2.CARRY_PL,
  '含损益科目仍归 carryPL（不被年结规则抢走）');
// 精确匹配的老行为不能被放宽过头：本年利润 + 累计折旧之类的普通凭证不得被标成年结
ck(S.voucherKind({ entries: [{ code: '1002', dr: 100000, cr: 0 }, { code: '3103', dr: 0, cr: 100000 }] }) === undefined,
  '仅有 3103 的普通凭证不标 kind');
// yearend 检查分支顺序：已结转 + 余额为 0 时必须说「已结转」，不能说「无需结转」
S.state.vouchers = [];
S.state.closedPeriods = [];
S.addVoucher({ word: '记', date: '2025-12-10', summary: '收入', entries: [{ code: '1002', dr: 8000, cr: 0 }, { code: '6001', dr: 0, cr: 8000 }] });
S.carryForwardProfit('2025-12');
S.carryYearEnd('2025-12');
const yeChk = (S.settleChecklist('2025-12') || []).filter((c) => c.key === 'yearend')[0];
ck(yeChk && yeChk.status === 'ok' && /已结转/.test(yeChk.tip || ''),
  'yearend 文案为「已结转」而非「无余额，无需结转」（' + (yeChk && yeChk.tip) + '）');

/* #13b 「利润分配」两条历史缺陷的防复发断言（2026-10-22 核实过程中发现）
 *   ① 金额翻倍：net 同时累加 3103 借方与 3104 贷方，同一笔金额计两次（净利润 1 亿 → net 2 亿）；
 *   ② ReferenceError：R(...) 调用点没跟着 2026-09-26 的收口一起改，一点就抛异常。
 *   两者此前都不可达（年结凭证识别不出 → 恒被「请先结转本年利润」挡住），
 *   修好识别后才会暴露 —— 所以必须在这里锁死，否则改回去也没人发现。 */
console.log('\n=== #13b. 利润分配金额（净利润 1 亿元）===');
baseState();
S.state.subjects = [
  { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
  { code: '3103', name: '本年利润', cls: 'equity', normal: 'cr', level: 0, enabled: true },
  { code: '3104', name: '利润分配', cls: 'equity', normal: 'cr', level: 0, enabled: true },
  { code: '310401', name: '法定盈余公积', cls: 'equity', normal: 'cr', level: 1, enabled: true },
  { code: '310402', name: '任意盈余公积', cls: 'equity', normal: 'cr', level: 1, enabled: true },
  { code: '2232', name: '应付股利', cls: 'liability', normal: 'cr', level: 0, enabled: true },
  { code: '3104006', name: '未分配利润', cls: 'equity', normal: 'cr', level: 1, enabled: true }
];
// addVoucher 的 dr/cr 是「元」→ 内部按 10000 定点；1 亿元 = 1e12 定点
S.addVoucher({ word: '记', date: '2025-12-10', summary: '收入', entries: [{ code: '1002', dr: 100000000, cr: 0 }, { code: '6001', dr: 0, cr: 100000000 }] });
S.carryForwardProfit('2025-12');
const ry2 = S.carryYearEnd('2025-12');
ck(ry2.ok, '结转本年利润成功（' + (ry2.msg || ry2.amount) + '）');
let rp;
try { rp = S.carryProfitDistribute('2025-12'); } catch (e) { rp = { ok: false, msg: '抛异常: ' + e.message }; }
ck(rp && rp.ok, '利润分配不再抛 ReferenceError（' + (rp && rp.msg) + '）');
if (rp && rp.ok) {
  const AMT_ALLOC = rp.amount;
  ck(AMT_ALLOC === 500000000000, '分配总额 = 净利润 50%（' + AMT_ALLOC + '，翻倍时为 1e12）');
  const eOf = (c) => rp.voucher.entries.filter((e) => e.code === c)[0] || { dr: 0, cr: 0 };
  ck(eOf('310401').cr === 100000000000, '法定盈余公积 10%（' + eOf('310401').cr + '）');
  ck(eOf('310402').cr === 100000000000, '任意盈余公积 10%（' + eOf('310402').cr + '）');
  ck(eOf('2232').cr === 300000000000, '应付股利 30%（' + eOf('2232').cr + '）');
  ck(eOf('3104').dr === AMT_ALLOC, '借方利润分配 = 分配总额');
  const drS = rp.voucher.entries.reduce((a, e) => a + e.dr, 0);
  const crS = rp.voucher.entries.reduce((a, e) => a + e.cr, 0);
  ck(drS === crS, '借贷平衡（' + drS + '）');
  ck(rp.voucher.entries.every((e) => Number.isInteger(e.dr) && Number.isInteger(e.cr)),
    '金额全部为 0.0001 元定点整数（非整数会污染 I15）');
}
// 亏损年度：年结凭证反向（借3104/贷3103）→ 必须拒绝分配，绝不能按负数提取
baseState();
S.state.subjects = S.state.subjects.concat([
  { code: '310401', name: '法定盈余公积', cls: 'equity', normal: 'cr', level: 1, enabled: true },
  { code: '2232', name: '应付股利', cls: 'liability', normal: 'cr', level: 0, enabled: true },
  { code: '3104006', name: '未分配利润', cls: 'equity', normal: 'cr', level: 1, enabled: true }
]);
S.state.subjects.filter((s) => s.code === '3103')[0].cls = 'equity';
S.addVoucher({ word: '记', date: '2025-12-10', summary: '费用', entries: [{ code: '6602', dr: 5000, cr: 0 }, { code: '1002', dr: 0, cr: 5000 }] });
S.carryForwardProfit('2025-12');
const ry3 = S.carryYearEnd('2025-12');
ck(ry3.ok, '亏损年度结转本年利润成功');
const rp2 = S.carryProfitDistribute('2025-12');
ck(rp2 && !rp2.ok && /可供分配的净利润/.test(rp2.msg || ''), '亏损年度拒绝分配（' + (rp2 && rp2.msg) + '）');

/* ============================================================
 * #13c 结转损益凭证的「版式」与金蝶逐条对齐（2026-10-22）
 *
 * 【为什么要锁】金额一致、只差排版时，人眼比对会误判成「不一样」；
 *   而为了排版去动分录顺序，又很容易踩到一个隐蔽坑：配平逻辑原本取 entries[last]，
 *   把本年利润移到首行后，配平就会去改**最后一个费用科目**（账平了，但科目金额错了）。
 *
 * 【金蝶事实】两本真实账套 86 张结转损益凭证（收入 40 / 费用 46，0 异常）：
 *   · 科目按编码升序；· 收入凭证本年利润在末行；· 费用凭证本年利润在首行；
 *   · 分录摘要统一「结转本期损益」。
 *   改完后对 47 个月重新结转，1703 条分录逐条比对：科目/方向/金额/顺序/摘要 0 差异。
 * ============================================================ */
console.log('\n=== #13c. 结转损益凭证版式（对齐金蝶）===');
baseState();
S.state.subjects = [
  { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
  { code: '6051', name: '其他业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '5601', name: '销售费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '3103', name: '本年利润', cls: 'equity', normal: 'cr', level: 0, enabled: true },
  { code: '3104', name: '利润分配', cls: 'equity', normal: 'cr', level: 0, enabled: true }
];
// 故意让费用凭证的录入顺序是 6602 → 5601（与编码升序相反），验证生成时会重排
S.addVoucher({ word: '记', date: '2025-06-10', summary: '收入', entries: [{ code: '1002', dr: 2000, cr: 0 }, { code: '6001', dr: 0, cr: 1200 }, { code: '6051', dr: 0, cr: 800 }] });
S.addVoucher({ word: '记', date: '2025-06-11', summary: '费用', entries: [{ code: '6602', dr: 200, cr: 0 }, { code: '5601', dr: 300, cr: 0 }, { code: '1002', dr: 0, cr: 500 }] });
const rAlign = S.carryForwardProfit('2025-06', { separate: true });
ck(rAlign.ok && (rAlign.vouchers || []).length === 2, 'separate=true 生成 2 张凭证');
const vsA = rAlign.vouchers || [];
const revV = vsA.filter((v) => String(v.entries[v.entries.length - 1].code) === '3103')[0];
const expV = vsA.filter((v) => String(v.entries[0].code) === '3103')[0];
ck(!!revV, '收入凭证：本年利润在末行');
ck(!!expV, '费用凭证：本年利润在首行（原实现放末行）');
if (revV) {
  ck(revV.entries.map((e) => String(e.code)).join(',') === '6001,6051,3103',
    '收入科目按编码升序（' + revV.entries.map((e) => e.code).join(',') + '）');
  ck(revV.entries[revV.entries.length - 1].cr === 20000000, '收入侧本年利润金额 = 2000 元');
}
if (expV) {
  ck(expV.entries.map((e) => String(e.code)).join(',') === '3103,5601,6602',
    '费用科目按编码升序，即使录入顺序相反（' + expV.entries.map((e) => e.code).join(',') + '）');
  ck(expV.entries[0].dr === 5000000, '费用侧本年利润金额 = 500 元');
  ck(expV.entries.filter((e) => e.code === '6602')[0].cr === 2000000, '管理费用金额未被配平逻辑改动');
  ck(expV.entries.filter((e) => e.code === '5601')[0].cr === 3000000, '销售费用金额未被配平逻辑改动');
}
const allE = [].concat.apply([], vsA.map((v) => v.entries));
ck(allE.every((e) => e.summary === '结转本期损益'), '全部分录摘要为「结转本期损益」');
// 配平必须落在本年利润：源码层检查（该分支只在逐科目 round2 出现残差时才走，运行时难以稳定构造）
const storeSrc = fs.readFileSync(path.resolve(__dirname, '../js/store.js'), 'utf8');
ck(/var _plug = null;[\s\S]{0,220}?String\(entries\[_i\]\.code\) === String\(profitCode\)/.test(storeSrc),
  '配平目标按本年利润定位，而非固定取末行（否则会改错费用科目）');

/* ============================================================
 * #13d 还原结转凭证时防重复结转（2026-10-22）
 *
 * 【为什么要锁】上一轮讨论发现：重新结转是软删旧凭证（进回收站），若用户误点「还原」，
 *   本期会并存两套结转凭证 → 本年利润（3103）双倍结转（借贷仍平、极难察觉）。
 *   已在 restoreVoucher 加前置拦截：「还原 carryPL 且本期已有其它 carryPL」时拒绝。
 *   这里只拦这一条最危险路径，普通凭证还原、还原唯一一张结转凭证都不受影响。
 * ============================================================ */
console.log('\n=== #13d. 还原结转凭证防重复===');
baseState();
S.state.subjects = [
  { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
  { code: '6051', name: '其他业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '5601', name: '销售费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '3103', name: '本年利润', cls: 'equity', normal: 'cr', level: 0, enabled: true },
  { code: '3104', name: '利润分配', cls: 'equity', normal: 'cr', level: 0, enabled: true }
];
S.addVoucher({ word: '记', date: '2025-06-10', summary: '收入', entries: [{ code: '1002', dr: 2000, cr: 0 }, { code: '6001', dr: 0, cr: 1200 }, { code: '6051', dr: 0, cr: 800 }] });
S.addVoucher({ word: '记', date: '2025-06-11', summary: '费用', entries: [{ code: '6602', dr: 200, cr: 0 }, { code: '5601', dr: 300, cr: 0 }, { code: '1002', dr: 0, cr: 500 }] });
const rcD = S.carryForwardProfit('2025-06', { separate: true });
const vvsD = rcD.vouchers || [];
ck(vvsD.length === 2, '生成 2 张结转损益凭证');
const revD = vvsD.filter((v) => String(v.entries[v.entries.length - 1].code) === '3103')[0];
// 模拟「重新结转」：软删收入凭证（进回收站）
S.removeVoucher(revD.id);
const rrD = S.restoreVoucher(revD.id);
ck(!rrD.ok, '本期已有其它结转凭证时，还原结转凭证被拒绝');
ck(S.periodVouchersOfKind('2025-06', S.VOUCHER_KINDS.CARRY_PL).length === 1, '拦截后本期仍只有 1 张结转凭证');
// 反向：还原一张普通凭证不受拦
const plainD = S.addVoucher({ word: '记', date: '2025-06-20', summary: 'x', entries: [{ code: '1002', dr: 1, cr: 0 }, { code: '6001', dr: 0, cr: 1 }] });
S.removeVoucher(plainD.id);
ck(S.restoreVoucher(plainD.id).ok, '还原普通凭证不受重复结转拦截影响');

/* ============================================================
 * #13e 年末结转提示金额口径（2026-10-22）
 *
 * 【缺陷】Settle.js 结转成功后提示读 `r.bal`，而 store.carryYearEnd 返回的是
 *   `{ok, voucher, amount}` —— 没有 bal。`Math.abs(undefined || 0)` 恒为 0，
 *   表现为「结转成功却提示 ¥0.00」，用户会以为没结转成功而重复操作。
 * 【为什么没被发现】页面层零测试覆盖；两个 Node 测试脚本用的都是 `.amount`（正确），
 *   唯独 UI 用了错字段，测试照不到。
 * ============================================================ */
console.log('\n=== #13e. 年末结转提示金额口径 ===');
baseState();
S.addVoucher({ word: '记', date: '2025-12-10', summary: '收入', entries: [{ code: '1002', dr: 8000, cr: 0 }, { code: '6001', dr: 0, cr: 8000 }] });
S.addVoucher({ word: '记', date: '2025-12-11', summary: '费用', entries: [{ code: '6602', dr: 2000, cr: 0 }, { code: '1002', dr: 0, cr: 2000 }] });
S.carryForwardProfit('2025-12');
const rYEBal = S.carryYearEnd('2025-12');
ck(rYEBal.ok, '年末结转执行成功');
ck(rYEBal.bal === undefined, '返回对象无 bal 字段（页面不得读 r.bal）');
ck(rYEBal.amount === 60000000, '返回 amount = 6000 元（定点 ' + rYEBal.amount + '）');
const settleSrcBal = fs.readFileSync(path.resolve(__dirname, '../js/pages/settle/Settle.js'), 'utf8');
ck(!/Math\.abs\(\s*r\.bal\b/.test(settleSrcBal), 'Settle.js 不再用 Math.abs(r.bal) 取金额（注释提及不算）');
ck(/r\.amount/.test(settleSrcBal), 'Settle.js 改读 r.amount');

console.log('\n============================');
console.log(bad === 0
  ? '全部通过：#5查重/#8年末结转接入/#9硬性检查展示/#11结转金额口径/#12结转目标科目单点/#13年结识别/#13b利润分配/#13c版式对齐/#13d还原防重复/#13e年末结转金额口径'
  : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
