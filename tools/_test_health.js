/* 测试资金体检：绅蓝多年合并账套 */
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
// 加载 store（financialHealthCheck 在 store.js）
global.STANDARDS = true;
try { require(path.join(__dirname, '..', 'js', 'standards.js')); } catch (e) {}

// 用 store 的构造和 emptyState：直接读 store.js 并 eval
var storeSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');
// store.js 假设浏览器环境，需提供 window/document；这里只测 financialHealthCheck 数据逻辑
// 简化：手动构造 store 单例（只测 financialHealthCheck + generalLedger + balanceSheet 的数据流）
// 直接 eval store.js 在 sandbox 里
var sandbox2 = {
  console: console, Buffer: global.Buffer,
  document: { getElementById: function () { return null; }, addEventListener: function () {} },
  localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} }
};
sandbox2.window = sandbox2; sandbox2.self = sandbox2; sandbox2.globalThis = sandbox2; sandbox2.global = sandbox2;
vm.createContext(sandbox2);
// 加载 standards 到 sandbox2
var stdSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'standards.js'), 'utf8');
vm.runInContext(stdSrc, sandbox2);
// 加载 store 到 sandbox2
try { vm.runInContext(storeSrc, sandbox2); } catch (e) { console.error('store load err:', e.message); }
console.log('sandbox2.__TY_EXPORT__ type:', typeof sandbox2.__TY_EXPORT__);

var Store = sandbox2.__TY_EXPORT__ && sandbox2.__TY_EXPORT__.store;
if (!Store) { console.error('Store 未加载'); process.exit(1); }

(async function () {
  // 1. 合并导入绅蓝 3 年
  const AIS_DIR = '/Users/chen/心中有数';
  var shenFiles = ['绅蓝之星_2024年_金蝶KIS格式.ais', '绅蓝之星_2025年_金蝶KIS格式.ais', '绅蓝之星_2026年_金蝶KIS格式.ais']
    .map(n => path.join(AIS_DIR, n));

  function asInput(p) { var buf = fs.readFileSync(p); buf.name = path.basename(p); return buf; }
  console.log('解析合并…');
  var r = await KisImport.parseMulti(shenFiles.map(asInput), { baseName: '绅蓝之星' });
  console.log('合并完成: ' + r.ledger.vouchers.length + ' 凭证');

  // 2. 装入 store 单例（S 是 IIFE 内部单例，直接赋 state）
  Store.state = r.ledger;
  Store.bookId = 'test_shen';
  Store._glCache = {};

  // 3. 跑体检
  console.log('\n=== 资金体检 ===');
  var t0 = Date.now();
  var hc = Store.financialHealthCheck({ largeVoucher: 50000, keySubject: 100000 });
  console.log('耗时: ' + (Date.now() - t0) + 'ms');
  console.log('体检期间: ' + hc.period);
  console.log('风险点总数: ' + hc.summary.total + ' (高危 ' + hc.summary.high + ' / 中危 ' + hc.summary.medium + ')');
  console.log('');
  hc.checks.forEach(function (c) {
    console.log('--- [' + c.severity + '] ' + c.title + ' (' + c.items.length + ' 项) ---');
    console.log('  ' + c.desc);
    c.items.slice(0, 5).forEach(function (it, i) {
      console.log('  ' + (i + 1) + '. ' + (it.code || it.codes || it.id || it.name || '') + ' ' + (it.issue || '').slice(0, 100));
    });
    if (c.items.length > 5) console.log('  … 还有 ' + (c.items.length - 5) + ' 项');
  });
})();
