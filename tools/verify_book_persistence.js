#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_book_persistence.js —— 账套持久化的不变量（写盘/加载/熔断）
 *
 * 【为什么有这个脚本】2026-10-27 给 store 加了"写前体检 + 损坏文件写盘闸门"，
 *   当时只用一次性探针验过 —— 探针不在仓库里，等于没有回归保护（改一行就可能失效）。
 *   本脚本把这些不变量固化下来，纳入 run-all：
 *     1. 补全只补 undefined，绝不覆盖已有值（否则就是"静默改账"）
 *     2. 顶层集合类型被破坏 → 拒绝写盘，且**磁盘上的原文件不被覆盖**
 *     3. 损坏文件（JSON 解析失败）→ 抛 parse_fail + 置写盘闸门
 *     4. 结构坏（subjects 是对象而非数组，truthy 但非法）→ 同样置闸门
 *     5. 成功读到结构正确的文件 → 自动解除闸门（避免瞬时故障导致永久只读）
 *     6. 闸门只锁"出问题的那一本"，新建/切换到其它账套不被连带拦住
 *     7. 闸门期间自动备份/手动存档也停手（否则空账套会挤掉环形保留里的好备份）
 *
 * 用法：node tools/verify_book_persistence.js
 * 退出码：0 = 全部通过；1 = 有不符
 * ============================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ---- 浏览器环境桩（store.js 需要） ---- */
const memLS = {};
global.localStorage = {
  getItem: k => (k in memLS ? memLS[k] : null),
  setItem: (k, v) => { memLS[k] = String(v); },
  removeItem: k => { delete memLS[k]; },
};
global.document = { getElementById: () => null, querySelectorAll: () => [] };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;

require(path.join(ROOT, 'js', 'storage.js'));
const STORE_MOD = require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;

let pass = 0, fail = 0;
function ck(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

(async function () {
  /* 1) 补全：只补 undefined，不动已有值 */
  S.state = { subjects: [], vouchers: [], company: { name: '测试账套' }, param: {} };
  S._fillMissingBookDefaults();
  ck(Array.isArray(S.state.fixedAssets), '缺 fixedAssets → 补成数组');
  ck(S.state.company.name === '测试账套', '已有值不被覆盖');
  ck(S.state.company.currency !== undefined, 'company 缺键 → 补默认');
  ck(!('reportRules' in S.state) || typeof S.state.reportRules === 'object', 'reportRules 不写入共享引用（缺失交给加载后深拷）');

  /* 2) 写前体检 + 拒绝写盘：磁盘原文件必须原样保留 */
  S.bookId = 'B1';
  const ORIGINAL = '{"subjects":[],"vouchers":[],"marker":"原文件"}';
  await window.Storage.saveBook('B1', ORIGINAL);
  S.state.vouchers = null;
  ck(S._bookSaveProblems().length > 0, 'vouchers=null 被体检识别');
  const ok = await S._saveBookChecked('B1');
  ck(ok === false, '结构异常 → 保存返回 false');
  ck((await window.Storage.loadBook('B1')) === ORIGINAL, '结构异常 → 磁盘原文件未被覆盖');

  /* 2b) 分层判据：空集合合法；个别脏凭证**不**阻断写盘
        （否则一张缺 entries 的老凭证会让整本账永远存不进去 —— 那比脏数据本身更糟） */
  S.state.vouchers = [{ id: 'v1', entries: [] }];
  S.state.assetCats = [];
  ck(S._bookSaveProblems().length === 0, '空 assetCats（=恢复默认类别）+ 正常凭证 → 体检通过');
  S.state.vouchers = [{ id: 'v1', entries: [] }, { id: 'v2' }];   // v2 缺 entries
  ck(S._bookSaveProblems().length === 0, '个别凭证缺 entries → 不阻断写盘（交给离线审计）');
  ck((await S._saveBookChecked('B1')) === true, '该状态仍能正常落盘（用户新录入不会丢）');

  /* 3) 损坏文件 → parse_fail + 闸门 */
  S._clearBookWriteBlock();
  let threw = false;
  try { await S._consumeDiskBook('{oops', true); } catch (e) { threw = (e.message === 'parse_fail'); }
  ck(threw, '坏 JSON → 抛 parse_fail');
  ck(S._bookWriteBlocked === true, '坏 JSON → 置写盘闸门');

  /* 4) 结构坏（truthy 但非数组）→ 闸门 */
  S._clearBookWriteBlock();
  await S._consumeDiskBook('{"subjects":{},"vouchers":[]}', true);
  ck(S._bookWriteBlocked === true, 'subjects 是对象（非数组）→ 置闸门');

  /* 5) 结构正确 → 自动解锁 */
  await S._consumeDiskBook(JSON.stringify({ schemaVersion: 6, subjects: [], vouchers: [], fixedAssets: [] }), true);
  ck(S._bookWriteBlocked === false, '文件结构正确 → 自动解除闸门');

  /* 6) 闸门只锁本账套 */
  S.bookId = 'B_old';
  S._markBookWriteBlocked('模拟损坏');
  ck(S._isWriteBlockedFor('B_old') === true, '同一账套 → 写盘被拦');
  ck(S._isWriteBlockedFor('B_new') === false, '其它账套 → 不被连带拦截');

  /* 7) 闸门期间备份也停手（否则空账套备份会挤掉环形保留里的好备份） */
  ck((await S.backupNow()) === false, '闸门期间 backupNow() 不写备份');

  /* 8) 写**指定快照**的唯一入口（设置页改名其它账套 / 还原后去重）：同样过体检与熔断 */
  S.state.vouchers = [];                       // 复原成合法态再取快照
  const snap = JSON.parse(JSON.stringify(S.state));
  snap.company = { name: '另一本账' };
  ck((await S.saveSnapshotChecked('B_other', snap)) === true, 'saveSnapshotChecked 正常快照 → 写入成功');
  const badSnap = JSON.parse(JSON.stringify(snap));
  badSnap.vouchers = null;
  const beforeBad = await window.Storage.loadBook('B_other');
  const okBad = await S.saveSnapshotChecked('B_other', badSnap);
  ck(okBad === false, 'saveSnapshotChecked 坏快照 → 拒绝写入');
  ck((await window.Storage.loadBook('B_other')) === beforeBad, 'saveSnapshotChecked 坏快照 → 原文件未被覆盖');

  /* 9) 受控写入口（B2）：写字段 → 作废派生缓存 → 落盘，三件事必须成对发生 */
  S._glCache = { fake: 1 };
  S._vchIndex = { fake: 1 };
  S.bookId = 'B2test';
  const okf = S.setBookFields({ depts: [{ code: '001', name: '测试部' }] });
  ck(okf === true && Array.isArray(S.state.depts), 'setBookFields 写入字段');
  ck(Object.keys(S._glCache).length === 0 && S._vchIndex === null, 'setBookFields 同时作废 _glCache / _vchIndex');
  S._glCache = { fake: 1 };
  S._vchIndex = { fake: 1 };
  S.setParam('voucherWord', '转');
  ck(S.state.param.voucherWord === '转', 'setParam 写入 param 键');
  ck(Object.keys(S._glCache).length === 0 && S._vchIndex === null, 'setParam 同时作废派生缓存（param 影响取数口径）');

  /* 10) 体检规则必须**随 schema 派生**：schema 里每个数组字段被写成 null 都要能识别。
        （有人把它改回硬编码清单时，这里会立刻红 —— 那正是"新增字段漏检"的来源） */
  const shape = STORE_MOD.bookSchema;
  const missed = (shape.arrayKeys || []).filter(function (k) {
    const probe = { subjects: [], vouchers: [] };
    probe[k] = null;
    return !S._bookSaveProblems(probe).some(function (x) { return x.indexOf(k) === 0; });
  });
  ck(missed.length === 0, '写前体检覆盖 schema 全部 ' + (shape.arrayKeys || []).length + ' 个数组字段' +
    (missed.length ? '（漏：' + missed.join(',') + '）' : ''));

  console.log('');
  if (fail) { console.log('✗ 账套持久化不变量：' + fail + ' 项不符（通过 ' + pass + '）'); process.exit(1); }
  console.log('✓ 账套持久化不变量：' + pass + ' 项全部通过');
  process.exit(0);
})();
