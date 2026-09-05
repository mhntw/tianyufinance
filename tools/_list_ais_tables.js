/* 列出 .ais 的所有表+字段，找期间结账状态表 */
'use strict';
const path = require('path');
const fs = require('fs');
global.window = global; global.self = global;
require(path.join(__dirname, '..', 'js', 'buffer.js'));
var vm = require('vm');
var mdbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8');
var sandbox = { window: global, self: global, console: console, Buffer: global.Buffer, process: process };
vm.createContext(sandbox); vm.runInContext(mdbSrc, sandbox);
console.log('sandbox.MDBReader type:', typeof sandbox.MDBReader);
console.log('global.MDBReader type:', typeof global.MDBReader);
console.log('sandbox.window.MDBReader type:', typeof (sandbox.window && sandbox.window.MDBReader));
global.MDBReader = sandbox.MDBReader || global.MDBReader || (sandbox.window && sandbox.window.MDBReader);
if (!global.MDBReader || typeof global.MDBReader !== 'function') {
  console.error('MDBReader 仍不可用，尝试 eval 兜底');
  try { eval(mdbSrc); } catch (e) { console.error('eval 失败:', e.message); }
}
console.log('最终 global.MDBReader type:', typeof global.MDBReader);

var file = process.argv[2] || '/Users/chen/心中有数/绅蓝之星_2026年_金蝶KIS格式.ais';
var buf = fs.readFileSync(file);
var MDBReader = global.MDBReader;
var reader = new MDBReader(buf);
var names = reader.getTableNames();
console.log('=== 表清单 (' + names.length + ' 个) ===');
names.forEach(function (n) {
  var tbl = reader.getTable(n);
  var cols = tbl.getColumnNames ? tbl.getColumnNames() : (tbl.columns || []).map(function (c) { return c.name; });
  var rows = tbl.getData() || [];
  console.log(n + '  [' + rows.length + ' 行] 列: ' + (cols || []).join(', '));
});
