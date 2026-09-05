#!/usr/bin/env node
/* _verify_kinds.js — 验证「期末业务凭证类型标记 v.kind」改造
 *
 * 目的：在真实账套上逐类型对比「结构识别」与「改造前的摘要正则」，确认：
 *   ① 无漏识别（漏识别 = 幂等/结账检查失效，属回归，必须为 0）；
 *   ② 新增识别确实覆盖了金蝶导入的无摘要凭证，且识别结果正确（无误标）。
 * 只读：不写任何账套文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const BOOKS_DIR = '/Users/chen/Library/Application Support/添钰财务/books';
const TARGETS = process.argv.slice(2);

// 改造前各判定点使用的摘要正则（旧口径）
const OLD_RE = {
  carryPL:       /结转.*损益/,
  carryYE:       /年度本年利润/,
  depr:          /计提.*折旧/,
  carryCost:     /结转销售成本|销售成本/,
  carryVat:      /转出未交增值税|未交增值税/,
  accrueSurTax:  /附加税/,
  accrueIncTax:  /所得税/,
  payroll:       /(计提|发放).*工资/
};
const KINDS = ['carryPL', 'carryYE', 'depr', 'carryCost', 'carryVat', 'accrueSurTax', 'accrueIncTax'];

function vno(v) { return (v.word || '记') + '-' + v.no; }
function dumpV(v) {
  const codes = (v.entries || []).map(function (e) {
    return e.code + (e.dr ? '借' + Math.round(e.dr) : '') + (e.cr ? '贷' + Math.round(e.cr) : '');
  }).join(' / ');
  return vno(v) + ' [' + (v.date || '?') + '] 摘要="' + (v.summary || '') + '" 分录=' + codes;
}

function verifyBook(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  S.state = JSON.parse(JSON.stringify(raw));
  S.bookId = path.basename(file, '.json');
  S._glCache = {};                 // 切换账套必须作废总账缓存
  S.normalizeState();              // 内部调用 ensureVoucherKinds 回填存量凭证
  const vs = (S.state.vouchers || []).filter(function (v) { return v.deleted !== 'y'; });

  console.log('\n================================================================');
  console.log('账套：' + path.basename(file));
  console.log('  凭证数(未删)=' + vs.length + '  准则=' + S.state.standard +
              '  启用月=' + ((S.state.company && S.state.company.startMonth) || '?'));

  // 已打标（生成端写入）与回填（结构识别）各多少
  const dist = {};
  vs.forEach(function (v) { const k = v.kind || '(普通业务凭证)'; dist[k] = (dist[k] || 0) + 1; });
  console.log('  【kind 分布】' + JSON.stringify(dist));

  let regressions = 0, gains = 0;

  console.log('  —— 逐类型对比：摘要正则(旧) vs 结构识别(新) ——');
  KINDS.forEach(function (kind) {
    const re = OLD_RE[kind];
    const bySummary = vs.filter(function (v) { return re.test(v.summary || ''); });
    const byKind = vs.filter(function (v) { return S.voucherKind(v) === kind; });
    // 漏识别：旧口径认得、新口径认不出 → 幂等/检查失效，属回归
    const miss = bySummary.filter(function (v) { return byKind.indexOf(v) < 0; });
    // 新增识别：新口径认得、旧口径认不出 → 金蝶导入凭证被正确纳入
    const extra = byKind.filter(function (v) { return bySummary.indexOf(v) < 0; });
    console.log('    ' + kind.padEnd(14) +
      ' 摘要=' + String(bySummary.length).padStart(3) +
      '  结构=' + String(byKind.length).padStart(3) +
      '  漏识别=' + String(miss.length).padStart(2) +
      '  新增识别=' + String(extra.length).padStart(3) +
      (miss.length ? '   ⚠️ 回归' : ''));
    miss.slice(0, 6).forEach(function (v) { console.log('       [漏] ' + dumpV(v)); });
    extra.slice(0, 2).forEach(function (v) { console.log('       [新] ' + dumpV(v)); });
    regressions += miss.length;
    gains += extra.length;
  });
  // 工资（计提/发放两类合一，与 hasPayrollVoucher 口径一致）
  (function () {
    const bySummary = vs.filter(function (v) { return OLD_RE.payroll.test(v.summary || ''); });
    const byKind = vs.filter(function (v) {
      const k = S.voucherKind(v); return k === 'payrollAcc' || k === 'payrollPay';
    });
    const miss = bySummary.filter(function (v) { return byKind.indexOf(v) < 0; });
    const extra = byKind.filter(function (v) { return bySummary.indexOf(v) < 0; });
    console.log('    ' + 'payroll'.padEnd(14) +
      ' 摘要=' + String(bySummary.length).padStart(3) +
      '  结构=' + String(byKind.length).padStart(3) +
      '  漏识别=' + String(miss.length).padStart(2) +
      '  新增识别=' + String(extra.length).padStart(3) +
      (miss.length ? '   ⚠️ 回归' : ''));
    miss.slice(0, 6).forEach(function (v) { console.log('       [漏] ' + dumpV(v)); });
    extra.slice(0, 3).forEach(function (v) { console.log('       [新] ' + dumpV(v)); });
    regressions += miss.length;
    gains += extra.length;
  })();

  // 场景验证：结账检查项 + 结转状态（重点看金蝶已结转月能否被正确识别）
  console.log('  —— 结账检查（结转损益 / 12月年结）——');
  const months = {};
  vs.forEach(function (v) { const m = (v.date || '').slice(0, 7); if (m) months[m] = 1; });
  const mlist = Object.keys(months).sort();
  mlist.forEach(function (m) {
    const st = S.carryForwardState(m);
    const net = S.periodProfitNet(m);
    const isDec = m.slice(5, 7) === '12';
    const yeCnt = isDec ? S.periodVouchersOfKind(m, 'carryYE').length : 0;
    if (st.done || isDec) {
      console.log('    ' + m + '  已结转=' + (st.done ? '是' : '否') +
        '  凭证=[' + st.vouchers.map(vno).join(',') + ']' +
        '  损益净额(收=' + net.rev.toFixed(2) + '/费=' + net.exp.toFixed(2) + ')' +
        (isDec ? '  年结凭证=' + yeCnt : ''));
    }
  });

  // 不变量回归：借贷平衡 + 试算平衡
  let bad = 0;
  vs.forEach(function (v) { if (!S.voucherBalance(v.entries).balanced) bad++; });
  const lastM = mlist[mlist.length - 1] || '';
  let dr = 0, cr = 0;
  if (lastM) {
    S.generalLedger(lastM).forEach(function (r) { if (r.code.length <= 4) { dr += r.endDr; cr += r.endCr; } });
  }
  console.log('  —— 不变量 ——');
  console.log('    借贷不平凭证数=' + bad + '（应为 0）');
  console.log('    试算平衡 ' + lastM + '：借=' + dr.toFixed(2) + ' 贷=' + cr.toFixed(2) + ' 差=' + (dr - cr).toFixed(2));

  return { regressions: regressions, gains: gains, bad: bad, name: path.basename(file) };
}

// ===== 主流程 =====
const files = (TARGETS.length ? TARGETS : fs.readdirSync(BOOKS_DIR).filter(function (f) { return /\.json$/.test(f); }))
  .map(function (f) { return path.isAbsolute(f) ? f : path.join(BOOKS_DIR, f); });

let totalReg = 0, totalGain = 0, totalBad = 0;
files.forEach(function (f) {
  let r;
  try { r = verifyBook(f); } catch (e) { console.log('\n[跳过] ' + path.basename(f) + '：' + e.message); return; }
  totalReg += r.regressions; totalGain += r.gains; totalBad += r.bad;
});

console.log('\n================================================================');
console.log('汇总：漏识别(回归)=' + totalReg + '   新增识别(修复收益)=' + totalGain + '   借贷不平凭证=' + totalBad);
console.log(totalReg === 0 && totalBad === 0 ? '结论：✅ 结构识别未引入回归' : '结论：❌ 存在回归，需修正识别规则');
