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
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- mock 浏览器环境 ---------- */
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };

const storePath = path.join(__dirname, '..', 'js', 'store.js');
const S = require(storePath).store;
S.persist = function () { };
S.addLog = function () { };
S.backupNow = function () { return Promise.resolve(true); };

function round2(n) { return Math.round(Number(n) * 100) / 100; }

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
      obDr: round2(r.obDr), obCr: round2(r.obCr),
      periodDr: round2(r.periodDr), periodCr: round2(r.periodCr),
      endDr: round2(r.endDr), endCr: round2(r.endCr),
      balance: round2(r.balance), dir: r.dir,
      ytdDr: round2(r.ytdDr), ytdCr: round2(r.ytdCr)
    }));
    fs.writeFileSync(path.join(outDir, S.bookId + '_generalLedger_' + m + '.json'),
      JSON.stringify({ month: m, rows: glOut }, null, 2));
    count++;

    // 资产负债表
    const bs = S.balanceSheet(m);
    fs.writeFileSync(path.join(outDir, S.bookId + '_balanceSheet_' + m + '.json'),
      JSON.stringify({
        month: m,
        totalAsset: round2(bs.totalAsset),
        totalLiability: round2(bs.totalLiability),
        totalEquity: round2(bs.totalEquity),
        totalAll: round2(bs.totalAll),
        groups: bs.groups
      }, null, 2));
    count++;

    // 利润表
    const pl = S.profitStatement(m);
    fs.writeFileSync(path.join(outDir, S.bookId + '_profitStatement_' + m + '.json'),
      JSON.stringify({
        month: m,
        totalRevenue: round2(pl.totalRevenue),
        totalExpense: round2(pl.totalExpense),
        netProfit: round2(pl.netProfit),
        items: pl.items.map(it => ({ code: it.code, name: it.name, cur: round2(it.cur), ytd: round2(it.ytd), cls: it._cls }))
      }, null, 2));
    count++;

    // 现金流量表
    const cf = S.cashFlow(m);
    fs.writeFileSync(path.join(outDir, S.bookId + '_cashFlow_' + m + '.json'),
      JSON.stringify({
        month: m,
        opening: round2(cf.opening),
        ending: round2(cf.ending),
        operating: round2(cf.operating),
        investing: round2(cf.investing),
        financing: round2(cf.financing),
        exchange: round2(cf.exchange),
        items: Object.keys(cf.items).reduce((acc, k) => { acc[k] = round2(cf.items[k]); return acc; }, {}),
        ytd: Object.keys(cf.ytd).reduce((acc, k) => { acc[k] = round2(cf.ytd[k]); return acc; }, {})
      }, null, 2));
    count++;
  });

  console.log('已导出 ' + count + ' 个文件到 ' + outDir);
}

main();
