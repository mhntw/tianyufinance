#!/usr/bin/env node
/* 验证「借贷平衡以分为单位判定」的口径（2026-11-03 定稿，见 store.js 的 AMT_CENT）。
 *
 * 【背景（实测，不是假设）】金蝶源账套金额是 4 位定点，导入后会出现 <1 分的残差：
 *   绅蓝之星 2026-10「记-21」里 5602015 一行 1,022.8508 元（4 位小数），使借贷差 8 个单位
 *   （0.0008 元），进而在「运行期自检 / 结账清单 / 资产负债表 / 健康检查」四处各报一条。
 *   金蝶与凭证录入页都按「分」判平，所以这 8 个单位不是账错，而是精度残差。
 *
 * 【本脚本锁住的不变量】
 *   1) 差 < 1 分（<100 个单位）：voucherBalance().centBalanced = true；
 *      自检不出 vbal/bsBal 项、结账清单 vbal/bsBal 均为 ok、健康检查不出 bs_unbalanced；
 *   2) 差 ≥ 1 分：仍然严格拦截 —— 自检 error、结账 fail、健康检查风险项、_addVoucher 拒绝保存；
 *   3) 亚分残差凭证允许被保存/编辑（否则这类导入凭证连改摘要都会被"借贷不平衡"挡住）；
 *   4) 元域（v5 未迁移账套）不得因阈值单位不同而误判 —— 0.01 元必须仍被当作 1 分。
 *
 * 用法：node tools/verify_subcent_policy.js    退出码 0 通过 / 1 失败
 */
'use strict';
const path = require('path');

const mem = {};
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;

const STORE_PATH = path.resolve(__dirname, '../js/store.js');
const STORAGE_PATH = path.resolve(__dirname, '../js/storage.js');
require(STORAGE_PATH);
require(STORE_PATH);
const exported = require(STORE_PATH);
const S = global.S;
const U = exported.util;

let bad = 0;
const ck = (cond, msg, extra) => { console.log((cond ? '  \u2713 ' : '  \u2717 ') + msg + (cond || !extra ? '' : '  → ' + extra)); if (!cond) bad++; };
const MON = '2026-02';

const SUBJ = [
  { code: '1001', name: '库存现金', normal: 'dr', cls: 'asset', level: 1 },
  { code: '2202', name: '应付账款', normal: 'cr', cls: 'liability', level: 1 },
  { code: '3001', name: '实收资本', normal: 'cr', cls: 'equity', level: 1 }
];

/* 构造样本账套：一张被测凭证（借 1001 / 贷 3001，差额 = diffUnits 个单位）。
   legacy=true 时用 v5 元域（金额直接是元），否则 v6（金额 = 0.0001 元整数）。 */
function build(diffUnits, legacy) {
  const dr = legacy ? 100 + diffUnits : U.amt(100) + diffUnits;
  const cr = legacy ? 100 : U.amt(100);
  S.state = {
    schemaVersion: legacy ? 5 : 6,
    company: { name: '亚分样本', startMonth: '2026-01' },
    subjects: SUBJ, openingBalances: {}, param: {}, closedPeriods: [], fixedAssets: [],
    vouchers: [{
      id: 'V1', word: '记', no: 1, date: MON + '-10', deleted: '', summary: '被测凭证',
      entries: [
        { code: '1001', name: '库存现金', dr: dr, cr: 0, summary: '被测' },
        { code: '3001', name: '实收资本', dr: 0, cr: cr, summary: '被测' }
      ]
    }]
  };
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  S.bookId = 'SUBCENT_SAMPLE';
  return S.state.vouchers[0];
}

console.log('=== A. 亚分残差（8 个单位 = 0.0008 元）：四处都不得报 ===');
{
  const v = build(8, false);
  const vb = S.voucherBalance(v.entries);
  ck(vb.centBalanced === true && vb.balanced === false,
    'A1 voucherBalance：centBalanced=true、balanced=false（口径分层正确）');

  const st = S.runSelfTest(MON);
  const badItems = (st.items || []).filter((i) => i.key === 'vbal' || i.key === 'bsBal');
  ck(badItems.length === 0, 'A2 运行期自检：无 vbal / bsBal 项', JSON.stringify(badItems));

  const cl = S.settleChecklist(MON);
  const vbal = cl.filter((c) => c.key === 'vbal')[0], bsBal = cl.filter((c) => c.key === 'bsBal')[0];
  ck(!!vbal && vbal.status === 'ok', 'A3 结账清单 vbal = ok', vbal && vbal.tip);
  ck(!!bsBal && bsBal.status === 'ok', 'A4 结账清单 bsBal = ok', bsBal && bsBal.tip);

  const h = S.financialHealthCheck({});
  const types = (h.checks || []).map((c) => c.type);
  ck(types.indexOf('bs_unbalanced') < 0, 'A5 健康检查：不出 bs_unbalanced', types.join(',') || '(无)');

  // addVoucher 入参是「元」（内部统一 amt() 换算），故这里用 100.0008 造 8 个单位的残差
  const r = S.addVoucher({
    word: '记', no: 90, date: MON + '-20', summary: '亚分残差凭证（模拟导入）',
    entries: [
      { code: '1001', name: '库存现金', dr: 100.0008, cr: 0, summary: 'x' },
      { code: '3001', name: '实收资本', dr: 0, cr: 100, summary: 'x' }
    ]
  });
  ck(!!r && r.ok !== false, 'A6 4 位残差凭证允许保存（否则编辑导入凭证连改摘要都会被拒）', r && r.msg);
}

console.log('\n=== B. 真不平（100 个单位 = 1 分）：四处必须拦 ===');
{
  const v = build(100, false);
  const vb = S.voucherBalance(v.entries);
  ck(vb.centBalanced === false, 'B1 voucherBalance：centBalanced=false');

  const st = S.runSelfTest(MON);
  const vItem = (st.items || []).filter((i) => i.key === 'vbal')[0];
  ck(!!vItem && vItem.level === 'error', 'B2 运行期自检：vbal = error', vItem && vItem.label);

  const cl = S.settleChecklist(MON);
  const vbal = cl.filter((c) => c.key === 'vbal')[0];
  ck(!!vbal && vbal.status === 'fail', 'B3 结账清单 vbal = fail（拦截结账）', vbal && vbal.tip);

  const h = S.financialHealthCheck({});
  ck((h.checks || []).map((c) => c.type).indexOf('bs_unbalanced') >= 0, 'B4 健康检查：出 bs_unbalanced');

  const r = S.addVoucher({
    word: '记', no: 91, date: MON + '-21', summary: '差 1 分',
    entries: [
      { code: '1001', name: '库存现金', dr: U.amt(100) + 100, cr: 0, summary: 'x' },
      { code: '3001', name: '实收资本', dr: 0, cr: U.amt(100), summary: 'x' }
    ]
  });
  ck(!!r && r.ok === false, 'B5 addVoucher：1 分不平必须拒绝保存', r && r.msg);
}

console.log('\n=== C. 元域（v5 未迁移账套）不得误判 ===');
{
  build(0.01, true);   // 元域：差额正好 1 分
  ck(S.state.schemaVersion === 5, 'C0 样本确为 v5（元域）账套');
  const st = S.runSelfTest(MON);
  const bs = (st.items || []).filter((i) => i.key === 'bsBal');
  ck(bs.length > 0, 'C1 元域账套差 0.01 元（=1 分）仍必须报 bsBal', JSON.stringify(bs));
  ck(S._toAmtUnits(0.01) === 100, 'C2 _toAmtUnits：元域的 0.01 元归一为 100 个单位', String(S._toAmtUnits(0.01)));

  build(0.0008, true);  // 元域：亚分残差
  const st2 = S.runSelfTest(MON);
  const bs2 = (st2.items || []).filter((i) => i.key === 'bsBal');
  ck(bs2.length === 0, 'C3 元域账套差 0.0008 元（亚分）不报 bsBal', JSON.stringify(bs2));
}

console.log('\n' + (bad ? '\u2717 有 ' + bad + ' 项断言失败' : '\u2713 全部通过：平衡以「分」为单位（亚分不报 / 1 分必拦 / 元域不误判）'));
process.exit(bad ? 1 : 0);
