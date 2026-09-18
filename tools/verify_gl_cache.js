// 总账缓存（_glCache）正确性验证 —— 严重缺陷回归
// 缺陷：generalLedger 的记忆化缓存原来只以 month 为键，切换账套 / 恢复备份后
//       查询「同月份」会命中旧账套（或恢复前）的缓存，导致账簿/报表显示错误数据。
// 修复：① 缓存键加入 bookId（切换账套自然失效，覆盖所有 state 替换路径）
//       ② switchBook / restoreFromData 显式清空缓存
// 用法：node tools/verify_gl_cache.js
'use strict';

const path = require('path');
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;

let bad = 0;
const ck = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); bad++; } };
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function mkState(subjects, vouchers) {
  S.state = {};
  S.normalizeState();
  // 本测试的凭证日期是 2026-05，而 normalizeState 会把 company.startMonth 默认成"当前月"，
  // 于是 addVoucher 的「不得早于账套启用期间」闸门会整张拒掉这些凭证 —— 表现为 addVoucher 后
  // 金额不变、断言失败。这里显式把启用月提前，让本测试专注在"凭证变更是否使总账缓存失效"。
  S.state.company = S.state.company || {};
  S.state.company.startMonth = '2026-01';
  S.state.subjects = subjects;
  S.state.vouchers = vouchers;
  S.state.openingBalances = {};
  S.state.closedPeriods = [];
  S.state.bankAccounts = [];
  S.state.cashJournals = [];
  S.state.bankStatements = [];
  S._glCache = {};
}
function glOf(code, month) {
  const r = (S.generalLedger(month) || []).filter((x) => x.code === code)[0];
  return r ? num(r.periodDr) : 0;
}

const SUBJ = [
  { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr', level: 0, enabled: true },
  { code: '6001', name: '主营业务收入', cls: 'revenue', normal: 'cr', level: 0, enabled: true }
];

console.log('=== 1. 缓存键带 bookId：切换账套后同月份不串数据 ===');
// 账套 A：2026-03 现金借方 1000
mkState(SUBJ, [{ id: 'V1', word: '记', no: 1, date: '2026-03-05', summary: 'A收款', entries: [{ code: '1001', dr: 1000, cr: 0 }, { code: '6001', dr: 0, cr: 1000 }] }]);
S.bookId = 'BOOK_A';
const aVal = glOf('1001', '2026-03');
ck(aVal === 1000, '账套A 2026-03 现金发生额 = 1000（实际 ' + aVal + '）');

// 切到账套 B：2026-03 现金借方 555（同月份！）。
// 注意：这里【不清缓存、只换 bookId + 换数据】，专门验证「靠 key 隔离」是否生效
// （真实 switchBook 会显式清缓存，此处故意不清，以验证 key 隔离这一道防线本身就足够）。
S.state.vouchers = [{ id: 'V2', word: '记', no: 1, date: '2026-03-06', summary: 'B收款', entries: [{ code: '1001', dr: 555, cr: 0 }, { code: '6001', dr: 0, cr: 555 }] }];
S.bookId = 'BOOK_B';
const bVal = glOf('1001', '2026-03');
ck(bVal === 555, '账套B 2026-03 现金发生额 = 555（实际 ' + bVal + '，修复前会命中A缓存返回1000）');
ck(bVal !== aVal, '切换账套后同月份不再返回旧账套数据');

// 切回账套 A（同时恢复 A 的数据，模拟真实 switchBook 从磁盘加载），仍应是 1000
S.state.vouchers = [{ id: 'V1', word: '记', no: 1, date: '2026-03-05', summary: 'A收款', entries: [{ code: '1001', dr: 1000, cr: 0 }, { code: '6001', dr: 0, cr: 1000 }] }];
S.bookId = 'BOOK_A';
const aVal2 = glOf('1001', '2026-03');
ck(aVal2 === 1000, '切回账套A 仍为 1000（实际 ' + aVal2 + '）');
// A 的缓存被保留复用（同 bookId+month 命中）
ck(Object.keys(S._glCache).length === 2, '两个账套的缓存各自独立（' + Object.keys(S._glCache).join(' , ') + '）');

console.log('\n=== 2. restoreFromData 后缓存失效 ===');
mkState(SUBJ, [{ id: 'V3', word: '记', no: 1, date: '2026-03-05', summary: '恢复前', entries: [{ code: '1001', dr: 3000, cr: 0 }, { code: '6001', dr: 0, cr: 3000 }] }]);
S.bookId = 'BOOK_C';
const beforeRestore = glOf('1001', '2026-03');
ck(beforeRestore === 3000, '恢复前 2026-03 现金 = 3000');

// 恢复备份：新数据为 777（同 bookId、同月份）
const backup = {
  subjects: SUBJ,
  vouchers: [{ id: 'V4', word: '记', no: 1, date: '2026-03-05', summary: '恢复后', entries: [{ code: '1001', dr: 777, cr: 0 }, { code: '6001', dr: 0, cr: 777 }] }]
};
const rr = S.restoreFromData(backup);
ck(rr.ok, 'restoreFromData 成功');
const afterRestore = glOf('1001', '2026-03');
ck(afterRestore === 777, '恢复后 2026-03 现金 = 777（实际 ' + afterRestore + '，修复前会命中旧缓存返回3000）');

console.log('\n=== 3. 缓存仍能正常命中（性能未被破坏）===');
mkState(SUBJ, [{ id: 'V5', word: '记', no: 1, date: '2026-04-05', summary: '缓存测试', entries: [{ code: '1001', dr: 888, cr: 0 }, { code: '6001', dr: 0, cr: 888 }] }]);
S.bookId = 'BOOK_D';
S._glCache = {};
const c1 = glOf('1001', '2026-04');
const cacheKeys = Object.keys(S._glCache);
const c2 = glOf('1001', '2026-04');
ck(c1 === 888 && c2 === 888, '同一 bookId+month 连续两次查询均为 888');
ck(cacheKeys.length === 1, '缓存条目 1 条（第二次命中缓存，未重复计算）');
ck(/\|/.test(cacheKeys[0] || ''), '缓存键含账套分隔符（' + cacheKeys[0] + '）');

console.log('\n=== 4. 凭证增删改仍使缓存失效（原有行为不变）===');
mkState(SUBJ, [{ id: 'V6', word: '记', no: 1, date: '2026-05-05', summary: '初', entries: [{ code: '1001', dr: 100, cr: 0 }, { code: '6001', dr: 0, cr: 100 }] }]);
S.bookId = 'BOOK_E';
S._glCache = {};
ck(glOf('1001', '2026-05') === 100, '新增前 = 100');
S.addVoucher({ word: '记', date: '2026-05-06', summary: '新', entries: [{ code: '1001', dr: 200, cr: 0 }, { code: '6001', dr: 0, cr: 200 }] });
ck(glOf('1001', '2026-05') === 300, 'addVoucher 后 = 300（缓存已失效）');

console.log('\n============================');
console.log(bad === 0 ? '全部通过：总账缓存按账套隔离，切换/恢复不再串数据，且缓存仍正常命中' : '存在 ' + bad + ' 处不符');
process.exitCode = bad === 0 ? 0 : 1;
