#!/usr/bin/env node
/* 验证：计提折旧的「锚点对齐」链路（store 拒绝 → 页面确认 → align:true 重调）。
 *
 * 【要守住的不变量】
 *   1) 锚点落后时，不带 align 的计提必须**被拒且零副作用**（卡片/凭证一个字节都不许动）；
 *   2) 带 align:true 时必须成功，且「并入金额」正好等于预览值；
 *   3) 对齐只换锚点表示：计提后卡片累计折旧与总账 1602 仍对平（不得凭空多/少一期）；
 *   4) 同一期间重复点击只能「作废重提」，账上始终只有一张有效折旧凭证（不叠加）；
 *   5) UI 必须真的消费 needAlign 并把 align:true 传下去 —— 否则 store 拒绝后用户无路可走
 *      （2026-11-03 实测：Asset.js 与已删除的期末处理卡都只把 r.msg 弹成红字）。
 *   6) 对齐后的「台账六件套」必须同时推进：accumDepr/Begin、periodUsed、deprMonth、
 *      netValueBegin/End、yearDepr —— 缺任一项都会让卡片表单/Excel 导出与辅助账对不上。
 *   7) 删除本期凭证时锚点必须退回【本次计提之前】的锚点月（凭证快照 anchorBefore），
 *      不能交回「购置月 + 期数」推导 —— 两者可以差好几期，会让报表累计折旧虚增。
 *   8) 对齐后本月恰好无卡可提（如对齐后正好提满）时，必须如实回报 aligned 并落库，
 *      不许「提示失败、数据却已改」。
 *
 * A 合成场景（自包含，不依赖账套）：不变量 1~4 的精确断言（金额用可控的整千数，便于逐分核对）。
 * B 真实账套（只读内存副本）：在「下一期」上重跑同一条链路；无账套时自动跳过。
 * D 台账同步（6/7/8）：对齐后 yearDepr / netValue、删除回退锚点、无卡可提的如实回报。
 * C 静态契约：Asset.js 必须消费 needAlign。
 *
 * 用法：node tools/verify_asset_depr_align.js [账套.json]
 * 退出码：0 通过 / 1 有失败。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

/* 内存版 localStorage：store.persist()/backupNow() 只写内存，绝不触碰真实账套文件 */
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
/* store 是单例且内部有缓存：每个账套用全新实例，避免上一个账套的总账缓存串进来
   （见 verify_asset_depr_reconcile.js 的同名说明）。 */
function freshStore() {
  delete require.cache[STORE_PATH];
  delete require.cache[STORAGE_PATH];
  global.S = undefined;
  require(STORAGE_PATH);
  const exported = require(STORE_PATH);
  return { S: global.S, U: exported.util };
}

let bad = 0;
const ck = (cond, msg) => { console.log((cond ? '  \u2713 ' : '  \u2717 ') + msg); if (!cond) bad++; };
function addMonths(ym, n) {
  if (!ym) return '';
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
  return String(Math.floor(y + m / 12)).padStart(4, '0') + '-' + String(((m % 12) + 12) % 12 + 1).padStart(2, '0');
}

/* ============ A. 合成场景：拒绝零副作用 / 对齐金额 / 计提后对平 / 重复点击不叠加 ============ */
console.log('=== A. 合成场景（1000 元/月 × 1 张卡，锚点落后 25 期）===');
{
  const { S, U } = freshStore();
  const Y = (v) => Number(v || 0) / U.AMT_SCALE;
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2024-01', bookkeeper: '测试' });
  S.state.closedPeriods = [];
  S.state.vouchers = [];
  S.state.fixedAssets = [];
  S._glCache = {};

  /* 卡片：2024-08 启用、原值 60,000、5 年、无残值 → 月折旧恰好 1,000.00（定点域无舍入误差，
     便于逐分断言；真实账套的零头由容差承担） */
  S.addFixedAsset({
    code: 'T001', name: '测试设备', acqDate: '2024-08-01', status: '正常',
    original: 60000, salvage: 0, life: 5, periodUsed: 0,
    accumDepr: 0, accumDeprBegin: 0, deprMonth: '',
    depFeeAcct: '6602', accDeprAcct: '1602'
  });
  const fa = S.state.fixedAssets[0];
  const md = S.assetMonthlyDepr(fa);
  ck(md === U.amt(1000), 'A1 月折旧 = 1,000.00（定点 ' + md + '）');

  /* 账上已有 2026-09 的折旧凭证（25 期 = 25,000），但卡片锚点仍在 2024-08 —— 这正是现实里的
     「导入/手工提过、卡片没回写」形态 */
  const oldV = S.addVoucher({
    word: '记', date: '2026-09-30', attach: 0, summary: '计提2026-09固定资产折旧',
    entries: [
      { code: '6602', name: '管理费用', summary: '折旧', dr: 25000, cr: 0 },
      { code: '1602', name: '累计折旧', summary: '折旧', dr: 0, cr: 25000 }
    ]
  });
  ck(!!(oldV && oldV.ok !== false), 'A2 历史折旧凭证已落账 ' + ((oldV && oldV.word) || '') + '-' + ((oldV && oldV.no) || ''));
  ck(S._lastDeprVoucherMonth() === '2026-09', 'A3 账上最后折旧月 = 2026-09（实际 ' + S._lastDeprVoucherMonth() + '）');

  const pv = S.depreciationAlignPreview('2026-10');
  ck(pv.need === true && pv.cards.length === 1 && pv.periods === 25 && pv.total === U.amt(25000),
    'A4 对齐预览：1 卡 / 25 期 / 25,000.00（实际 ' + pv.cards.length + ' 卡 / ' + pv.periods + ' 期 / ' + Y(pv.total).toFixed(2) + '）');

  /* A5~A7：拒绝 + 零副作用（这是最关键的一条：提醒不能变成"提示一半就改了数据"） */
  const snapCards = JSON.stringify(S.state.fixedAssets);
  const snapVchs = JSON.stringify(S.state.vouchers);
  const rRefuse = S.depreciateMonth('2026-10');
  ck(rRefuse.ok === false && rRefuse.needAlign === true,
    'A5 不带 align 的计提被拒且返回 needAlign');
  ck(JSON.stringify(S.state.fixedAssets) === snapCards, 'A6 被拒后卡片分毫未动');
  ck(JSON.stringify(S.state.vouchers) === snapVchs, 'A7 被拒后凭证分毫未动（没有"提一半"的中间态）');

  const vchBefore = S.state.vouchers.length;
  const rAlign = S.depreciateMonth('2026-10', { align: true });
  ck(rAlign.ok === true, 'A8 带 align:true 计提成功' + (rAlign.ok ? '' : '（' + (rAlign.msg || '') + '）'));
  if (rAlign.ok) {
    ck(rAlign.aligned === pv.total, 'A9 并入基准金额 = 预览值 ' + Y(pv.total).toFixed(2) + '（实际 ' + Y(rAlign.aligned).toFixed(2) + '）');
    ck(S.state.vouchers.length === vchBefore + 1, 'A10 只新增 1 张折旧凭证（对齐本身不生成凭证）');
    ck(U.num(fa.accumDepr) === U.amt(26000), 'A11 卡片累计折旧 = 26,000.00（25,000 对齐 + 1,000 本期，实际 ' + Y(fa.accumDepr).toFixed(2) + '）');
    ck(fa.deprMonth === '2026-10' && U.num(fa.periodUsed) === 26, 'A12 锚点推进到 2026-10、已折旧 26 期');
    const row = (S.generalLedger('2026-10') || []).filter((x) => String(x.code) === '1602')[0];
    const ledger = row ? U.num(row.endCr) - U.num(row.endDr) : null;
    ck(ledger !== null && Math.abs(ledger - U.num(fa.accumDepr)) < 1,
      'A13 总账 1602 = 卡片累计 ' + Y(ledger).toFixed(2) + '（差 ' + Y(U.num(fa.accumDepr) - ledger).toFixed(2) + '）');

    /* A14~A15：同一期再点 = 作废重提，不得叠加 */
    const accBefore = U.num(fa.accumDepr);
    const oldId = rAlign.voucher.id;
    const rAgain = S.depreciateMonth('2026-10', { align: true });
    const live = S.state.vouchers.filter((v) =>
      v.kind === S.VOUCHER_KINDS.DEPR && v.deleted !== 'y' && String(v.date || '').slice(0, 7) === '2026-10');
    ck(rAgain.ok === true && live.length === 1, 'A14 重复点击只作废重提：本期有效折旧凭证仍 1 张');
    ck(U.num(fa.accumDepr) === accBefore, 'A15 重复点击后累计折旧不叠加（' + Y(fa.accumDepr).toFixed(2) + '）');
    const oldV2 = S.state.vouchers.filter((v) => v.id === oldId)[0];
    ck(!!(oldV2 && oldV2.deleted === 'y'), 'A16 上一张折旧凭证由系统作废（软删留痕）');
  }
}

/* ============ B. 真实账套（只读内存副本） ============ */
console.log('\n=== B. 真实账套（下一期上重跑同一条链路）===');
const BOOKS_DIR = process.env.TY_BOOKS_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', '添钰财务', 'books');
let books = [];
try {
  books = fs.readdirSync(BOOKS_DIR).filter((f) => f.endsWith('.json') && f.indexOf('.bak') < 0);
} catch (e) { books = []; }
const only = process.argv[2];
if (only) books = books.filter((f) => f === path.basename(only));
if (!books.length) {
  console.log('  跳过：找不到账套目录或账套（' + BOOKS_DIR + '）');
} else {
  books.forEach(function (bf) {
    const { S, U } = freshStore();
    const Y = (v) => (Number(v) || 0) / U.AMT_SCALE;
    let res;
    try { res = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, bf), 'utf8')); } catch (e) { console.log('  - ' + bf + ' 解析失败，跳过'); return; }
    S.state = res;
    if (S.normalizeState) S.normalizeState();
    const name = (S.state.company && S.state.company.name) || bf;
    const last = S._lastDeprVoucherMonth();
    const month = addMonths(last, 1);
    console.log('\n  [' + name + '] 账上最后折旧月 ' + (last || '(无)') + ' → 试算 ' + (month || '(无)'));
    if (!last) { console.log('    - 无折旧凭证，跳过'); return; }
    if (S.isPeriodClosed(month)) { console.log('    - ' + month + ' 已结账，跳过（不越闸门）'); return; }
    if (S.deprVoucherIn(month)) { console.log('    - ' + month + ' 已有折旧凭证，跳过'); return; }

    const ledgerOf = (m) => {
      const depSubj = S.subjectRole('ACC_DEPR');
      const code = depSubj ? String(depSubj.code) : '1602';
      const row = (S.generalLedger(m) || []).filter((x) => String(x.code) === code)[0];
      return row ? U.num(row.endCr) - U.num(row.endDr) : null;
    };
    const live = () => (S.state.fixedAssets || []).filter((f) => f.status !== '清理' && !f.cleanPeriod);
    const cardSum = () => live().reduce((s, f) => s + U.num(f.accumDepr), 0);
    const tol = (live().length + 1) * U.AMT_CENT;

    const pv = S.depreciationAlignPreview(month);
    let r;
    if (pv.need) {
      const snapCards = JSON.stringify(S.state.fixedAssets);
      const snapVchs = JSON.stringify(S.state.vouchers);
      const rRefuse = S.depreciateMonth(month);
      ck(rRefuse.ok === false && rRefuse.needAlign === true,
        'B1 ' + name + ' ' + month + ' 被要求先对齐（' + pv.cards.length + ' 卡 / ' + pv.periods + ' 期 / ' + Y(pv.total).toFixed(2) + '）');
      ck(JSON.stringify(S.state.fixedAssets) === snapCards && JSON.stringify(S.state.vouchers) === snapVchs,
        'B2 ' + name + ' 被拒后卡片与凭证零改动');
      r = S.depreciateMonth(month, { align: true });
      ck(r.ok === true, 'B3 ' + name + ' 确认对齐后计提成功' + (r.ok ? '' : '（' + (r.msg || '') + '）'));
    } else {
      r = S.depreciateMonth(month);
      ck(r.ok === true, 'B1 ' + name + ' ' + month + ' 无需对齐，直接计提成功' + (r.ok ? '' : '（' + (r.msg || '') + '）'));
    }
    if (!r.ok) return;
    const ledger = ledgerOf(month);
    ck(ledger !== null && Math.abs(cardSum() - ledger) <= tol,
      'B4 ' + name + ' 计提后卡片累计 ' + Y(cardSum()).toFixed(2) + ' vs 总账 ' + (ledger === null ? '—' : Y(ledger).toFixed(2)) +
      '（差 ' + (ledger === null ? '—' : Y(cardSum() - ledger).toFixed(2)) + '，容差 ' + Y(tol).toFixed(2) + '）');
    /* 重复点击（真实账套上同样验证"不叠加"） */
    const accBefore = cardSum();
    const r2 = S.depreciateMonth(month, { align: true });
    const liveDepr = S.state.vouchers.filter((v) =>
      v.kind === S.VOUCHER_KINDS.DEPR && v.deleted !== 'y' && String(v.date || '').slice(0, 7) === month);
    ck(r2.ok === true && liveDepr.length === 1 && Math.abs(cardSum() - accBefore) <= tol,
      'B5 ' + name + ' 重复点击不叠加：本期有效折旧凭证 ' + liveDepr.length + ' 张，卡片合计 ' + Y(cardSum()).toFixed(2));
  });
}

/* ============ D. 台账同步与删除回退（2026-11-04 补齐） ============
 * 对齐只改卡片基准（不改凭证），所以「基准」必须是一个完整自洽的时点快照：
 *   accumDeprBegin / periodUsed / deprMonth / netValueBegin / netValueEnd / yearDepr 六件套。
 * 原先只改前三件，后三件要么停在旧值、要么只累加本期；实测分别在
 *   「对齐后本月提满、不再计提」与「本年已折旧」两个台账字段上留下错值。
 * 另外删除本期凭证时锚点必须退回【本次计提之前】的锚点月，不能交回推导 —— 否则报表虚增。 */
console.log('\n=== D. 台账同步（yearDepr / netValue）与删除回退锚点 ===');
{
  /* D1~D3：同一张「导入过、卡片没回写」的卡，对齐 25 期后 yearDepr 只并入 2026 年内的 9 期 */
  const { S, U } = freshStore();
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2024-01', bookkeeper: '测试' });
  S.state.closedPeriods = []; S.state.vouchers = []; S.state.fixedAssets = []; S._glCache = {};
  S.addFixedAsset({
    code: 'D001', name: '台账设备', acqDate: '2024-08-01', status: '正常',
    original: 60000, salvage: 0, life: 5, periodUsed: 0,
    accumDepr: 0, accumDeprBegin: 0, deprMonth: '',
    depFeeAcct: '6602', accDeprAcct: '1602'
  });
  const fa = S.state.fixedAssets[0];
  S.addVoucher({
    word: '记', date: '2026-09-30', attach: 0, summary: '计提2026-09固定资产折旧',
    entries: [
      { code: '6602', name: '管理费用', summary: '折旧', dr: 25000, cr: 0 },
      { code: '1602', name: '累计折旧', summary: '折旧', dr: 0, cr: 25000 }
    ]
  });
  const r = S.depreciateMonth('2026-10', { align: true });
  ck(r.ok === true, 'D1 对齐 + 计提成功');
  /* 对齐区间 2024-09~2026-09 共 25 期，其中落在 2026 年的 9 期 + 本期 1 期 = 10,000 */
  ck(U.num(fa.yearDepr) === U.amt(10000),
    'D2 本年已折旧 = 10,000.00（年内 9 期 + 本期 1 期，实际 ' + (U.num(fa.yearDepr) / U.AMT_SCALE).toFixed(2) + '）');
  ck(U.num(fa.netValueEnd) === U.num(fa.original) - U.num(fa.accumDepr) - U.num(fa.impairment)
    && U.num(fa.netValueBegin) === U.num(fa.netValueEnd),
    'D3 净值 = 原值 − 累计 − 减值，且期初=期末（' + (U.num(fa.netValueEnd) / U.AMT_SCALE).toFixed(2) + '）');
}

{
  /* D4~D6：显式锚点（2026-06）≠ 推导锚点（acqDate+periodUsed = 2026-08）时，删除本期凭证
     必须退回对齐基准月 2026-09，否则报表在 2026-09 会虚增一期 */
  const { S, U } = freshStore();
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2024-01', bookkeeper: '测试' });
  S.state.closedPeriods = []; S.state.vouchers = []; S.state.fixedAssets = []; S._glCache = {};
  S.addFixedAsset({
    code: 'D002', name: '锚点设备', acqDate: '2024-08-01', status: '正常',
    original: 60000, salvage: 0, life: 5, periodUsed: 21,
    accumDepr: 21000, accumDeprBegin: 21000, deprMonth: '2026-06',
    depFeeAcct: '6602', accDeprAcct: '1602'
  });
  const fa2 = S.state.fixedAssets[0];
  S.addVoucher({
    word: '记', date: '2026-09-30', attach: 0, summary: '计提2026-09固定资产折旧',
    entries: [
      { code: '6602', name: '管理费用', summary: '折旧', dr: 3000, cr: 0 },
      { code: '1602', name: '累计折旧', summary: '折旧', dr: 0, cr: 3000 }
    ]
  });
  const r2 = S.depreciateMonth('2026-10', { align: true });
  ck(r2.ok === true && fa2.deprMonth === '2026-10', 'D4 对齐到 2026-09 后计提 2026-10（锚点 ' + fa2.deprMonth + '）');
  const lines = (r2.voucher && r2.voucher.deprLines) || [];
  ck(lines.length === 1 && lines[0].anchorBefore === '2026-09',
    'D5 凭证快照记下计提前锚点 = 2026-09（实际 ' + ((lines[0] && lines[0].anchorBefore) || '—') + '）');
  const del = S.removeVoucher(r2.voucher.id, '回归：删除本期折旧凭证', { system: 'asset' });
  ck(!!(del && del.ok), 'D6 系统作废本期折旧凭证成功');
  ck(fa2.deprMonth === '2026-09', 'D7 锚点退回 2026-09（不是推导值 2026-08，实际 ' + (fa2.deprMonth || '空') + '）');
  const md2 = U.num(S.assetMonthlyDepr(fa2));
  const d2 = 0;   // 2026-09 相对锚点 2026-09 差 0 期
  const accAt = U.num(fa2.accumDeprBegin) + md2 * d2;
  ck(accAt === U.amt(24000), 'D8 报表 2026-09 累计折旧 = 24,000.00（实际 ' + (accAt / U.AMT_SCALE).toFixed(2) + '）');
}

{
  /* D9~D11：对齐后本月恰好提满、无卡可提 —— 必须如实回报 aligned，且不得留在「改了内存没落盘」的状态 */
  const { S, U } = freshStore();
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2021-01', bookkeeper: '测试' });
  S.state.closedPeriods = []; S.state.vouchers = []; S.state.fixedAssets = []; S._glCache = {};
  S.addFixedAsset({
    code: 'D003', name: '提满设备', acqDate: '2021-08-01', status: '正常',
    original: 60000, salvage: 0, life: 5, periodUsed: 58,
    accumDepr: 58000, accumDeprBegin: 58000, deprMonth: '2026-07',
    depFeeAcct: '6602', accDeprAcct: '1602'
  });
  const fa3 = S.state.fixedAssets[0];
  S.addVoucher({
    word: '记', date: '2026-09-30', attach: 0, summary: '计提2026-09固定资产折旧',
    entries: [
      { code: '6602', name: '管理费用', summary: '折旧', dr: 2000, cr: 0 },
      { code: '1602', name: '累计折旧', summary: '折旧', dr: 0, cr: 2000 }
    ]
  });
  const r3 = S.depreciateMonth('2026-10', { align: true });
  ck(r3.ok === false && r3.aligned === U.amt(2000),
    'D9 无卡可提时仍如实回报已并入金额 2,000.00（不是静默返回失败）');
  ck(fa3.periodUsed === 60 && U.num(fa3.accumDepr) === U.amt(60000),
    'D10 卡片基准确实推进到提满（60 期 / 60,000.00）');
  ck(U.num(fa3.netValueEnd) === 0, 'D11 提满后净值 = 0（不再停在旧值 2,000.00）');
}

/* ============ C. 静态契约：UI 必须消费 needAlign ============ */
console.log('\n=== C. 静态契约（Asset.js 接住 needAlign）===');
{
  const src = fs.readFileSync(path.resolve(__dirname, '../js/pages/asset/Asset.js'), 'utf8');
  ck(/r\.needAlign/.test(src), 'C1 Asset.js 判断 r.needAlign（store 拒绝后必须给出出口）');
  ck(/depreciateMonth\(month,\s*\{\s*align:\s*true\s*\}\)/.test(src), 'C2 Asset.js 确认后带 align:true 重调');
  ck(/折旧基准对齐/.test(src), 'C3 确认框标题明确（用户知道自己在确认什么）');
}

console.log('\n' + (bad ? '\u2717 有 ' + bad + ' 项断言失败' : '\u2713 全部通过：折旧锚点对齐链路（拒绝零副作用 / 对齐金额 / 计提后对平 / 不叠加 / 台账六件套 / 删除回退锚点 / UI 已接）'));
process.exit(bad ? 1 : 0);
