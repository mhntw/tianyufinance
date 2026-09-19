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

/* 数据隔离（2026-09-19）：原实现把 Storage 的 mock 指向**真实账套目录**
 *   $HOME/Library/Application Support/添钰财务/books
 * 而本测试里有 deleteBook（unlinkSync 删文件）与 restoreBookState（覆盖账套）这类破坏性操作。
 * 此前没酿成事故只是因为本机没有 default.json：switchBook('default') 先 ENOENT 退出，
 * 删除与覆盖根本没机会执行 —— 这是运气，不是安全。
 * 现改为沙箱（os.tmpdir 下唯一临时目录），install() 内含路径硬校验，
 * 一旦试图指向真实数据目录会直接抛错拒绝运行。 */
const sandbox = require('./e2e_sandbox.js');
const SB = sandbox.create('import');
const sh = sandbox.install(Storage, SB);
const booksDir = SB.books;

let fails = 0;
function assert(c,m){ if(!c){console.error('  ✗ '+m);fails++;} else console.log('  ✓ '+m); }
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  console.log('=== 初始化 ===');
  // 沙箱内预置一份 default 账套（自造 fixture，不复制任何真实数据）。
  // 原先依赖真实账套目录里存在 default.json —— 既耦合客户数据，又导致数据一旦缺失
  // 整个测试就 ENOENT 退出（后面的删除/覆盖用例从没被执行过）。
  await Storage.saveBook('default', JSON.stringify(sandbox.makeDefaultBook()));
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
  assert(fs.existsSync(path.join(booksDir, bid + '.json')), '导入账套已落盘到磁盘');
  assert(sh.meta().last_book === bid, '导入后 meta.last_book 指向新账套（重开默认进此账套）');
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
  const reloaded = JSON.parse(fs.readFileSync(path.join(booksDir, 'default.json'), 'utf8'));
  assert(reloaded.company.name === '从备份恢复的账套', '导入备份已覆盖当前 default 账套（磁盘一致）');
  assert(S.state.company.name === '从备份恢复的账套', '内存 state 同步为备份内容');
  assert(mem['kis_books'] === undefined, '导入备份过程未写 kis_books 缓存');

  console.log('\n=== 全程无 kis_books 脏写 ===');
  assert(mem['kis_books'] === undefined, 'localStorage 全程无 kis_books 键');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '导入账套/导入备份 功能验证通过 ✅'));
  SB.cleanup();                      // 清掉沙箱，不在临时目录留账套副本
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e); SB.cleanup(); process.exit(1);});
