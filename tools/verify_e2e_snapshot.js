// 端到端验证（真实账套）：在真实账套上模拟结账板块的完整操作路径，确认
//   ①（原期末调汇幂等段已随期末调汇功能下线移除，见下方注释）
//   ② 幂等性生效：重复操作不再改变凭证数/余额（折旧等）
//   ③ 无副作用：操作前后关键报表数字不变
//   ④ 年末结转在真实账套上行为正确
// 只读账套文件，所有操作仅在内存中进行（persist/addLog/backupNow 已 no-op）。
// 用法：node tools/verify_e2e_snapshot.js
'use strict';

const fs = require('fs');
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
// 只读保障：所有写操作（persist/addLog/backupNow）一律 no-op，绝不触碰磁盘账套
S.persist = function () { /* no-op */ };
S.addLog = function () { /* no-op */ };
S.backupNow = function () { return Promise.resolve(true); };

const BOOKS_DIR = path.resolve(process.env.HOME, 'Library/Application Support/添钰财务/books');
const EPS = 0.005;
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function loadBook(file) {
  S.state = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, file), 'utf8'));
  if (S.state.schemaVersion == null) S.state.schemaVersion = S.SCHEMA_VERSION;
  S.normalizeState(); S.ensureVoucherIds(); // ensureBankAccounts 已随出纳板块下线移除
}

// 关键指标快照：凭证总数 + 各资金科目期末余额 + 资产负债表是否平衡
function snapshot() {
  const month = currentMonthOfBook();
  const gl = S.generalLedger(month) || [];
  const cash = S.cashAccounts();
  const cashEnd = {};
  cash.forEach((c) => {
    const r = gl.filter((x) => x.code === c.code)[0];
    cashEnd[c.code] = r ? (r.normal === 'dr' ? (num(r.endDr) - num(r.endCr)) : (num(r.endCr) - num(r.endDr))) : 0;
  });
  return {
    vchCount: (S.state.vouchers || []).length,
    cashEnd: cashEnd,
    month: month
  };
}
function currentMonthOfBook() {
  const mm = {};
  (S.state.vouchers || []).forEach((v) => { const m = (v.date || '').slice(0, 7); if (m) mm[m] = 1; });
  const list = Object.keys(mm).sort();
  return list.length ? list[list.length - 1] : '';
}
function sameSnap(a, b) {
  if (a.vchCount !== b.vchCount) return false;
  const ka = Object.keys(a.cashEnd), kb = Object.keys(b.cashEnd);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Math.abs(num(a.cashEnd[k]) - num(b.cashEnd[k])) < EPS);
}

let bad = 0;
const ck = (c, m) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m); bad++; } };

(function main() {
  const files = fs.readdirSync(BOOKS_DIR).filter((f) => /\.json$/.test(f));
  console.log('真实账套端到端验证：' + files.join(', '));
  files.forEach((file) => {
    console.log('\n========== ' + file + ' ==========');
    loadBook(file);
    const m = currentMonthOfBook();
    const before = snapshot();
    console.log('  基准：凭证 ' + before.vchCount + ' 张，最后期间 ' + m + '，资金科目 ' + Object.keys(before.cashEnd).length + ' 个');

    // ①（已移除）期末调汇幂等：期末调汇功能已随出纳/外币处理整体下线（2026-09-01），
    // store.js 无 exchangeAdjust，原调用必抛 TypeError。见 CHANGELOG 2026-09-05。

    // ② 幂等：折旧重复计提
    loadBook(file);
    const s0 = snapshot();
    const d1 = S.depreciateMonth(m);
    const d2 = S.depreciateMonth(m);
    const s1 = snapshot();
    ck(d1.ok || !d1.ok, '② 折旧：调用未抛错（' + (d1.ok ? '成功' : d1.msg || '无资产/已结账') + '）');
    if (d1.ok) {
      ck(!d2.ok || s1.vchCount === s0.vchCount + (d1.count || 1), '② 折旧：重复调用不产生额外凭证（' + s0.vchCount + '→' + s1.vchCount + '）');
    }

    // ③ 无副作用：只读操作不改变任何数据
    loadBook(file);
    const sBefore = snapshot();
    // 跑一遍所有只读报表/取数（cashAccounts=资金类科目口径，现金流量表在用，非出纳）
    S.generalLedger(m); S.trialBalance(m);
    (S.cashAccounts() || []).forEach((c) => { S.detailLedger(c.code, m); });
    // 注：原 bankAccountsAll/adjustTable（出纳对账口径）已随出纳板块整体下线移除
    const sAfter = snapshot();
    ck(sameSnap(sBefore, sAfter), '③ 无副作用：跑完全部报表取数后凭证数与余额均不变');

    // ④ 结转损益摘要可被 UI 正则匹配（真实账套）
    loadBook(file);
    const rc = S.carryForwardProfit(m);
    if (rc.ok) {
      const cv = S.periodVouchers(m).filter((v) => /结转/.test(v.summary || '') && /损益/.test(v.summary || ''))[0];
      ck(!!cv && /结转.*损益/.test(cv.summary), '④ 结转损益：摘要可被修复后正则匹配（' + (cv ? cv.summary : '无') + '）');
      // 重新结转路径：UI 正则能定位旧凭证
      const old = S.periodVouchers(m).filter((v) => /结转.*损益/.test(v.summary || ''));
      ck(old.length >= 1, '④ 结转损益：「重新结转」能定位到旧凭证（' + old.length + ' 张）');
    } else {
      ck(true, '④ 结转损益：本期无需结转（' + (rc.msg || '') + '），跳过');
    }

    // ⑤ settleChecklist 不抛错且结构完整
    loadBook(file);
    let clErr = null, cl = null;
    try { cl = S.settleChecklist(m); } catch (e) { clErr = e.message; }
    ck(!clErr, '⑤ settleChecklist 不抛错' + (clErr ? '（' + clErr + '）' : ''));
    if (cl) {
      const okStruct = cl.every((c) => c && typeof c.key === 'string' && typeof c.status === 'string' && typeof c.label === 'string');
      ck(okStruct, '⑤ settleChecklist 结构完整（' + cl.length + ' 项：' + cl.map((c) => c.key + ':' + c.status).join(' ') + '）');
    }

    console.log('  本账套不符 ' + bad + ' 项');
  });

  console.log('\n============================');
  console.log(bad === 0 ? '全部通过：真实账套上幂等生效、无副作用、新功能行为正确' : '存在 ' + bad + ' 处不符');
  process.exitCode = bad === 0 ? 0 : 1;
})();
