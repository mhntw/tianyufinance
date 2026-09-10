#!/usr/bin/env node
/* ============================================================
 * 导入完整性对账：源文件 .ais  vs  导入后的账套 JSON
 *
 * 目的：回答「账上看到的异常，会不会是导入时丢数据造成的？」
 * 做法：对同一套账，分别从 .ais（金蝶源）与 books/*.json（导入结果）统计
 *       凭证笔数 / 分录条数 / 借贷合计 / 科目数，逐项比对。
 *       任一指标不一致，说明导入环节确实丢了东西。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) {}
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'kis-import.js'), 'utf8'));
const KisImport = global.KisImport;

const AIS = '/Users/chen/Desktop/金蝶账套 ais';
const BOOKS = '/Users/chen/Library/Application Support/添钰财务/books';

// 账套名 -> { 年文件, 账套 json }
const CASES = [
  { name: '绅蓝之星', years: [2024, 2025, 2026], book: '绅蓝之星_合并_20260908_1788867828204.json' },
  { name: '添钰来客', years: [2025, 2026], book: '添钰来客_合并_20260908_1788869265606.json' }
];

function makeFile(p) {
  var buf = fs.readFileSync(p);
  return { name: path.basename(p), arrayBuffer: function () { return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); } };
}
function statFromLedger(L) {
  var vouchers = (L.vouchers || []).length, entries = 0, dr = 0, cr = 0;
  (L.vouchers || []).forEach(function (v) {
    (v.entries || []).forEach(function (e) {
      entries++; dr += (e.dr || 0); cr += (e.cr || 0);
    });
  });
  return { vouchers: vouchers, entries: entries, dr: dr, cr: cr, subjects: (L.subjects || []).length };
}
function add(a, b) {
  return { vouchers: a.vouchers + b.vouchers, entries: a.entries + b.entries, dr: a.dr + b.dr, cr: a.cr + b.cr, subjects: Math.max(a.subjects, b.subjects) };
}
function fmt(n) { return Number(n).toFixed(2); }

CASES.reduce(function (chain, c) {
  return chain.then(function () {
    var files = c.years.map(function (y) { return path.join(AIS, c.name + '_' + y + '年_金蝶KIS格式.ais'); });
    return Promise.all(files.map(function (f) { return KisImport.parse(makeFile(f)); })).then(function (rs) {
      var src = { vouchers: 0, entries: 0, dr: 0, cr: 0, subjects: 0 };
      rs.forEach(function (r, i) {
        var s = statFromLedger(r.ledger);
        src = add(src, s);
        console.log('  源 ' + c.years[i] + '：凭证 ' + s.vouchers + '，分录 ' + s.entries + '，借 ' + fmt(s.dr));
      });
      var bookJson = JSON.parse(fs.readFileSync(path.join(BOOKS, c.book), 'utf8'));
      var dst = statFromLedger(bookJson);
      console.log('\n=== ' + c.name + ' ===');
      console.log('  源文件合计：凭证 ' + src.vouchers + '，分录 ' + src.entries + '，借方 ' + fmt(src.dr) + '，贷方 ' + fmt(src.cr) + '，科目 ' + src.subjects);
      console.log('  导入后账套：凭证 ' + dst.vouchers + '，分录 ' + dst.entries + '，借方 ' + fmt(dst.dr) + '，贷方 ' + fmt(dst.cr) + '，科目 ' + dst.subjects);
      var dv = dst.vouchers - src.vouchers, de = dst.entries - src.entries;
      var ddr = Math.round((dst.dr - src.dr) * 100) / 100, dcr = Math.round((dst.cr - src.cr) * 100) / 100;
      console.log('  差异：凭证 ' + (dv === 0 ? '0 ✓' : dv) + '，分录 ' + (de === 0 ? '0 ✓' : de) +
        '，借方 ' + (ddr === 0 ? '0 ✓' : ddr) + '，贷方 ' + (dcr === 0 ? '0 ✓' : dcr));
      console.log('  结论：' + ((dv === 0 && de === 0 && ddr === 0 && dcr === 0) ? '导入完整，无丢失 ✓' : '★ 存在差异，导入环节有问题'));
      console.log('');
    });
  });
}, Promise.resolve()).catch(function (e) { console.error('失败：', e && e.stack || e); });
