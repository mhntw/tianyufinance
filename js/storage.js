/*
 * storage.js —— Tauri 桌面版存储引擎
 * 替代原浏览器的 File System Access API / IndexedDB 方案。
 *
 * 数据根目录（由 Rust 后端管理，自动创建）：
 *   macOS:   ~/Library/Application Support/添钰财务/
 *   Windows: %APPDATA%\添钰财务\
 * 注意：必须用应用数据目录而非「文档」，否则会被 iCloud / OneDrive 静默同步（详见 lib.rs）
 *   books/<id>.json        账套（真相源，原子写）
 *   backups/<bookId>_<ts>.json  滚动备份
 *   changelog.json         操作日志
 *   exports/<name>_<date>.json 用户手动导出备份
 *
 * 所有读写通过 window.__TAURI__.tauri.invoke 调用 Rust 命令完成。
 * 对外 API 与原浏览器版保持一致，store.js 无需改动即可使用。
 */
(function (global) {
  'use strict';

  // Tauri 全局 API（withGlobalTauri: true 时挂在 window.__TAURI__；v2 中 invoke 在 core 命名空间）
  function getInvoke() {
    try {
      if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === 'function') {
        return global.__TAURI__.core.invoke;
      }
    } catch (e) {}
    return null;
  }

  // 在浏览器（非 Tauri）环境下提供内存兜底，避免开发期直接打开 index.html 时整页报错。
  // 注意：浏览器直接打开的功能受限，正式使用请通过 Tauri 应用。
  var memBooks = {};
  var memBackups = {};
  var memChangelog = [];

  var TAURI = (typeof global.isTauri !== 'undefined') ? global.isTauri
            : (typeof global.__TAURI__ !== 'undefined');

  function invoke(cmd, args) {
    var fn = getInvoke();
    if (fn) return fn(cmd, args || {});
    // 浏览器兜底（仅用于非 Tauri 调试，不保证数据持久）
    return fallback(cmd, args || {});
  }

  function fallback(cmd, args) {
    switch (cmd) {
      case 'save_book': memBooks[args.id] = args.json; return Promise.resolve();
      case 'load_book': return Promise.resolve(memBooks[args.id] !== undefined ? memBooks[args.id] : null);
      case 'list_books': return Promise.resolve(Object.keys(memBooks));
      case 'delete_book': delete memBooks[args.id]; return Promise.resolve();
      case 'save_backup':
        var k = args.book_id; memBackups[k] = memBackups[k] || [];
        memBackups[k].push({ ts: Date.now(), json: args.json });
        return Promise.resolve({ ts: Date.now() });
      case 'save_restore_snapshot':
        var rk = args.book_id; memBackups[rk] = memBackups[rk] || [];
        memBackups[rk].push({ ts: Date.now(), json: args.json, pre: true });
        return Promise.resolve(rk + '_pre_restore_' + Date.now() + '.json');
      case 'list_backups':
        var bk = memBackups[args.book_id || ''] || [];
        return Promise.resolve(bk.map(function (b) { return { ts: b.ts, bookId: args.book_id }; }));
      case 'load_backup': return Promise.resolve(null);
      case 'append_changelog': memChangelog.push(args.entry); return Promise.resolve();
      case 'list_changelog': return Promise.resolve(memChangelog);
      case 'get_data_dir': return Promise.resolve('<浏览器调试模式，无真实文件>');
      case 'debug_status': return Promise.resolve({ dir: '<浏览器调试模式>', books: Object.keys(memBooks) });
      default: return Promise.resolve();
    }
  }

  // 本地日期 YYYYMMDD（每日快照按本地日分天，避免用 UTC 日期差一天）
  function localYmd() {
    var d = new Date();
    return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  var Storage = {
    // Tauri 桌面版恒为文件模式
    isFileMode: function () { return true; },
    fsAvailable: function () { return true; },
    isTauri: function () { return TAURI; },

    // 初始化：Tauri 下数据目录由后端保证存在，无需用户手势，直接就绪。
    init: function () {
      return Promise.resolve(true);
    },

    // 兼容旧调用（不再需要用户手势授权）
    requestDirFromUser: function () { return Promise.resolve(true); },
    probeWrite: function () { return Promise.resolve(true); },

    // 写账套主文件 books/<id>.json
    saveBook: function (id, json) {
      var payload = (typeof json === 'string') ? json : JSON.stringify(json);
      return invoke('save_book', { id: id, json: payload })
        .then(function () { return { ok: true, mode: 'file' }; })
        .catch(function (e) { return { ok: false, mode: 'file', error: String(e) }; });
    },

    // 读账套主文件
    loadBook: function (id) {
      return invoke('load_book', { id: id }).then(function (txt) {
        return (txt === undefined || txt === null) ? null : txt;
      });
    },

    // 列出全部账套 id
    listBooks: function () {
      return invoke('list_books').then(function (ids) { return ids || []; });
    },

    // 删除账套
    deleteBook: function (id) {
      return invoke('delete_book', { id: id }).then(function () { return { ok: true, mode: 'file' }; });
    },

    // 写备份 backups/<bookId>_<ts>.json；附本地日期供后端补「每日快照」（每天 1 份，保留 31 天）
    saveBackup: function (bookId, state) {
      var payload = (typeof state === 'string') ? state : JSON.stringify(state);
      // Tauri 2 默认把 Rust snake_case 参数转 camelCase：book_id → bookId
      return invoke('save_backup', { bookId: bookId, json: payload, day: localYmd() })
        .then(function (fname) {
          var ts = (fname && /\d+/.test(fname)) ? Number(fname.match(/\d+/)[0]) : Date.now();
          return { ok: true, ts: ts };
        });
    },

    // 恢复/导入覆盖当前账本前的强制快照：backups/<bookId>_pre_restore_<ts>.json
    // 与 saveBackup 的区别：文件名带 pre_restore 标记，备份列表可识别为回滚点，且单独配额保留。
    // 与 saveBackup 不同，失败不 reject，而是返回 {ok:false}，交由调用方决定是否继续覆盖。
    saveRestoreSnapshot: function (bookId, state) {
      var payload = (typeof state === 'string') ? state : JSON.stringify(state);
      return invoke('save_restore_snapshot', { bookId: bookId, json: payload, day: localYmd() })
        .then(function (fname) {
          var m = /(\d+)\.json$/.exec(fname || '');
          return { ok: true, ts: m ? Number(m[1]) : Date.now(), filename: fname };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // 列出某账套备份：返回 [{ts, bookId}]
    listBackups: function (bookId) {
      return invoke('list_backups', { bookId: bookId }).then(function (list) { return list || []; });
    },

    // 备份健康度：份数 / 占用 / 最近备份时间 / 最近导出时间（供"该做本机外副本了吗"提醒）
    backupStats: function (bookId) {
      return invoke('backup_stats', { bookId: bookId })
        .then(function (s) { return s || null; })
        .catch(function () { return null; });
    },

    // —— 账套回收站：删除改为移入 trash/，保留期内可还原 ——
    trashBook: function (id) {
      return invoke('trash_book', { id: id }).then(function (file) { return { ok: true, file: file }; });
    },
    listTrash: function () {
      return invoke('list_trash').then(function (list) { return list || []; })
        .catch(function () { return []; });
    },
    // 还原：返回落回后的账套 id（原 id 被占用时会自动换 id，故以返回值为准）
    restoreFromTrash: function (file) {
      return invoke('restore_book_from_trash', { file: file })
        .then(function (id) { return { ok: true, id: id }; });
    },
    deleteTrashItem: function (file) {
      return invoke('delete_trash_item', { file: file }).then(function () { return { ok: true }; });
    },
    emptyTrash: function () {
      return invoke('empty_trash').then(function (n) { return { ok: true, count: n || 0 }; });
    },

    // 读备份内容（filename 形式）
    loadBackup: function (bookId, ts) {
      // 兼容：若 store.js 传入 ts 数字，则拼成文件名查询
      var fname = (typeof ts === 'number') ? (bookId + '_' + ts + '.json') : String(ts);
      return invoke('load_backup', { filename: fname }).then(function (txt) {
        return (txt === undefined || txt === null) ? null : txt;
      });
    },

    // 追加变更日志
    appendChangeLog: function (entry) {
      var rec = Object.assign({ ts: Date.now(), time: new Date().toISOString() }, entry);
      return invoke('append_changelog', { entry: JSON.stringify(rec) }).then(function () { return rec; });
    },
    // 读取全局变更日志（changelog.json：账套级事件跨账套留痕，如删除/导入账套）。
    // Rust 端存 Vec<String>（每条为一段 JSON 字符串），此处解析为对象数组返回。
    listChangeLog: function () {
      return invoke('list_changelog').then(function (list) {
        list = list || [];
        return list.map(function (s) {
          try { return JSON.parse(s); } catch (e) { return null; }
        }).filter(function (x) { return x != null; });
      }).catch(function () { return []; });
    },

    // 导出单个账套为独立 .json 到 exports/（用户可携带备份）
    exportBook: function (bookId, json) {
      return invoke('export_book', { id: bookId, json: json }).then(function (fname) {
        return { ok: true, filename: fname };
      });
    },

    // 读取账套元信息（轻量：当前账套指针 + 停用标记），落磁盘 meta.json，不依赖易失缓存
    readMeta: function () {
      return invoke('read_meta_cmd').then(function (m) {
        return m || { last_book: null, disabled: {} };
      }).catch(function () { return { last_book: null, disabled: {} }; });
    },

    // 写入账套元信息（meta_json 为 { last_book, disabled } 的 JSON 字符串）
    writeMeta: function (metaObj) {
      var json = (typeof metaObj === 'string') ? metaObj : JSON.stringify(metaObj);
      // Tauri 2 默认 camelCase：meta_json → metaJson
      return invoke('write_meta_cmd', { metaJson: json }).then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // 数据根目录绝对路径（用于导出后展示文件位置）
    getDataDir: function () {
      return invoke('get_data_dir').then(function (d) { return d || ''; })
        .catch(function () { return ''; });
    },

    // 调试/状态自检
    debugStatus: function () {
      return invoke('debug_status').then(function (r) {
        return { mode: 'file', fileMode: true, dir: r.dir, books: r.books };
      });
    }
  };

  global.Storage = Storage;
})(window);
