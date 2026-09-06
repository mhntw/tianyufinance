// Tools.js —— 基础功能页（账套管理 / 数据恢复 / 金蝶导入导出）
// 从 app.js 原块精确搬迁（L1369-1908），逻辑逐字一致，只挪窝不改写。
// 依赖全部从全局桥接对象取；XLSX / KinDee 为 index.html 加载的全局。

const H = globalThis.__KINGDEE_HELPERS__ || {};
const $ = H.$;
const S = H.S || window.S;
const showToast = H.showToast;
const refreshAll = H.refreshAll;

// 本地存储引擎封装（替代 serve.py 的 /api/* 备份读写）
// 注意数据契约：Rust 的 list_backups 返回「文件名数组」（如 "default_1724xxx.json"），
// 浏览器兜底返回「{ts,bookId} 对象数组」。这里统一解析为 { ts, file, name, mtime }，
// 供下方 listBackups 渲染与恢复按钮使用。
function storageListBackups(bid) {
  if (typeof window.Storage === 'undefined') return Promise.resolve([]);
  return window.Storage.listBackups(bid).then(function (list) {
    var out = [];
    (list || []).forEach(function (it) {
      var file, label, ts = 0;
      if (typeof it === 'string') {
        // Rust 返回文件名，三类：<id>_<ts>.json / <id>_pre_restore_<ts>.json / <id>_daily_<YYYYMMDD>.json
        file = it;
        var pre = it.indexOf('_pre_restore_') >= 0;
        var dm = /_daily_(\d{4})(\d{2})(\d{2})\.json$/.exec(it);
        if (dm) {
          ts = Date.parse(dm[1] + '-' + dm[2] + '-' + dm[3] + 'T00:00:00') || 0;
          label = '每日快照（' + dm[1] + '-' + dm[2] + '-' + dm[3] + '，自动留档）';
        } else {
          var m = /(\d+)\.json$/.exec(it);
          ts = m ? Number(m[1]) : 0;
          if (!ts) return;
          label = (pre ? '关键节点快照（结账/结转/恢复前）' : '自动备份') + ' · ' + fmtTs(ts);
        }
      } else {
        // 浏览器兜底返回对象：{ ts, bookId }
        ts = it && it.ts;
        if (!ts) return;
        file = (bid ? bid + '_' : '') + ts + '.json';
        label = ((it && it.pre) ? '关键节点快照（结账/结转/恢复前）' : '自动备份') + ' · ' + fmtTs(ts);
      }
      out.push({ file: file, ts: ts, label: label });
    });
    // 按时间倒序（每日快照/关键节点/自动备份按各自时间点混排）
    out.sort(function (a, b) { return b.ts - a.ts; });
    return out;
  }).catch(function () { return []; });
}
// 恢复一律按「完整文件名」取回（自动/关键节点/每日快照均适用）
function storageLoadBackup(bid, file) {
  if (typeof window.Storage === 'undefined') return Promise.resolve(null);
  return window.Storage.loadBackup(bid, file)
    .then(function (txt) { try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; } })
    .catch(function () { return null; });
}

// 覆盖当前账本前先留一份「恢复前快照」，保证误恢复/误导入可一键撤回。
// 返回 true=已留快照，false=留快照失败，null=当前环境不支持（浏览器兜底等，静默跳过不打扰用户）。
function snapshotBeforeRestore() {
  if (typeof window.Storage === 'undefined') return Promise.resolve(null);
  if (typeof window.Storage.saveRestoreSnapshot !== 'function') return Promise.resolve(null);
  var bid = S.currentBookId();
  if (!bid || !S.state) return Promise.resolve(null);
  return Promise.resolve(window.Storage.saveRestoreSnapshot(bid, S.state))
    .then(function (r) { return !!(r && r.ok); })
    .catch(function () { return false; });
}

// 统一守卫：快照失败时让用户知情并二次确认，避免"以为有回滚点结果没有"。
function guardBeforeRestore(tip) {
  return snapshotBeforeRestore().then(function (snap) {
    if (snap === true) return true;                       // 已留快照，放心覆盖
    if (snap === null) return true;                       // 环境不支持，静默放行
    return H.confirmAsync(tip, { title: '未能创建恢复前快照' });
  });
}

/* ============================================================
 * 基础功能：账套列表（刷新入口：app.js 委托桩 -> globalThis.__renderTools）
 * ============================================================ */
function refreshTools() {
  // 先异步用磁盘真实账套刷新索引（桌面版索引真相源为 <应用数据目录>/添钰财务/books/），
  // fire-and-forget：当前渲染仍用已同步的缓存，删除/新建/导入操作后缓存已即时更新。
  if (typeof S.refreshBookIndex === 'function') { try { S.refreshBookIndex(); } catch (e) {} }
  // 账套列表
  var tb = $('bookBody'); tb.innerHTML = '';
  var books = S.listBooks();
  var cur = S.currentBookId();
  books.forEach(function (b) {
    var isCur = b.id === cur;
    var enabled = S.isBookEnabled(b.id);
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + b.name + '</td><td class="mono">' + b.period + '</td><td>' + b.vouchers + '</td>'
      + '<td>' + (isCur ? '<span class="tag tag-current">当前</span>' : (enabled ? '<span class="tag">启用</span>' : '<span class="tag tag-stop">停用</span>')) + '</td>'
      + '<td class="book-ops">'
      + (isCur ? '<span class="muted">已在使用</span>'
          : '<button class="btn btn-xs" data-switch="' + b.id + '">切换</button>'
          + '<button class="btn btn-xs" data-enable="' + b.id + '" data-on="' + (enabled ? 0 : 1) + '">' + (enabled ? '停用' : '启用') + '</button>'
          + '<button class="btn btn-danger-xs" data-del="' + b.id + '">删除</button>')
      + '</td>';
    tb.appendChild(tr);
  });
  if (!books.length) tb.innerHTML = '<tr><td colspan="5" class="empty-hint">暂无账套。</td></tr>';
}

$('bookBody').addEventListener('click', async function (e) {
  var sw = e.target.getAttribute('data-switch');
  var dl = e.target.getAttribute('data-del');
  var en = e.target.getAttribute('data-enable');
  if (sw) {
    var r = S.switchBook(sw);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已切换到「' + (S.state.company.name) + '」'); refreshTools();
    refreshAll();
  } else if (en) {
    var on = e.target.getAttribute('data-on') === '1';
    S.setBookEnabled(en, on);
    showToast(on ? '账套已启用' : '账套已停用');
    refreshTools();
  } else if (dl) {
    // 删除改为移入回收站（保留 7 天可还原），不再是"一键不可逆"
    const nm = (S.listBooks().filter(function (b) { return b.id === dl; })[0] || {}).name || dl;
    const ok = await H.confirmAsync('确定删除账套「' + nm + '」？\n删除后会在回收站保留 7 天，期间可随时还原。', { title: '删除账套' });
    if (!ok) return;
    S.removeBook(dl).then(function (rd) {
      if (!rd || !rd.ok) return showToast((rd && rd.msg) || '删除失败', 'error');
      showToast('账套已移入回收站（7 天内可还原）'); refreshTools();
      if (trashPanelOpen()) renderTrash();
      // 删除账套 changelog 已由 store.removeBook 异步写盘，稍候刷新系统事件卡
      if (globalThis.__renderSysEvents) setTimeout(globalThis.__renderSysEvents, 400);
    }).catch(function (e) {
      showToast('删除失败：' + ((e && e.message) || e), 'error');
    });
  }
});
// 新建账套（可建多个独立核算主体；纯新增+切换，不覆盖现有账套，无需高危密码）
// 简化为单表单弹窗：账套名称 + 会计准则 一次填写（不再两步系统弹窗）
$('btnNewBook').addEventListener('click', function () {
  var nameEl = $('nbName'); if (nameEl) nameEl.value = '';
  if (H.openModal) H.openModal('newBookModal');
});
var nbCreate = $('btnCreateBook');
if (nbCreate) nbCreate.addEventListener('click', function () {
  var name = ($('nbName') && $('nbName').value || '').trim();
  if (!name) return showToast('请输入账套名称', 'warn');
  var key = ($('nbStandard') && $('nbStandard').value) || 'old';
  var STD = (typeof globalThis !== 'undefined' && globalThis.STANDARDS) || {};
  var standardLabel = (STD[key] && STD[key].label) || key;
  S.newBook(name, key);
  if (H.closeModal) H.closeModal('newBookModal');
  showToast('已新建账套「' + S.state.company.name + '」（' + standardLabel + '）并切换至此');
  // 落盘是异步的：等一小段时间待真实文件写完后刷新列表，确保新建账套立即出现
  setTimeout(refreshTools, 250);
  refreshAll();
});
var nbCancel = $('btnCancelNewBook');
if (nbCancel) nbCancel.addEventListener('click', function () { if (H.closeModal) H.closeModal('newBookModal'); });

/* ============================================================
 * 账套备份 / 恢复（Rust 备份目录，环形保留最近 5 份 / 账套）
 * 说明：已随 UI 精简，所有备份按钮并入「账套管理」卡片一行。
 * ============================================================ */
function fmtTs(ts) {
  var d = new Date(ts);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtSize(bytes) {
  var b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
// 距今多少天（向下取整），用于"多久没做本机外副本"
function daysAgo(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

// —— 备份健康度 ——
// 自动备份只说明"数据在滚"，不说明"数据丢不了"：备份和账套在同一块硬盘上，
// 硬盘一坏两者一起没。所以这里额外盯住「最后一次导出到本机之外」的时间。
function renderBackupHealth(st) {
  if (!st) return '';
  var html = '<div class="backup-health">';
  var bits = [st.count + ' 份自动备份'];
  if (st.snapshot_count) bits.push(st.snapshot_count + ' 份恢复前快照');
  bits.push('占用 ' + fmtSize(st.total_bytes));
  if (st.last_ts) bits.push('最近备份 ' + fmtTs(st.last_ts));
  html += '<div class="muted" style="font-size:12px">' + bits.join('　·　') + '</div>';

  // 落盘备份挡不住硬盘损坏，超过 7 天没导出就提醒做本机外副本
  var d = daysAgo(st.last_export_ts);
  if (st.last_export_ts === 0) {
    html += '<div class="health-warn">尚未导出过账套副本。建议点「导出账套」存一份到 U 盘或网盘——自动备份与账套在同一块硬盘上，硬盘损坏时两者会一起丢失。</div>';
  } else if (d !== null && d > 7) {
    html += '<div class="health-warn">已 ' + d + ' 天未导出账套副本（上次导出：' + fmtTs(st.last_export_ts) + '）。建议点「导出账套」存一份到 U 盘或网盘。</div>';
  }
  html += '</div>';
  return html;
}

function listBackups() {
  var box = $('backupList'); if (!box) return;
  var bid = S.currentBookId();
  box.style.display = 'block';
  box.innerHTML = '<p class="muted">正在读取备份…</p>';
  // 备份均落 Rust 备份目录（<应用数据目录>/添钰财务/backups）
  Promise.all([
    storageListBackups(bid),
    (typeof window.Storage !== 'undefined' && window.Storage.backupStats)
      ? window.Storage.backupStats(bid) : Promise.resolve(null)
  ]).then(function (res) {
    var disk = res[0], stats = res[1];
    box.innerHTML = '';
    var html = '<div class="backup-toolbar"><a class="tool-link" id="btnRefreshBk">刷新列表</a><span class="muted" style="font-size:12px">共 ' +
      (disk ? disk.length : 0) + ' 份备份</span></div>';
    html += renderBackupHealth(stats);
    if (disk !== null && disk.length) {
      html += '<p class="backup-sec-title">账套备份（最安全，落真实文件）</p>';
      disk.forEach(function (b) {
        html += '<div class="backup-item"><span>' + esc(b.label || '') + '</span>' +
          '<button class="btn btn-xs" data-file="' + esc(b.file) + '">恢复</button></div>';
      });
    }
    if (!disk || !disk.length) {
      html += '<p class="muted">暂无备份（点击「立即备份」创建）</p>';
    }
    box.innerHTML = html;
  }).catch(function (e) { showToast('读取备份失败：' + (e && e.message || e), 'error'); });
}

/* ============================================================
 * 账套回收站：删除的账套保留 7 天，可还原 / 彻底删除
 * ============================================================ */
function trashPanelOpen() {
  var p = $('trashPanel');
  return !!(p && p.style.display !== 'none');
}
function renderTrash() {
  var box = $('trashPanel'); if (!box) return;
  if (typeof window.Storage === 'undefined' || !window.Storage.listTrash) {
    box.innerHTML = '<p class="muted">当前环境不支持回收站</p>';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = '<p class="muted">正在读取回收站…</p>';
  window.Storage.listTrash().then(function (items) {
    items = items || [];
    var html = '<div class="backup-toolbar"><a class="tool-link" id="btnRefreshTrash">刷新</a>'
      + '<span class="muted" style="font-size:12px">共 ' + items.length + ' 项（保留 7 天，过期自动清理）</span>'
      + (items.length ? '<a class="tool-link" id="btnEmptyTrash" style="margin-left:12px">清空回收站</a>' : '')
      + '</div>';
    if (!items.length) {
      html += '<p class="muted">回收站为空</p>';
    } else {
      items.forEach(function (it) {
        var left = 7 - (daysAgo(it.ts) || 0);
        var expire = left <= 0 ? '即将清理' : ('还剩 ' + left + ' 天');
        html += '<div class="backup-item"><span>' + esc(it.name) + '（删除于 ' + fmtTs(it.ts) + '，' + expire + '）</span>'
          + '<button class="btn btn-xs" data-trash-restore="' + esc(it.file) + '">还原</button>'
          + '<button class="btn btn-danger-xs" data-trash-del="' + esc(it.file) + '">彻底删除</button></div>';
      });
    }
    box.innerHTML = html;
  }).catch(function (e) {
    box.innerHTML = '<p class="muted">读取回收站失败：' + ((e && e.message) || e) + '</p>';
  });
}
// 回收站里的账套名取自 JSON 内容，属于用户可控数据，插入 HTML 前必须转义
function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
// 回收站 DOM 是本次新增的：若 index.html 尚未同步（如 dist 未重建），
// 直接 addEventListener 会在模块加载期抛错并带崩整个页面，故先判空再绑定。
var trashBtn = $('btnToggleTrash'), trashBox = $('trashPanel');
if (trashBtn && trashBox) {
  trashBtn.addEventListener('click', function () {
    if (trashBox.style.display !== 'none') { trashBox.style.display = 'none'; return; }
    renderTrash();
  });
}
// 回收站相关操作（还原/彻底删除/清空）直接走 Storage，不经 store.removeBook，
// 故在本地补齐 changelog 留痕（跨账套系统事件，供「账套与系统事件」卡展示）。
// 注：removeBook（移入回收站）已自带 changelog「删除账套」。
function logSysEvent(action, detail, bookId) {
  try {
    if (typeof window.Storage === 'undefined' || typeof window.Storage.appendChangeLog !== 'function') return;
    var user = (S && S.state && S.state.company && S.state.company.bookkeeper) || '会计';
    window.Storage.appendChangeLog({ bookId: bookId || '', action: action, module: '账套', detail: detail, user: user })
      .catch(function () {});
  } catch (e) {}
}
if (trashBox) trashBox.addEventListener('click', async function (e) {
  var t = e.target;
  if (!t || t.tagName !== 'A' && t.tagName !== 'BUTTON') return;
  var restoreFile = t.getAttribute('data-trash-restore');
  var delFile = t.getAttribute('data-trash-del');
  if (t.id === 'btnRefreshTrash') { renderTrash(); return; }
  if (t.id === 'btnEmptyTrash') {
    // 高危操作保护：整账套永久删除，先验证操作密码（默认 admin，可在系统设置修改）
    if (!(await H.askOpPassword('清空账套回收站'))) return;
    const ok = await H.confirmAsync('确定清空回收站？其中的账套将永久删除，无法还原。', { title: '清空回收站' });
    if (!ok) return;
    var r = await window.Storage.emptyTrash();
    showToast(r && r.ok ? ('已清空回收站（' + r.count + ' 项）') : '清空失败', (r && r.ok) ? 'success' : 'error');
    if (r && r.ok) logSysEvent('清空回收站', '清空账套回收站（' + (r.count || 0) + ' 项，永久删除）');
    renderTrash();
    if (globalThis.__renderSysEvents) setTimeout(globalThis.__renderSysEvents, 400);
    return;
  }
  if (restoreFile) {
    try {
      var rr = await window.Storage.restoreFromTrash(restoreFile);
      if (!rr || !rr.ok) { showToast('还原失败', 'error'); return; }
      // 原 id 被占用时 Rust 会换一个新 id 落回，这里如实告知，避免用户找不到账套
      await S.refreshBookIndex();
      showToast('账套已还原' + (rr.id ? '（' + rr.id + '）' : ''));
      logSysEvent('还原账套', '还原账套（' + (rr.id || '') + '）', rr.id || '');
      renderTrash(); refreshTools(); refreshAll();
      if (globalThis.__renderSysEvents) setTimeout(globalThis.__renderSysEvents, 400);
    } catch (err) { showToast('还原失败：' + ((err && err.message) || err), 'error'); }
    return;
  }
  if (delFile) {
    // 规则：单条彻底删除与「清空回收站」同为不可逆操作 → 必须先验证操作密码
    if (!(await H.askOpPassword('彻底删除账套'))) return;
    const ok2 = await H.confirmAsync('确定彻底删除该账套？此操作不可恢复。', { title: '彻底删除' });
    if (!ok2) return;
    var rd = await window.Storage.deleteTrashItem(delFile);
    showToast(rd && rd.ok ? '已彻底删除' : '删除失败', (rd && rd.ok) ? 'success' : 'error');
    if (rd && rd.ok) logSysEvent('彻底删除账套', '彻底删除回收站账套（' + delFile + '，不可恢复）');
    renderTrash();
    if (globalThis.__renderSysEvents) setTimeout(globalThis.__renderSysEvents, 400);
  }
});
// 手动备份：立即落 Rust 备份目录（<应用数据目录>/添钰财务/backups）。
$('btnBkNow').addEventListener('click', function () {
  var r = S.backupNow();
  Promise.resolve(r).then(function (ok) {
    if (ok) { showToast('已创建备份'); listBackups(); }
    else showToast('备份失败，请查看软件控制台确认原因', 'error');
  });
});
// 查看备份 / 恢复
$('btnListBackup').addEventListener('click', listBackups);
$('backupList').addEventListener('click', async function (e) {
  if (e.target.id === 'btnRefreshBk') { listBackups(); return; }
  if (e.target.tagName !== 'BUTTON') return;
  const ok = await H.confirmAsync('确定用该备份覆盖当前账本？\n（覆盖前会自动留一份「恢复前快照」，可随时再恢复回来）', { title: '恢复备份' });
  if (!ok) return;
  // 覆盖前强制留快照：一旦恢复到的备份不对，可从快照回滚，不再是不可逆操作
  const goon = await guardBeforeRestore('未能创建「恢复前快照」，继续恢复将无法撤回。是否仍要继续？');
  if (!goon) return;
  var file = e.target.getAttribute('data-file');
  var bid = S.currentBookId();
  var done = function (st) {
    if (!st) return showToast('备份数据为空', 'error');
    S.restoreBookState(st);
    showToast('已恢复备份（如需撤销，可恢复列表中的关键节点/每日快照）');
    refreshAll(); listBackups(); refreshTools();
  };
  if (file) {
    storageLoadBackup(bid, file)
      .then(function (st) {
        if (!st) throw new Error('读取备份失败');
        done(st);
      })
      .catch(function (err) { showToast('恢复失败：' + (err && err.message || err), 'error'); });
  }
});
// 打开导出目录。
// 实现：Tauri 下用 invoke('open_in_explorer', {path}) 在 Rust 端用 open crate 直接打开系统文件管理器，
// 彻底绕过 opener 插件的 scope 限制，跨平台（macOS Finder / Windows 资源管理器）、打包后均稳。
// 非 Tauri 环境（浏览器 dev）：直接提示绝对路径。
function openExportsFolder() {
  if (typeof window.Storage === 'undefined') return;
  window.Storage.getDataDir().then(function (dir) {
    if (!dir) return showToast('无法获取导出目录', 'error');
    var exportsDir = dir.replace(/\/?$/, '') + '/exports';
    var tauri = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
    if (tauri && tauri.invoke) {
      return tauri.invoke('open_in_explorer', { path: exportsDir })
        .then(function () {})
        .catch(function (e) { showToast('打开文件夹失败：' + (e && e.message || e), 'error'); });
    }
    // 非 Tauri 环境：提示绝对路径，由用户手动打开
    showToast('导出目录：' + exportsDir);
  }).catch(function (e) {
    showToast('无法获取导出目录：' + (e && e.message || e), 'error');
  });
}

// 导出全部账套为独立 .json（逐账套导出到 <应用数据目录>/添钰财务/exports/，用户可在该目录取用）。
// 数据来源：优先从存储引擎拉取磁盘权威完整 state，保证导出的是真实落盘数据。
// 导出完成后明确展示完整绝对路径，并提供「打开文件夹」按钮（用系统文件管理器打开）。
$('btnBkAll').addEventListener('click', function () {
  var books = S.listBooks();
  if (!books.length) return showToast('暂无账套可导出', 'error');
  var total = books.length, done = 0, okCount = 0, lastFile = '';
  books.forEach(function (b) {
    var p;
    if (typeof window.Storage !== 'undefined') {
      p = window.Storage.loadBook(b.id)
        .then(function (txt) { try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; } })
        .catch(function () { return null; });
    } else {
      p = Promise.resolve(null);
    }
    p.then(function (st) {
      if (!st) { done++; return; }
      if (typeof window.Storage !== 'undefined') {
        return window.Storage.exportBook(b.id, JSON.stringify(st))
          .then(function (r) {
            if (r && r.ok) { okCount++; lastFile = (r.filename || b.name); }
          })
          .catch(function (e) { showToast('导出「' + b.name + '」失败：' + (e && e.message || e), 'error'); });
      }
    }).then(function () {
      done++;
      if (done === total) {
        if (okCount === 0) return showToast('导出失败（磁盘写入异常）', 'error');
        // 展示完整路径 + 打开文件夹入口
        window.Storage.getDataDir().then(function (dir) {
          var full = (dir ? dir.replace(/\/?$/, '') + '/exports' : 'exports 目录');
          showToast('已导出 ' + okCount + ' 个账套到：' + full, 'success', 4000);
        // 提示文案明确为「导出账套」，与「备份」（backups/ 自动备份）概念脱钩
          // 在备份卡片区域追加一个「打开文件夹」入口
          try {
            var box = $('backupList');
            if (box) {
              var tip = document.getElementById('exportOpenTip');
              if (!tip) {
                tip = document.createElement('div');
                tip.id = 'exportOpenTip';
                tip.className = 'export-tip';
                box.parentNode.insertBefore(tip, box);
              }
              tip.innerHTML = '<span class="muted">导出完成：' + full + '</span> ' +
                '<button class="btn btn-xs" id="btnOpenExports">打开文件夹</button>';
              var ob = document.getElementById('btnOpenExports');
              if (ob) ob.addEventListener('click', openExportsFolder);
            }
          } catch (e) {}
        }).catch(function () { showToast('已导出 ' + okCount + ' 个账套', 'success'); });
      }
    });
  });
});
// 导入备份文件（.json 恢复）
$('btnImportBackup').addEventListener('click', function () { $('bkFile').click(); });
$('bkFile').addEventListener('change', function (e) {
  var f = e.target.files[0]; if (!f) return;
  var reader = new FileReader();
  reader.onload = async function (ev) {
    var input = e.target;
    try {
      var st = JSON.parse(ev.target.result);
      if (!st || !st.company) { showToast('文件不是有效的账套备份', 'error'); input.value = ''; return; }
      // 外部文件导入同样是整体覆盖当前账本，先留快照以便撤回
      const goon = await guardBeforeRestore('未能创建「恢复前快照」，继续导入将无法撤回。是否仍要继续？');
      if (!goon) { input.value = ''; return; }
      S.restoreBookState(st);
      showToast('已从备份文件恢复（如需撤销，可恢复列表中「恢复前快照」）');
      refreshAll(); listBackups(); refreshTools();
    } catch (err) { showToast('解析失败：' + err.message, 'error'); }
    input.value = '';
  };
  reader.onerror = function () { showToast('读取文件失败', 'error'); e.target.value = ''; };
  reader.readAsText(f);
});
// 暴露给 Settings.js 用于初始刷新备份状态
globalThis.listBackups = listBackups;
// 暴露覆盖前快照守卫：Settings.js 的「导入账套」同为整体覆盖，复用同一套保护
globalThis.__guardBeforeRestore = guardBeforeRestore;

export { refreshTools };
