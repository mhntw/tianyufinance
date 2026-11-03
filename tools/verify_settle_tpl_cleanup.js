#!/usr/bin/env node
/* 验证：结账模板清理（已下线 id / 纯空壳，store.cleanupSettleTemplates）—— 2026-11-03
 *
 * 【要守住的不变量】
 *   1) dep / cost / fx 一律清掉（功能已下线，记录没有消费者）；
 *   2) 纯 {id, enabled} 空壳清掉 —— 旧版把分录定义放在 localStorage，迁移丢失后只剩 id；
 *   3) **该留的必须留**：profit（唯一在用的系统模板）、有 name 无分录、custom、fromVchTpl、
 *      有分录 —— 误删等于丢用户模板，比留脏记录严重得多；
 *   4) 幂等：连跑两次结果一致（normalizeState 每次加载都会调它）；
 *   5) normalizeState 真的接线了（否则函数一辈子不执行，等于没清理）。
 *
 * 用法：node tools/verify_settle_tpl_cleanup.js
 * 退出码：0 通过 / 1 有失败。
 */
'use strict';
const path = require('path');

/* 内存版 localStorage：store.persist() 只写内存，绝不触碰真实账套文件 */
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

let bad = 0;
const ck = (cond, msg) => { console.log((cond ? '  \u2713 ' : '  \u2717 ') + msg); if (!cond) bad++; };
const ids = (list) => (list || []).map((t) => (t && t.id) || '(无id)').join(',');

require(STORAGE_PATH);
const exported = require(STORE_PATH);
const S = global.S;
const cleanup = exported.cleanupSettleTemplates;
const U = exported.util;

/* ============ A. 判定边界：只删三类，其余一律保留 ============ */
console.log('=== A. 判定边界 ===');
ck(typeof cleanup === 'function', 'A0 store 导出 cleanupSettleTemplates（工具测真实实现，不手抄判定）');
{
  const book = {
    settleTemplates: [
      { id: 'dep', name: '计提折旧', enabled: true, summary: '计提本月固定资产折旧' },  // 已下线 → 删
      { id: 'cost', enabled: false },                                                   // 已下线 → 删
      { id: 'fx', custom: true, template: [{ code: '1001', dr: 1, cr: 0 }] },            // 已下线 → 删
      { id: 'profit', enabled: true },                                                   // 系统模板 → 留
      { id: 'ghost1', enabled: true },                                                    // 空壳 → 删
      { id: 'ghost2' },                                                                   // 空壳 → 删
      null,                                                                               // 无效 → 删
      { enabled: true },                                                                  // 缺 id → 删
      { id: 'named', name: '只有名字没有分录' },                                          // 有名字 → 留
      { id: 'cust', custom: true, template: [{ code: '1801', dr: 1, cr: 0 }] },           // custom → 留
      { id: 'vch1', fromVchTpl: true },                                                   // 录凭证同步 → 留
      { id: 'hasrow', template: [{ code: '1801', dr: 1, cr: 0 }] }                        // 有分录 → 留
    ]
  };
  cleanup(book);
  const got = ids(book.settleTemplates);
  ck(got === 'profit,named,cust,vch1,hasrow', 'A1 只留 profit/named/cust/vch1/hasrow（实际 ' + got + '）');
  ck(book.settleTemplates.length === 5,
    'A2 12 条 → 5 条（删 7 条：dep/cost/fx 3 + ghost1/ghost2 2 + null 1 + 缺 id 1）');
  ck(!book.settleTemplates.some((t) => t.id === 'dep'), 'A3 dep（计提折旧）必须清掉');
  ck(book.settleTemplates.some((t) => t.id === 'profit'), 'A4 profit 不得被误删');

  // 幂等
  const snap = JSON.stringify(book.settleTemplates);
  cleanup(book);
  ck(JSON.stringify(book.settleTemplates) === snap, 'A5 幂等：连跑两次结果一致');
}

/* ============ B. 入参健壮性：不是数组 / 空对象不得抛错 ============ */
console.log('=== B. 入参健壮性 ===');
{
  let err = '';
  try {
    cleanup(null); cleanup(undefined); cleanup({}); cleanup({ settleTemplates: null }); cleanup({ settleTemplates: 'x' });
  } catch (e) { err = e.message; }
  ck(!err, 'B1 null / 无该字段 / 非数组入参均不抛错' + (err ? '（实际 ' + err + '）' : ''));
}

/* ============ C. 接线：normalizeState 必须真的调用它 ============ */
console.log('=== C. normalizeState 接线 ===');
{
  S.state = { settleTemplates: [
    { id: 'dep', enabled: true },
    { id: 'ghost', enabled: true },
    { id: 'profit', enabled: true }
  ] };
  S.normalizeState();
  const got = ids(S.state.settleTemplates);
  ck(got === 'profit', 'C1 加载账套（normalizeState）即完成清理，只剩 profit（实际 ' + got + '）');
  // 再跑一次不得变化（每次加载都会跑）
  const snap = JSON.stringify(S.state.settleTemplates);
  S.normalizeState();
  ck(JSON.stringify(S.state.settleTemplates) === snap, 'C2 再次 normalizeState 不改动（幂等）');
  // 有定义的自定义模板不能在加载路径里被干掉
  S.state.settleTemplates = [
    { id: 'c_keep', custom: true, name: '摊销房租', template: [{ code: '540103', dr: 50500, cr: 0 }] }
  ];
  S.normalizeState();
  ck(ids(S.state.settleTemplates) === 'c_keep', 'C3 有分录的自定义模板经加载后仍在（实际 ' + ids(S.state.settleTemplates) + '）');
  ck(U && typeof U.num === 'function', 'C4 util 导出可用（store 加载正常）');
}

/* ---------- 汇总 ---------- */
if (bad) {
  console.log('\n✗ 结账模板清理验证失败：' + bad + ' 项');
  process.exit(1);
}
console.log('\n✓ 结账模板清理验证通过：11 项');
