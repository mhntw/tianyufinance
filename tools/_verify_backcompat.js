#!/usr/bin/env node
/* _verify_backcompat.js — 验证 v.kind 改造对旧版账套/备份的向前兼容
 * 场景：账套 JSON 来自改造前（凭证无 kind 字段），加载/恢复后必须：
 *  ① normalizeState 自动按结构识别回填 kind（结果与本次已回填版本一致）；
 *  ② 结转状态/结账检查/不变量不受影响；
 *  ③ restoreFromData（备份恢复）可正常完成并同样回填。
 * 只读（内存深拷贝，persist no-op）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

let bad = 0;
const ck = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };
const dir = '/Users/chen/Library/Application Support/添钰财务/books';
const files = fs.readdirSync(dir).filter(f => /\.json$/.test(f));

files.forEach(f => {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (((raw.vouchers || []).length) < 10) return;
  console.log('\n===== ' + f + ' =====');
  const orig = JSON.parse(JSON.stringify(raw));
  // 1) 先在现版引擎回填（作为基准计数）
  S.state = JSON.parse(JSON.stringify(raw)); S.bookId = f; S._glCache = {};
  S.normalizeState();
  const baseKind = {}; let baseCarry = 0, baseYE = 0;
  (S.state.vouchers || []).forEach(v => { if (v.kind) { baseKind[v.kind] = (baseKind[v.kind] || 0) + 1; if (v.kind === 'carryPL') baseCarry++; if (v.kind === 'carryYE') baseYE++; } });

  // 2) 模拟「旧版账套」：深拷贝并剥除全部 v.kind
  const old = JSON.parse(JSON.stringify(orig));
  (old.vouchers || []).forEach(v => { delete v.kind; });
  S.state = old; S.bookId = f; S._glCache = {};
  S.normalizeState(); // 应自动回填
  const rekind = {}; let reCarry = 0;
  (S.state.vouchers || []).forEach(v => { if (v.kind) { rekind[v.kind] = (rekind[v.kind] || 0) + 1; if (v.kind === 'carryPL') reCarry++; } });
  const kindSame = Object.keys(baseKind).every(k => baseKind[k] === rekind[k]) && Object.keys(rekind).every(k => baseKind[k] === rekind[k]);
  ck(kindSame, '旧版(无kind)账套加载后自动回填，分布与现版一致 ' + JSON.stringify(rekind));
  ck(reCarry === baseCarry, '结转损益凭证识别数一致（' + baseCarry + ' → ' + reCarry + '）');

  // 3) 结转状态/结账检查
  const months = {};
  (S.state.vouchers || []).forEach(v => { const k = (v.date || '').slice(0, 7); if (k) months[k] = 1; });
  const ms = Object.keys(months).sort();
  let carryBad = 0;
  ms.forEach(m => { if (S.carryForwardState(m).done && S.periodVouchersOfKind(m, 'carryPL').length === 0) carryBad++; });
  ck(carryBad === 0, '已结转月均可定位到 kind=carryPL 凭证');
  let badBal = 0;
  (S.state.vouchers || []).forEach(v => { if (v.deleted !== 'y' && !S.voucherBalance(v.entries).balanced) badBal++; });
  ck(badBal === 0, '借贷平衡保持');
  // 断言用「最近已结账月」：未结转月（如 2026-08）存在 carry:fail 是正确预期，不能作断言对象
  const closedLast = (S.state.closedPeriods || []).slice().sort().pop();
  const cl = S.settleChecklist(closedLast || ms[ms.length - 1]);
  ck(!cl.some(c => c.status === 'fail'), (closedLast || '末月') + ' settleChecklist 无 fail 项');

  // 4) restoreFromData（备份恢复路径）同样回填
  S.state = { subjects: [] }; // 破坏状态
  const rr = S.restoreFromData(JSON.parse(JSON.stringify(orig)));
  ck(rr.ok === true, 'restoreFromData 恢复旧备份成功');
  const afterRestore = (S.state.vouchers || []).filter(v => v.kind === 'carryPL').length;
  ck(afterRestore === baseCarry, '恢复后自动回填 carryPL=' + afterRestore + '（基准 ' + baseCarry + '）');
});

console.log('\n' + (bad === 0 ? '✅ 旧版账套/备份向前兼容验证全部通过' : '❌ ' + bad + ' 处不符'));
process.exit(bad === 0 ? 0 : 1);
