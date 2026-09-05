#!/usr/bin/env node
/* _verify_scenarios.js — 期末凭证类型改造后的场景验收（内存副本，不改磁盘）
 *
 * 覆盖此前三个真实缺口：
 *   A. 金蝶已结转月：二次结转必须被拒，且提示能给出具体凭证号
 *   B. 金蝶已结转月：「重新结转」必须可用（此前因摘要正则找不到旧凭证而完全失效）
 *   C. 真实未结转月：能正常结转；结转后二次结转被拒；损益净额归零
 *   D. 12 月：年结检查不阻塞，可结账
 *   E. 全年不变量：借贷平衡 + 试算平衡 + 资产负债表恒等式
 */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const BOOKS_DIR = '/Users/chen/Library/Application Support/心中有数/books';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✅ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

function monthsOf() {
  const m = {};
  (S.state.vouchers || []).forEach(function (v) {
    if (v.deleted === 'y') return;
    const k = (v.date || '').slice(0, 7); if (k) m[k] = 1;
  });
  return Object.keys(m).sort();
}
function vno(v) { return (v.word || '记') + '-' + v.no; }

function runBook(file) {
  const raw = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, file), 'utf8'));
  if (((raw.vouchers || []).length) < 10) return;
  S.state = JSON.parse(JSON.stringify(raw));
  S.bookId = file; S._glCache = {};
  S.normalizeState();
  const ms = monthsOf();
  console.log('\n===== ' + file + ' =====');

  // ---- A. 已结转月：幂等 + 提示带凭证号 ----
  // 注意：必须选「未结账」的已结转月，否则 carryForwardProfit 会先被结账锁拦下，
  // 根本走不到幂等分支，测出来的是结账锁而非幂等（此前用例即因此误判）。
  const carriedMs = ms.filter(function (m) { return S.carryForwardState(m).done; });
  const carriedOpen = carriedMs.filter(function (m) { return !S.isPeriodClosed(m); });
  if (carriedOpen.length) {
    const m = carriedOpen[carriedOpen.length - 1];
    const before = S.periodVouchers(m).length;
    const r = S.carryForwardProfit(m);
    const after = S.periodVouchers(m).length;
    check('A1 已结转月二次结转被拒', r.ok === false, r.msg || '');
    check('A2 二次结转未新增凭证', before === after, before + ' -> ' + after);
    check('A3 拒绝提示含具体凭证号', /记-\d+|转-\d+/.test(r.msg || ''), r.msg || '');
  } else {
    console.log('  (无「未结账且已结转」月份，跳过 A)');
  }

  // ---- B. 已结转月：重新结转（删旧 → 重生）必须可用 ----
  if (carriedMs.length) {
    // 选一个未结账的已结转月，避免被结账锁拦
    const m = carriedMs.filter(function (x) { return !S.isPeriodClosed(x); })[0] || carriedMs[carriedMs.length - 1];
    if (S.isPeriodClosed(m)) {
      console.log('  (已结转月均已结账，跳过 B)');
    } else {
      const old = S.periodVouchersOfKind(m, S.VOUCHER_KINDS.CARRY_PL);
      const cntBefore = S.periodVouchers(m).length;
      check('B1 能按 kind 定位到旧结转凭证', old.length > 0, old.map(vno).join(','));
      let delOk = true, delErr = '';
      old.forEach(function (v) {
        const dr = S.removeVoucher(v.id);
        if (!dr.ok) { delOk = false; delErr = dr.msg; }
      });
      check('B2 旧结转凭证可删除', delOk, delErr);
      const r2 = S.carryForwardProfit(m);
      check('B3 删除后可重新结转', r2.ok === true, r2.msg || ('net=' + (r2.net || 0).toFixed(2)));
      // 金蝶常把结转拆成多张凭证（转收入/转费用各一张），本软件重做时合并生成为 1 张，
      // 故凭证总数本就不相等；应断言「重做后恰有 1 张结转凭证」而非总数不变。
      const afterCarry = S.periodVouchersOfKind(m, S.VOUCHER_KINDS.CARRY_PL);
      check('B4 重做后恰生成 1 张结转凭证', afterCarry.length === 1,
        '重做前结转凭证 ' + old.length + ' 张 -> 重做后 ' + afterCarry.length + ' 张（期间总凭证 ' + cntBefore + ' -> ' + S.periodVouchers(m).length + '）');
      check('B4b 重做后凭证借贷平衡',
        afterCarry.length === 1 && S.voucherBalance(afterCarry[0].entries).balanced);
      check('B5 重新结转后净额归零', (function () {
        const n = S.periodProfitNet(m);
        return Math.abs(n.rev) < 0.005 && Math.abs(n.exp) < 0.005;
      })(), '');
      check('B6 重做后再次结转被拒', S.carryForwardProfit(m).ok === false);
      // 还原（软删可恢复，但为免影响后续用例，直接重载账套）
      S.state = JSON.parse(JSON.stringify(raw)); S._glCache = {}; S.normalizeState();
    }
  }

  // ---- C. 真实未结转月 ----
  const todo = ms.filter(function (m) {
    if (S.isPeriodClosed(m)) return false;
    if (S.carryForwardState(m).done) return false;
    const n = S.periodProfitNet(m);
    return Math.abs(n.rev) >= 0.005 || Math.abs(n.exp) >= 0.005;
  });
  if (todo.length) {
    const m = todo[todo.length - 1];
    const r1 = S.carryForwardProfit(m);
    check('C1 未结转月可正常结转', r1.ok === true, r1.msg || ('net=' + (r1.net || 0).toFixed(2)));
    if (r1.ok) {
      check('C2 结转后二次结转被拒', S.carryForwardProfit(m).ok === false);
      const n = S.periodProfitNet(m);
      check('C3 结转后损益净额归零', Math.abs(n.rev) < 0.005 && Math.abs(n.exp) < 0.005,
        '收=' + n.rev.toFixed(2) + ' 费=' + n.exp.toFixed(2));
      const st = S.carryForwardState(m);
      check('C4 新凭证带 kind=carryPL', st.vouchers.some(function (v) { return v.kind === 'carryPL'; }));
    }
  } else {
    console.log('  (无未结转月份，跳过 C)');
  }

  // ---- D. 12 月结账 ----
  const decs = ms.filter(function (m) { return m.slice(5, 7) === '12' && !S.isPeriodClosed(m); });
  decs.forEach(function (m) {
    const cl = S.settleChecklist(m);
    const fails = cl.filter(function (c) { return c.status === 'fail'; });
    check('D1 ' + m + ' 结账检查无 fail 项', fails.length === 0,
      fails.map(function (c) { return c.label + '(' + c.tip + ')'; }).join('；'));
    if (!fails.length) {
      const rr = S.closePeriod(m, { force: true });
      check('D2 ' + m + ' 可成功结账', rr.ok === true, rr.msg || '');
    }
  });
  if (!decs.length) console.log('  (无未结账的 12 月，跳过 D)');

  // ---- E. 不变量 ----
  let bad = 0;
  (S.state.vouchers || []).forEach(function (v) {
    if (v.deleted === 'y') return;
    if (!S.voucherBalance(v.entries).balanced) bad++;
  });
  check('E1 全部凭证借贷平衡', bad === 0, '不平=' + bad);
  const lastM = ms[ms.length - 1];
  if (lastM) {
    let dr = 0, cr = 0;
    S.generalLedger(lastM).forEach(function (r) { if (r.code.length <= 4) { dr += r.endDr; cr += r.endCr; } });
    check('E2 ' + lastM + ' 试算平衡', Math.abs(dr - cr) < 0.005, '差=' + (dr - cr).toFixed(2));
    const bs = S.balanceSheet(lastM);
    check('E3 ' + lastM + ' 资产=负债+权益', Math.abs(bs.totalAsset - bs.totalAll) < 0.005,
      '差=' + (bs.totalAsset - bs.totalAll).toFixed(2));
  }
}

fs.readdirSync(BOOKS_DIR).filter(function (f) { return /\.json$/.test(f); }).forEach(runBook);

console.log('\n================================================================');
console.log('场景验收：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log(fail === 0 ? '结论：✅ 全部通过' : '结论：❌ 存在失败项');
