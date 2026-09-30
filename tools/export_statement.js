#!/usr/bin/env node
/**
 * export_statement.js — 从 ty 账套导出报表为 JSON（供对照工具使用）
 *
 * 用法：
 *   node tools/export_statement.js <账套JSON路径> <输出目录>
 *   node tools/export_statement.js            # 默认取最新账套，输出到 tools/_out/
 *
 * 导出文件：
 *   <bookId>_generalLedger_<month>.json   科目余额表（全部科目，含期初/本期/期末/本年累计）
 *   <bookId>_balanceSheet_<month>.json    资产负债表
 *   <bookId>_profitStatement_<month>.json 利润表
 *   <bookId>_cashFlow_<month>.json        现金流量表
 *
 * 【单位契约】对外导出的一切金额都是「元」（2 位小数）—— store 内部是 0.0001 元
 *   定点整数，出口统一经 util.yuan() 换回「元」；对照工具 contrast_kis.js 即按元比对。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- mock 浏览器环境 ---------- */
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };

const storePath = path.join(__dirname, '..', 'js', 'store.js');
const storeMod = require(storePath);
const S = storeMod.store;
const U = storeMod.util;                        // 定点换算单点：amt / yuan / AMT_SCALE
S.persist = function () { };
S.addLog = function () { };
S.backupNow = function () { return Promise.resolve(true); };

/* 【2026-09-30 定点化】store 取出的金额是**内部定点整数**（0.0001 元），而本工具对外
   契约是「元」。故所有金额出口必须经 yuan() 换回「元」——绝不能把整数直接当元写出去。
   （这正是定点化后本文件一度失真的原因：旧 round2 对整数是恒等，整数被原样写成了"元"，
     使 contrast_kis.js 按元比对时整体差 10000 倍。）
   比例只认 util.AMT_SCALE 单点，不在此处内联 10000。 */
function toYuan(n) { return U.round2(U.yuan(n)); }
/* 资产负债表分组结构里也有金额（items[].end/year、组小计 subEnd/subYear），
   与合计同口径一并换回「元」，避免同一份导出里两种单位并存。 */
function convBsGroups(gs) {
  const out = {};
  Object.keys(gs || {}).forEach(k => {
    const g = gs[k] || {};
    out[k] = {
      title: g.title, subtotal: g.subtotal,
      subEnd: toYuan(g.subEnd), subYear: toYuan(g.subYear),
      items: (g.items || []).map(it => Object.assign({}, it, { end: toYuan(it.end), year: toYuan(it.year) }))
    };
  });
  return out;
}

function findBook(arg) {
  if (arg && fs.existsSync(arg)) return arg;
  const dir = path.join(process.env.HOME, 'Library', 'Application Support', '添钰财务', 'books');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({
    name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs
  })).sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].path : null;
}

function main() {
  const bookArg = process.argv[2];
  const outDir = process.argv[3] || path.join(__dirname, '_out');
  const bookPath = findBook(bookArg);
  if (!bookPath) { console.error('未找到账套'); process.exit(1); }

  fs.mkdirSync(outDir, { recursive: true });

  const data = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
  S.state = data;
  /* 磁盘账套多为 v5（金额=「元」）：必须先迁到 v6（定点整数）再取数，
     否则 generalLedger 等会拿「元」值当整数算（整体差 10000 倍）。
     migrateAmountsToV6 自带幂等门（已是 v6 直接返回），对 v6 账套无副作用。 */
  if (data.schemaVersion !== S.SCHEMA_VERSION) S.migrateAmountsToV6(S.state);
  S.bookId = data.id || path.basename(bookPath, '.json');

  // 确定所有有凭证的月份
  const months = {};
  (data.vouchers || []).forEach(v => {
    const m = (v.date || '').slice(0, 7);
    if (m) months[m] = (months[m] || 0) + 1;
  });
  const monthList = Object.keys(months).sort();

  console.log('账套：' + (data.company && data.company.name || S.bookId));
  console.log('期间：' + monthList.join(', '));
  console.log('输出：' + outDir);
  console.log('');

  let count = 0;
  monthList.forEach(m => {
    // 科目余额表
    const gl = S.generalLedger(m);
    const glOut = gl.map(r => ({
      code: r.code, name: r.name, cls: r.cls, normal: r.normal,
      obDr: toYuan(r.obDr), obCr: toYuan(r.obCr),
      periodDr: toYuan(r.periodDr), periodCr: toYuan(r.periodCr),
      endDr: toYuan(r.endDr), endCr: toYuan(r.endCr),
      balance: toYuan(r.balance), dir: r.dir,
      ytdDr: toYuan(r.ytdDr), ytdCr: toYuan(r.ytdCr)
    }));
    fs.writeFileSync(path.join(outDir, S.bookId + '_generalLedger_' + m + '.json'),
      JSON.stringify({ month: m, rows: glOut }, null, 2));
    count++;

    // 资产负债表
    const bs = S.balanceSheet(m);
    fs.writeFileSync(path.join(outDir, S.bookId + '_balanceSheet_' + m + '.json'),
      JSON.stringify({
        month: m,
        totalAsset: toYuan(bs.totalAsset),
        totalLiability: toYuan(bs.totalLiability),
        totalEquity: toYuan(bs.totalEquity),
        totalAll: toYuan(bs.totalAll),
        groups: convBsGroups(bs.groups)
      }, null, 2));
    count++;

    // 利润表
    const pl = S.profitStatement(m);
    fs.writeFileSync(path.join(outDir, S.bookId + '_profitStatement_' + m + '.json'),
      JSON.stringify({
        month: m,
        totalRevenue: toYuan(pl.totalRevenue),
        totalExpense: toYuan(pl.totalExpense),
        netProfit: toYuan(pl.netProfit),
        items: pl.items.map(it => ({ code: it.code, name: it.name, cur: toYuan(it.cur), ytd: toYuan(it.ytd), cls: it._cls }))
      }, null, 2));
    count++;

    // 现金流量表
    const cf = S.cashFlow(m);
    fs.writeFileSync(path.join(outDir, S.bookId + '_cashFlow_' + m + '.json'),
      JSON.stringify({
        month: m,
        opening: toYuan(cf.opening),
        ending: toYuan(cf.ending),
        operating: toYuan(cf.operating),
        investing: toYuan(cf.investing),
        financing: toYuan(cf.financing),
        exchange: toYuan(cf.exchange),
        items: Object.keys(cf.items).reduce((acc, k) => { acc[k] = toYuan(cf.items[k]); return acc; }, {}),
        ytd: Object.keys(cf.ytd).reduce((acc, k) => { acc[k] = toYuan(cf.ytd[k]); return acc; }, {})
      }, null, 2));
    count++;
  });

  console.log('已导出 ' + count + ' 个文件到 ' + outDir);
}

main();
