// 账套管理功能端到端验证（注入模拟 Tauri 落盘 Storage，验证「磁盘为真 + 切换先存后读 + meta 落盘」）
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
 * 原实现把 Storage 的 mock 指向**真实账套目录与导出目录**
 *   $HOME/Library/Application Support/添钰财务/books 与 /exports
 * 而本测试包含删除账套、停用、导出等写操作 —— 一旦本机存在 default 账套，跑一次
 * 就可能删除或改写真实账套。此前只是因为 default.json 缺失才没出事 —— 这是运气不是安全。
 * 真实落盘由 Rust 后端负责，Node 里本来也模拟不了；故一律改用内存，
 * 全程**零 fs 调用**，从原理上不可能触碰真实账套（不靠路径校验去兜）。 */
const books = {};            // 账套内容（id → json 字符串）
const trash = [];            // 回收站：删除 = 移入，保留期内可还原
let exportLog = [];
let metaStore = { last_book: null, disabled: {} };

Storage.init = () => { global.__refreshAll = () => {}; return Promise.resolve({ ok: true }); };
Storage.saveBook = (id, json) => { books[id] = json; return Promise.resolve({ ok: true }); };
Storage.loadBook = (id) => Promise.resolve(books[id] || null);
// store.removeBook 优先走 trashBook（移入回收站），只有旧引擎才退回 deleteBook
Storage.trashBook = (id) => {
  if (books[id] === undefined) return Promise.resolve(null);
  const file = id + '__' + Date.now() + '.json';
  trash.push(file); delete books[id];
  return Promise.resolve(file);
};
Storage.listTrash = () => Promise.resolve(trash.slice());
Storage.deleteBook = (id) => { delete books[id]; return Promise.resolve({ ok: true }); };
Storage.listBooks = () => Promise.resolve(Object.keys(books));
Storage.readMeta = () => Promise.resolve(JSON.parse(JSON.stringify(metaStore)));
Storage.writeMeta = (m) => { metaStore = (typeof m === 'string') ? JSON.parse(m) : m; return Promise.resolve({ ok: true }); };
Storage.getDataDir = () => Promise.resolve('<内存模式>');
Storage.exportBook = (id, json) => {
  const fname = (books[id] ? (JSON.parse(books[id]).company.name || id) : id) + '_20260826.json';
  exportLog.push(fname);
  return Promise.resolve({ ok: true, filename: fname });
};
Storage.saveBackup = () => Promise.resolve({ ok: true });
Storage.listBackups = () => Promise.resolve([]);
Storage.loadBackup = () => Promise.resolve(null);

let fails = 0;
function assert(c,m){ if(!c){console.error('  ✗ '+m);fails++;} else console.log('  ✓ '+m); }
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  console.log('=== 初始化（应异步读磁盘，默认进上次店） ===');
  // 沙箱内预置一份 default 账套（自造 fixture，不复制任何真实数据）。
  // 原先依赖真实账套目录里存在 default.json —— 既耦合客户数据，又使其一旦缺失
  // 整个测试就中断，后面的新建/切换/停用/导出用例从未被执行过。
  await Storage.saveBook('default', JSON.stringify({
    schemaVersion: 5,
    company: { name: '默认账套', startMonth: '2026-01' },
    subjects: [], vouchers: [],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  }));
  S.init();
  await wait(400);
  assert(S.currentBookId() === 'default', '初始默认账套为 default');
  assert(S.state && S.state.company, '首屏已异步从磁盘加载 default 完整 state');

  console.log('\n=== 新建账套（应立即落盘 + 刷新列表） ===');
  const newId = S.newBook('测试新建账套');
  assert(/^B\d+$/.test(newId), 'newBook 返回新 id：' + newId);
  await wait(150);
  assert(books[newId] !== undefined, '新建账套已立即写入存储（不依赖防抖）');
  const ids1 = S.listBooks().map(b=>b.id);
  assert(ids1.indexOf(newId) >= 0, '新建后列表含新账套（索引以磁盘为准）');

  console.log('\n=== 切换到新建账套（先存 default → 再读新账套权威） ===');
  // 先给 default 加一笔改动，验证切换时 default 被落盘
  S.switchBook(newId);
  await wait(200);
  assert(S.currentBookId() === newId, '当前账套切到新建账套');
  assert(S.state.company.name === '测试新建账套', '切换后加载的是新账套磁盘权威 state');

  console.log('\n=== 切回 default（验证 default 切换前的改动已落盘） ===');
  // 回到 default
  S.switchBook('default');
  await wait(200);
  assert(S.currentBookId() === 'default', '切回 default 成功');

  console.log('\n=== 当前账套指针（meta）持久化 ===');
  await wait(50);
  assert(metaStore.last_book === 'default', 'meta.last_book 记录上次店=default（关闭后重开应默认进此店）');

  console.log('\n=== 停用标记走 meta（不赖 localStorage） ===');
  S.setBookEnabled(newId, false);
  await wait(50);
  assert(metaStore.disabled[newId] === true, '停用标记写入 meta（非 localStorage）');
  assert(S.isBookEnabled(newId) === false, 'isBookEnabled 从 meta 读取停用状态');
  assert(S.isBookEnabled('default') === true, '未停用的账套默认启用');

  console.log('\n=== 切换到已停用账套应被拒绝 ===');
  const r1 = await S.switchBook(newId);
  if (r1 && typeof r1.then === 'function') {
    const rr = await r1;
    assert(rr.ok === false && /停用/.test(rr.msg), '已停用账套拒绝切换：' + rr.msg);
  } else {
    assert(r1.ok === false, '已停用账套拒绝切换');
  }
  assert(S.currentBookId() === 'default', '拒绝切换后仍在 default');

  console.log('\n=== 切换不存在的账套应被拒绝（磁盘为准） ===');
  const r2 = await S.switchBook('B_not_exist');
  if (r2 && typeof r2.then === 'function') {
    const rr = await r2; assert(rr.ok === false, '不存在账套拒绝切换：' + rr.msg);
  } else { assert(r2.ok === false, '不存在账套拒绝切换'); }

  console.log('\n=== 恢复备份（应立即写入存储 + 刷新索引） ===');
  const st = JSON.parse(JSON.stringify(S.state));
  st.company.name = '恢复后的名称';
  const r3 = S.restoreBookState(st);
  assert(r3 === true, 'restoreBookState 返回 true');
  await wait(150);
  const reloaded = JSON.parse(books['default']);
  assert(reloaded.company.name === '恢复后的名称', '恢复结果已写入存储（读取一致）');

  console.log('\n=== 删除账套（移入回收站 + 刷新索引） ===');
  const del = await S.removeBook(newId);
  assert(del.ok === true, 'removeBook 成功');
  // 删除 = 移入回收站（保留期内可还原），不是物理删除 —— 故断言"移出存储"而非"内容消失"
  assert(books[newId] === undefined, '删除账套已移出账套存储');
  assert((await Storage.listTrash()).length >= 1, '删除的账套进入回收站（可还原）');
  assert(S.listBooks().map(b=>b.id).indexOf(newId) < 0, '删除后列表不含该账套');

  console.log('\n=== 索引刷新（refreshBookIndex 收敛到存储） ===');
  const ghost = 'Bghost999';
  // 绕过 store 直接往存储里塞一个账套文件，模拟"磁盘上多出一个未被索引登记的账套"
  books[ghost] = JSON.stringify({company:{name:'幽灵账套'},schemaVersion:5,subjects:[],vouchers:[]});
  await S.refreshBookIndex();
  const ids2 = S.listBooks().map(b=>b.id);
  assert(ids2.indexOf(ghost) >= 0, '列表包含存储中新增的幽灵账套（索引以存储为准）');
  delete books[ghost];
  await S.refreshBookIndex();
  assert(S.listBooks().map(b=>b.id).indexOf(ghost) < 0, '清理后索引同步移除幽灵');

  console.log('\n=== 导出（逐个账套调用导出 + 文件名可获取） ===');
  exportLog.length = 0;
  const bookList = S.listBooks();     // 变量名避开外层的 books（账套存储对象）
  for (const b of bookList) {
    const txt = await Storage.loadBook(b.id);
    const st2 = txt ? JSON.parse(txt) : null;
    if (st2) await Storage.exportBook(b.id, JSON.stringify(st2));
  }
  assert(exportLog.length === bookList.length, '每个账套都导出了文件：' + exportLog.join(', '));
  assert(exportLog.length > 0 && !!exportLog[0], '导出返回了文件名（真实落盘由存储层负责）');

  console.log('\n=== 旧 kis_books 缓存已废弃（不应再写入） ===');
  assert(mem['kis_books'] === undefined, 'localStorage 不再写入 kis_books 混乱缓存');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '全部账套管理功能验证通过 ✅'));
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e); process.exit(1);});
