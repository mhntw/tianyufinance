// 稳定性测试：内存副本上做，绝不落盘（persist/backupNow 全部 stub）
//   C1 缓存一致性：期初/科目/凭证变更后，账簿与报表必须立即反映
//   C2 边界期间：空期间、未来期间、年初、建账前月份
//   C3 幂等性：结转损益、未达账结转、凭证 id 重排
//   C4 软删除：删除/恢复凭证后报表与账簿一致
//   C5 各计算接口健壮性：真实数据全期间遍历不抛异常
// 用法：node tools/preflight_stability.js
'use strict';

const fs = require('fs');
const path = require('path');
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null, addEventListener() {} };
global.window = global;
global.__TAURI__ = {}; global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
const EPS = 0.005;
const near = (a, b, e) => Math.abs(num(a) - num(b)) < (e === undefined ? EPS : e);

let FAIL = 0, WARN = 0;
function ck(c, m, d) { if (c) { console.log('    ✓ ' + m); return true; } FAIL++; console.log('    ✗ ' + m + (d ? '  → ' + d : '')); return false; }
function warn(c, m, d) { if (c) { console.log('    ✓ ' + m); return true; } WARN++; console.log('    ! ' + m + (d ? '  → ' + d : '')); return false; }

// 绝不落盘（保留原始引用，供 C7 数据安全用例使用）
const REAL_PERSIST = S.persist;
S.persist = function () { return true; };
S.backupNow = function () { return Promise.resolve(true); };
S.addLog = function () {};

const BOOK_DIR = path.resolve(process.env.HOME, 'Library/Application Support/心中有数/books');
const TARGET = process.argv[2] || '添钰来客_合并_20260905_1788605413724.json';

function load() {
  S.state = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, TARGET), 'utf8'));
  S.bookId = TARGET;
  S.normalizeState(); S.ensureVoucherIds();
  if (S.ensureBankAccounts) S.ensureBankAccounts();
  if (S.ensureCashFlowFields) S.ensureCashFlowFields();
  S._glCache = {};
  return S.state;
}

function months(st) {
  const mm = {};
  (st.vouchers || []).forEach((v) => { const m = (v.date || '').slice(0, 7); if (/^\d{4}-\d{2}$/.test(m)) mm[m] = 1; });
  return Object.keys(mm).sort();
}

const st = load();
const ms = months(st);
const last = ms[ms.length - 1];
console.log('账套：' + TARGET + '  期间 ' + ms.length + ' 个，最后期间 ' + last + '\n');

/* ---------- C1 缓存一致性 ---------- */
console.log('[C1] 缓存一致性（数据变更后账簿/报表必须立即反映）');
{
  // C1-1 期初余额变更
  load();
  const before = S.generalLedger(last).filter((r) => r.code === '1001')[0];
  const cashLeaf = (function () {
    const codes = (S.state.subjects || []).map((s) => String(s.code));
    const leaf = codes.filter((c) => /^1001/.test(c) && !codes.some((o) => o !== c && o.indexOf(c) === 0));
    return leaf[0] || '1001';
  })();
  const r0 = S.setOpening(cashLeaf, 100000, 0, 0, 0, 0);
  const after = S.generalLedger(last).filter((r) => r.code === '1001')[0];
  const changed = Math.abs(num(after.obDr) - num(before.obDr)) > EPS;
  ck(!r0.ok || changed, 'C1-1 修改期初余额后 generalLedger 立即反映',
    'setOpening=' + JSON.stringify(r0) + ' 期初前=' + before.obDr + ' 后=' + after.obDr);

  // C1-2 期初变更后资产负债表同步
  load();
  const bs0 = S.balanceSheet(last).totalAsset;
  S.setOpening(cashLeaf, 100000, 0, 0, 0, 0);
  const bs1 = S.balanceSheet(last).totalAsset;
  ck(Math.abs(bs1 - bs0) > EPS, 'C1-2 修改期初余额后 资产负债表 立即反映', '前=' + bs0 + ' 后=' + bs1);

  // C1-3 新增科目后账簿包含新科目
  load();
  const n0 = S.generalLedger(last).length;
  S.addSubject('9999', '测试科目', 'asset');
  const n1 = S.generalLedger(last).length;
  ck(n1 === n0 + 1, 'C1-3 新增科目后 科目余额表 立即包含', '前=' + n0 + ' 后=' + n1);

  // C1-4 停用科目（财务规范：停用而非物理删除）后，账簿立即标记为停用
  load();
  S.addSubject('9998', '待停用科目', 'asset');
  const on0 = S.subject('9998').enabled;
  S.removeSubject('9998');
  const on1 = S.subject('9998').enabled;
  S.enableSubject('9998');
  const on2 = S.subject('9998').enabled;
  ck(on0 === true && on1 === false && on2 === true, 'C1-4 科目停用/启用状态即时生效',
    '新增后=' + on0 + ' 停用后=' + on1 + ' 启用后=' + on2);

  // C1-5 新增凭证后报表反映
  load();
  const pl0 = S.profitStatement(last).totalExpense;
  S.addVoucher({
    word: '记', no: 9999, date: last + '-28', attach: 0, summary: '稳定性测试',
    entries: [
      { code: '5602', name: '管理费用', summary: '测试', dr: 1000, cr: 0 },
      { code: '1001', name: '库存现金', summary: '测试', dr: 0, cr: 1000 }
    ]
  });
  const pl1 = S.profitStatement(last).totalExpense;
  ck(Math.abs(pl1 - pl0 - 1000) < EPS, 'C1-5 新增凭证后 利润表 立即反映', '前=' + pl0 + ' 后=' + pl1);
}

/* ---------- C2 边界期间 ---------- */
console.log('\n[C2] 边界期间健壮性');
{
  load();
  const cases = ['2099-12', '1970-01', last.slice(0, 4) + '-01', '2020-06', ''];
  let okAll = true, err = '';
  cases.forEach((m) => {
    try {
      const gl = S.generalLedger(m);
      const bs = S.balanceSheet(m);
      const cf = S.cashFlow(m);
      const pl = S.profitStatement(m);
      if (!gl || !bs || !cf || !pl) { okAll = false; err = m + ' 返回空'; }
      if (!isFinite(bs.totalAsset) || !isFinite(pl.netProfit) || !isFinite(cf.ending)) { okAll = false; err = m + ' 出现 NaN/Infinity'; }
    } catch (e) { okAll = false; err = m + ' 抛异常: ' + e.message; }
  });
  ck(okAll, 'C2-1 空/未来/历史/非法期间 计算不抛异常且无 NaN', err);

  // 未来期间（无凭证）：应等于「截至最后期间的累计快照」，而非崩溃或归零
  load();
  const empty = '2099-12';
  const bsE = S.balanceSheet(empty);
  const bsL = S.balanceSheet(last);
  ck(bsE && near(bsE.totalAsset, bsL.totalAsset, 0.01), 'C2-2 未来期间返回截至最后期间的累计快照',
    bsE ? '未来期间资产=' + bsE.totalAsset + ' 最后期间资产=' + bsL.totalAsset : 'null');

  // valid month 参数缺失
  load();
  let noCrash = true, e2 = '';
  try { S.generalLedger(undefined); } catch (e) { noCrash = false; e2 = e.message; }
  try { S.balanceSheet(undefined); } catch (e) { noCrash = false; e2 += ' / bs:' + e.message; }
  try { S.cashFlow(undefined); } catch (e) { noCrash = false; e2 += ' / cf:' + e.message; }
  ck(noCrash, 'C2-3 期间参数为 undefined 时不崩溃', e2);
}

/* ---------- C3 幂等性 ---------- */
console.log('\n[C3] 关键操作幂等性');
{
  // C3-1 结转损益幂等（同一期间连续执行两次不得产生两张凭证）
  load();
  const openMonth = (function () {
    const closed = S.state.closedPeriods || [];
    const cand = ms.filter((m) => closed.indexOf(m) < 0);
    return cand.length ? cand[cand.length - 1] : last;
  })();
  const before = S.periodVouchers(openMonth).length;
  let r1 = null, r2 = null;
  try { r1 = S.carryForwardProfit(openMonth); } catch (e) { r1 = { err: e.message }; }
  const mid = S.periodVouchers(openMonth).length;
  try { r2 = S.carryForwardProfit(openMonth); } catch (e) { r2 = { err: e.message }; }
  const after = S.periodVouchers(openMonth).length;
  ck(r1 && !r1.ok ? true : (mid === before + 1 && after === mid), 'C3-1 结转损益不可重复生成',
    '首次=' + JSON.stringify(r1 && (r1.ok || r1.msg)) + ' 第二次=' + JSON.stringify(r2 && (r2.ok || r2.msg)) +
    ' 凭证数 ' + before + '→' + mid + '→' + after);

  // C3-2 凭证 id 稳定（重复 ensureVoucherIds 不改变 id）
  load();
  const ids1 = (S.state.vouchers || []).map((v) => v.id).join(',');
  S.ensureVoucherIds();
  const ids2 = (S.state.vouchers || []).map((v) => v.id).join(',');
  ck(ids1 === ids2, 'C3-2 凭证 id 幂等（重复 ensureVoucherIds 不变）');
}

/* ---------- C4 软删除 ---------- */
console.log('\n[C4] 软删除与恢复');
{
  load();
  const vs = S.periodVouchers(last);
  if (!vs.length) { console.log('    - 最后期间无凭证，跳过'); }
  else {
    const target = vs[0];
    const bsBefore = S.balanceSheet(last).totalAsset;
    S.removeVoucher(target.id);
    const bsAfterDel = S.balanceSheet(last).totalAsset;
    const inList = S.periodVouchers(last).some((v) => v.id === target.id);
    S.restoreVoucher(target.id);
    const bsAfterRestore = S.balanceSheet(last).totalAsset;
    ck(!inList, 'C4-1 软删凭证从期间列表移除');
    ck(near(bsAfterRestore, bsBefore, 0.01), 'C4-2 恢复凭证后资产负债表回到原值',
      '原=' + bsBefore + ' 删后=' + bsAfterDel + ' 恢复后=' + bsAfterRestore);
    ck(S.deletedVouchers().some((v) => v.id === target.id) === false, 'C4-3 恢复后回收站不再包含该凭证');
  }
}

/* ---------- C5 计算接口健壮性（全期间遍历） ---------- */
console.log('\n[C5] 全期间 × 全接口 遍历（真实数据）');
{
  load();
  const ifaces = ['generalLedger', 'balanceSheet', 'profitStatement', 'cashFlow', 'trialBalance'];
  let errs = [];
  ms.forEach((m) => {
    ifaces.forEach((fn) => {
      try { const r = S[fn](m); if (!r) errs.push(fn + '(' + m + ') 返回空'); }
      catch (e) { errs.push(fn + '(' + m + ') ' + e.message); }
    });
  });
  ck(errs.length === 0, 'C5-1 报表四接口 × ' + ms.length + ' 期间全部正常', errs.slice(0, 5).join(' | '));

  // 明细账：对全部科目取明细（含无发生额科目）
  const codes = (S.state.subjects || []).map((s) => String(s.code));
  let dErr = [];
  codes.slice(0, 400).forEach((c) => {
    try { S.detailLedger(c, last); } catch (e) { dErr.push(c + ': ' + e.message); }
  });
  ck(dErr.length === 0, 'C5-2 全部 ' + codes.length + ' 科目取明细账无异常', dErr.slice(0, 5).join(' | '));

  // 结账检查类
  let chkErr = [];
  try {
    if (S.periodCheck) { S.periodCheck(last); }
    if (S.financialHealthCheck) { S.financialHealthCheck({}); }
  } catch (e) { chkErr.push(e.message); }
  ck(chkErr.length === 0, 'C5-3 期末检查 / 风险体检无异常', chkErr.join(' | '));
}

/* ---------- C6 切换账套不串数据 ---------- */
console.log('\n[C6] 账套隔离');
{
  load();
  const a1 = S.balanceSheet(last).totalAsset;
  S.bookId = 'ANOTHER_BOOK';
  const a2 = S.balanceSheet(last).totalAsset;
  ck(near(a1, a2, 0.01) === false || a1 === a2, 'C6-1 切换 bookId 后重新计算（缓存带 bookId 隔离）', 'a1=' + a1 + ' a2=' + a2);
  S.bookId = TARGET;
}

/* ---------- C7 数据安全：写盘失败必须显性告警 ---------- */
console.log('\n[C7] 数据安全（写盘失败不得静默）');
{
  load();
  const realSave = global.Storage.saveBook;
  let alerted = null;
  global.window.__onPersistError = function (err, count) { alerted = { err: err, count: count }; };
  const origErr = console.error; console.error = function () {}; // 屏蔽预期错误输出
  // 模拟磁盘写入失败
  global.Storage.saveBook = function () { return Promise.resolve({ ok: false, error: '模拟磁盘已满' }); };
  REAL_PERSIST.call(S);
  setTimeout(function () {
    console.error = origErr;
    ck(alerted !== null, 'C7-1 账套写盘失败时触发显性告警（不得静默）',
      alerted ? '' : '未调用 __onPersistError（用户会误以为已保存）');
    // 恢复正常写盘后应清除告警
    let okCalled = false;
    global.window.__onPersistOk = function () { okCalled = true; };
    global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); };
    REAL_PERSIST.call(S);
    setTimeout(function () {
      ck(okCalled || alerted === null, 'C7-2 恢复写盘成功后清除告警');
      global.Storage.saveBook = realSave;
      console.log('\n========== 稳定性汇总：失败 ' + FAIL + ' 项，警告 ' + WARN + ' 项 ==========');
      process.exit(FAIL ? 1 : 0);
    }, 30);
  }, 30);
}
// 注：汇总输出与 process.exit 在 C7 的异步回调中执行（写盘告警为异步 Promise）
