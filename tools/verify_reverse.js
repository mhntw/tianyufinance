#!/usr/bin/env node
/**
 * verify_reverse.js — 红字冲销（store.reverseVoucher）回归
 *
 * 【为什么需要本脚本】红字冲销是本次新增的【写账套】核心方法（约 190 行）：
 *   它自己造凭证、维护双向关联、还要按来源逐类拦截。但这些规则此前【零覆盖】——
 *   本次开发期的验证用的是临时探针，用完即删（本项目一贯做法是「临时脚本用后即删」），
 *   于是 42 个回归脚本里没有一个碰过 reverseVoucher。
 *   后果很具体：CI 的回归是【硬门禁】（build-release.yml 的 build-windows 带 needs: selftest），
 *   而门禁对这块逻辑只会亮绿灯、什么都没检查 —— 这正是 CHANGELOG 里反复讲的
 *   「测试写了不跑，等于没写」的同构问题：跑了不等于覆盖了。
 *
 * 【覆盖范围】红字口径 / 双向关联 / 摘要口径 / 期间落点 / 防重复 / 四类来源拦截 /
 *   期间与入参校验 / 红冲凭证被删后可再冲 / 可对红字凭证再冲销（撤销冲销）/ 返工提示的开关。
 *
 * 【数据隔离】全程在【内存构造】的账套上跑，不读不写任何真实账套目录：
 *   persist / addLog / backupNow 均被 mock 成空函数，零 fs 写操作
 *   （tools/check_test_isolation.js 会扫描并拦下「指向真实数据目录且有写操作」的脚本）。
 *
 * 用法：node tools/verify_reverse.js
 * 退出码：0 = 全部通过；1 = 有失败
 */
'use strict';

const path = require('path');

/* ---------- mock 浏览器环境（与 verify_empty_audit.js 同法） ---------- */
const lsStore = {};
global.localStorage = {
  getItem: k => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: k => { delete lsStore[k]; }
};
global.window = global;
// ⚠ Node 21+ 的 globalThis.navigator 是【只读 getter】，在 'use strict' 下赋值会直接抛 TypeError。
// （verify_empty_audit.js 同样写了这行却不报错，只因它没有 'use strict'，赋值静默失败 —— 不是它更对。）
// store.js 只在浏览器分支用 navigator，设不上就跳过，不影响本脚本。
try { global.navigator = { sendBeacon: () => true }; } catch (e) { /* 只读 getter，跳过 */ }
global.document = { addEventListener() {} };
global.fetch = () => Promise.reject(new Error('off'));
global.XMLHttpRequest = function () { this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {}; this.status = 200; };
global.addEventListener = () => {};

const storeMod = require(path.join(__dirname, '..', 'js', 'store.js'));
const S = storeMod.store || global.S;

/* ---------- 绝不写盘：本脚本只在内存账套上跑 ---------- */
S.persist = function () { /* no-op：不碰真实账套 */ };
S.addLog = function () { /* no-op */ };
S.backupNow = function () { return Promise.resolve(true); };

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let nPass = 0, nFail = 0;

function ck(label, ok, detail) {
  if (ok) { nPass++; console.log('  [' + PASS + '] ' + label); }
  else { nFail++; console.log('  [' + FAIL + '] ' + label + (detail ? '  ' + detail : '')); }
}
function eq(label, actual, expected) {
  const ok = actual === expected;
  ck(label, ok, ok ? '' : '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
}

/* ---------- 造一个最小可用账套（每次重建，用例之间互不影响） ---------- */
// 期间基准：原凭证记在 2026-07，红字冲销一律记入 2026-08。
// 选【过去的月份】是有意的：addVoucher 有「凭证日期不得晚于当前自然月」的闸门，
// 用将来月份会让本脚本随系统日期变化而失效。
const TARGET = '2026-08';
const ORIG_DATE = '2026-07-15';

function mkBook() {
  const st = {
    subjects: [
      { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr' },
      { code: '1002', name: '银行存款', cls: 'asset', normal: 'dr' },
      { code: '3103', name: '本年利润', cls: 'equity', normal: 'cr' },
      { code: '5602', name: '管理费用', cls: 'expense', normal: 'dr' },
      { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr' }
    ],
    openingBalances: {},
    vouchers: [],
    closedPeriods: [],
    company: { name: '测试账套（内存）', startMonth: '2026-01', bookkeeper: '测试' },
    param: {},
    fixedAssets: [],
    salary: []
  };
  S.state = st;
  S._glCache = {};
  S.normalizeState();
  return st;
}

// 直接放进 state（绕过 addVoucher 的编号与闸门），以便精确控制 kind / payroll / 卡片引用
function putVoucher(st, v) {
  v.word = v.word || '记';
  if (v.no == null) v.no = String(st.vouchers.length + 1);
  v.date = v.date || ORIG_DATE;
  v.id = v.id || (v.word + '-' + v.no + '@' + String(v.date).slice(0, 7));
  v.entries = (v.entries || []).map(function (e) {
    const s = S.subject(e.code) || {};
    return {
      code: e.code, name: e.name || s.name || '', summary: e.summary || '',
      dr: Number(e.dr) || 0, cr: Number(e.cr) || 0,
      cashActivity: e.cashActivity || ''
    };
  });
  st.vouchers.push(v);
  return v;
}

// 一笔最简单的平衡分录：借 1001 / 贷 6001，各 500
function saleEntries(summary, amt, cashActivity) {
  return [
    { code: '1001', summary: summary, dr: amt, cr: 0, cashActivity: cashActivity || '' },
    { code: '6001', summary: summary, dr: 0, cr: amt, cashActivity: cashActivity || '' }
  ];
}

console.log('════ 红字冲销回归（verify_reverse.js）════');
console.log('');

/* ══════════ 1. 主路径：生成红字凭证 ══════════ */
console.log('【1】正常红冲');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  const r = S.reverseVoucher(orig.id, { month: TARGET, reason: '科目选错' });

  ck('1.1 返回 ok 且带新凭证', !!(r && r.ok === true && r.voucher), JSON.stringify(r && r.msg));
  const red = r.voucher;
  if (!red) { ck('1.2 起（无红字凭证，跳过）', false, '未生成红字凭证'); }
  else {
    ck('1.2 红字口径＝方向【不变】、金额【取负】（借 -500 / 贷 -500）',
      red.entries[0].dr === -500 && red.entries[0].cr === 0
      && red.entries[1].dr === 0 && red.entries[1].cr === -500,
      JSON.stringify(red.entries.map(function (e) { return [e.code, e.dr, e.cr]; })));
    const drSum = red.entries.reduce(function (s, e) { return s + e.dr; }, 0);
    const crSum = red.entries.reduce(function (s, e) { return s + e.cr; }, 0);
    ck('1.3 红字凭证自身借贷仍平衡', Math.abs(drSum - crSum) < 0.005, drSum + ' vs ' + crSum);
    ck('1.4 双向关联（新凭证 reverses / 原凭证 reversedBy）',
      red.reverses === orig.id && orig.reversedBy === red.id, red.reverses + ' / ' + orig.reversedBy);
    eq('1.5 摘要口径＝「冲销 + YYYYMM + 原凭证字号 + 本行原摘要」',
      red.entries[0].summary, '冲销202608记-1销售收入');
    eq('1.6 日期落在目标期间内（否则会被 voucherMonth 归到别的月份）',
      String(red.date).slice(0, 7), TARGET);
    ck('1.7 原凭证未被改动、未被删除（红冲不动历史账）',
      orig.deleted !== 'y' && orig.entries[0].dr === 500 && orig.entries[1].cr === 500);
    ck('1.8 红字凭证 id 与原凭证不同', red.id !== orig.id);
    eq('1.9 红字凭证已入账套（state.vouchers 可见）',
      st.vouchers.filter(function (v) { return v.id === red.id; }).length, 1);
  }
}

/* ══════════ 2. 防重复红冲 ══════════ */
console.log('');
console.log('【2】防重复红冲');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  const r1 = S.reverseVoucher(orig.id, { month: TARGET, reason: '第一次' });
  const r2 = S.reverseVoucher(orig.id, { month: TARGET, reason: '第二次' });
  ck('2.1 重复红冲被拒', !!(r2 && r2.ok === false), JSON.stringify(r2));
  ck('2.2 拒绝理由点名「已被哪张冲销」', /已被/.test((r2 && r2.msg) || ''), r2 && r2.msg);
  ck('2.3 第二次没有真的生成凭证', st.vouchers.length === 2, '账套凭证数 ' + st.vouchers.length);
  ck('2.4 第一次的关联未被第二次覆盖', orig.reversedBy === r1.voucher.id);
}

/* ══════════ 3. 防重复的判据：以「账上实际存在的凭证」为准 ══════════ */
console.log('');
console.log('【3】红字凭证被删后可再次红冲（不读 reversedBy 字段）');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  const r1 = S.reverseVoucher(orig.id, { month: TARGET, reason: '第一次' });
  S.removeVoucher(r1.voucher.id);          // 红字凭证被删（软删进回收站）
  const r3 = S.reverseVoucher(orig.id, { month: TARGET, reason: '重开一张' });
  ck('3.1 红字凭证被删后，原凭证可再次红冲', !!(r3 && r3.ok === true), JSON.stringify(r3 && r3.msg));
  ck('3.2 新红字凭证换了个号，未与已删凭证撞号',
    !!(r3 && r3.voucher && r3.voucher.id !== r1.voucher.id),
    r3 && r3.voucher && r3.voucher.id);
  ck('3.3 反向关联已指向新的红字凭证', orig.reversedBy === (r3.voucher && r3.voucher.id));
}

/* ══════════ 4. 来源拦截：期末类（kind） ══════════ */
console.log('');
console.log('【4】来源拦截 —— 期末类凭证（v.kind）');
{
  const st = mkBook();
  const carry = putVoucher(st, {
    no: '1', date: '2026-07-31', kind: S.VOUCHER_KINDS.CARRY_PL, summary: '结转损益',
    entries: [
      { code: '6001', summary: '结转损益', dr: 500, cr: 0 },
      { code: '3103', summary: '结转损益', dr: 0, cr: 500 }
    ]
  });
  const r = S.reverseVoucher(carry.id, { month: TARGET, reason: 'x' });
  ck('4.1 结转损益凭证被拒', !!(r && r.ok === false), JSON.stringify(r));
  ck('4.2 理由点出业务名并引导「重新生成」',
    /结转损益/.test((r && r.msg) || '') && /重新生成/.test((r && r.msg) || ''), r && r.msg);
  ck('4.3 被拒时未产生任何凭证', st.vouchers.length === 1, '账套凭证数 ' + st.vouchers.length);
}

/* ══════════ 5. 来源拦截：固定资产折旧（卡片 deprVoucher，与 kind 无关） ══════════ */
console.log('');
console.log('【5】来源拦截 —— 固定资产折旧凭证（卡片 deprVoucher，外部导入的没有 kind）');
{
  const st = mkBook();
  const depr = putVoucher(st, { no: '1', date: '2026-07-31', summary: '计提折旧', entries: [
    { code: '5602', summary: '计提折旧', dr: 300, cr: 0 },
    { code: '1002', summary: '计提折旧', dr: 0, cr: 300 }
  ] });
  st.fixedAssets = [{ code: 'FA001', name: '空调', deprVoucher: '记-1' }];   // 卡片存的【凭证号】，不带 kind
  const r = S.reverseVoucher(depr.id, { month: TARGET, reason: 'x' });
  ck('5.1 折旧凭证被拒（即便它没有 kind）', !!(r && r.ok === false), JSON.stringify(r));
  ck('5.2 理由说明「红冲不会回退卡片累计折旧」',
    /不会回退卡片/.test((r && r.msg) || '') && /FA001/.test((r && r.msg) || ''), r && r.msg);
}

/* ══════════ 6. 来源拦截：固定资产清理（卡片 cleanVoucher） ══════════ */
console.log('');
console.log('【6】来源拦截 —— 固定资产清理凭证（卡片 cleanVoucher）');
{
  const st = mkBook();
  const clean = putVoucher(st, { no: '2', date: '2026-07-31', summary: '固定资产清理', entries: [
    { code: '1002', summary: '清理', dr: 800, cr: 0 },
    { code: '1001', summary: '清理', dr: 0, cr: 800 }
  ] });
  st.fixedAssets = [{ code: 'FA002', name: '面包窑', cleanVoucher: '记-2' }];
  const r = S.reverseVoucher(clean.id, { month: TARGET, reason: 'x' });
  ck('6.1 清理凭证被拒', !!(r && r.ok === false), JSON.stringify(r));
  ck('6.2 理由引导走「取消清理」（红冲撤销不了处置业务）',
    /取消清理/.test((r && r.msg) || ''), r && r.msg);
}

/* ══════════ 7. 来源拦截：工资（v.payroll） ══════════ */
console.log('');
console.log('【7】来源拦截 —— 工资模块生成的凭证（v.payroll）');
{
  const st = mkBook();
  const pay = putVoucher(st, { no: '1', date: '2026-07-31', payroll: true, summary: '计提工资', entries: [
    { code: '5602', summary: '计提工资', dr: 600, cr: 0 },
    { code: '1002', summary: '计提工资', dr: 0, cr: 600 }
  ] });
  const r = S.reverseVoucher(pay.id, { month: TARGET, reason: 'x' });
  ck('7.1 工资凭证被拒', !!(r && r.ok === false), JSON.stringify(r));
  ck('7.2 理由点明「红冲不改工资记录」',
    /工资/.test((r && r.msg) || '') && /工资记录/.test((r && r.msg) || ''), r && r.msg);
}

/* ══════════ 8. 期间校验：目标期间已结账 ══════════ */
console.log('');
console.log('【8】目标期间已结账');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  st.closedPeriods = [TARGET];
  const r = S.reverseVoucher(orig.id, { month: TARGET, reason: 'x' });
  ck('8.1 目标期间已结账时被拒', !!(r && r.ok === false), JSON.stringify(r));
  ck('8.2 理由给出可照做的两条路（反结账 / 等下一期间）',
    /反结账/.test((r && r.msg) || '') && /下一期间/.test((r && r.msg) || ''), r && r.msg);
}

/* ══════════ 9. 入参校验：目标期间必填且格式合法 ══════════ */
console.log('');
console.log('【9】目标期间入参校验');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  ck('9.1 未传目标期间被拒（期间口径不许 store 自己猜）',
    S.reverseVoucher(orig.id, { reason: 'x' }).ok === false);
  ck('9.2 退化为空对象也不崩', S.reverseVoucher(orig.id).ok === false);
  ck('9.3 目标期间格式非法被拒',
    S.reverseVoucher(orig.id, { month: '2026/08' }).ok === false);
  ck('9.4 目标期间为「8 月」这种非定长写法也被拒',
    S.reverseVoucher(orig.id, { month: '2026-8' }).ok === false);
}

/* ══════════ 10. 被冲销凭证自身的资格校验 ══════════ */
console.log('');
console.log('【10】被冲销凭证的资格');
{
  const st = mkBook();
  const live = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  const empty = putVoucher(st, { no: '2', summary: '空凭证', entries: [] });
  S.removeVoucher(live.id);
  ck('10.1 不存在的 id 被拒',
    S.reverseVoucher('记-99@2026-07', { month: TARGET, reason: 'x' }).ok === false);
  ck('10.2 已删除（软删）的凭证被拒，且引导去回收站还原',
    /回收站/.test(S.reverseVoucher(live.id, { month: TARGET, reason: 'x' }).msg || ''));
  ck('10.3 无分录的凭证被拒',
    /没有分录/.test(S.reverseVoucher(empty.id, { month: TARGET, reason: 'x' }).msg || ''));
}

/* ══════════ 11. 对红字凭证再冲销（＝撤销这次冲销） ══════════ */
console.log('');
console.log('【11】可对红字凭证再冲销');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '销售收入', entries: saleEntries('销售收入', 500) });
  const r1 = S.reverseVoucher(orig.id, { month: TARGET, reason: '原凭证错了' });
  const r2 = S.reverseVoucher(r1.voucher.id, { month: TARGET, reason: '冲销本身撤销' });
  ck('11.1 红字凭证可以再被冲销', !!(r2 && r2.ok === true), JSON.stringify(r2 && r2.msg));
  const back = r2.voucher;
  ck('11.2 冲销红字＝负负得正，金额回到原方向（借 +500 / 贷 +500）',
    !!back && back.entries[0].dr === 500 && back.entries[1].cr === 500,
    back && JSON.stringify(back.entries.map(function (e) { return [e.code, e.dr, e.cr]; })));
}

/* ══════════ 12. 摘要逐行沿用「本行自己的」原摘要 ══════════ */
console.log('');
console.log('【12】多行不同摘要的凭证，逐行各用本行摘要');
{
  const st = mkBook();
  const orig = putVoucher(st, { no: '1', summary: '混合业务', entries: [
    { code: '1001', summary: '收房租', dr: 300, cr: 0 },
    { code: '6001', summary: '收房租', dr: 0, cr: 300 },
    { code: '1001', summary: '收水电', dr: 200, cr: 0 },
    { code: '6001', summary: '收水电', dr: 0, cr: 200 }
  ] });
  const r = S.reverseVoucher(orig.id, { month: TARGET, reason: 'x' });
  ck('12.1 第一行摘要带本行原文（收房租）',
    !!r.voucher && r.voucher.entries[0].summary === '冲销202608记-1收房租',
    r.voucher && r.voucher.entries[0].summary);
  ck('12.2 第二组摘要带本行的另一段原文（收水电），未串味',
    !!r.voucher && r.voucher.entries[2].summary === '冲销202608记-1收水电',
    r.voucher && r.voucher.entries[2].summary);
}

/* ══════════ 13. 现金流量映射随分录继承 ══════════ */
console.log('');
console.log('【13】现金流量项目映射随分录继承');
{
  const st = mkBook();
  const orig = putVoucher(st, {
    no: '1', summary: '投资收款',
    entries: saleEntries('投资收款', 500, 'investing')
  });
  const r = S.reverseVoucher(orig.id, { month: TARGET, reason: 'x' });
  ck('13.1 红字分录继承了 cashActivity（否则现金流量表会缺这笔冲销）',
    !!(r.voucher && r.voucher.entries[0].cashActivity === 'investing'),
    r.voucher && JSON.stringify(r.voucher.entries.map(function (e) { return e.cashActivity; })));
}

/* ══════════ 14. 返工提示（hint）的开关 ══════════ */
console.log('');
console.log('【14】「需重新结转」提示 —— 只在真正打破已结平状态时才给');
{
  // 14a. 本期已结转且当时结平 → 红冲一张损益类原始凭证 ⇒ 应提示
  const st = mkBook();
  putVoucher(st, { no: '1', date: '2026-08-05', summary: '收入', entries: saleEntries('收入', 500) });
  putVoucher(st, { no: '2', date: '2026-08-06', summary: '费用', entries: [
    { code: '5602', summary: '费用', dr: 200, cr: 0 },
    { code: '1001', summary: '费用', dr: 0, cr: 200 }
  ] });
  putVoucher(st, { no: '3', date: '2026-08-31', kind: S.VOUCHER_KINDS.CARRY_PL, summary: '结转损益', entries: [
    { code: '6001', summary: '结转损益', dr: 500, cr: 0 },
    { code: '3103', summary: '结转损益', dr: 0, cr: 500 },
    { code: '3103', summary: '结转损益', dr: 200, cr: 0 },
    { code: '5602', summary: '结转损益', dr: 0, cr: 200 }
  ] });
  const rA = S.reverseVoucher('记-1@2026-08', { month: TARGET, reason: '收入录多了' });
  ck('14.1 打破已结平的结转 ⇒ 给出「重新结转」提示',
    !!(rA && rA.ok === true && typeof rA.hint === 'string' && /重新结转/.test(rA.hint)),
    rA && JSON.stringify(rA.hint));

  // 14b. 本期【未】结转 → 红冲损益类凭证也不该提示（否则月中天天误报，提示成噪音）
  const st2 = mkBook();
  putVoucher(st2, { no: '1', date: '2026-08-05', summary: '收入', entries: saleEntries('收入', 500) });
  const rB = S.reverseVoucher('记-1@2026-08', { month: TARGET, reason: '收入录多了' });
  ck('14.2 本期未结转 ⇒ 不提示', !!(rB && rB.ok === true && rB.hint === null),
    rB && JSON.stringify(rB.hint));

  // 14c. 已结转、但红冲的是【不碰损益】的凭证（纯资产间划转）⇒ 不该提示
  const st3 = mkBook();
  putVoucher(st3, { no: '1', date: '2026-08-05', summary: '内部划转', entries: [
    { code: '1002', summary: '内部划转', dr: 400, cr: 0 },
    { code: '1001', summary: '内部划转', dr: 0, cr: 400 }
  ] });
  putVoucher(st3, { no: '2', date: '2026-08-31', kind: S.VOUCHER_KINDS.CARRY_PL, summary: '结转损益', entries: [
    { code: '6001', summary: '结转损益', dr: 500, cr: 0 },
    { code: '3103', summary: '结转损益', dr: 0, cr: 500 }
  ] });
  const rC = S.reverseVoucher('记-1@2026-08', { month: TARGET, reason: '划转取消' });
  ck('14.3 已结转但红冲未动损益 ⇒ 不提示（避免噪音）',
    !!(rC && rC.ok === true && rC.hint === null), rC && JSON.stringify(rC.hint));
}

/* ══════════ 汇总 ══════════ */
console.log('');
console.log('════ 汇总 ════');
console.log('  红字冲销回归：PASS ' + nPass + ' / FAIL ' + nFail);
console.log('');
if (nFail) {
  console.log('结果：存在失败   PASS ' + nPass + ' / FAIL ' + nFail);
  process.exit(1);
}
console.log('结果：全部通过   PASS ' + nPass + ' / FAIL 0');
process.exit(0);
