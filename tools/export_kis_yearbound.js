#!/usr/bin/env node
/* export_kis_yearbound.js — 导出金蝶导入账套的「跨年差异」明细为 CSV（供金蝶端对账）
 * 数据来源：账套 JSON 的 meta.yearBoundaries.allDiffs（导入器校验存档）。
 * 列：年界 | 科目编码 | 科目名称 | 类别 | 上年末余额(推导) | 本年期初(金蝶期初) | 差异 | 差异率
 * 用法：node tools/export_kis_yearbound.js <账套.json> [输出.csv]
 * 默认输出：tools/_out/跨年差异_<账套文件名>.csv（UTF-8 BOM，Excel 直接打开）
 * 只读账套文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.log('用法：node tools/export_kis_yearbound.js <账套.json> [输出.csv]'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = (data.company && data.company.name) || path.basename(file, '.json');

const outPath = process.argv[3] || path.join(__dirname, '_out', '跨年差异_' + path.basename(file, '.json') + '.csv');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const subj = {};
(data.subjects || []).forEach(s => { subj[s.code] = s; });
const mb = (data.meta && data.meta.yearBoundaries) || [];

const rows = [['年界', '科目编码', '科目名称', '类别', '上年末(推导)', '本年期初(金蝶)', '差异', '差异率']];
mb.forEach(b => {
  const list = (b.allDiffs || []).slice().sort((a, x) => Math.abs(x.diff) - Math.abs(a.diff));
  if (!list.length) {
    rows.push([b.fromYear + '→' + b.toYear + '（校验通过）', '', '', '', '', '', '', '0']);
    return;
  }
  list.forEach(d => {
    const s = subj[d.code] || {};
    const rate = d.prevEnd !== 0 ? (Math.abs(d.diff / d.prevEnd) * 100).toFixed(1) + '%' : '—';
    rows.push([
      b.fromYear + '→' + b.toYear, d.code, s.name || '', s.cls || '',
      (d.prevEnd || 0).toFixed(2), (d.curOpen || 0).toFixed(2), (d.diff || 0).toFixed(2), rate
    ]);
  });
});

const esc = v => { const t = String(v == null ? '' : v); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const csv = '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
fs.writeFileSync(outPath, csv);

// 控制台摘要
console.log('已导出：' + outPath);
console.log('共 ' + (rows.length - 1) + ' 行（' + mb.map(b => b.fromYear + '→' + b.toYear + '：差异 ' + (b.checked || 0) + ' / 核对 ' + (b.total || 0)).join('；') + '）');
console.log('前 5 行预览：');
rows.slice(1, 6).forEach(r => console.log('  ' + r[0] + ' | ' + r[1] + ' ' + r[2] + '[' + r[3] + '] 上年末=' + r[4] + ' 期初=' + r[5] + ' 差=' + r[6] + ' ' + r[7]));
