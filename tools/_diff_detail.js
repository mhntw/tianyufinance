/* 详细打印绅蓝多年合并的跨年校验差异 */
'use strict';
const path = require('path');
const fs = require('fs');
global.window = global; global.self = global;
require(path.join(__dirname, '..', 'js', 'buffer.js'));
var vm = require('vm');
var mdbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8');
var sandbox = { window: global, self: global, console: console, Buffer: global.Buffer, process: process };
vm.createContext(sandbox); vm.runInContext(mdbSrc, sandbox);
global.MDBReader = sandbox.MDBReader || sandbox.window.MDBReader;
if (!global.MDBReader) { try { eval(mdbSrc); } catch (e) { console.error(e); } }
require(path.join(__dirname, '..', 'js', 'kis-import.js'));

function asInput(p) {
  var buf = fs.readFileSync(p);
  buf.name = path.basename(p);
  return buf;
}

(async function () {
  const AIS_DIR = '/Users/chen/心中有数';
  var shenFiles = ['绅蓝之星_2024年_金蝶KIS格式.ais', '绅蓝之星_2025年_金蝶KIS格式.ais', '绅蓝之星_2026年_金蝶KIS格式.ais']
    .map(n => path.join(AIS_DIR, n));
  console.log('解析中…');
  var r = await KisImport.parseMulti(shenFiles.map(asInput), { baseName: '绅蓝之星' });
  var s = r.stats;
  console.log('\n=== 跨年校验结果 ===');
  console.log('yearBoundaries 数量: ' + s.yearBoundaries.length);
  s.yearBoundaries.forEach(b => {
    console.log('\n--- ' + b.fromYear + '→' + b.toYear + ' ---');
    console.log('  不一致科目数: ' + b.checked);
    console.log('  最大差异: ' + Math.abs(b.maxDiff).toFixed(2));
    var diffs = b.allDiffs || b.samples || [];
    console.log('  差异明细 (' + diffs.length + ' 条):');
    diffs.forEach(d => {
      console.log('    ' + d.code + ': 上年期末=' + d.prevEnd.toFixed(2) + ', 本年期初=' + d.curOpen.toFixed(2) + ', 差=' + d.diff.toFixed(2));
    });
  });
})();
