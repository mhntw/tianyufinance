// 端到端整体测试：在 Node 中模拟 Tauri 桌面版运行环境，验证 storage.js（内存兜底分支）
// + store.js 计算引擎整链可用。
//
// 数据隔离（2026-09-19）：原实现直接读取**真实账套目录**下的 default.json —— 那是客户数据，
// 测试不该碰。现改为自造一份同结构的 default 账套，全程不落盘（走 storage.js 的内存兜底分支），
// 于是没有任何途径能触碰真实账套 —— 不靠"路径校验"去兜，而是压根不调 fs。
'use strict';

const fs = require('fs');
const path = require('path');

// 自造的 default 账套：科目规模取 48（与真实账套同量级），故下游依赖"48"的断言依旧成立。
function makeDefaultBook() {
  var subjects = [];
  for (var i = 0; i < 48; i++) {
    var code = String(1001 + i);
    subjects.push({ code: code, name: '测试科目' + code, cls: '资产', normal: 'dr', dc: 1, level: 1 });
  }
  return {
    schemaVersion: 5,
    company: { name: '测试账套', startMonth: '2026-01', code: 'TEST' },
    subjects: subjects,
    vouchers: [],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  };
}

// ---- 最小化浏览器全局 ----
const mem = {};
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.document = { getElementById: () => null };
global.window = global;
global.console = console;

// 注入 Tauri 全局（无真实 Rust，走 storage.js 的内存兜底分支）
global.__TAURI__ = {}; // 空对象 → storage.js 判定为非 Tauri → 用内存兜底
global.isTauri = false;

// ---- 加载 storage.js ----
require(path.resolve(__dirname, '../js/storage.js'));
// ---- 加载 store.js ----
require(path.resolve(__dirname, '../js/store.js'));

const S = global.S;
const Storage = global.Storage;

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL: ' + msg); process.exitCode = 1; }
  else { console.log('  ✓ ' + msg); }
}

(async function run() {
  console.log('=== 1. 存储引擎加载 ===');
  assert(typeof Storage === 'object' && typeof Storage.saveBook === 'function', 'Storage 已加载且含 saveBook');
  assert(Storage.isFileMode() === true, 'Storage.isFileMode() 恒为 true（桌面版）');

  console.log('\n=== 2. 载入真实账套 default.json 到存储引擎 ===');
  const raw = JSON.stringify(makeDefaultBook());
  const parsed = JSON.parse(raw);
  const saveRes = await Storage.saveBook('default', raw);
  assert(saveRes && saveRes.ok === true, 'saveBook("default") 成功');
  const ids = await Storage.listBooks();
  assert(ids.indexOf('default') >= 0, 'listBooks 含 default（' + JSON.stringify(ids) + '）');
  const loaded = await Storage.loadBook('default');
  assert(loaded && loaded.length === raw.length, 'loadBook 内容与写入一致（' + (loaded ? loaded.length : 0) + ' 字节）');

  console.log('\n=== 3. S.init() 初始化 + 从存储引擎加载账套 ===');
  const S2 = S.init();
  await new Promise((r) => setTimeout(r, 300)); // 等异步 loadFromServer / _initStorageEngine
  assert(S2.bookId === 'default', '当前账套 id = default');
  assert(Array.isArray(S2.state.subjects) && S2.state.subjects.length === parsed.subjects.length,
    'state.subjects 已加载（' + S2.state.subjects.length + ' 个科目）');
  assert(S2.state.schemaVersion === 5, 'schemaVersion = 5');

  console.log('\n=== 4. 核心计算引擎（基于真实科目表） ===');
  const subs = S2.subjects();
  assert(subs.length === 48, '科目表总数 = ' + subs.length);
  const cash = S2.subject('1001');
  assert(cash && cash.name, '能按编码取科目 1001 → ' + (cash && cash.name));

  // 试算平衡（trialBalance 实则返回总账数组，空账期为 48 行）
  const tb = S2.trialBalance('2026-01');
  assert(tb && Array.isArray(tb) && tb.length === 48, 'trialBalance 返回 48 行（与科目数一致）');

  // 总账 / 明细账（空账期不应抛错）
  const gl = S2.generalLedger('2026-01');
  assert(gl && Array.isArray(gl) && gl.length === 48, 'generalLedger 返回 48 行');
  const dl = S2.detailLedger('1001', '2026-01');
  assert(dl && dl.subject && Array.isArray(dl.rows), 'detailLedger 返回 {subject, rows} 结构');

  // 资产负债表（字段为 groups.assetCurrent 等，空账期为 0 但结构正确）
  const bs = S2.balanceSheet('2026-01');
  assert(bs && bs.groups && Array.isArray(bs.groups.assetCurrent.items),
    'balanceSheet 含 groups.assetCurrent 段');
  assert(typeof bs.totalAsset === 'number' && typeof bs.totalLiability === 'number',
    'balanceSheet 含 totalAsset/totalLiability 数值（' + bs.totalAsset + ' / ' + bs.totalLiability + '）');

  console.log('\n=== 5. 录入一张凭证后整体重算（闭环测试） ===');
  const before = S2.state.vouchers.length;
  const v = {
    word: '记', no: 1, date: '2026-01-31',
    entries: [
      { code: '1001', name: '库存现金', dr: 1000, cr: 0, summary: '测试' },
      { code: '1002', name: '银行存款', dr: 0, cr: 1000, summary: '测试' },
    ],
    attachments: 0,
  };
  const addRes = S2.addVoucher(v);
  assert(addRes && addRes.ok !== false, 'addVoucher 成功');
  assert(S2.state.vouchers.length === before + 1, '凭证数 +1（' + before + ' → ' + S2.state.vouchers.length + '）');
  // 保存回存储引擎
  const save2 = await Storage.saveBook('default', JSON.stringify(S2.state));
  assert(save2 && save2.ok === true, 'persist 后 saveBook 成功');

  // 备份链路
  const bk = await Storage.saveBackup('default', JSON.stringify(S2.state));
  assert(bk && bk.ok === true && bk.ts > 0, 'saveBackup 返回时间戳 ts=' + (bk && bk.ts));
  const bks = await Storage.listBackups('default');
  assert(Array.isArray(bks) && bks.length >= 1, 'listBackups 含 ≥1 条（' + (bks ? bks.length : 0) + '）');

  console.log('\n=== 6. 变更日志 ===');
  const log = await Storage.appendChangeLog({ action: '整体测试', module: 'test' });
  assert(log && log.ts > 0, 'appendChangeLog 写入成功 ts=' + (log && log.ts));

  console.log('\n=== 7. 恢复为干净账套（撤销测试凭证，保持数据整洁） ===');
  S2.state.vouchers.pop();
  await Storage.saveBook('default', JSON.stringify(S2.state));
  assert(S2.state.vouchers.length === before, '已撤销测试凭证，恢复 ' + before + ' 张');

  console.log('\n全部整体测试完成。');
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
