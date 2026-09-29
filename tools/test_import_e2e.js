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

  console.log('\n=== 导入账套 .json（跑**真实实现** S.importExternalBook） ===');
  /* 2026-09-29 起改为直接调用真实实现。旧写法是"手抄一份 loadServerBookIntoLocal 的逻辑"
     （自己 bookId=/state=/ensureCashFlowMap/saveBook），于是 normalizeState / ensureVoucherIds /
     ensureCashFlowFields / 落盘成败判定 全都没被跑到，真出问题时测试照样全绿。
     现在整理与落盘在 store 的 importExternalBook 里（页面只负责读文件与提示），可被真实调用。 */
  // 故意造一份**旧备份**：没有 schemaVersion、凭证没有 id、没有 cashFlowItems
  const importBook = {
    company: { name: '导入的测试账套', startMonth: '2024-01', code: 'TEST' },
    subjects: [{ code: '1001', name: '库存现金', dc: 1, level: 1 }],
    vouchers: [{ word: '记', no: 1, date: '2024-01-05', entries: [{ code: '1001', name: '库存现金', dr: 100, cr: 0 }] }],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  };
  // id 约定与 Settings.js 一致：safeIdOf(名称) + '_' + 时间戳。safeIdOf 是纯函数，加载真身
  const icSrc = fs.readFileSync(path.resolve(__dirname, '../js/common/import-classify.js'), 'utf8')
    .replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1');
  (0, eval)(icSrc);
  assert(typeof safeIdOf === 'function', 'safeIdOf 可加载（账套 id 净化判据）');
  const bid = safeIdOf(importBook.company.name) + '_' + Date.now();
  assert(!/[\\/:*?"<>|]/.test(bid), '由名称拼出的账套 id 不含非法文件名字符：' + bid);
  const saved = await S.importExternalBook(bid, importBook);
  await wait(200);
  assert(saved === true, 'importExternalBook 返回 true（已写入磁盘）');
  assert(books[bid] !== undefined, '导入账套已写入存储');
  assert(metaStore.last_book === bid, '导入后 meta.last_book 指向新账套（重开默认进此账套）');
  const stored = JSON.parse(books[bid]);
  assert(stored.schemaVersion === S.SCHEMA_VERSION, '旧备份缺的 schemaVersion 已补齐（避免每次加载误判版本冲突）');
  assert(Array.isArray(stored.cashFlowItems) && stored.cashFlowItems.length > 0,
    '旧备份缺的 cashFlowItems 已兜底（否则现金流量相关页面 forEach 崩溃、页面空白）');
  assert(!!stored.vouchers[0].id, '导入的凭证被补上稳定 id：' + stored.vouchers[0].id);
  const ids = S.listBooks().map(b => b.id);
  assert(ids.indexOf(bid) >= 0, '导入账套出现在账套列表');
  assert(ids.indexOf('default') >= 0, '原 default 账套未被覆盖（导入=新增，非覆盖）');
  assert(mem['kis_books'] === undefined, '导入账套过程未写 kis_books 缓存（已废弃）');

  console.log('\n=== 导入时落盘失败必须被识别（不得谎报"导入成功"） ===');
  // Storage.saveBook 内部已 catch、恒为 resolved，只挂 .catch 的写法永远收不到失败
  // —— 于是用户看到"已作为新账套导入"，而账套其实没写进磁盘（重启即消失）。
  const origSaveBook = Storage.saveBook;
  const seenErr = [];
  global.__onPersistError = (m) => seenErr.push(String(m));
  Storage.saveBook = () => Promise.resolve({ ok: false, error: '磁盘空间不足' });
  const failId = 'FAILCASE_' + Date.now();
  const failSaved = await S.importExternalBook(failId, {
    company: { name: '会失败的账套', startMonth: '2024-01' }, subjects: [], vouchers: []
  });
  await wait(150);
  assert(failSaved === false, '落盘失败时 importExternalBook 返回 false（调用方据此不报成功）');
  assert(books[failId] === undefined, '失败的账套没有出现在存储里（内存有、磁盘没有）');
  assert(seenErr.length > 0, '落盘失败触发了保存失败告警（红色横幅），不是静默：' + (seenErr[0] || ''));
  Storage.saveBook = origSaveBook;
  delete global.__onPersistError;

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

  console.log('\n=== 从备份恢复：写盘失败必须被识别（不得静默） ===');
  // restoreBookState 原先直接调 Storage.saveBook(...).catch(...) —— saveBook 内部已 catch、
  // 恒 resolved，那条 .catch 是死代码：恢复后内存是新数据、盘上还是旧数据，却一声不响。
  const seenErr2 = [];
  global.__onPersistError = function (msg) { seenErr2.push(msg); };
  const orig2 = Storage.saveBook;
  Storage.saveBook = () => Promise.resolve({ ok: false, error: '磁盘已满' });
  const rFail = S.restoreBookState({ company: { name: '写盘会失败的恢复', startMonth: '2026-01' }, subjects: [], vouchers: [] });
  assert(rFail === true, 'restoreBookState 仍同步返回 true（表示"已应用到内存"）');
  await wait(150);
  assert(seenErr2.length > 0, '恢复时写盘失败触发了保存失败告警（不再是死代码）：' + (seenErr2[0] || ''));
  Storage.saveBook = orig2;
  delete global.__onPersistError;

  console.log('\n=== 全程无 kis_books 脏写 ===');
  assert(mem['kis_books'] === undefined, 'localStorage 全程无 kis_books 键');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '导入账套/导入备份 功能验证通过 ✅'));
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e); process.exit(1);});
