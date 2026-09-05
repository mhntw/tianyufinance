#!/usr/bin/env node
/* _diag_carryfix.js — 验证结账-结转死锁修复 */
'use strict';
const fs = require('fs');
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const f = process.argv[2] || '/Users/chen/Library/Application Support/添钰财务/books/添钰来客_合并_20260905_1788605413724.json';
S.state = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))));
S.bookId = 'fixverify';

// 1. 未结账月 2026-08：真实需结转
const r = S.carryForwardProfit('2026-08');
console.log('[2026-08 首次结转] ok=', r.ok, '|', r.msg || ('net=' + Math.round(r.net * 100) / 100));
const r2 = S.carryForwardProfit('2026-08');
console.log('[2026-08 二次结转] ok=', r2.ok, '|', r2.msg || '（不应重复生成）');

// 2. 金蝶已结转月 2025-12（未结账状态）：应被 hasCarryForward 结构化判定拦截
const before = S.periodVouchers('2025-12').length;
const r3 = S.carryForwardProfit('2025-12');
const afterCnt = S.periodVouchers('2025-12').length;
console.log('[2025-12 结转(金蝶已结转)] ok=', r3.ok, '|', r3.msg || '', '| 凭证数', before, '->', afterCnt);

// 3. 结账检查（2025-12）现在应为通过该项
const cl = S.settleChecklist('2025-12');
const carry = cl.find(c => c.key === 'carry');
console.log('[2025-12 结账检查-结转损益]', carry.status, '|', carry.tip);

// 4. 反结账最近期 2026-07 后重新结账：现在应可走通（原死锁场景）
const rOpen = S.reopenPeriod('2026-07', '修复验证');
console.log('[2026-07 反结账]', rOpen.ok, rOpen.msg || '');
const cl7 = S.settleChecklist('2026-07');
const carry7 = cl7.find(c => c.key === 'carry');
console.log('[2026-07 反结账后 结账检查-结转损益]', carry7.status, '|', carry7.tip);
const fails7 = cl7.filter(c => c.status === 'fail');
if (!fails7.length) {
  const rClose = S.closePeriod('2026-07', { force: true });
  console.log('[2026-07 重新结账]', rClose.ok, rClose.msg || '');
} else {
  console.log('[2026-07 重新结账] 阻塞项:', fails7.map(c => c.label).join('、'));
}

// 5. 全套不变量（保证修复未破坏）
let bad = 0;
S.state.vouchers.forEach(v => { const b = S.voucherBalance(v.entries); if (!b.balanced) bad++; });
console.log('[借贷平衡复查] 不平衡凭证数=', bad);
const gl = S.generalLedger('2026-08');
let dr = 0, cr = 0;
gl.forEach(r => { if (r.code.length <= 4) { dr += r.endDr; cr += r.endCr; } });
console.log('[试算平衡复查 2026-08]', '借=' + dr.toFixed(2), '贷=' + cr.toFixed(2), '差=' + (dr - cr).toFixed(2));