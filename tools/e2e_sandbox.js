'use strict';
/* e2e 测试的数据沙箱 —— 把 Storage 的磁盘读写全部重定向到临时目录，绝不碰真实账套。
 *
 * 【为什么要这个模块】（2026-09-19）
 * 原先 test_import_e2e.js 与 test_book_manage_e2e.js 把 Storage 的 mock 直接指向：
 *     $HOME/Library/Application Support/添钰财务/books      ← 这就是**真实账套目录**
 * 而这两份 e2e 里有：
 *     Storage.deleteBook  → fs.unlinkSync(booksDir/<id>.json)   // 删文件
 *     S.restoreBookState  → 覆盖当前账套                        // 写覆盖
 * 也就是说，一旦本机存在 default 账套，跑一次测试就可能**删掉或覆盖真实账套**。
 * 此前没出事只是因为本机恰好没有 default.json：switchBook('default') 先 ENOENT 退出，
 * 后面的删除与覆盖根本没机会执行 —— 这是运气，不是安全。
 *
 * 本模块提供：
 *   create()            建一个临时沙箱（os.tmpdir 下唯一目录）
 *   install(Sb, sb)     把 Storage 的文件类方法全部 mock 到沙箱目录
 *   makeDefaultBook()   生成一个自造的 default 账套 fixture（不复制任何真数据）
 *   sb.cleanup()        递归删除沙箱
 *
 * 【硬性保护】create() 与 install() 都会校验路径：一旦落在真实数据目录（或家目录、
 * 系统 Application Support）内，直接抛错拒绝运行 —— 宁可测试失败，也不能碰真账。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 真实数据目录的特征串（命中即拒绝）。跨平台的常见位置一并覆盖。
var DANGER = ['添钰财务', 'tianyufinance', 'application support', 'appdata'];

function assertNotReal(dir, what) {
  var p = path.resolve(dir);
  var low = p.toLowerCase();
  for (var i = 0; i < DANGER.length; i++) {
    if (low.indexOf(DANGER[i]) >= 0) {
      throw new Error('拒绝运行（' + what + '）：路径落在真实数据目录范围内 —— ' + p +
        '\ne2e 测试绝不能触碰真实账套，请使用 e2e_sandbox.create() 取临时目录。');
    }
  }
  if (p === os.homedir() || p === '/' || p === path.parse(p).root) {
    throw new Error('拒绝运行（' + what + '）：路径过于危险 —— ' + p);
  }
}

// 建沙箱：返回 { root, books, exports, backups, cleanup() }
function create(tag) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'ty_e2e_' + (tag || '') + '_'));
  assertNotReal(root, 'create');
  return {
    root: root,
    books: path.join(root, 'books'),
    exports: path.join(root, 'exports'),
    backups: path.join(root, 'backups'),
    name: path.basename(root),
    cleanup: function () {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响测试结果 */ }
    }
  };
}

/* 把 Storage 的文件类方法 mock 到沙箱目录。
 * 返回 { meta(), diskBooks, exportLog } 供断言使用。 */
function install(Storage, sb) {
  assertNotReal(sb.root, 'install');
  fs.mkdirSync(sb.books, { recursive: true });
  fs.mkdirSync(sb.exports, { recursive: true });

  var diskBooks = {};
  var exportLog = [];
  var meta = { last_book: null, disabled: {} };
  var pathOf = function (id) { return path.join(sb.books, String(id) + '.json'); };

  Storage.init = function () {
    return Promise.resolve({ ok: true });
  };
  Storage.saveBook = function (id, json) {
    diskBooks[id] = json;
    fs.writeFileSync(pathOf(id), (typeof json === 'string') ? json : JSON.stringify(json));
    return Promise.resolve({ ok: true, mode: 'file' });
  };
  Storage.loadBook = function (id) {
    try { return Promise.resolve(fs.readFileSync(pathOf(id), 'utf8')); }
    catch (e) { return Promise.resolve(null); }
  };
  Storage.deleteBook = function (id) {
    delete diskBooks[id];
    try { fs.unlinkSync(pathOf(id)); } catch (e) { /* 文件不存在无需处理 */ }
    return Promise.resolve({ ok: true, mode: 'file' });
  };
  Storage.listBooks = function () {
    return Promise.resolve(fs.readdirSync(sb.books)
      .filter(function (f) { return f.endsWith('.json'); })
      .map(function (f) { return f.replace(/\.json$/, ''); }));
  };
  Storage.readMeta = function () { return Promise.resolve(JSON.parse(JSON.stringify(meta))); };
  Storage.writeMeta = function (m) {
    meta = (typeof m === 'string') ? JSON.parse(m) : m;
    return Promise.resolve({ ok: true });
  };
  Storage.getDataDir = function () { return Promise.resolve(sb.root); };
  Storage.exportBook = function (id, json) {
    var fname = id + '_20260826.json';
    fs.writeFileSync(path.join(sb.exports, fname), json);
    exportLog.push(fname);
    return Promise.resolve({ ok: true, filename: fname });
  };
  /* 回收站：store.removeBook 优先走 trashBook（移入 trash/，保留期内可还原），
   * 只有旧引擎才退回 deleteBook。若沙箱不实现 trashBook，invoke 会落到
   * storage.js 兜底分支的 default 分支返回 undefined —— 表现为「删除返回成功、
   * 磁盘文件却还在」，测试会误判成删除成功。故此处按真实文件语义实现。 */
  var trashDir = path.join(sb.root, 'trash');
  Storage.trashBook = function (id) {
    var src = pathOf(id);
    if (!fs.existsSync(src)) return Promise.resolve(null);
    var file = String(id) + '__' + Date.now() + '.json';
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(src, path.join(trashDir, file));
    return Promise.resolve(file);
  };
  Storage.listTrash = function () {
    try { return Promise.resolve(fs.readdirSync(trashDir)); } catch (e) { return Promise.resolve([]); }
  };
  Storage.restoreFromTrash = function () { return Promise.resolve({ ok: true, id: null }); };
  Storage.deleteTrashItem = function () { return Promise.resolve({ ok: true }); };
  Storage.emptyTrash = function () { return Promise.resolve({ ok: true, count: 0 }); };

  Storage.saveBackup = function () { return Promise.resolve({ ok: true, ts: Date.now() }); };
  Storage.listBackups = function () { return Promise.resolve([]); };
  Storage.loadBackup = function () { return Promise.resolve(null); };
  Storage.appendChangeLog = function (entry) {
    return Promise.resolve({ ok: true, ts: Date.now(), entry: entry });
  };
  Storage.listChangeLog = function () { return Promise.resolve([]); };

  return {
    meta: function () { return meta; },
    setMeta: function (m) { meta = m; },
    diskBooks: diskBooks,
    exportLog: exportLog,
    pathOf: pathOf
  };
}

/* 自造的 default 账套 fixture —— 刻意**不复制**任何真实账套，避免把客户财务数据
 * 带进临时目录，也避免测试断言依赖"本机恰好存在某份真数据"。
 * 科目规模取 48（与真实账套同量级），故依赖"48"的断言仍然成立。 */
function makeDefaultBook() {
  var subjects = [];
  for (var i = 0; i < 48; i++) {
    var code = String(1001 + i);
    subjects.push({ code: code, name: '测试科目' + code, cls: '资产', normal: 'dr', dc: 1, level: 1 });
  }
  return {
    schemaVersion: 5,
    company: { name: '沙箱测试账套', startMonth: '2026-01', code: 'SANDBOX' },
    subjects: subjects,
    vouchers: [],
    currencies: [{ code: 'CNY', name: '人民币', rate: 1, base: true }]
  };
}

module.exports = {
  create: create,
  install: install,
  makeDefaultBook: makeDefaultBook,
  assertNotReal: assertNotReal
};
