/* 空账套 / 无凭证 / 无期初 鲁棒性压测：用真实 store 函数跑边界场景，看是否抛异常或产生 NaN。
 *
 * 【2026-09-26 修假绿 —— 本文件此前是收录集里最典型的"假绿"】
 *   原状：通篇只有 console.log，**零断言、无 process.exit(1)**，因此被 run-all 收录却永远记"通过"。
 *   一个永远通过的"鲁棒性压测"比没有它更糟：它占着"已覆盖"的位置，让人以为边界场景有人看着。
 *   现改为真断言：三个场景各自给出明确结论，任一不满足即 exit(1)，并打印 通过/失败 汇总。
 *
 * 三个场景都刻意构造"最空/最脏"的输入：
 *   ① 完全空账套（连默认科目都没有）—— 最容易在取数时踩空指针/NaN；
 *   ② 有默认科目、无期初无凭证 —— 报表必须平衡（0=0）；
 *   ③ 借贷不平的脏凭证 —— 必须被 addVoucher 拒绝（否则会被静默记账）。
 */
const fs = require('fs'), path = require('path');
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
global.window = global; global.navigator = { sendBeacon: () => true }; global.document = { addEventListener() { } };
global.fetch = () => Promise.reject(new Error('off')); global.XMLHttpRequest = function () { this.open = () => { }; this.setRequestHeader = () => { }; this.send = () => { }; this.status = 200; };
global.addEventListener = () => { }; global.setTimeout = setTimeout; global.clearTimeout = clearTimeout;
require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S; const num = x => { x = Number(x); return isNaN(x) ? 0 : x; }; const EPS = 0.005;

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function hasNaN(obj, p) {
  if (typeof obj === 'number') return isNaN(obj) ? [p] : [];
  if (obj && typeof obj === 'object') { let r = []; for (const k in obj) { r = r.concat(hasNaN(obj[k], p + '.' + k)); } return r.slice(0, 5); }
  return [];
}
const EMPTY = () => ({ subjects: [], openingBalances: {}, vouchers: [], closedPeriods: [], company: { name: '空账套', startMonth: '2026-01' }, param: {} });

console.log('【场景1】完全空账套（无科目、无凭证、无期初）');
{
  const problems = [];
  [S.state = EMPTY(), S._glCache = {}, S.normalizeState(), S.ensureCashFlowFields()];
  ['2026-01', '2026-02'].forEach(m => {
    try {
      const bs = S.balanceSheet(m), pl = S.profitStatement(m), gl = S.generalLedger(m), cf = S.cashFlow(m);
      const nan = hasNaN(bs, 'bs').concat(hasNaN(pl, 'pl')).concat(hasNaN(cf, 'cf'));
      if (nan.length) problems.push(m + ' 出现NaN字段: ' + nan.join(','));
    } catch (e) { problems.push(m + ' 抛异常: ' + e.message); }
  });
  T('空账套取数不抛异常、不产生 NaN', problems.length === 0, problems.join(' | '));
}

console.log('【场景2】有默认科目、无期初、无凭证 —— 资产负债表必须平衡');
{
  [S.state = EMPTY(), S._glCache = {}, S.normalizeState(), S.ensureCashFlowFields()];
  let diff = null, err = '';
  try {
    const bs = S.balanceSheet('2026-01');
    diff = num(bs.assets) - num(bs.liabilities) - num(bs.equity);
  } catch (e) { err = e.message; }
  T('资产负债表平衡（资产 = 负债 + 权益）', diff !== null && Math.abs(diff) <= EPS,
    err ? '异常: ' + err : '差=' + (diff === null ? '?' : diff.toFixed(2))
      + ' 资产=' + num(S.balanceSheet('2026-01').assets).toFixed(2));
}

console.log('【场景3】借贷不平的脏凭证必须被拒绝');
{
  S.state = {
    subjects: [{ code: '1001', name: '现金', cls: 'asset', normal: 'dr' }, { code: '6001', name: '收入', cls: 'revenue', normal: 'cr' }],
    openingBalances: {}, vouchers: [], closedPeriods: [], company: { name: 'x', startMonth: '2026-01' }, param: {}
  };
  S._glCache = {}; S.normalizeState(); S.ensureCashFlowFields();
  let r = null, err = '';
  try {
    r = S.addVoucher({ word: '记', no: '1', date: '2026-01-15', summary: '测试', entries: [{ code: '1001', name: '现金', dr: 100, cr: 0 }, { code: '6001', name: '收入', dr: 0, cr: 50 }] });
  } catch (e) { err = e.message; }
  T('借贷不平凭证被拒绝（ok=false）', r && r.ok === false, err ? '抛异常: ' + err : JSON.stringify(r));
  T('脏凭证未入库', (S.state.vouchers || []).length === 0, '已入库 ' + (S.state.vouchers || []).length + ' 张');
}

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
