/* 测试 parseMulti：绅蓝 3 年合并 + 添钰 2 年合并 */
'use strict';
const path = require('path');
const fs = require('fs');

// 复刻 mdb-reader 加载路径（与 xzys 前端一致）
global.window = global;
global.self = global;

// 加载 buffer polyfill（kis-import.js 依赖）
require(path.join(__dirname, '..', 'js', 'buffer.js'));
// 加载 mdb-reader（浏览器里 var MDBReader 自动挂 window，node 里需手动挂 global）
var vm = require('vm');
var mdbSrc = require('fs').readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8');
var sandbox = { window: global, self: global, console: console, Buffer: global.Buffer, process: process };
vm.createContext(sandbox);
vm.runInContext(mdbSrc, sandbox);
global.MDBReader = sandbox.MDBReader || sandbox.window.MDBReader;
if (!global.MDBReader) {
  // 兜底：直接 eval（让 var MDBReader 进入全局）
  try { eval(mdbSrc); } catch (e) { console.error('mdb-reader load failed', e); }
}
// 加载 kis-import
require(path.join(__dirname, '..', 'js', 'kis-import.js'));

const KisImport = global.KisImport;
if (!KisImport || !KisImport.parseMulti) {
  console.error('KisImport.parseMulti 未加载');
  process.exit(1);
}

function makeFile(p) {
  var buf = fs.readFileSync(p);
  // 模拟 File 对象
  return {
    name: path.basename(p),
    arrayBuffer: function () { return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); }
  };
}

function asInput(p) {
  // 直接用 Buffer 形式（parse 支持 Uint8Array/Buffer）
  var buf = fs.readFileSync(p);
  buf.name = path.basename(p);
  return buf;
}

async function testOne(storeName, files) {
  console.log('=== ' + storeName + ' 多年合并导入 ===');
  console.log('文件:', files.map(f => path.basename(f)).join(', '));
  var t0 = Date.now();
  try {
    var r = await KisImport.parseMulti(files.map(asInput), { baseName: storeName });
    var s = r.stats;
    console.log('  耗时: ' + (Date.now() - t0) + 'ms');
    console.log('  合并后: ' + s.subjects + ' 科目 / ' + s.vouchers + ' 凭证 / ' + s.opening + ' 期初条目');
    console.log('  年份: ' + s.years.join(', '));
    console.log('  每年统计: ' + s.perYear.map(y => y.year + '年(' + y.vouchers + '凭证/' + y.subjects + '科目)').join('  '));
    console.log('  closedPeriods 数: ' + s.closedPeriods.length);
    console.log('  最近期间: ' + (s.closedPeriods[s.closedPeriods.length - 1] || '(无)'));
    console.log('  跨年校验:');
    if (s.yearBoundaries.length === 0) {
      console.log('    (无跨年校验项)');
    } else {
      s.yearBoundaries.forEach(b => {
        console.log('    ' + b.fromYear + '→' + b.toYear + ': ' + b.checked + ' 个科目不一致, 最大差异 ' + Math.abs(b.maxDiff).toFixed(2));
      });
    }
    // 调试：手动算 2024 期末 vs 2025 期初
    var mergedOpening = r.ledger.openingBalances;
    console.log('  [DEBUG] 基础年 openingBalances keys: ' + Object.keys(r.ledger.openingBalances).length);
    var sum2024End = {};
    r.ledger.vouchers.forEach(v => {
      if ((v.date || '').slice(0, 4) !== '2024') return;
      v.entries.forEach(e => {
        sum2024End[e.code] = (sum2024End[e.code] || 0) + (e.dr || 0) - (e.cr || 0);
      });
    });
    console.log('  [DEBUG] 2024 推导期末 keys: ' + Object.keys(sum2024End).length);
    // 调试：绅蓝 2025→2026 差异详情
    if (s.yearBoundaries.find(b => b.fromYear === 2025 && b.toYear === 2026)) {
      var b2526 = s.yearBoundaries.find(b => b.fromYear === 2025 && b.toYear === 2026);
      console.log('  [DEBUG] 2025→2026 差异样本:');
      b2526.samples.forEach(s => {
        console.log('    科目 ' + s.code + ': 上年期末=' + s.prevEnd.toFixed(2) + ', 本年期初=' + s.curOpen.toFixed(2) + ', 差=' + s.diff.toFixed(2));
      });
    }
    if (r.warnings.length) {
      console.log('  告警:');
      r.warnings.forEach(w => console.log('    - ' + w));
    }
    // 凭证号重排校验：检查 no 是否连续
    var byWord = {};
    r.ledger.vouchers.forEach(v => {
      var w = v.word || '记';
      byWord[w] = (byWord[w] || 0) + 1;
    });
    console.log('  凭证字分布: ' + Object.keys(byWord).map(w => w + '(' + byWord[w] + ')').join('  '));
    // 检查 no 连续性
    var wordNos = {};
    r.ledger.vouchers.forEach(v => {
      var w = v.word || '记';
      if (!wordNos[w]) wordNos[w] = [];
      wordNos[w].push(v.no);
    });
    Object.keys(wordNos).forEach(w => {
      var nos = wordNos[w].sort((a, b) => a - b);
      var max = nos[nos.length - 1];
      var missing = nos.filter((n, i) => n !== i + 1).length;
      console.log('  ' + w + ' 凭证号 1..' + max + (missing === 0 ? '（连续）' : '（缺号 ' + missing + ' 个）'));
    });
    // 期间跨度
    var dates = r.ledger.vouchers.map(v => v.date).filter(Boolean).sort();
    console.log('  凭证日期范围: ' + dates[0] + ' ~ ' + dates[dates.length - 1]);
    console.log('  公司名: ' + r.ledger.company.name);
    console.log('  startMonth: ' + r.ledger.company.startMonth);
    console.log('  currentPeriod: ' + r.ledger.company.currentPeriod);
    return r;
  } catch (e) {
    console.error('  错误: ' + e.message);
    console.error(e.stack);
    throw e;
  }
}

(async function () {
  const AIS_DIR = '/Users/chen/心中有数';

  // 绅蓝 3 年合并
  var shenFiles = ['绅蓝之星_2024年_金蝶KIS格式.ais', '绅蓝之星_2025年_金蝶KIS格式.ais', '绅蓝之星_2026年_金蝶KIS格式.ais']
    .map(n => path.join(AIS_DIR, n));
  await testOne('绅蓝之星', shenFiles);

  console.log('');

  // 添钰 2 年合并
  var tianFiles = ['添钰来客_2025年_金蝶KIS格式.ais', '添钰来客_2026年_金蝶KIS格式.ais']
    .map(n => path.join(AIS_DIR, n));
  await testOne('添钰来客', tianFiles);
})();
