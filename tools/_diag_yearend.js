#!/usr/bin/env node
/* _diag_yearend.js — 诊断 12 月「结转本年利润」检查项是否仍阻塞结账
 * 关注：金蝶导入账套 12 月 3103 是否有余额、是否有年结凭证、yearend 检查项状态。
 * 只读。
 */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const BOOKS_DIR = '/Users/chen/Library/Application Support/心中有数/books';
const files = fs.readdirSync(BOOKS_DIR).filter(function (f) { return /\.json$/.test(f); });

files.forEach(function (f) {
  const raw = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, f), 'utf8'));
  if (((raw.vouchers || []).length) < 10) return;   // 跳过空/演示账套
  S.state = JSON.parse(JSON.stringify(raw));
  S.bookId = f; S._glCache = {};
  S.normalizeState();
  const vs = (S.state.vouchers || []).filter(function (v) { return v.deleted !== 'y'; });
  const months = {};
  vs.forEach(function (v) { const m = (v.date || '').slice(0, 7); if (m) months[m] = 1; });
  const decs = Object.keys(months).filter(function (m) { return m.slice(5, 7) === '12'; }).sort();

  console.log('\n===== ' + f + ' =====');
  console.log('  已结账期间：' + JSON.stringify((S.state.closedPeriods || []).slice().sort()));
  console.log('  12 月期间：' + JSON.stringify(decs));

  decs.forEach(function (m) {
    const gl = S.generalLedger(m);
    const p3103 = gl.filter(function (r) { return r.code === '3103'; })[0];
    const p3104 = gl.filter(function (r) { return r.code === '3104'; })[0];
    const bal3103 = p3103 ? (p3103.normal === 'dr' ? p3103.endDr - p3103.endCr : p3103.endCr - p3103.endDr) : null;
    const bal3104 = p3104 ? (p3104.normal === 'dr' ? p3104.endDr - p3104.endCr : p3104.endCr - p3104.endDr) : null;
    const yeVch = S.periodVouchersOfKind(m, 'carryYE');
    const cl = S.settleChecklist(m);
    const ye = cl.filter(function (c) { return c.key === 'yearend'; })[0];
    const fails = cl.filter(function (c) { return c.status === 'fail'; });
    const warns = cl.filter(function (c) { return c.status === 'warn'; });
    console.log('  ' + m + '：');
    console.log('     3103 余额=' + (bal3103 == null ? '科目缺失' : bal3103.toFixed(2)) +
                '   3104 余额=' + (bal3104 == null ? '科目缺失' : bal3104.toFixed(2)));
    console.log('     年结凭证(kind=carryYE)=' + yeVch.length + ' 张');
    console.log('     yearend 检查项：' + (ye ? (ye.status + ' — ' + ye.tip) : '(不适用)'));
    console.log('     全部 fail 项：' + (fails.length ? fails.map(function (c) { return c.label + '(' + c.tip + ')'; }).join('；') : '无'));
    console.log('     全部 warn 项：' + (warns.length ? warns.map(function (c) { return c.label; }).join('；') : '无'));
  });
});
