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
let snapLog = [];            // 迁移前强制快照记录（v5→v6 升级链路，记录 {id, ver}）
let ceBanner = null;         // 红条横幅文案（app.js 的 window.__onPersistError 实现，这里只记录）
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
// 迁移前强制快照：默认成功并留痕（②③ 两节会按需换成"失败"mock）。
// 必须在 S.init() 之前装好 —— 首屏加载的 default 是 v5，升级链路会立刻走这条路。
Storage.saveRestoreSnapshot = (id, json) => {
  snapLog.push({ id: id, ver: JSON.parse(json).schemaVersion });
  return Promise.resolve({ ok: true, ts: 1 });
};
global.__onPersistError = (m) => { ceBanner = m; };

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
  // 上面这份 fixture 是 v5（「元」浮点）。首屏加载必须走完「快照→迁移→落盘 v6→回读校验」，
  // 否则定点代码会把「元」当 0.0001 元用，界面与报表整体错 10000 倍。
  assert(S.state.schemaVersion === 6, '首屏加载的 v5 账套已自动升级为 v6（金额转入定点整数域）');
  assert(snapLog.length === 1 && snapLog[0].id === 'default' && snapLog[0].ver === 5,
    '升级前先写迁移前快照，快照内容是 v5 原文（可回滚）');
  assert(JSON.parse(books['default']).schemaVersion === 6,
    '升级结果已回写磁盘（盘上也是 v6，下次启动不再重复迁移）');

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

  console.log('\n=== 新建账套必须"开箱可用"：首屏就能录第一张凭证 ===');
  // 自建账套若科目表为空 / 缺 param / 缺 cashFlowItems，用户建完就卡住（页面空白或存不进凭证），
  // 而"新建账套"恰恰是唯一没有外部数据可参照的入口 —— 缺什么都不会有人提醒。
  assert(Array.isArray(S.state.subjects) && S.state.subjects.length > 0,
    '新账套自带准则科目表：' + (S.state.subjects || []).length + ' 个科目');
  assert(!!(S.state.param && S.state.param.voucherWord), '新账套自带默认凭证字');
  assert(Array.isArray(S.state.cashFlowItems) && S.state.cashFlowItems.length > 0, '新账套自带现金流量项目');
  assert(S.state.standard === 'small2013', '新账套准则为小企业准则 2013：' + S.state.standard);
  assert(S.state.company.startMonth === new Date().getFullYear() + '-' +
    ('0' + (new Date().getMonth() + 1)).slice(-2), '启用期间默认当月：' + S.state.company.startMonth);
  const subj0 = S.state.subjects[0];
  /* ⚠ 日期必须用**本地**口径。原先写 `new Date().toISOString().slice(0, 10)` —— toISOString 是 **UTC**，
     而上面的「启用期间默认当月」用的是本地 getMonth()：在 UTC+8 的**每月 1 号 00:00~08:00**，
     UTC 还停在上月最后一天 → 于是"凭证日期(上月末) 早于 账套启用期间(本月)"，本断言每月头 8 小时必红一次
     （2026-10-01 实测：日期 2026-09？启用期间 2026-10）。故与 startMonth 保持同一口径。 */
  const _d = new Date();
  const today = _d.getFullYear() + '-' + ('0' + (_d.getMonth() + 1)).slice(-2) + '-' + ('0' + _d.getDate()).slice(-2);
  const av = S.addVoucher({
    word: '记', date: today,
    entries: [{ code: subj0.code, name: subj0.name, dr: 100, cr: 0 },
              { code: subj0.code, name: subj0.name, dr: 0, cr: 100 }]
  });
  // 注意契约不一致：addVoucher 成功时返回**凭证对象**（无 ok 字段），失败才返回 {ok:false,msg}
  assert(av && av.id, '新建账套后能立即录入第一张凭证' + (av && av.msg ? '：' + av.msg : ''));
  assert((S.state.vouchers || []).length === 1, '首张凭证已入账');

  console.log('\n=== 启用期间晚于当前月份 = 死账套（故 UI 层必须拦住，见 Tools.js） ===');
  // 这类账套一张凭证也录不进去：store.addVoucher 的「未来月」闸门会把每个月全部拒绝，
  // 用户只会看到"凭证日期不能晚于当前月份"这种摸不着头脑的错。故新建账套时就不该允许。
  const futureMonth = (new Date().getFullYear() + 1) + '-01';
  const futureId = S.newBook('未来启用账套', 'small2013', futureMonth);
  await wait(120);
  const fv = S.addVoucher({
    word: '记', date: futureMonth + '-05',
    entries: [{ code: subj0.code, name: subj0.name, dr: 1, cr: 0 },
              { code: subj0.code, name: subj0.name, dr: 0, cr: 1 }]
  });
  assert(fv && fv.ok === false && /晚于当前月份/.test(fv.msg || ''),
    '未来启用期间的账套录不进凭证：' + (fv && fv.msg));
  await S.removeBook(futureId);          // 别留在存储里干扰后面的列表断言
  await S.switchBook('default'); await wait(150);

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

  /* ============================================================
   * 账套升级链路（v5「元」浮点 → v6「0.0001 元」定点整数）
   * 【为什么单独立一节】这段逻辑写的是**用户的历史数据**，出错就是数据事故；
   *   而它只在这一个入口（从磁盘载入账套）上跑，页面测试与报表测试都碰不到。
   * ============================================================ */
  console.log('\n=== 升级链路②：快照失败必须中止升级、不动盘上数据 ===');
  // 带真实金额的 v5 账套：只断言 schemaVersion 会漏掉"金额被 ×10000 了但版本没改"这种半吊子状态，
  // 故必须拿一个**4 位小数**的金额作探针（2 位小数无法区分是否被放大）。
  books['Bv5fail'] = JSON.stringify({
    schemaVersion: 5, company: { name: '升级快照失败账套', startMonth: '2026-01' },
    subjects: [{ code: '1001', name: '库存现金', class: '资产', direction: '借' }],
    vouchers: [{
      word: '记', no: 1, date: '2026-01-10',
      entries: [
        { code: '1001', name: '库存现金', dr: 2051.6644, cr: 0, summary: '升级链路探针' },
        { code: '1001', name: '库存现金', dr: 0, cr: 2051.6644, summary: '升级链路探针' }
      ]
    }]
  });
  Storage.saveRestoreSnapshot = () => Promise.resolve({ ok: false, error: '模拟磁盘满' });
  ceBanner = null;
  global.__onPersistError = (m) => { ceBanner = m; };   // 红条横幅（app.js 的实现，这里只记录）
  S.switchBook('Bv5fail');
  await wait(250);
  assert(S.currentBookId() === 'Bv5fail' && S.state.company.name === '升级快照失败账套',
    '快照失败时仍可进该账套（用 v5 原数据顶屏，money() 兜底按元显示，不会错 10000 倍）');
  assert(S.state.schemaVersion === 5, '内存里仍是 v5（未迁移）');
  // 注意：盘上文本会被"补齐现金流量兜底字段"的常规归一化改写（ensureCashFlowFields → persist），
  // 与迁移无关。故这里断言的是**金额域未被改动**，而不是"文件字节完全没变"。
  const diskAfterFail = JSON.parse(books['Bv5fail']);
  assert(diskAfterFail.schemaVersion === 5, '盘上仍是 v5（升级被中止，下次启动可安全重试）');
  assert(diskAfterFail.vouchers[0].entries[0].dr === 2051.6644,
    '金额未被 ×10000：仍是 2051.6644 元（无备份就绝不动历史数据）');
  assert(!!ceBanner && ceBanner.indexOf('账套升级') >= 0, '已弹红条横幅告知用户：' + (ceBanner || '（无）'));

  console.log('\n=== 升级链路③：快照成功 → 迁移 → 落盘 v6 ===');
  S.switchBook('default');            // 先离开目标账套，否则同名切换会被"目标即当前"短路
  await wait(200);
  Storage.saveRestoreSnapshot = (id, json) => {
    snapLog.push({ id: id, ver: JSON.parse(json).schemaVersion });
    return Promise.resolve({ ok: true, ts: 1 });
  };
  snapLog.length = 0;
  S.switchBook('Bv5fail');
  await wait(250);
  assert(snapLog.length === 1 && snapLog[0].ver === 5 && snapLog[0].id === 'Bv5fail',
    '迁移前先写快照，且快照是**迁移前原文**（v5）');
  assert(S.state.schemaVersion === 6, '内存已升级为 v6');
  const diskAfterOk = JSON.parse(books['Bv5fail']);
  assert(diskAfterOk.schemaVersion === 6, '盘上已回写 v6（下次启动不再重复迁移）');
  assert(diskAfterOk.vouchers[0].entries[0].dr === 20516644,
    '金额已定点化：2051.6644 元 → 20516644（0.0001 元整数，4 位精度未丢）');
  assert(global.util.money(20516644) === '2,051.66',
    '显示层仍是 2 位（4 位精度只落在内部整数域）：' + global.util.money(20516644));
  // 幂等：再切走再切回 —— 若二次载入仍按 v5 迁移一次，金额会被重复 ×10000（放大 1 亿倍且每个数都自洽）
  const v6Text = books['Bv5fail'];
  S.switchBook('default'); await wait(200);
  S.switchBook('Bv5fail'); await wait(250);
  assert(books['Bv5fail'] === v6Text, '二次载入不改写该账套（迁移幂等，未重复放大）');
  assert(snapLog.length === 1, '二次载入不再写快照（v6 直通，不走迁移链路）');

  console.log('\n' + (fails ? ('有 '+fails+' 项失败') : '全部账套管理功能验证通过 ✅'));
  process.exit(fails ? 1 : 0);
})().catch(e=>{console.error('异常:',e); process.exit(1);});
