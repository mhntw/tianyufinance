'use strict';
/* ============================================================
 * verify_asset_depr_reconcile.js —— 固定资产「卡片锚点 vs 总账累计折旧」只读核对
 *
 * 【要回答的问题】资产台账里常出现「卡片 periodUsed / accumDepr 与账上已提不符」的卡
 *   （典型：直接录入、或用手工/结转模板提了折旧但没回写卡片锚点）。这类卡在页面显示上
 *   可能仍对（_accumDeprAt 会按 acq+periodUsed 卷算），但内置「计提折旧」路径
 *   （assetDeprDue 用 periodUsed 当"已提期数"计数器）会从落后锚点继续提 → 重复/滞后。
 *
 * 【本脚本做什么（只读，不改任何数据）】
 *   1) 账套级：Σ 各卡「按锚点卷算到 refMonth 的累计折旧」 vs 总账「累计折旧」期末余额。
 *      refMonth = 账套内最后一个「含累计折旧贷方凭证」的月份（即折旧实际记到哪个月）。
 *   2) 卡片级：逐卡列出 acq / 月折旧 / accumDeprBegin / periodUsed / 锚点月 / 已过月 / 滞后，
 *      滞后 = min(已过月, 总月数) − periodUsed。滞后>0 即"内置计提锚点落后"（候选 stale）。
 *      单卡「账上已提」无法从凭证精确拆出（折旧凭证无到卡的可靠关联），故只在账套级对平，
 *      卡片级只报锚点状态，供人工判断，不臆断单卡金额。
 *
 * 【为什么每个账套用全新 store 实例】store 是单例、内部有缓存；同一进程里只换 S.state
 *   不换实例，第二个账套会沿用第一个账套的缓存（实测总账余额串账）。这里清 require 缓存重载。
 *
 * 无账套目录 / 无账套 / 无折旧凭证 → 打印「跳过：」并 exit 0（run-all 视为跳过）。
 * 账套级差额超容差 → exit 1。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const STORE_PATH = path.join(ROOT, 'js', 'store.js');
const STORAGE_PATH = path.join(ROOT, 'js', 'storage.js');

// 全局 shim（store 需要）
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;

function freshStore() {
  delete require.cache[STORE_PATH];
  delete require.cache[STORAGE_PATH];
  global.S = undefined;
  require(STORAGE_PATH);
  const exported = require(STORE_PATH);
  return { S: global.S, U: exported.util };
}

function monthsBetween(a, b) {
  if (!a || !b) return 0;
  return ((+b.slice(0, 4)) * 12 + (+b.slice(5, 7))) - ((+a.slice(0, 4)) * 12 + (+a.slice(5, 7)));
}
function addMonths(ym, n) {
  if (!ym) return '';
  let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
  return Math.floor(y + m / 12) + '-' + String((((m % 12) + 12) % 12) + 1).padStart(2, '0');
}

/* 复刻 Asset.js 的 _deprAnchorMonth / _accumDeprAt（同口径，勿独立改算法） */
function deprAnchorMonth(fa) {
  if (fa.deprMonth) return String(fa.deprMonth);
  const acq = String(fa.acqDate || '').slice(0, 7);
  return acq ? addMonths(acq, Number(fa.periodUsed || 0)) : '';
}
function accumDeprAt(fa, month, md, num) {
  const begin = num(fa.accumDeprBegin);
  const anchor = deprAnchorMonth(fa);
  if (!anchor || !month || !md) return num(fa.accumDepr) || begin;
  const d = monthsBetween(anchor, month);
  if (!d) return begin;
  let v = begin + md * d;
  if (v < 0) v = 0;
  const cap = Math.max(0, num(fa.original) - num(fa.salvage));
  if (cap > 0 && v > cap) v = cap;
  return v;
}

function hasAccDepr(v) {
  return (v.entries || []).some(e => String(e.name || '').indexOf('累计折旧') >= 0 && Number(e.cr) > 0);
}

function booksDir() {
  return process.env.TY_BOOKS_DIR || path.join(process.env.HOME || '', 'Library', 'Application Support', '添钰财务', 'books');
}

function analyzeOne(bf, res) {
  const { S, U } = freshStore();
  const num = U.num, AMT_SCALE = U.AMT_SCALE, Y = v => (Number(v) || 0) / AMT_SCALE;

  S.state = res; if (S.normalizeState) S.normalizeState();
  const vouchers = S.state.vouchers || [];

  // refMonth = 最后一个「含累计折旧贷方凭证」的月份（折旧实际记到哪个月）
  let refMonth = '';
  vouchers.forEach(v => { if (hasAccDepr(v)) { const m = String(v.date || '').slice(0, 7); if (m > refMonth) refMonth = m; } });
  if (!refMonth) { console.log('  skip（无折旧凭证）：' + bf); return 'SKIP'; }

  const cards = (S.state.fixedAssets || []).filter(function (fa) {
    if (fa.status === '清理') return false;
    const acqM = fa.acqDate ? String(fa.acqDate).slice(0, 7) : '';
    return !(acqM && acqM > refMonth);
  });

  let cardTotal = 0;
  const rows = [];
  cards.forEach(function (fa) {
    const md = S.assetMonthlyDepr(fa);
    const rf = accumDeprAt(fa, refMonth, md, num);
    cardTotal += rf;
    const acqM = String(fa.acqDate || '').slice(0, 7);
    const totalMonths = num(fa.life) * 12;
    const elapsed = acqM ? monthsBetween(acqM, refMonth) : 0;
    const effElapsed = Math.max(0, Math.min(elapsed, totalMonths));
    const lag = effElapsed - num(fa.periodUsed || 0);
    rows.push({ fa, md, rf, acqM, anchor: deprAnchorMonth(fa), periodUsed: num(fa.periodUsed || 0), effElapsed, lag });
  });

  let depCode = '1602';
  try { const r = S.subjectRole && S.subjectRole('ACC_DEPR'); if (r && r.code) depCode = String(r.code); } catch (e) {}
  let ledgerEnd = null;
  try {
    const gl = S.generalLedger(refMonth) || [];
    const row = gl.filter(x => String(x.code) === String(depCode))[0];
    if (row) ledgerEnd = S.displayBalance(num(row.endDr) - num(row.endCr), row.normal).amount;
  } catch (e) {}
  const diff = ledgerEnd == null ? null : cardTotal - ledgerEnd;
  const tol = (cards.length + 1) * (AMT_SCALE / 100);
  const ok = diff != null && Math.abs(diff) <= tol;

  console.log('');
  console.log('账套：' + bf + '   refMonth(最后折旧月)=' + refMonth + '   卡片 ' + cards.length + ' 张');
  console.log('  卡片卷算累计 = ' + Y(cardTotal).toFixed(2) +
    '   总账' + depCode + '期末 = ' + (ledgerEnd == null ? '(无此科目)' : Y(ledgerEnd).toFixed(2)) +
    '   差 = ' + (diff == null ? '—' : Y(diff).toFixed(2)) + '   容差 ' + Y(tol).toFixed(2) +
    (ok ? '   ✓ 对平' : '   ✗ 不符'));
  console.log('  卡片级锚点（滞后>0 标注 *；滞后 = min(已过月,总月数) − periodUsed）：');
  console.log('    ' + '编码'.padEnd(10) + '名称'.padEnd(16) + '购置月'.padEnd(9) + '月折旧'.padStart(11) +
    '锚点月'.padStart(12) + '已过月'.padStart(8) + 'periodUsed'.padStart(12) + '滞后'.padStart(6) + '  滚算累计');
  rows.forEach(function (r) {
    const mark = r.lag > 0 ? '*' : ' ';
    console.log('    ' + String(r.fa.code || '').padEnd(10) + String(r.fa.name || '').slice(0, 14).padEnd(16) +
      String(r.acqM || '').padEnd(9) + Y(r.md).toFixed(2).padStart(11) + String(r.anchor || '').padStart(12) +
      String(r.effElapsed).padStart(8) + String(r.periodUsed).padStart(12) + String(r.lag).padStart(6) +
      '  ' + Y(r.rf).toFixed(2).padStart(12) + mark);
  });
  const lagged = rows.filter(r => r.lag > 0);
  console.log('  滞后卡 ' + lagged.length + ' / ' + rows.length + ' 张' +
    (lagged.length ? '：' + lagged.map(r => r.fa.code + '(滞后' + r.lag + '月,锚点' + (r.anchor || '?') + ')').join(' ') : ''));
  console.log('  注：单卡「账上已提」无法从凭证精确拆出（折旧凭证无到卡的可靠关联），故仅账套级对平；');
  console.log('      卡片级「滞后>0」表示内置计提锚点落后，若再跑内置「计提折旧」可能重复/滞后，需人工确认。');

  return ok ? 'OK' : 'BAD';
}

function main() {
  const dir = booksDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.indexOf('.bak') < 0);
  } catch (e) {
    console.log('跳过：找不到账套目录 ' + dir);
    return 0;
  }
  if (!files.length) {
    console.log('跳过：账套目录下没有 .json 账套 ' + dir);
    return 0;
  }

  let pass = 0, bad = 0, skip = 0;
  files.forEach(function (bf) {
    let res;
    try { res = JSON.parse(fs.readFileSync(path.join(dir, bf), 'utf8')); } catch (e) { console.log('  ! ' + bf + ' 解析失败，跳过'); skip++; return; }
    const r = analyzeOne(bf, res);
    if (r === 'OK') pass++; else if (r === 'BAD') bad++; else skip++;
  });

  console.log('');
  if (!pass && !bad) { console.log('跳过：没有可核对的账套（均无折旧凭证）'); return 0; }
  console.log('结果：' + (pass + bad) + ' 本账套可核对，' + pass + ' 通过 / ' + bad + ' 不符' + (skip ? '（另有 ' + skip + ' 本跳过）' : '') +
    '   （卡片卷算累计 vs 总账累计折旧）');
  if (bad) console.log('✗ 有账套卡片卷算累计与总账累计折旧不符');
  else console.log('✓ 通过：卡片卷算累计与总账累计折旧一致');
  return bad ? 1 : 0;
}

process.exit(main());
