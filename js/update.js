/* 更新检查（直连 GitHub，简单稳定）
 *
 * 流程：
 *   1. 启动/手动 → 查 GitHub API → 发现新版
 *   2. 点击下载 → 浏览器直连 GitHub Release 资产地址
 */

(function () {
  'use strict';

  var REPO_RELEASE = 'https://github.com/mhntw/tianyufinance/releases';
  var REPO_API = 'https://api.github.com/repos/mhntw/tianyufinance/releases/latest';

  var CACHE_KEY = 'ty_update_check';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  var NOTIFIED_KEY = 'ty_update_notified';
  var NOTIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function getLocalVersion() {
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (tauri && tauri.invoke) {
      return tauri.invoke('app_version').catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function openUrl(url) {
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (tauri && tauri.invoke) {
      tauri.invoke('open_url', { url: url }).catch(function () {
        window.open(url, '_blank');
      });
    } else {
      window.open(url, '_blank');
    }
  }

  function getLatestRelease() {
    return fetch(REPO_API, {
      headers: { 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      return {
        tag: (data.tag_name || '').replace(/^v/, ''),
        url: data.html_url,
        assets: (data.assets || []).map(function (a) {
          return { name: a.name, url: a.browser_download_url, size: a.size };
        })
      };
    }).catch(function (e) {
      console.warn('[update] 检查更新失败:', e.message);
      return null;
    });
  }

  function pickAsset(assets) {
    if (!assets || !assets.length) return null;
    var isMac = /darwin|mac/i.test(navigator.platform + navigator.userAgent);
    var isWin = /win/i.test(navigator.platform + navigator.userAgent);
    var isArmMac = isMac && /arm|aarch64|Apple Silicon/i.test(navigator.userAgent);
    var patterns = [];
    if (isMac) {
      if (isArmMac) patterns = [/aarch64.*\.dmg$/i, /arm64.*\.dmg$/i, /\.dmg$/i];
      else patterns = [/x64.*\.dmg$/i, /amd64.*\.dmg$/i, /\.dmg$/i];
    } else if (isWin) {
      patterns = [/x64.*\.exe$/i, /amd64.*\.exe$/i, /\.exe$/i];
    }
    for (var i = 0; i < patterns.length; i++) {
      for (var j = 0; j < assets.length; j++) {
        if (patterns[i].test(assets[j].name)) return assets[j];
      }
    }
    return assets[0];
  }

  function compareSemver(a, b) {
    a = String(a).replace(/^v/, '').split('.').map(Number);
    b = String(b).replace(/^v/, '').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var av = a[i] || 0, bv = b[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  function parseVersion(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') return raw.version || raw.pkgVersion || null;
    return null;
  }

  function triggerDownload(assetUrl, releaseUrl) {
    openUrl(assetUrl || releaseUrl || REPO_RELEASE);
  }

  // 在关于卡常驻一个可点击的「下载 vX →」入口，避免只依赖一闪而过的 toast
  function surfaceDownload(latest, asset) {
    var chk = document.getElementById('aboutCheckUpdate');
    if (chk) {
      chk.textContent = '下载 v' + latest.tag + ' →';
      chk.style.cursor = 'pointer';
      chk.onclick = function () { triggerDownload(asset ? asset.url : null, latest.url); };
    }
  }

  // 让“发现新版本”提示点击后真正触发下载并收起 toast
  function bindToastDownload(asset, latest) {
    var tEl = document.getElementById('toast');
    if (!tEl) return;
    tEl.style.cursor = 'pointer';
    tEl.onclick = function () {
      tEl.onclick = null;
      tEl.style.cursor = '';
      tEl.className = 'toast';
      triggerDownload(asset ? asset.url : null, latest.url);
    };
  }

  function checkUpdateManual() {
    var toast = window.showToast;
    if (toast) toast('正在检查更新…', '', 1500);

    Promise.all([getLocalVersion(), getLatestRelease()])
      .then(function (results) {
        var local = parseVersion(results[0]);
        var latest = results[1];
        if (!latest) {
          if (toast) toast('检查更新失败：无法访问网络', 'error');
          return;
        }
        if (!local) {
          if (toast) toast('当前版本未知', 'error');
          return;
        }
        var cmp = compareSemver(latest.tag, local);
        if (cmp <= 0) {
          if (toast) toast('已是最新版本 ✓（v' + local + '）', 'success');
          return;
        }
        var asset = pickAsset(latest.assets);
        surfaceDownload(latest, asset);
        if (toast) {
          toast('发现新版本 v' + latest.tag + '，点击下载 →', 'success', 0);
          bindToastDownload(asset, latest);
        } else {
          triggerDownload(asset ? asset.url : null, latest.url);
        }
      });
  }

  function silentCheckUpdate() {
    try {
      var cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cache && (Date.now() - cache.t) < CACHE_TTL_MS) return;
    } catch (e) {}

    Promise.all([getLocalVersion(), getLatestRelease()])
      .then(function (results) {
        var local = parseVersion(results[0]);
        var latest = results[1];
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now() })); } catch (e) {}
        if (!latest || !local) return;
        var cmp = compareSemver(latest.tag, local);
        if (cmp <= 0) return;
        try {
          var notif = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || 'null');
          if (notif && notif.version === latest.tag && (Date.now() - notif.t) < NOTIFIED_TTL_MS) return;
        } catch (e) {}

        var asset = pickAsset(latest.assets);
        surfaceDownload(latest, asset);
        var toast = window.showToast;
        if (toast) {
          toast('发现新版本 v' + latest.tag + '，点击下载 →', 'success', 0);
          bindToastDownload(asset, latest);
        }
        try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ t: Date.now(), version: latest.tag })); } catch (e) {}
      });
  }

  function getCurrentVersion() {
    return getLocalVersion().then(parseVersion);
  }

  window.__TY_UPDATE__ = {
    check: checkUpdateManual,
    silentCheck: silentCheckUpdate,
    getVersion: getCurrentVersion,
    REPO_RELEASE: REPO_RELEASE
  };
})();
