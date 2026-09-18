// CloudSync.js —— 云同步（WebDAV，手动触发）
// 设计边界（与后端 sync.rs 一致，改动前先读）：
// 1. 软件永不在后台联网：只有用户点「云备份 / 云同步」才发起请求；
// 2. 同步只做「补齐与覆盖」，永不删除；
// 3. 取回（云同步）前后端已自动给本机被覆盖的账套留备份，可在「查看备份」回滚；
// 4. 对端存在更更新的账套时先给一次确认，不静默覆盖。

const H = globalThis.__TY_HELPERS__ || {};
const $ = H.$;
const S = H.S || window.S;
const showToast = H.showToast;
const refreshAll = H.refreshAll;

const LAST_KEY = 'cloud_sync_last';

function readLast() {
  try {
    var s = localStorage.getItem(LAST_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}
function writeLast(dir, n) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ t: Date.now(), dir: dir, n: n || 0 }));
  } catch (e) {}
}
function fmtTime(ts) {
  var d = new Date(ts);
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function cloudLabel(c) {
  var dir = (c && c.dir) ? c.dir : '添钰财务同步';
  var u = (c && c.url) ? String(c.url).replace(/\/+$/, '') : '';
  return u + ' · ' + dir;
}

/* ---------------- 渲染：未配置 / 已配置两态 ---------------- */
async function refreshCloudSync() {
  if (!$('cardCloudSync')) return;
  if (typeof window.Storage === 'undefined' || !window.Storage.syncGetConfig) return;
  bindCloudSync();
  var c = await window.Storage.syncGetConfig();
  lastCfg = c && c.url ? c : null; // 供 openConfig 同步判断，见该函数注释
  var ok = !!(c && c.url);
  $('csUnset').style.display = ok ? 'none' : '';
  $('csSet').style.display = ok ? '' : 'none';
  if (!ok) return;
  var lab = $('csCloud'); if (lab) lab.textContent = cloudLabel(c);
  var last = readLast();
  var el = $('csLast');
  if (el) {
    if (last) {
      el.textContent = fmtTime(last.t) + ' · ' + (last.dir === 'push' ? '云备份' : '云同步') + (last.n ? '（' + last.n + ' 本）' : '');
    } else if (c.lastPush) {
      // localStorage 会随 WebView 缓存一起丢（换机/清缓存），后端 lastPush 才是真相源
      el.textContent = fmtTime(c.lastPush) + ' · 云备份';
    } else {
      el.textContent = '尚未同步过';
    }
  }
}

/* ---------------- 弹窗 ---------------- */
// 最近一次读到的云端配置（refreshCloudSync 写入）。
// 用途：openConfig 需要同步判断「清空设置」该不该显示——若等异步返回再决定，
// 弹窗打开后按钮会晚一拍冒出来（闪烁）。这里用缓存先定，异步返回后再校正一次。
var lastCfg = null;

function openConfig() {
  var u = $('csUrl'), s = $('csUser'), p = $('csPass');
  var bClear = $('btnCsClear');
  var hint = $('csPassHint');
  if (u) u.value = 'https://dav.jianguoyun.com/dav/';
  if (s) s.value = '';
  if (p) p.value = '';
  // 默认按「未配置」收起，避免清空设置后再打开时残留旧状态
  if (bClear) bClear.style.display = 'none';
  if (hint) hint.style.display = 'none';
  if (lastCfg && lastCfg.url) {
    if (u) u.value = lastCfg.url;
    if (s) s.value = lastCfg.user || '';
    // 后端不返回真实密码，只给掩码：这里回填掩码表示"已记住"
    if (p) p.value = lastCfg.pass || '';
    if (hint) hint.style.display = '';
    if (bClear) bClear.style.display = '';
  }
  // 已配置时回填（密码不外露，留空表示不修改）；同时校正上面的缓存判断
  if (typeof window.Storage !== 'undefined' && window.Storage.syncGetConfig) {
    window.Storage.syncGetConfig().then(function (c) {
      if (!c || !c.url) return;
      lastCfg = c;
      if (u) u.value = c.url;
      if (s) s.value = c.user || '';
      if (p) p.value = c.pass || '';
      if (hint) hint.style.display = '';
      if (bClear) bClear.style.display = '';
    });
  }
  if (H.openModal) H.openModal('cloudSyncModal');
}
function formVals() {
  // 云端目录由后端自动选择（坚果云根目录不允许建文件夹时会自动落到已有同步文件夹下）
  var rawPass = ($('csPass') && $('csPass').value || '');
  // 回填的是掩码（******）：视为"未修改"，提交空串让后端沿用已保存的应用密码
  if (/^\*+$/.test(rawPass)) rawPass = '';
  return {
    url: ($('csUrl') && $('csUrl').value || '').trim(),
    user: ($('csUser') && $('csUser').value || '').trim(),
    pass: rawPass.trim(),
    dir: ''
  };
}

/* ---------------- 同步动作 ---------------- */
function busy(on, btn, txt) {
  var b1 = $('btnCsPush'), b2 = $('btnCsPull');
  if (b1) b1.disabled = on;
  if (b2) b2.disabled = on;
  var t = btn || null;
  if (on && t) {
    t.dataset.txt = t.textContent;
    t.textContent = txt || '同步中…';
  } else if (t && t.dataset.txt) {
    t.textContent = t.dataset.txt;
  }
}

async function doPush(force) {
  var btn = $('btnCsPush');
  busy(true, btn, '备份中…');
  var r = await window.Storage.syncPush(force);
  busy(false, btn);
  if (r.error) return showToast(r.error, 'error');
  if ((r.conflicts || []).length && !force) {
    var n = r.conflicts.length;
    var ok = await H.confirmAsync(
      '云端有 ' + n + ' 本账套比本机新：\n\n' +
      r.conflicts.map(function (x) { return '· ' + x; }).join('\n') +
      '\n\n继续会用本机覆盖它们（建议先点「云同步」取回）。\n确认继续备份？',
      { title: '云备份' }
    );
    if (!ok) return;
    return doPush(true);
  }
  try { S.addLog('云备份', '备份 ' + (r.pushed || 0) + ' 本账套到云端', '云同步'); } catch (e) {}
  writeLast('push', r.pushed || 0);
  refreshCloudSync();
  showToast('已备份 ' + (r.pushed || 0) + ' 本账套到云端', 'success');
}

async function doPull(force) {
  var btn = $('btnCsPull');
  busy(true, btn, '同步中…');
  var r = await window.Storage.syncPull(force);
  busy(false, btn);
  if (r.error) return showToast(r.error, 'error');
  if ((r.conflicts || []).length && !force) {
    var n = r.conflicts.length;
    var ok2 = await H.confirmAsync(
      '本机有 ' + n + ' 本账套比云端新：\n\n' +
      r.conflicts.map(function (x) { return '· ' + x; }).join('\n') +
      '\n\n取回会用云端覆盖它们（覆盖前会自动留本机备份，可在「查看备份」回滚）。\n确认继续？',
      { title: '云同步' }
    );
    if (!ok2) return;
    return doPull(true);
  }
  if (!r.pulled) return showToast('云端暂无账套可同步', 'warn');
  try { S.addLog('云同步', '从云端取回 ' + r.pulled + ' 本账套（新增 ' + (r.added || 0) + ' 本）', '云同步'); } catch (e) {}
  writeLast('pull', r.pulled || 0);
  refreshCloudSync();
  refreshAll();
  if (globalThis.__renderTools) setTimeout(globalThis.__renderTools, 300);
  showToast('已同步 ' + r.pulled + ' 本账套（新增 ' + (r.added || 0) + ' 本）', 'success');
}

/* ---------------- 事件绑定（一次性） ---------------- */
function bindCloudSync() {
  if (globalThis.__csBound) return;
  var bCfg = $('btnCsConfig'), bRe = $('btnCsReconfig'), bClr = $('btnCsClear');
  var bSave = $('btnCsSave'), bTest = $('btnCsTest'), bCancel = $('btnCsCancel');
  var bPush = $('btnCsPush'), bPull = $('btnCsPull');
  if (!bPush || !bPull) return;

  if (bCfg) bCfg.addEventListener('click', openConfig);
  if (bRe) bRe.addEventListener('click', openConfig);

  if (bClr) bClr.addEventListener('click', async function () {
    var ok = await H.confirmAsync(
      '清空后本机不再保留云端地址与账号，再次同步需重新填写。\n云端已备份的账套不会删除。\n确认清空？',
      { title: '清空云同步设置' }
    );
    if (!ok) return;
    var r = await window.Storage.syncClearConfig();
    if (r && r.ok === false) return showToast(r.error || '清空失败', 'error');
    lastCfg = null; // 立即失效，避免下次打开弹窗还按"已配置"显示「清空设置」
    // 本机记录也一并清掉：否则重新配置后卡片会显示一条并不存在的「上次操作」
    try { localStorage.removeItem(LAST_KEY); } catch (e) {}
    if (H.closeModal) H.closeModal('cloudSyncModal');
    showToast('已清空云同步设置', 'success');
    refreshCloudSync();
  });

  if (bTest) bTest.addEventListener('click', async function () {
    var v = formVals();
    if (!v.url || !v.user) return showToast('请填写服务器地址与账号', 'warn');
    if (!v.pass) {
      // 密码留空时后端会沿用已保存的应用密码；未配置过则必须填
      var c = await window.Storage.syncGetConfig();
      if (!c || !c.url) return showToast('请填写应用密码', 'warn');
    }
    bTest.disabled = true;
    bTest.textContent = '测试中…';
    var r = await window.Storage.syncTest(v.url, v.user, v.pass, v.dir);
    bTest.disabled = false;
    bTest.textContent = '测试连接';
    if (r && r.ok) showToast(r.msg || '连接成功', 'success');
    else showToast((r && r.error) || '连接失败', 'error');
  });

  if (bSave) bSave.addEventListener('click', async function () {
    var v = formVals();
    if (!v.url || !v.user) return showToast('请填写服务器地址与账号', 'warn');
    var r = await window.Storage.syncSetConfig(v.url, v.user, v.pass, v.dir);
    if (r && r.ok === false) return showToast(r.error || '保存失败', 'error');
    if (H.closeModal) H.closeModal('cloudSyncModal');
    showToast('云同步已配置', 'success');
    refreshCloudSync();
  });

  if (bCancel) bCancel.addEventListener('click', function () {
    if (H.closeModal) H.closeModal('cloudSyncModal');
  });

  bPush.addEventListener('click', function () { doPush(false); });
  bPull.addEventListener('click', function () { doPull(false); });

  globalThis.__csBound = true;
}

// 首页「去配置」跳转时直接打开配置弹窗
globalThis.__CS_OPEN_CONFIG__ = openConfig;

export { refreshCloudSync };
