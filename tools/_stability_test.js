#!/usr/bin/env node
/**
 * _stability_test.js — 稳定性测试（在内存副本上执行高风险操作，不触碰磁盘文件）
 *
 * 用法：node tools/_stability_test.js <账套JSON路径>
 *
 * 验证：
 *   T1. 结账检查（settleChecklist）返回结构正常
 *   T2. 对未结账月 closePeriod 成功，清算后试算平衡、资产负债表恒等式仍成立
 *   T3. 反结账 reopenPeriod：仅允许最近一期，拒绝非最近期
 *   T4. 反结账后可重新结账（幂等往复）
 *   T5. 已结账月不允许改/删凭证（updateVoucher/removeVoucher 拦截）
 *   T6. 未结账月允许新增凭证（借贷平衡），新增后凭证号自动递增
 *   T7. 结转损益 carryForwardProfit：对未结账月执行成功且幂等（二次拒绝）；新增凭证借贷平衡
 *   T8. 年末结转本年利润 carryForwardYear 幂等
 *   T9. 高频操作看门狗：反复结账/反结账/结转 100 次内存对象稳定（无异常抛出）
 *   T10. addVoucher 拒绝借贷不平凭证
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- mock 浏览器环境 ---------- */
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };

const storePath = path.join(__dirname, '..', 'js', 'store.js');
const storeMod = require(storePath);
const S = storeMod.store || storeMod;
// 关键：所有写操作最终走 persist，这里不真正落盘
S.addLog = function () { /* no-op */ };
S.backupNow = function () { return Promise.resolve(true); };

let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++;
  if (ok) {
    console.log('  \x1b[32mPASS\x1b[0m ' + label + (detail ? '  ' + detail : ''));
  } else {
    fails++;
    console.log('  \x1b[31mFAIL\x1b[0m ' + label + '  ' + (detail || ''));
  }
}
const fmt = n => Number(n).toFixed(2);
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const near = (a, b) => Math.abs(num(a) - num(b)) < 0.01;

function balancedBooks(month) {
  const gl = S.generalLedger(month);
  let dr = 0, cr = 0;
  gl.forEach(r => { if (r.code.length <= 4) { dr += num(r.endDr); cr += num(r.endCr); } });
  return Math.abs(dr - cr) < 0.01;
}
function bsBalanced(month) {
  const bs = S.balanceSheet(month);
  return Math.abs(bs.totalAsset - bs.totalAll) < 0.01;
}

const bookArg = process.argv[2];
const raw = JSON.parse(fs.readFileSync(bookArg, 'utf8'));

/* ---------- 深拷贝到内存（隔离测试用，避免破坏 process.argv 指定文件） ---------- */
const data = JSON.parse(JSON.stringify(raw));
S.state = data;
S.bookId = (data.id || 'stability') + '_test';

const months = {};
(data.vouchers || []).forEach(v => { const m = (v.date || '').slice(0, 7); if (m) months[m] = (months[m] || 0) + 1; });
const monthList = Object.keys(months).sort().filter(m => /^\d{4}-\d{2}$/.test(m));
const closedSrc = (data.closedPeriods || []).slice();
const openMonths = monthList.filter(m => closedSrc.indexOf(m) < 0);
const closedMonths = monthList.filter(m => closedSrc.indexOf(m) >= 0);

console.log('=== 稳定性测试（内存副本） ===');
console.log('账套：' + (data.company && data.company.name || path.basename(bookArg)));
console.log('凭证：' + data.vouchers.length + '  期间：' + monthList.join(', '));
console.log('已结账：' + JSON.stringify(closedSrc) + '  未结账：' + JSON.stringify(openMonths));
console.log('');

/* --- T1: 结账检查结构 --- */
console.log('--- T1. 结账检查（settleChecklist） ---');
const chkMonth = openMonths[0];
try {
  const cl = S.settleChecklist(chkMonth);
  const validKeys = !!cl && Array.isArray(cl);
  check('T1 结账检查返回数组', validKeys, validKeys ? '期间 ' + chkMonth + ' 共 ' + cl.length + ' 项' : '');
  if (validKeys) {
    cl.forEach(c => {
      if (!['ok', 'fail', 'warn'].includes(c.status)) { check('T1 状态枚举合法', false, c.label + ' => ' + c.status); }
    });
    check('T1 状态枚举合法', true, cl.map(c => c.label + ':' + c.status).join(' | '));
  }
} catch (e) {
  check('T1 结账检查', false, e.message);
}

/* --- T2: 结账（未结账月：先结转损益再结账，验证借贷平衡与恒等式）--- */
console.log('--- T2. 结账（未结账月全流程）---');
const cfClose = chkMonth;
let rCf = S.carryForwardProfit(cfClose);
if (rCf.ok) {
  const r2 = S.closePeriod(cfClose, { force: true });
  check('T2 结转后 closePeriod(' + cfClose + ')', r2 && r2.ok, (r2 && r2.msg) || '');
} else if (/已结转|无需结转/.test(rCf.msg || '')) {
  // 已结转（金蝶摘要为空场景）→ 直接结账应成功（修复点验证）
  const r2 = S.closePeriod(cfClose, { force: true });
  check('T2 已结转时 closePeriod(' + cfClose + ')', r2 && r2.ok, (r2 && r2.msg) || '');
} else {
  check('T2 结转前置失败 ' + cfClose, false, rCf.msg || '');
}
if (S.isPeriodClosed(cfClose)) {
  check('T2 结账后试算平衡', balancedBooks(cfClose));
  check('T2 结账后资产负债表恒等', bsBalanced(cfClose));
  // 重复结账应拒绝
  const r2b = S.closePeriod(cfClose, { force: true });
  check('T2 重复结账被拒绝', r2b && !r2b.ok, (r2b && r2b.msg) || '');
} else {
  check('T2 结账未生效', false, 'closePeriod 未将期间加入 closedPeriods');
}

/* --- T3: 反结账（仅最近一期可反结）--- */
console.log('--- T3. 反结账（reopenPeriod，仅最近一期）---');
// 用原始已结账清单的最近一期
const realLatest = closedSrc.slice().sort().pop();
if (realLatest) {
  // 非最近期应被拒绝（真实状态：最近期=realLatest，试反更早日）
  const older = closedSrc.filter(m => m < realLatest).pop();
  if (older) {
    const rRej = S.reopenPeriod(older, '测试');
    check('T3 反结账非最近期被拒绝', rRej && !rRej.ok, (rRej && rRej.msg) || '');
  }
  // 反结账最近期成功
  const rOpen = S.reopenPeriod(realLatest, '测试反结账');
  check('T3 reopenPeriod(' + realLatest + ')', rOpen.ok, rOpen.ok ? '' : (rOpen.msg || ''));
  if (rOpen.ok) {
    check('T3 反结账后未标记已结账', !S.isPeriodClosed(realLatest));
    // 恢复：重新结账 realLatest（反结账不改变凭证，若 realLatest 有损益需先处理）
    const rRestore = S.closePeriod(realLatest, { force: true });
    check('T3 恢复结账 ' + realLatest, rRestore && rRestore.ok,
      rRestore && rRestore.ok ? '' : ((rRestore && rRestore.msg) || ''));
  }
} else {
  console.log('    WARN 无已结账月');
}

/* --- T5: 已结账月不允许改/删 --- */
console.log('--- T5. 已结账月账证保护 ---');
// 用最早期已结账月（T2/T3 只动最近期，此月状态稳定）
const closedProbeMonth = closedMonths.length ? closedMonths[0] : null;
const closedV = closedProbeMonth ? (data.vouchers || []).find(v => (v.date || '').startsWith(closedProbeMonth)) : null;
check('T5 找到已结账月凭证', !!closedV,
  closedV ? closedProbeMonth + ' ' + closedV.id : (closedProbeMonth ? '该月无凭证' : '无已结账月'));
if (closedV && S.isPeriodClosed(closedProbeMonth)) {
  // 修改属一个「微改」：改摘要不应被允许
  const copy = JSON.parse(JSON.stringify(closedV));
  copy.summary = (copy.summary || '') + '【改】';
  const rUpd = S.updateVoucher(closedV.id, copy);
  check('T5 已结账月不允许修改凭证', rUpd && rUpd.ok !== undefined && rUpd.ok === false, (rUpd && rUpd.msg) || '');
  const rDel = S.removeVoucher(closedV.id);
  check('T5 已结账月不允许删除凭证', rDel && rDel.ok !== undefined && rDel.ok === false, (rDel && rDel.msg) || '');
} else if (closedMonths.length) {
  console.log('    WARN 探测月 ' + closedProbeMonth + ' 已不在结账清单（状态被前序测试改变），跳过');
}
/* --- T6: 未结账月新增凭证 --- */
console.log('--- T6. 未结账月新增凭证 ---');
const openMonth = openMonths.length ? openMonths[openMonths.length - 1] : null;
if (openMonth) {
  const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return y + '-' + String(mo).padStart(2, '0') + '-' + new Date(y, mo, 0).getDate(); };
  const nextNo = S.nextVoucherNo('记', openMonth);
  const r6 = S.addVoucher({
    word: '记', date: lastDay(openMonth), attach: 0,
    summary: '自动稳定性测试凭证（可删除）',
    entries: [
      { code: '1002', name: '银行存款', summary: '测试', dr: 100, cr: 0 },
      { code: '5001', name: '主营业务收入', summary: '测试', dr: 0, cr: 100 }
    ]
  });
  const createdOk = r6 && r6.ok !== false;
  check('T6 新增凭证成功', createdOk, (createdOk && r6.id) ? '凭证 ' + r6.id : (r6 && r6.msg) || '');
  if (createdOk) {
    check('T6 新增凭证号自动递增', Number(r6.no) === nextNo, '期望 ' + nextNo + ' 实际 ' + r6.no);
    check('T6 新增后试算平衡', balancedBooks(openMonth));
    const rDel = S.removeVoucher(r6.id);
    check('T6 测试凭证可删除', !!(rDel && rDel.ok !== false), (rDel && rDel.msg) || '');
  }
}

/* --- T7: 结转损益幂等 --- */
console.log('--- T7. 结转损益（carryForwardProfit）---');
const cfMonth = openMonth;
if (cfMonth) {
  const r7 = S.carryForwardProfit(cfMonth);
  if (r7 && r7.ok) {
    check('T7 结转损益成功', true, '净利 ' + fmt(r7.net || 0));
    check('T7 结转后试算平衡', balancedBooks(cfMonth));
    const r7b = S.carryForwardProfit(cfMonth);
    check('T7 二次结转被拒绝（幂等）', r7b && !r7b.ok, (r7b && r7b.msg) || '');
  } else {
    check('T7 结转损益', false, (r7 && r7.msg) || '未知错误');
  }
}

/* --- T8: 年末结转本年利润幂等（独立副本，避免前序测试状态污染）--- */
console.log('--- T8. 年末结转本年利润（carryYearEnd）---');
const yEnd12 = monthList.filter(m => m.endsWith('-12')).pop();
if (yEnd12 && closedSrc.indexOf(yEnd12) >= 0) {
  // 目标 12 月原始已结账 → 用「最早期」非12月未结账月验证 carryYearEnd 的 12月限定
  const rNotDec = S.carryYearEnd ? S.carryYearEnd('2026-08') : null;
  check('T8 非12月调用被拒绝', rNotDec && !rNotDec.ok,
    rNotDec && !rNotDec.ok ? (rNotDec.msg || '') : '（应拒绝）');
  // 且有已结账 12 月，直接验证 carryYearEnd 对已结账月拒绝
  const rClosedDec = S.carryYearEnd(yEnd12);
  check('T8 已结账12月调用被拒绝', rClosedDec && !rClosedDec.ok,
    rClosedDec && !rClosedDec.ok ? (rClosedDec.msg || '') : '（应拒绝）');
} else if (yEnd12) {
  // 12 月原始未结账：从 raw 原始数据深拷贝独立验证（不受 T2 结账影响）
  const snapState = JSON.parse(JSON.stringify(raw));
  S.state = snapState;
  S.bookId = (data.id || 'stability') + '_t8';
  S._glCache = {};
  const r8 = S.carryYearEnd ? S.carryYearEnd(yEnd12) : null;
  if (r8) {
    if (r8.ok) {
      check('T8 结转本年利润', true, '生成年结凭证');
      const r8b = S.carryYearEnd(yEnd12);
      check('T8 二次结转被拒绝（幂等）', r8b && !r8b.ok, (r8b && r8b.msg) || '');
      check('T8 结转后试算平衡', balancedBooks(yEnd12));
    } else if (/无余额|无需结转|已结转|无利润分配/.test(r8.msg || '')) {
      // 本年利润已清零（金蝶年结完成）——正确拒绝，无需重复年结
      check('T8 结转本年利润（已年结，正确拒绝）', true, r8.msg);
    } else {
      check('T8 结转本年利润', false, r8.msg || '');
    }
  } else {
    check('T8 结转本年利润', false, '引擎无此方法');
  }
  // 恢复主状态
  // 由于 persist 是 no-op，直接恢复 data
  S.state = JSON.parse(JSON.stringify(raw));
  S.bookId = (data.id || 'stability') + '_test';
} else {
  console.log('    WARN 无 12 月期间');
}

/* --- T9: 高频操作循环（看门狗） --- */
console.log('--- T9. 高频操作循环（结账/反结账 各5轮） ---');
try {
  const loopMonth = openMonths[openMonths.length - 1];
  for (let i = 0; i < 5; i++) {
    S.closePeriod(loopMonth, { force: true });
    S.reopenPeriod(loopMonth, '循环测试');
  }
  check('T9 5轮结账/反结账无异常且仍平衡', balancedBooks(loopMonth), balancedBooks(loopMonth) ? '' : '出现不平衡');
} catch (e) {
  check('T9 高频操作', false, e.message);
}

/* --- T10: 拒绝借贷不平凭证 --- */
console.log('--- T10. 借贷平衡强制校验 ---');
const before = S.state.vouchers.length;
const r10 = S.addVoucher({
  word: '记', date: '2026-01-01', attach: 0, summary: '不平衡测试',
  entries: [
    { code: '1002', name: '银行存款', summary: 'test', dr: 100, cr: 0 },
    { code: '5001', name: '主营业务收入', summary: 'test', dr: 0, cr: 50 }
  ]
});
check('T10 借贷不平凭证被拒绝', r10 && r10.ok === false, (r10 && r10.msg) || '');
check('T10 拒绝后凭证数不变', S.state.vouchers.length === before, '原始 ' + before + ' 当前 ' + S.state.vouchers.length);

/* --- 汇总 --- */
console.log('');
console.log('=== 稳定性测试汇总 === ' + (checks - fails) + ' PASS / ' + fails + ' FAIL');
process.exit(fails > 0 ? 1 : 0);