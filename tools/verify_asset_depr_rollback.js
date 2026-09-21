#!/usr/bin/env node
/* 验证：删除/还原「折旧凭证」「清理凭证」时，固定资产卡片业务状态同步回退/恢复。
 *
 * 背景（2026-09-18 实测事故）：计提折旧会更新卡片（accumDepr += 本期、periodUsed++、
 * deprMonth = 本月、deprVoucher = 凭证号），但删除折旧凭证原先只软删凭证、卡片不回滚 ——
 * 卡片于是永久比总账多一期折旧（实测 130,520.13 vs 119,653.50，差额 10,866.63 恰好一期）。
 * 清理凭证另有「删凭证要求先取消清理、取消清理要求先删凭证」的互锁，一并解除。
 * 规范依据：账账相符（卡片辅助账 ⇄ 总账）、账实相符（处置撤销则资产仍在）。
 *
 * 断言分四组：
 *   A 最小自包含场景（折旧）：计提 → 删除 → 还原，逐字段核对（不依赖任何账套文件）
 *   B 真实账套端到端：相对量断言（计提 +N → 删除回基线 → 还原再 +N），不依赖账套当前是否已对齐
 *   C 回归：工资引用仍拦截且给出具体指引；原始凭证引用【不再拦截】（该功能已于 2026-09-21 移除）
 *   D 清理凭证链路：清理 → 生成凭证 → 删除（卡片回退「正常」）→ 还原（状态复原）
 *
 * 用法：node tools/verify_asset_depr_rollback.js [账套.json]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// 内存版 localStorage：store.persist() 只写内存，绝不触碰真实账套文件
const mem = {};
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};
global.document = { getElementById: () => null, addEventListener: () => {} };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;

const FILE = process.argv[2] ||
  path.join(os.homedir(), 'Library/Application Support/添钰财务/books/添钰来客_2026年_金蝶KIS格式_1789713314012.json');
const BOOK = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;

let bad = 0;
const ck = (c, m) => { console.log((c ? '  \u2713 ' : '  \u2717 ') + m); if (!c) bad++; };
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const cardSum = () => r2((S.state.fixedAssets || []).reduce((s, fa) => s + num(fa.accumDepr), 0));
const vById = (id) => (S.state.vouchers || []).filter((v) => v.id === id)[0];
// 复刻 Asset.js 的 _deprAnchorMonth：显式 deprMonth 优先，否则「购置月 + 已折旧期间数」
function addMonths(ym, n) {
  const p = String(ym).split('-');
  const t = (+p[0]) * 12 + (+p[1] - 1) + n;
  return String(Math.floor(t / 12)).padStart(4, '0') + '-' + String(t % 12 + 1).padStart(2, '0');
}
const anchorOf = (fa) => fa.deprMonth ? String(fa.deprMonth)
  : (fa.acqDate ? addMonths(String(fa.acqDate).slice(0, 7), num(fa.periodUsed || 0)) : '');

/* ============ A. 最小自包含场景 ============ */
console.log('=== A. 最小自包含场景：计提 → 删除 → 还原 ===');
S.state = {};
S.normalizeState();
// 累计折旧（ACC_DEPR 角色）+ 管理费用（DEPR_FEE 角色）是计提的前置科目，缺一即被拒
S.state.subjects = [
  { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '540102', name: '折旧', cls: 'expense', normal: 'dr', level: 0, enabled: true }
];
S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
S.state.closedPeriods = [];
S.state.vouchers = [];
S.state.fixedAssets = [{
  id: 'fa1', code: '001', name: '测试设备', acqDate: '2026-01-01', status: '在用',
  original: 12000, salvage: 0, life: 10, periodUsed: 0,
  accumDepr: 0, accumDeprBegin: 0, deprMonth: '',
  depFeeAcct: '540102', accDeprAcct: '1602'
}];
S._glCache = {};

const r1 = S.depreciateMonth('2026-02');
ck(r1.ok === true, 'A1 计提成功' + (r1.ok ? '' : '（' + (r1.msg || '') + '）'));
if (!r1.ok) {
  console.log('  - A2~A17 跳过（计提前置未通过，先修场景前置再跑）');
} else {
  const fa1 = S.state.fixedAssets[0];
  const vno1 = (r1.voucher.word || '记') + '-' + r1.voucher.no;
  const accAfter = num(fa1.accumDepr);
  ck(accAfter > 0, 'A2 卡片累计折旧已计入 ' + accAfter.toFixed(2));
  ck(String(fa1.deprMonth) === '2026-02', 'A3 锚点月 = 2026-02');
  ck(fa1.deprVoucher === vno1, 'A4 卡片引用凭证 ' + vno1);
  ck(num(fa1.periodUsed) === 1, 'A5 已折旧期间 = 1');

  const rDel = S.removeVoucher(r1.voucher.id);
  ck(rDel.ok === true, 'A6 删除折旧凭证成功（未再被「固定资产引用」拦死）' + (rDel.ok ? '' : '（' + rDel.msg + '）'));
  ck(Math.abs(num(fa1.accumDepr)) < 0.01, 'A7 卡片累计折旧已回滚为 0');
  ck(num(fa1.periodUsed) === 0, 'A8 已折旧期间回退为 0');
  ck(!fa1.deprVoucher, 'A9 deprVoucher 已清空');
  ck(!fa1.deprMonth && anchorOf(fa1) === '2026-01',
    'A10 锚点已交回推导并落在 2026-01（显式字段已清除，不与推导打架）');
  const rec1 = vById(r1.voucher.id);
  ck(!!(rec1 && rec1.deprReverted && rec1.deprReverted.length === 1), 'A11 凭证上留存 1 条回滚快照');

  const rRes = S.restoreVoucher(r1.voucher.id);
  ck(rRes.ok === true, 'A12 还原凭证成功');
  ck(Math.abs(num(fa1.accumDepr) - accAfter) < 0.01, 'A13 卡片累计折旧恢复 ' + num(fa1.accumDepr).toFixed(2));
  ck(num(fa1.periodUsed) === 1, 'A14 已折旧期间恢复 1');
  ck(fa1.deprVoucher === vno1, 'A15 deprVoucher 恢复 ' + vno1);
  ck(String(fa1.deprMonth) === '2026-02', 'A16 锚点月恢复 2026-02');
  ck(!(rec1 && rec1.deprReverted), 'A17 快照已消费（不会重复回滚）');
}

/* ============ B. 真实账套端到端 ============ */
console.log('\n=== B. 真实账套端到端 ===');
if (!BOOK) {
  console.log('  - 跳过（账套文件不存在：' + FILE + '）');
} else {
  console.log('  账套：' + path.basename(FILE));
  S.state = JSON.parse(JSON.stringify(BOOK));
  S.state.closedPeriods = [];           // 仅内存中解除结账闸门，便于测试删除
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  const base = cardSum();
  console.log('  基线卡片累计合计 ' + base.toFixed(2) + '，卡片 ' + (S.state.fixedAssets || []).length + ' 张');

  const rB = S.depreciateMonth('2026-09');
  ck(rB.ok === true, 'B1 计提 2026-09 成功' + (rB.ok ? '' : '（' + (rB.msg || '') + '）'));
  if (rB.ok) {
    const after = cardSum();
    const total = r2(rB.total);
    ck(Math.abs(after - base - total) < 0.02, 'B2 卡片合计 ' + after.toFixed(2) + ' = 基线 + 本期折旧 ' + total.toFixed(2));
    const vnoB = (rB.voucher.word || '记') + '-' + rB.voucher.no;
    ck(S.state.fixedAssets.filter((f) => f.deprVoucher === vnoB).length === rB.count,
      'B3 ' + rB.count + ' 张卡片引用新凭证 ' + vnoB);

    const rBDel = S.removeVoucher(rB.voucher.id);
    ck(rBDel.ok === true, 'B4 删除新凭证成功' + (rBDel.ok ? '' : '（' + rBDel.msg + '）'));
    ck(Math.abs(cardSum() - base) < 0.02, 'B5 删除后卡片合计回到基线 ' + cardSum().toFixed(2));
    ck(S.state.fixedAssets.filter((f) => f.deprVoucher === vnoB).length === 0, 'B6 deprVoucher 已全部清空');

    const rBRes = S.restoreVoucher(rB.voucher.id);
    ck(rBRes.ok === true, 'B7 还原成功');
    ck(Math.abs(cardSum() - after) < 0.02, 'B8 还原后卡片合计回到 ' + cardSum().toFixed(2));
    ck(S.state.fixedAssets.filter((f) => f.deprVoucher === vnoB).length === rB.count, 'B9 deprVoucher 全部恢复');
  }
}

/* ============ C. 回归：仍应拦截的引用类型 + 提示准确性 ============ */
console.log('\n=== C. 回归：工资引用仍拦截；原始凭证引用不再拦截（功能已移除）===');
S.state = {};
S.normalizeState();
S.state.subjects = [
  { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
  { code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true }
];
S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
S.state.closedPeriods = [];
S.state.fixedAssets = [];
S.state.originals = [{ id: 'o1', name: '增值税发票', voucherNo: '测-901' }];
S.state.vouchers = [
  { id: 'vc1', word: '测', no: 901, date: '2026-02-28', entries: [], summary: '' },
  { id: 'vc2', word: '测', no: 902, date: '2026-02-28', entries: [], summary: '', payroll: true }
];
S._glCache = {};
// 原始凭证功能已于 2026-09-21 整体移除（state.originals 字段随之删除）。
// 此处仍【故意残留】originals 数据，用以确认：即便旧账套里还有这个字段，也不再拦截删除
// —— 否则会出现「页面已删、无处解除关联、凭证永远删不掉」的死锁。
const rC1 = S.removeVoucher('vc1');
ck(rC1.ok === true, 'C1 残留 originals 数据时仍可删除（原始凭证拦截已随功能移除）：' + (rC1.msg || ''));
const rC2 = S.removeVoucher('vc2');
ck(rC2.ok === false && /工资/.test(rC2.msg || '') && /工资模块/.test(rC2.msg || ''),
  'C2 工资凭证仍拦截，并给出具体指引：' + (rC2.msg || ''));

/* ============ D. 清理凭证链路：删除 → 卡片回退 → 还原（死锁解除） ============ */
console.log('\n=== D. 清理凭证链路：删除 → 卡片回退 → 还原 ===');
S.state = {};
S.normalizeState();
S.state.subjects = [
  { code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
  { code: '1606', name: '固定资产清理', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '540102', name: '折旧', cls: 'expense', normal: 'dr', level: 0, enabled: true }
];
S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
S.state.closedPeriods = [];
S.state.vouchers = [];
S.state.fixedAssets = [{
  id: 'fa7', code: '007', name: '待处置设备', acqDate: '2026-01-01', status: '正常',
  original: 12000, salvage: 0, life: 10, periodUsed: 1,
  accumDepr: 100, accumDeprBegin: 100, deprMonth: '',
  depFeeAcct: '540102', accDeprAcct: '1602'
}];
S._glCache = {};
const fa7 = S.state.fixedAssets[0];
S.cleanFixedAsset('fa7', '2026-03');
ck(fa7.status === '清理' && fa7.cleanPeriod === '2026-03', 'D1 卡片置为「清理」，清理期间 2026-03');

const rGen = S.genCleanVoucher(['fa7'], '2026-03');
ck(rGen.ok === true, 'D2 生成清理凭证成功' + (rGen.ok ? '' : '（' + (rGen.msg || '') + '）'));
if (rGen.ok) {
  const cvno = (rGen.voucher.word || '记') + '-' + rGen.voucher.no;
  ck(fa7.cleanVoucher === cvno, 'D3 卡片记录清理凭证 ' + cvno);
  const puBefore = num(fa7.periodUsed);
  const rDelC = S.removeVoucher(rGen.voucher.id);
  ck(rDelC.ok === true, 'D4 删除清理凭证成功（死锁解除，无需先「取消清理」）' + (rDelC.ok ? '' : '（' + rDelC.msg + '）'));
  ck(fa7.status === '正常', 'D5 卡片状态回退为「正常」');
  ck(!fa7.cleanVoucher, 'D6 cleanVoucher 已清空');
  ck(fa7.cleanPeriod === '', 'D7 cleanPeriod 已清空');
  ck(num(fa7.periodUsed) === puBefore, 'D8 已折旧期间数不变（' + puBefore + '，漏提期间不自动补提）');
  const recC = vById(rGen.voucher.id);
  ck(!!(recC && recC.cleanReverted && recC.cleanReverted.length === 1), 'D9 凭证上留存清理回退快照');
  const rResC = S.restoreVoucher(rGen.voucher.id);
  ck(rResC.ok === true, 'D10 还原清理凭证成功');
  ck(fa7.status === '清理', 'D11 卡片状态恢复为「清理」');
  ck(fa7.cleanPeriod === '2026-03', 'D12 清理期间恢复 2026-03');
  ck(fa7.cleanVoucher === cvno, 'D13 清理凭证引用恢复 ' + cvno);
  ck(!(recC && recC.cleanReverted), 'D14 快照已消费（不会重复回退）');
  // D15~D18 代码层：清理已改成一步式（标记＋生成凭证），并保持失败回滚；防日后被改回两步
  const assetSrc = fs.readFileSync(path.resolve(__dirname, '../js/pages/asset/Asset.js'), 'utf8');
  const inlineClean = assetSrc.slice(assetSrc.indexOf("contains('link-clean')"));
  ck(/genCleanVoucher/.test(inlineClean.slice(0, 1400)), 'D15 行内清理一步式：标记后紧接调用 genCleanVoucher');
  ck(/cancelCleanFixedAsset/.test(inlineClean.slice(0, 1800)), 'D16 行内清理生成失败时回滚标记（不留悬空状态）');
  const batchClean = assetSrc.slice(assetSrc.indexOf("act === 'clean'"));
  ck(/genCleanVoucher/.test(batchClean.slice(0, 1400)), 'D17 批量清理同样是一步式');
  const idxSrc = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const menu = idxSrc.slice(idxSrc.indexOf('id="assetBatchMenu"'));
  ck(menu.indexOf('data-batch="clean"') < menu.indexOf('data-batch="cleanvch"'),
    'D18 批量菜单按「日常操作在上、维护工具在下」排列');
  const genBtn = assetSrc.slice(assetSrc.indexOf('btnAssetGenVoucher'));
  ck(/aChk:checked/.test(genBtn.slice(0, 800)) && /与勾选无关/.test(genBtn.slice(0, 1800)),
    'D19 计提折旧在「有勾选」时会告知范围与勾选无关（防误以为只提勾选的资产）');
}

/* ============ E. 删除守卫：按账面事实拦截（2026-09-18 事故防退化） ============
 * 事故：守卫原用 deprMonth 判断，而锚点修复会清空该字段 → 守卫整体失效，
 * 有累计折旧的卡片被静默放行删除（002 电视 13,749.19 因此丢失，卡片与总账差一期多的金额）。 */
console.log('\n=== E. 删除守卫：有折旧记录的卡片不可直接删除 ===');
S.state = {};
S.normalizeState();
S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
S.state.subjects = [{ code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true }];
S.state.closedPeriods = [];
S.state.vouchers = [];
S.state.fixedAssets = [
  { id: 'faA', code: '001', name: '有累计折旧的卡', original: 1000, accumDepr: 100, accumDeprBegin: 100, periodUsed: 1 },
  { id: 'faB', code: '002', name: '全新未折旧卡', original: 1000, accumDepr: 0, accumDeprBegin: 0, periodUsed: 0 }
];
S._glCache = {};
const rDelA = S.removeFixedAsset('faA');
ck(rDelA.ok === false && /清理/.test(rDelA.msg || ''),
  'E1 有累计折旧（accumDepr>0）的卡片不可直接删除：' + (rDelA.msg || ''));
ck(S.state.fixedAssets.filter(x => x.id === 'faA').length === 1, 'E2 该卡片未被移除');
const rDelB = S.removeFixedAsset('faB');
ck(rDelB.ok === true, 'E3 无折旧记录的全新卡片仍可删除（保留误导入卡片的清理能力）');
ck(S.state.fixedAssets.filter(x => x.id === 'faB').length === 0, 'E4 全新卡片已移除');

/* ============ F. 取消清理：一步撤销（连同清理凭证） ============
 * 背景：清理改为一步式后，卡片走在正常路径上必然带凭证，而原实现「有凭证就不许取消」，
 * 使「取消清理」成为死功能（永远被挡回）。现改为撤销整个处置动作：删凭证 + 恢复卡片。 */
console.log('\n=== F. 取消清理：一步撤销（连同清理凭证） ===');
S.state = {};
S.normalizeState();
S.state.subjects = [
  { code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
  { code: '1606', name: '固定资产清理', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true },
  { code: '540102', name: '折旧', cls: 'expense', normal: 'dr', level: 0, enabled: true }
];
S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
S.state.closedPeriods = [];
S.state.vouchers = [];
S.state.fixedAssets = [{
  id: 'faF', code: '008', name: '待撤销设备', acqDate: '2026-01-01', status: '正常',
  original: 12000, salvage: 0, life: 10, periodUsed: 1,
  accumDepr: 100, accumDeprBegin: 100, deprMonth: '',
  depFeeAcct: '540102', accDeprAcct: '1602'
}];
S._glCache = {};
S.cleanFixedAsset('faF', '2026-03');
const rF = S.genCleanVoucher(['faF'], '2026-03');
ck(rF.ok === true, 'F1 清理并生成凭证成功');
const fvno = (rF.voucher.word || '记') + '-' + rF.voucher.no;
ck(S.state.fixedAssets[0].cleanVoucher === fvno, 'F2 卡片带清理凭证 ' + fvno);

const rCancel = S.cancelCleanFixedAsset('faF');
ck(rCancel.ok === true, 'F3 有清理凭证时「取消清理」成功（不再被挡回）' + (rCancel.ok ? '' : '（' + rCancel.msg + '）'));
ck(rCancel.removedVoucher === fvno, 'F4 连同清理凭证一并撤销：' + rCancel.removedVoucher);
const faF = S.state.fixedAssets[0];
ck(faF.status === '正常', 'F5 卡片状态恢复「正常」');
ck(!faF.cleanVoucher && !faF.cleanPeriod, 'F6 清理凭证引用与清理期间已清空');
const vF = vById(rF.voucher.id);
ck(!!(vF && vF.deleted === 'y'), 'F7 清理凭证为软删（可在回收站还原，非物理抹除）');

// 无凭证的历史遗留清理态 → 直接恢复状态，不涉及凭证
faF.status = '清理';
faF.cleanPeriod = '2026-03';
delete faF.cleanVoucher;
const rCancel2 = S.cancelCleanFixedAsset('faF');
ck(rCancel2.ok === true && !rCancel2.removedVoucher, 'F8 无凭证的历史遗留清理态：直接恢复，不动凭证');
ck(faF.status === '正常' && !faF.cleanPeriod, 'F9 状态与清理期间已恢复');

// F11~F12 失败分支：清理月份已结账 → 取消清理被拦，且卡片不被改成一半（原子性）
S.cleanFixedAsset('faF', '2026-04');
const rF3 = S.genCleanVoucher(['faF'], '2026-04');
ck(rF3.ok === true, 'F11 重新生成清理凭证（2026-04）成功');
S.state.closedPeriods = ['2026-04'];
const rCancel3 = S.cancelCleanFixedAsset('faF');
ck(rCancel3.ok === false && /^无法取消清理：/.test(rCancel3.msg || ''),
  'F12 已结账时取消清理被拦，提示带场景前缀：' + (rCancel3.msg || ''));
ck(faF.status === '清理' && !!faF.cleanVoucher, 'F13 失败后卡片保持「已清理」（不做一半，账实不脱节）');
S.state.closedPeriods = [];

// 代码层：批量清理失败回滚必须只针对本次新标记的卡片（否则会误删勾选里既有凭证卡片的凭证）
const assetSrc2 = fs.readFileSync(path.resolve(__dirname, '../js/pages/asset/Asset.js'), 'utf8');
const batchCleanSrc = assetSrc2.slice(assetSrc2.indexOf("act === 'clean'"));
ck(/newlyMarked/.test(batchCleanSrc.slice(0, 1600)), 'F10 批量清理回滚范围已收窄为「本次新标记的卡片」');

console.log('\n' + (bad ? '\u2717 \u6709 ' + bad + ' \u9879\u672a\u901a\u8fc7' : '\u2713 \u5168\u90e8\u901a\u8fc7'));
process.exit(bad ? 1 : 0);
