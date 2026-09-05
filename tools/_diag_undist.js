#!/usr/bin/env node
/* _diag_undist.js — 逐月定位「未分配利润勾稽」差异来源
 * 对目标年逐月输出：3103+3104 较上年底的累计变动 vs Σ净利−分配的累计期望，
 * 找出差异在哪个月份产生；对该月列出 3103/3104 全部分录凭证，供定位到具体凭证。
 * 只读。用法：node tools/_diag_undist.js <账套路径> [年份…]
 */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const file = process.argv[2];
const wantYears = process.argv.slice(3);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
S.state = data; S.bookId = 'undist'; S._glCache = {};

const mm = {};
(data.vouchers || []).forEach(v => { const k = (v.date || '').slice(0, 7); if (k) mm[k] = 1; });
const monthList = Object.keys(mm).sort();
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function balOf(m, code) {
  // 与 _deep_audit 同口径：贷正（权益 3103/3104 normal=cr，取 endCr-endDr）
  const gl = S.generalLedger(m);
  const r = gl.find(x => x.code === code);
  return r ? (num(r.endCr) - num(r.endDr)) : 0;
}
function dumpV(m, tag) {
  console.log('\n  ── ' + m + ' 期间含 3103/3104 分录的凭证（' + tag + '）──');
  S.periodVouchers(m).forEach(v => {
    const hits = (v.entries || []).filter(e => String(e.code).indexOf('3103') === 0 || String(e.code).indexOf('3104') === 0);
    if (!hits.length) return;
    const det = hits.map(e => e.code + ' ' + (e.dr ? '借' + num(e.dr).toFixed(2) : '') + (e.cr ? '贷' + num(e.cr).toFixed(2) : '')).join(' / ');
    const other = (v.entries || []).filter(e => !(String(e.code).indexOf('3103') === 0 || String(e.code).indexOf('3104') === 0))
      .map(e => e.code + (e.dr ? '借' + num(e.dr).toFixed(0) : '') + (e.cr ? '贷' + num(e.cr).toFixed(0) : '')).join(' ');
    console.log('    ' + (v.word || '记') + '-' + v.no + ' [' + v.date + '] 摘要="' + (v.summary || '') + '" kind=' + (v.kind || '-') +
      ' | 权益侧: ' + det + (other ? ' | 对方: ' + other : ''));
  });
}

const years = wantYears.length ? wantYears
  : [...new Set(monthList.map(m => m.slice(0, 4)))].sort();

years.forEach(y => {
  const ms = monthList.filter(m => m.startsWith(y));
  if (!ms.length) { console.log(y + '：无月份'); return; }
  const closedMs = ms.filter(m => (data.closedPeriods || []).includes(m));
  const lastClosed = closedMs.length ? closedMs[closedMs.length - 1] : ms[ms.length - 1];
  // 上年基准：上一年最后一个有凭证月（脚本现口径）
  const prevLast = monthList.filter(m => m.slice(0, 4) < y).pop();
  const base = prevLast ? balOf(prevLast, '3103') + balOf(prevLast, '3104') : 0;
  console.log('\n========================================');
  console.log(y + '（截至 ' + lastClosed + '，上年基准月=' + (prevLast || '无') + '，基准 3103+3104 贷余=' + (-base).toFixed(2) + '）');
  console.log('  月    3103+3104累计变动       Σ净利累计    Σ分配累计     期望累计        差(变动-期望)');

  let runDelta = 0, runNet = 0, runDist = 0, prevDiff = 0;
  let breakout = null;
  ms.forEach(m => {
    if (m > lastClosed) return;
    const end = balOf(m, '3103') + balOf(m, '3104');
    runDelta = end - base;
    runNet += S.profitStatement(m).netProfit;
    // 当月 3104 借方（分配）
    let d = 0;
    S.periodVouchers(m).forEach(v => {
      if (v.entries.some(e => String(e.code).indexOf('3104') === 0 && num(e.dr) > 0))
        v.entries.forEach(e => { if (String(e.code).indexOf('3104') === 0) d += num(e.dr); });
    });
    runDist += d;
    const exp = runNet - runDist;
    const diff = runDelta - exp;
    const step = diff - prevDiff;
    console.log('  ' + m + '   ' + runDelta.toFixed(2) + '   ' + runNet.toFixed(2) +
      '   ' + runDist.toFixed(2) + '   ' + exp.toFixed(2) + '   ' + diff.toFixed(2) + (Math.abs(step) > 0.005 ? '   ← 本月新增差异 ' + step.toFixed(2) : ''));
    if (!breakout && Math.abs(step) > 0.005) breakout = { m: m, step: step };
    prevDiff = diff;
  });
  if (breakout) dumpV(breakout.m, '差异产生月 ' + breakout.step.toFixed(2));
  // 也列出期初月/上年末月是否有相关
  if (prevLast && monthsHave(prevLast)) dumpV(prevLast, '上年基准月');
  function monthsHave(m) { return !!mm[m]; }
});
