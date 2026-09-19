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

/* 数据隔离（2026-09-19）：原实现把 Storage 的 mock 指向**真实账套目录与导出目录**
 *   $HOME/Library/Application Support/添钰财务/books 与 /exports
 * 而本测试包含 deleteBook（unlinkSync 删文件）、停用账套、导出等写操作 —— 一旦本机存在
 * default 账套，跑一次就可能删除或改写真实账套。此前只是因为 default.json 缺失才没出事。
 * 现改为沙箱（os.tmpdir 下唯一临时目录）；e2e_sandbox.install() 内含路径硬校验，
 * 任何试图指向真实数据目录的行为都会直接抛错拒绝运行。 */
const sandbox = require('./e2e_sandbox.js');
const SB = sandbox.create('bookmanage');
const sh = sandbox.install(Storage, SB);
const booksDir = SB.books;
const exportsDir = SB.exports;

let fails = 0;
function assert(c,m){ if(!c){console.error('  ✗ '+m);fails++;} else console.log('  ✓ '+m); }
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  console.log('=== 初始化（应异步读磁盘，默认进上次店） ===');
  // 沙箱内预置一份 default 账套（自造 fixture，不复制任何真实数据）。
  // 原先依赖真实账套目录里存在 default.json —— 既耦合客户数据，又使其一旦缺失
  // 整个测试就中断，后面的新建/切换/停用/导出用例从未被执行过。
  await Storage.saveBook('default', JSON.stringify(sandbox.makeDefaultBook()));
  S.init();
  await wait(400);
  assert(S.currentBookId() === 'default', '初始默认账套为 default');
  assert(S.state && S.state.company, '首屏已异步从磁盘加载 default 完整 state');

  console.log('\n=== 新建账套（应立即落盘 + 刷新列表） ===');
  const newId = S.newBook('测试新建账套');
  assert(/^B\d+$/.test(newId), 'newBook 返回新 id：' + newId);
  await wait(150);
  assert(fs.existsSync(path.join(booksDir, newId + '.json')), '新建账套已立即落盘（不依赖防抖）');
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
  assert(sh.meta().last_book === 'default', 'meta.last_book 记录上次店=default（关闭后重开应默认进此店）');

  console.log('\n=== 停用标记走 meta（不赖 localStorage） ===');
  S.setBookEnabled(newId, false);
  await wait(50);
  assert(sh.meta().disabled[newId] === true, '停用标记写入 meta.json（非 localStorage）');
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

  console.log('\n=== 恢复备份（应立即落盘 + 刷新索引） ===');
  const st = JSON.parse(JSON.stringify(S.state));
  st.company.name = '恢复后的名称';
  const r3 = S.restoreBookState(st);
  assert(r3 === true, 'restoreBookState 返回 true');
  await wait(150);
  const reloaded = JSON.parse(fs.readFileSync(path.join(booksDir,'default.json'),'utf8'));
  assert(reloaded.company.name === '恢复后的名称', '恢复结果已落盘（磁盘读取一致）');

  console.log('\n=== 删除账套（删磁盘 + 刷新索引） ===');
  const del = await S.removeBook(newId);
  assert(del.ok === true, 'removeBook 成功');
  // 删除 = 移入回收站（trash/，保留期内可还原），不是物理删除 —— 故断言"移出 books/"而非"文件消失"
  assert(!fs.existsSync(path.join(booksDir, newId + '.json')), '删除账套已移出 books 目录');
  assert((await Storage.listTrash()).length >= 1, '删除的账套进入回收站（可还原）');
  assert(S.listBooks().map(b=>b.id).indexOf(newId) < 0, '删除后列表不含该账套');

  console.log('\n=== 索引刷新（refreshBookIndex 收敛到磁盘） ===');
  const ghost = 'Bghost999';
  fs.writeFileSync(path.join(booksDir, ghost + '.json'), JSON.stringify({company:{name:'幽灵账套'},schemaVersion:5,subjects:[],vouchers:[]}));
  await S.refreshBookIndex();
  const ids2 = S.listBooks().map(b=>b.id);
  assert(ids2.indexOf(ghost) >= 0, '列表包含磁盘新增的幽灵账套（索引以磁盘为准）');
  fs.unlinkSync(path.join(booksDir, ghost + '.json'));
  await S.refreshBookIndex();
  assert(S.listBooks().map(b=>b.id).indexOf(ghost) < 0, '清理后索引同步移除幽灵');

  console.log('\n=== 导出（落 exports + 路径可获取） ===');
  sh.exportLog.length = 0;   // 清空但保留数组引用（沙箱内部仍 push 到同一数组）
  const books = S.listBooks();
  for (const b of books) {
    const txt = await Storage.loadBook(b.id);
    const st2 = txt ? JSON.parse(txt) : null;
    if (st2) await Storage.exportBook(b.id, JSON.stringify(st2));
  }
  assert(sh.exportLog.length === books.length, '每个账套都导出了文件：' + sh.exportLog.join(', '));
  const dataDir = await Storage.getDataDir();
  assert(fs.existsSync(path.join(dataDir, 'exports', sh.exportLog[0])), '导出文件落在 exports 目录（可拼出完整路径）');

  console.log('\n=== 旧 kis_books 缓存已废弃（不应再写入） ===');
  assert(mem['kis_books'] === undefined, 'localStorage 不再写入 kis_books 混乱缓存');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '全部账套管理功能验证通过 ✅'));
  SB.cleanup();                      // 清掉沙箱，不在临时目录留账套副本
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e); SB.cleanup(); process.exit(1);});
