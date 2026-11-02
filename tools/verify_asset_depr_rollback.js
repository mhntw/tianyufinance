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
console.log('\n=== C. 回归：工资引用按条件拦截（该期有工资记录）；原始凭证引用不再拦截（功能已移除）===');
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
/* 工资拦截已于 2026-10-27 随模块下线整体取消：工资凭证不再有「业务单据」可回滚，
   继续拦会出现「页面已删、无处解除关联、凭证永远删不掉」的死锁（与上面 originals 同一个病）。
   这里保留断言（反向锁住），防止以后有人把这条拦截加回来。 */
S.state.payrolls = [{ id: 'pw1', month: '2026-02', name: '张三', category: '', should: 1, real: 1 }];
const rC2 = S.removeVoucher('vc2');
ck(rC2.ok === true,
  'C2 v.payroll 凭证不再被拦（工资模块已下线，即便账上还留着遗留 payrolls 数据）：' + (rC2.msg || ''));

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
  // D15~D16 代码层：行内清理一步式（标记＋生成凭证）并保持失败回滚；防日后被改回两步
  const assetSrc = fs.readFileSync(path.resolve(__dirname, '../js/pages/asset/Asset.js'), 'utf8');
  const inlineClean = assetSrc.slice(assetSrc.indexOf("contains('link-clean')"));
  ck(/genCleanVoucher/.test(inlineClean.slice(0, 1400)), 'D15 行内清理一步式：标记后紧接调用 genCleanVoucher');
  ck(/cancelCleanFixedAsset/.test(inlineClean.slice(0, 1800)), 'D16 行内清理生成失败时回滚标记（不留悬空状态）');
  // 注：批量清理 / 关联购入凭证 / 解除关联 / 补生成清理凭证 已于 2026-10-28 从「更多」菜单移除（低频维护工具，意义不大）；
  // 删除守卫仍保留行内清理一步式（D5~D14 的取消清理路径），故此处仅校验行内逻辑，不再校验已删除的批量清理分支及菜单排序。
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

// 注：批量清理功能已于 2026-10-28 从「更多」菜单移除，原 F10「批量清理回滚范围收窄」回归点随之撤销。

/* ============ G. 折旧快照回滚（2026-11-02）：末月 / 删中间期 / 跨月同号 ============
 * 旧实现按「记-N 字号」匹配卡片 + 用 assetMonthlyDepr 现场重算，三个实测缺陷：
 *   ① 末月提满后 assetMonthlyDepr 返回 0（remainingMonths=0）→ 该卡整期漏回滚，
 *      差额又被「并入最后一张卡」扣到别的卡上（真实账套实测把 4,251.11 从电视机挪到客房餐厅用品）；
 *   ② 卡片只存最后一张凭证号，删中间某一期匹配不上 → 不回滚（卡片比总账多一期）；
 *   ③ 凭证号按月重编（每月从 记-1 起），跨月同号无法区分 → 回滚错期、误清别的期的引用。
 * 现改为：计提时把各卡实提额挂到凭证（v.deprLines），删除时按「卡片 id + 实提额」精确回滚；
 * 卡片另存含月份的凭证 id（deprVoucherId），引用清理与守卫都不再依赖会重号的 记-N。 */
console.log('\n=== G. 折旧快照回滚：末月 / 删中间期 / 跨月同号 ===');
S.state = {};
S.normalizeState();
S.state.subjects = [
  { code: '1122', name: '应收账款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
];
S.state.company = Object.assign({}, S.state.company, { startMonth: '2025-01', bookkeeper: '测试' });
S.state.closedPeriods = [];
S.state.vouchers = [];
S.state.fixedAssets = [{
  id: 'faG', code: 'G1', name: '末月设备', acqDate: '2025-01-01', status: '在用',
  original: 12000, salvage: 0, life: 1, periodUsed: 11, accumDepr: 11000, accumDeprBegin: 11000,
  deprMonth: '2025-11', depFeeAcct: '6602', accDeprAcct: '1602'
}];
S._glCache = {};
const rG = S.depreciateMonth('2025-12');
ck(rG.ok === true, 'G1 末月（第 12 期）计提成功' + (rG.ok ? '' : '（' + (rG.msg || '') + '）'));
const vG = rG.ok ? vById(rG.voucher.id) : null;
ck(!!(vG && vG.deprLines && vG.deprLines.length === 1 && num(vG.deprLines[0].amt) === 1000),
  'G2 凭证挂上实提额快照 deprLines（末月补足 1000）');
if (rG.ok) {
  const accBeforeG = num(S.state.fixedAssets[0].accumDepr);
  ck(accBeforeG === 12000, 'G3 计提后卡片已提满 12000（原值-残值）');
  S.removeVoucher(rG.voucher.id);
  ck(num(S.state.fixedAssets[0].accumDepr) === 11000,
    'G4 删除末月凭证精确回滚到 11000（旧实现停在 12000 —— 末月卡漏回滚）');
  ck(num(S.state.fixedAssets[0].periodUsed) === 11, 'G5 已折旧期间回退为 11');
  ck(!S.state.fixedAssets[0].deprVoucher && !S.state.fixedAssets[0].deprVoucherId, 'G6 凭证引用（字号与 id）已清空');
  S.restoreVoucher(rG.voucher.id);
  ck(num(S.state.fixedAssets[0].accumDepr) === accBeforeG, 'G7 还原后精确回到 ' + accBeforeG);
}

// 跨月同号场景：1 月先插一张普通凭证占号，使三个月的折旧凭证号为 记-2 / 记-1 / 记-1
S.state = {};
S.normalizeState();
S.state.subjects = [
  { code: '1122', name: '应收账款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
  { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
];
S.state.company = Object.assign({}, S.state.company, { startMonth: '2025-01', bookkeeper: '测试' });
S.state.closedPeriods = [];
S.state.vouchers = [];
S.state.fixedAssets = [{
  id: 'faG2', code: 'G2', name: '跨月设备', acqDate: '2024-12-01', status: '在用',
  original: 24000, salvage: 0, life: 2, periodUsed: 0, accumDepr: 0, accumDeprBegin: 0,
  depFeeAcct: '6602', accDeprAcct: '1602'
}];
S._glCache = {};
S.addVoucher({ date: '2025-01-05', word: '记', summary: '占号', entries: [
  { code: '1122', name: '应收账款', summary: '占号', dr: 100, cr: 0 },
  { code: '6602', name: '管理费用', summary: '占号', dr: 0, cr: 100 }
] });
const g1 = S.depreciateMonth('2025-01');   // 记-2
const g2 = S.depreciateMonth('2025-02');   // 记-1
const g3 = S.depreciateMonth('2025-03');   // 记-1（与 2 月同号）
ck(g1.ok && g2.ok && g3.ok, 'G8 连续三期计提成功（记-2 / 记-1 / 记-1）');
const faG2 = S.state.fixedAssets[0];
ck(num(faG2.accumDepr) === 3000 && num(faG2.periodUsed) === 3, 'G9 三期累计 3000、已折旧期间 3');
ck(faG2.deprVoucher === '记-1' && faG2.deprVoucherId === g3.voucher.id,
  'G10 卡片引用指向最新一期（记-1 @2025-03，含月份 id）');
S.removeVoucher(g1.voucher.id);
ck(num(S.state.fixedAssets[0].accumDepr) === 2000,
  'G11 删除 1 月（记-2，非最新期）精确回滚到 2000（旧实现匹配不上 → 停在 3000）');
ck(num(S.state.fixedAssets[0].periodUsed) === 2, 'G12 已折旧期间 3 → 2');
ck(S.state.fixedAssets[0].deprVoucher === '记-1' && S.state.fixedAssets[0].deprVoucherId === g3.voucher.id,
  'G13 最新一期引用未被误清（旧实现按字号会误判）');
S.removeVoucher(g2.voucher.id);
ck(num(S.state.fixedAssets[0].accumDepr) === 1000,
  'G14 删除 2 月（与 3 月同为 记-1，跨月同号）精确回滚到 1000');
ck(S.state.fixedAssets[0].deprVoucherId === g3.voucher.id, 'G15 仍指向 3 月凭证（同号未误清）');
S.restoreVoucher(g2.voucher.id);
ck(num(S.state.fixedAssets[0].accumDepr) === 2000, 'G16 还原 2 月凭证后回到 2000（快照对称）');

/* ============ H. 清理凭证回滚（2026-11-02）：跨月同号 ============
 * 与 G 组同源缺陷：卡片只存「记-N」字号，而凭证号按月从 记-1 重编。原实现两处：
 *   ① _revertAssetClean 按字号匹配 → 删乙的清理凭证会把同号月份的甲一起改回「正常」
 *      （甲账上还挂着清理凭证 → 账实不符）；
 *   ② cancelCleanFixedAsset 按字号找凭证且不过滤月份 → 取消甲的清理可能删掉乙那一期的凭证。
 * 现改为「清理凭证 id 优先，老数据按 字号 + 清理期间月份 兜底」。 */
console.log('\n=== H. 清理凭证回滚：跨月同号 ===');
function cleanSetup() {
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '1606', name: '固定资产清理', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
  S.state.closedPeriods = [];
  S.state.vouchers = [];
  S.state.fixedAssets = [
    { id: 'faA', code: 'A', name: '甲资产', acqDate: '2025-01-01', status: '正常', original: 12000, salvage: 0,
      life: 10, periodUsed: 1, accumDepr: 100, accumDeprBegin: 100, depFeeAcct: '6602', accDeprAcct: '1602', assetAcct: '1601' },
    { id: 'faB', code: 'B', name: '乙资产', acqDate: '2025-01-01', status: '正常', original: 24000, salvage: 0,
      life: 10, periodUsed: 1, accumDepr: 200, accumDeprBegin: 200, depFeeAcct: '6602', accDeprAcct: '1602', assetAcct: '1601' }
  ];
  S._glCache = {};
}
function cleanOne(id, month) {
  S.cleanFixedAsset(id, month);
  return S.genCleanVoucher([id], month);
}
function faById(id) { return S.state.fixedAssets.filter(function (f) { return f.id === id; })[0]; }
function vAlive(id) { return S.state.vouchers.some(function (v) { return v.id === id && v.deleted !== 'y'; }); }

cleanSetup();
const cA = cleanOne('faA', '2026-01');   // 记-1
const cB = cleanOne('faB', '2026-03');   // 记-1（同号）
ck(cA.ok && cB.ok, 'H1 两卡分别在 1 月 / 3 月清理并生成凭证（都为 记-1）');
ck(faById('faA').cleanVoucherId === cA.voucher.id && faById('faB').cleanVoucherId === cB.voucher.id,
  'H2 卡片各存含月份的清理凭证 id');
S.removeVoucher(cB.voucher.id);
ck(faById('faB').status === '正常', 'H3 删乙的清理凭证 → 乙回到「正常」');
ck(faById('faA').status === '清理', 'H4 甲仍为「清理」，未被同号误伤（旧实现会把甲一起改成正常）');
ck(vAlive(cA.voucher.id), 'H5 甲的清理凭证仍在账上（账实相符）');
S.restoreVoucher(cB.voucher.id);
ck(faById('faB').status === '清理' && faById('faB').cleanVoucherId === cB.voucher.id,
  'H6 还原后乙回到「清理」并恢复凭证 id（快照对称）');

// 反向布置：乙 1 月清理、甲 3 月清理，取消甲的清理不应删到乙的凭证
cleanSetup();
const cB2 = cleanOne('faB', '2026-01');  // 记-1 @2026-01
const cA2 = cleanOne('faA', '2026-03');  // 记-1 @2026-03
ck(cB2.ok && cA2.ok, 'H7 反向布置：乙 1 月、甲 3 月（同为 记-1）');
const rcH = S.cancelCleanFixedAsset('faA');
ck(rcH && rcH.ok !== false, 'H8 取消甲的清理成功');
ck(vAlive(cB2.voucher.id), 'H9 乙的 1 月凭证仍在（旧实现会误删它）');
ck(!vAlive(cA2.voucher.id), 'H10 被删掉的是甲自己的 3 月凭证');
ck(faById('faA').status === '正常', 'H11 甲回到「正常」');
ck(faById('faB').status === '清理', 'H12 乙仍为「清理」（未被同号连带）');

// 老数据兼容：抹掉 id 模拟 2026-11-02 之前的账套，靠「字号 + 清理期间月份」兜底
cleanSetup();
const oA = cleanOne('faA', '2026-01');
const oB = cleanOne('faB', '2026-03');
S.state.fixedAssets.forEach(function (fa) { delete fa.cleanVoucherId; });
S.removeVoucher(oB.voucher.id);
ck(faById('faA').status === '清理' && faById('faB').status === '正常' && vAlive(oA.voucher.id),
  'H13 老数据（无 id）按「字号 + 清理期间」兜底，同样不误伤同号卡片');

/* ============ I. 红字冲销守卫（2026-11-02）：同号凭证不再被误拦 ============
 * reverseVoucher 原来只比「记-N」字号就断定"这张是折旧/清理凭证"，跨月同号时会把**普通凭证**也拦下，
 * 用户会遇到"一张普通凭证莫名不能红冲"。现按凭证 id 判，老数据按「字号 + 计提/清理月份」判。
 * 注意反向要求：真正的折旧/清理凭证仍必须被拦（红冲不会回退卡片，账实脱节）。 */
console.log('\n=== I. 红字冲销守卫：跨月同号 ===');
function guardSetup() {
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1122', name: '应收账款', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '1601', name: '固定资产', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '1606', name: '固定资产清理', cls: 'asset', normal: 'dr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2026-01', bookkeeper: '测试' });
  S.state.closedPeriods = [];
  S.state.vouchers = [];
  S.state.fixedAssets = [{
    id: 'faI', code: 'I1', name: '守卫设备', acqDate: '2025-01-01', status: '正常',
    original: 12000, salvage: 0, life: 1, periodUsed: 0, accumDepr: 0, accumDeprBegin: 0,
    depFeeAcct: '6602', accDeprAcct: '1602', assetAcct: '1601'
  }];
  S._glCache = {};
}
function ordinaryVoucher(date) {
  return S.addVoucher({ date: date, word: '记', summary: '普通业务', entries: [
    { code: '6602', name: '管理费用', summary: '普通业务', dr: 100, cr: 0 },
    { code: '1122', name: '应收账款', summary: '普通业务', dr: 0, cr: 100 }
  ] });
}

guardSetup();
const gd = S.depreciateMonth('2026-01');          // 记-1 @2026-01（折旧）
const gOrd = ordinaryVoucher('2026-03-05');       // 记-1 @2026-03（普通）
ck(gd.ok && gOrd && gOrd.no === gd.voucher.no, 'I1 折旧凭证与普通凭证同为 记-1（跨月同号）');
ck(S.reverseVoucher(gOrd.id, { month: '2026-03' }).ok === true,
  'I2 普通凭证可以红冲（旧实现被误判为折旧凭证而拦下）');
ck(S.reverseVoucher(gd.voucher.id, { month: '2026-03' }).ok === false,
  'I3 真正的折旧凭证仍被拦（红冲不回退卡片）');

// 清理凭证同理
guardSetup();
S.cleanFixedAsset('faI', '2026-04');
const gc = S.genCleanVoucher(['faI'], '2026-04');  // 记-1 @2026-04（清理）
const gOrd2 = ordinaryVoucher('2026-05-05');       // 记-1 @2026-05（普通）
ck(gc.ok && gOrd2 && gOrd2.no === gc.voucher.no, 'I4 清理凭证与普通凭证同为 记-1（跨月同号）');
ck(S.reverseVoucher(gOrd2.id, { month: '2026-05' }).ok === true, 'I5 普通凭证可以红冲（不被清理凭证误拦）');
ck(S.reverseVoucher(gc.voucher.id, { month: '2026-05' }).ok === false, 'I6 真正的清理凭证仍被拦');

// 老数据：抹掉 id 后退回「字号 + 月份」，月份不同即放行
guardSetup();
const gd3 = S.depreciateMonth('2026-01');
const gOrd3 = ordinaryVoucher('2026-03-05');
S.state.fixedAssets.forEach(function (fa) { delete fa.deprVoucherId; });
ck(S.reverseVoucher(gOrd3.id, { month: '2026-03' }).ok === true,
  'I7 老数据（无 id）按「字号 + 计提月份」判定，同号不同月不再误拦');
ck(S.reverseVoucher(gd3.voucher.id, { month: '2026-03' }).ok === false,
  'I8 老数据下真正的折旧凭证仍被拦（月份相同）');

console.log('\n' + (bad ? '\u2717 \u6709 ' + bad + ' \u9879\u672a\u901a\u8fc7' : '\u2713 \u5168\u90e8\u901a\u8fc7'));
process.exit(bad ? 1 : 0);
