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

const booksDir = path.resolve(process.env.HOME, 'Library/Application Support/心中有数/books');
fs.mkdirSync(booksDir, { recursive: true });
const diskBooks = {};
let metaStore = { last_book: null, disabled: {} };

Storage.init = () => { global.__refreshAll = () => {}; return Promise.resolve({ ok: true }); };
Storage.saveBook = (id, json) => { diskBooks[id] = json; fs.writeFileSync(path.join(booksDir, id + '.json'), json); return Promise.resolve({ ok: true }); };
Storage.loadBook = (id) => { try { return Promise.resolve(fs.readFileSync(path.join(booksDir, id + '.json'), 'utf8')); } catch (e) { return Promise.resolve(null); } };
Storage.deleteBook = (id) => { delete diskBooks[id]; try { fs.unlinkSync(path.join(booksDir, id + '.json')); } catch (e) {} return Promise.resolve(); };
Storage.listBooks = () => Promise.resolve(fs.readdirSync(booksDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
Storage.readMeta = () => Promise.resolve(JSON.parse(JSON.stringify(metaStore)));
Storage.writeMeta = (m) => { metaStore = (typeof m === 'string') ? JSON.parse(m) : m; return Promise.resolve({ ok: true }); };
Storage.getDataDir = () => Promise.resolve(path.resolve(process.env.HOME, 'Library/Application Support/心中有数'));
Storage.exportBook = (id, json) => Promise.resolve({ ok: true, filename: id + '.json' });
Storage.saveBackup = () => Promise.resolve({ ok: true });
Storage.listBackups = () => Promise.resolve([]);
Storage.loadBackup = () => Promise.resolve(null);

let fails = 0;
function assert(c,m){ if(!c){console.error('  ✗ '+m);fails++;} else console.log('  ✓ '+m); }
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  console.log('=== 初始化 ===');
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
  const reloaded = JSON.parse(fs.readFileSync(path.join(booksDir, 'default.json'), 'utf8'));
  assert(reloaded.company.name === '从备份恢复的账套', '导入备份已覆盖当前 default 账套（磁盘一致）');
  assert(S.state.company.name === '从备份恢复的账套', '内存 state 同步为备份内容');
  assert(mem['kis_books'] === undefined, '导入备份过程未写 kis_books 缓存');

  console.log('\n=== 全程无 kis_books 脏写 ===');
  assert(mem['kis_books'] === undefined, 'localStorage 全程无 kis_books 键');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '导入账套/导入备份 功能验证通过 ✅'));
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e);process.exit(1);});
