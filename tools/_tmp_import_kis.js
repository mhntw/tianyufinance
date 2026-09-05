#!/usr/bin/env node
/**
 * 临时脚本：用 kis-import.js 把 .ais 导入为 xzys 账套 JSON
 * 用法: node tools/_tmp_import_kis.js <.ais路径> <输出json路径>
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) {}

(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'kis-import.js'), 'utf8'));

const KisImport = global.KisImport;

const aisPath = process.argv[2];
const outPath = process.argv[3];
if (!aisPath || !outPath) {
  console.error('用法: node tools/_tmp_import_kis.js <.ais路径> <输出json路径>');
  process.exit(1);
}

const buf = fs.readFileSync(aisPath);
console.log('导入: ' + aisPath + ' (' + (buf.length / 1024 / 1024).toFixed(2) + ' MB)');

KisImport.parse(buf).then(function (r) {
  const ledger = r.ledger;
  const stats = r.stats;
  // 补 id（store.js 用 bookId 区分缓存）
  ledger.id = path.basename(outPath, '.json');
  fs.writeFileSync(outPath, JSON.stringify(ledger));
  console.log('已导出: ' + outPath);
  console.log('科目: ' + stats.subjects + '  凭证: ' + stats.vouchers +
    '  期初: ' + stats.opening + '  不平凭证: ' + stats.unbalancedVouchers);
  console.log('已结账期间: ' + JSON.stringify(stats.closedPeriods));
  console.log('当前期间: ' + stats.currentPeriod);
  if (stats.dupSubjects.length) console.log('重复科目: ' + stats.dupSubjects.join(', '));
}).catch(function (e) {
  console.error('导入失败:', e);
  process.exit(1);
});
