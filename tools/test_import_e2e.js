// 导入账套 / 导入备份 功能验证（注入模拟 Tauri 落盘 Storage）
'use strict';
const fs = require('fs');
const path = require('path');
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k,v)=>{mem[k]=String(v);}, removeItem: k=>{delete mem[k];} };
global.document = { getElementById: () => null };
global.window = global;
global.console = console;
global.__TAURI__ = {}; global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S, Storage = global.Storage;

/* 内存账套存储（2026-09-19 数据隔离）
 * 原实现把 Storage 的 mock 指向**真实账套目录**，而本测试含 deleteBook（删文件）与
 * restoreBookState（覆盖账套）—— 一旦本机存在 default 账套，跑一次就可能删掉真账。
 * 此前没酿成事故只是因为本机没有 default.json，删除与覆盖根本没机会执行 —— 这是运气不是安全。
 * 真实落盘由 Rust 后端负责，Node 里本来也模拟不了；故一律改用内存，
 * 全程**零 fs 调用**，从原理上不可能触碰真实账套（不靠路径校验去兜）。 */
const books = {};
let metaStore = { last_book: null, disabled: {} };

Storage.init = () => { global.__refreshAll = () => {}; return Promise.resolve({ ok: true }); };
Storage.saveBook = (id, json) => { books[id] = json; return Promise.resolve({ ok: true }); };
Storage.loadBook = (id) => Promise.resolve(books[id] || null);
Storage.deleteBook = (id) => { delete books[id]; return Promise.resolve({ ok: true }); };
Storage.listBooks = () => Promise.resolve(Object.keys(books));
Storage.readMeta = () => Promise.resolve(JSON.parse(JSON.stringify(metaStore)));
Storage.writeMeta = (m) => { metaStore = (typeof m === 'string') ? JSON.parse(m) : m; return Promise.resolve({ ok: true }); };
Storage.getDataDir = () => Promise.resolve('<内存模式>');
Storage.exportBook = (id, json) => Promise.resolve({ ok: true, filename: id + '.json' });
Storage.saveBackup = () => Promise.resolve({ ok: true });
Storage.listBackups = () => Promise.resolve([]);
Storage.loadBackup = () => Promise.resolve(null);

let fails = 0;
function assert(c,m){ if(!c){console.error('  ✗ '+m);fails++;} else console.log('  ✓ '+m); }
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  console.log('=== 初始化 ===');
  // 预置一份自造的 default 账套（不读真实账套目录）。
  // 原先依赖真实账套目录里存在 default.json —— 既耦合客户数据，又导致数据一旦缺失
  // 整个测试就 ENOENT 退出（后面的删除/覆盖用例从没被执行过）。
  await Storage.saveBook('default', JSON.stringify({
    schemaVersion: 5,
    company: { name: '默认账套', startMonth: '2026-01' },
    subjects: [], vouchers: [],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  }));
  S.init();
  await wait(300);
  assert(S.state && S.state.company, '首屏已加载 default 账套');

  console.log('\n=== 导入账套 .json（应新增独立账套并落盘 + 记录 meta 指针） ===');
  const importBook = {
    schemaVersion: S.SCHEMA_VERSION,
    company: { name: '导入的测试账套', startMonth: '2024-01', code: 'TEST' },
    subjects: [{ code: '1001', name: '库存现金', dc: 1, level: 1 }],
    vouchers: [{ id: 1, date: '2024-01-05', entries: [{ subjectCode: '1001', dc: 1, amount: 100 }] }],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  };
  // 模拟 Settings.js 的 loadServerBookIntoLocal 逻辑（注入新 id）
  const bid = 'IMPORT_' + Date.now();
  S.bookId = bid; S.state = importBook;
  if (S.state.schemaVersion == null) S.state.schemaVersion = S.SCHEMA_VERSION;
  S.ensureCashFlowMap();
  await Storage.saveBook(bid, JSON.stringify(S.state));
  S.setCurrentBookMeta(bid);
  S.addLog('导入账套', '导入账套 ' + bid, '账套');
  S.refreshBookIndex();
  await wait(200);
  assert(books[bid] !== undefined, '导入账套已写入存储');
  assert(metaStore.last_book === bid, '导入后 meta.last_book 指向新账套（重开默认进此账套）');
  assert(mem['kis_books'] === undefined, '导入账套过程未写 kis_books 缓存（已废弃）');
  const ids = S.listBooks().map(b => b.id);
  assert(ids.indexOf(bid) >= 0, '导入账套出现在账套列表');
  assert(ids.indexOf('default') >= 0, '原 default 账套未被覆盖（导入=新增，非覆盖）');

  console.log('\n=== 导入备份 .json（应覆盖当前账套） ===');
  // 先切到 default
  await S.switchBook('default'); await wait(150);
  assert(S.currentBookId() === 'default', '已切回 default');
  const backupState = {
    schemaVersion: S.SCHEMA_VERSION,
    company: { name: '从备份恢复的账套', startMonth: '2025-03' },
    subjects: [{ code: '1002', name: '银行存款', dc: 1, level: 1 }],
    vouchers: [],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  };
  const r = S.restoreBookState(backupState);
  assert(r === true, 'restoreBookState 返回 true');
  await wait(150);
  const reloaded = JSON.parse(books['default']);
  assert(reloaded.company.name === '从备份恢复的账套', '导入备份已覆盖当前 default 账套（存储与内存一致）');
  assert(S.state.company.name === '从备份恢复的账套', '内存 state 同步为备份内容');
  assert(mem['kis_books'] === undefined, '导入备份过程未写 kis_books 缓存');

  console.log('\n=== 全程无 kis_books 脏写 ===');
  assert(mem['kis_books'] === undefined, 'localStorage 全程无 kis_books 键');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '导入账套/导入备份 功能验证通过 ✅'));
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e); process.exit(1);});
