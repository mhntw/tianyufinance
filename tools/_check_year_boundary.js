#!/usr/bin/env node
/* ============================================================
 * 跨年一致性独立核查（不依赖任何 AI 分析产物 / 不依赖已合并账套）
 *
 * 数据源：金蝶导出的原账套 .ais（桌面「金蝶账套 ais」目录）
 * 做法：逐年解析 → 用「本年期初 + 本年凭证」推导本年期末 → 与下一年 .ais 的期初逐科目对比
 * 输出：每个跨年边界的真实差异科目（这才是可信结论）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) {}
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'kis-import.js'), 'utf8'));
const KisImport = global.KisImport;

const DIR = '/Users/chen/Desktop/金蝶账套 ais';
const FILES = [2024, 2025, 2026].map(function (y) {
  return { year: y, p: path.join(DIR, '绅蓝之星_' + y + '年_金蝶KIS格式.ais') };
});

function makeFile(p) {
  var buf = fs.readFileSync(p);
  return { name: path.basename(p), arrayBuffer: function () { return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); } };
}
function net(o) { return (o && o.dr || 0) - (o && o.cr || 0); }

// 本年期末 = 本年初期初 + 本年凭证（严格只取该年日期的凭证）
function yearEnd(L, year) {
  var bal = {};
  Object.keys(L.openingBalances || {}).forEach(function (c) { bal[c] = net(L.openingBalances[c]); });
  (L.vouchers || []).forEach(function (v) {
    var vy = parseInt((v.date || '').slice(0, 4), 10);
    if (vy !== year) return;
    (v.entries || []).forEach(function (e) {
      bal[e.code] = (bal[e.code] || 0) + (e.dr || 0) - (e.cr || 0);
    });
  });
  return bal;
}

Promise.all(FILES.map(function (f) { return KisImport.parse(makeFile(f.p)); })).then(function (rs) {
  var L = {};
  rs.forEach(function (r, i) {
    L[FILES[i].year] = r.ledger;
    console.log(FILES[i].year + ' 解析完成：科目 ' + (r.ledger.subjects || []).length +
      '，凭证 ' + (r.ledger.vouchers || []).length +
      '，期初科目 ' + Object.keys(r.ledger.openingBalances || {}).length);
  });

  for (var i = 0; i < FILES.length - 1; i++) {
    var y1 = FILES[i].year, y2 = FILES[i + 1].year;
    var end = yearEnd(L[y1], y1);
    var open = L[y2].openingBalances || {};
    var nameOf = {};
    (L[y2].subjects || []).forEach(function (s) { nameOf[s.code] = s.name; });

    var diffs = [], compared = 0, missing = [];
    Object.keys(end).forEach(function (c) {
      if (Math.abs(end[c]) <= 0.005) return;          // 上年末无余额，不比对
      if (!open[c]) { missing.push(c); return; }      // 下年期初里根本没有这个科目
      compared++;
      var d = Math.round((end[c] - net(open[c])) * 100) / 100;
      if (Math.abs(d) > 0.01) diffs.push({ code: c, name: nameOf[c] || '', prevEnd: end[c], curOpen: net(open[c]), diff: d });
    });

    console.log('\n================ ' + y1 + ' → ' + y2 + ' ================');
    console.log('上年末有余额科目 ' + Object.keys(end).filter(function (c) { return Math.abs(end[c]) > 0.005; }).length +
      '，其中下年期初也有记录 ' + compared + ' 个，有差异 ' + diffs.length + ' 个');
    if (missing.length) {
      console.log('★ 上年末有余额、但 ' + y2 + ' 年期初表里没有的科目 ' + missing.length + ' 个：');
      missing.forEach(function (c) {
        console.log('   ' + c + '  ' + (nameOf[c] || '') + '   上年末余额=' + end[c].toFixed(2));
      });
    }
    if (diffs.length) {
      console.log('差异明细（按金额）：');
      diffs.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
      diffs.slice(0, 15).forEach(function (x) {
        console.log('   ' + x.code + '  ' + x.name.slice(0, 10) + '  上年末=' + x.prevEnd.toFixed(2) +
          '  下年期初=' + x.curOpen.toFixed(2) + '  差=' + x.diff.toFixed(2));
      });
      if (diffs.length > 15) console.log('   …… 其余 ' + (diffs.length - 15) + ' 个略');
    } else {
      console.log('✓ 全部一致');
    }
  }
}).catch(function (e) { console.error('失败：', e && e.stack || e); });
