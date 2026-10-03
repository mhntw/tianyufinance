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

  /* 检查结果**就地**显示在「检查更新」右侧（**唯一实现**，2026-09-30）。
     【为什么要改】原先一律走 showToast —— 它固定在**屏幕正中央**、看着像个弹窗，
     却没有任何可点处（"正在检查…"、"已是最新"都不接受点击），2.2 秒后消失：
     用户既没看清结果，也不知道下一步能做什么。现改为常驻文本；
     有新版本时在文本里直接给一个**可点的**「下载 →」。
     @param text     文本（可空，仅给链接时用）
     @param kind     '' | 'ok'（绿，通过）| 'err'（红，失败）—— 全站语义色，不新增色值
     @param onClick  给了就追加一个可点的「下载 →」（只有"发现新版本"这一种情形需要）
     ⚠ 别退回 toast，也**别再把 #aboutCheckUpdate 的文案改成"下载 vX →"** ——
       那样"检查更新"这四个字就永久消失了，用户再也点不到第二次。 */
  function setStatus(text, kind, onClick) {
    var el = document.getElementById('aboutUpdateStatus');
    if (!el) return;
    el.className = 'about-status' + (kind ? ' ' + kind : '');
    el.textContent = '';
    if (text) el.appendChild(document.createTextNode(text));
    if (!onClick) return;
    var link = document.createElement('span');
    link.className = 'about-link';
    link.setAttribute('role', 'button');
    link.textContent = '下载 →';
    link.onclick = onClick;
    el.appendChild(link);
  }

  // 发现新版本时的统一出口（手动检查 / 启动静默检查共用同一条文案与同一个点击行为）
  function surfaceDownload(latest, asset) {
    setStatus('发现新版本 v' + latest.tag + ' ', '', function () {
      triggerDownload(asset ? asset.url : null, latest.url);
    });
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

  /* 手动「检查更新」（用户点的这次）：结果**只**写到按钮右侧，不再弹屏幕中央的 toast。
     启动时的静默检查（silentCheckUpdate）另有 toast —— 那时用户不在"关于"卡里，
     需要一个看得见的提示；但两处共用同一套"发现新版本"文案（surfaceDownload）。 */
  var _checking = false;
  function checkUpdateManual() {
    if (_checking) return;                       // 连点保护：一次只发一个请求，状态不会被后一次覆盖
    _checking = true;
    setStatus('正在检查…');
    Promise.all([getLocalVersion(), getLatestRelease()])
      .then(function (results) {
        var local = parseVersion(results[0]);
        var latest = results[1];
        if (!latest) { setStatus('检查失败：无法访问网络（请检查网络后重试）', 'err'); return; }
        if (!local) { setStatus('检查失败：读不到当前版本号', 'err'); return; }
        if (compareSemver(latest.tag, local) <= 0) { setStatus('已是最新（v' + local + '）', 'ok'); return; }
        surfaceDownload(latest, pickAsset(latest.assets));
      })
      .catch(function (e) {
        console.warn('[update] 检查更新异常:', (e && e.message) || e);
        setStatus('检查失败：无法访问网络（请检查网络后重试）', 'err');
      })
      .then(function () { _checking = false; });   // 相当于 finally（不用 .finally，兼容更老的 WebView）
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
      })
      /* 链尾必须接住拒绝（2026-10-04）：静默检查本就不该打扰用户，但 then 回调里抛错
         （localStorage / surfaceDownload / bindToastDownload 都可能）会冒到全局兜底弹
         「系统异常」—— 一次后台检查反而吓用户一跳。手动检查有 catch，这里漏了。 */
      .catch(function (e) { console.warn('[update] 静默检查失败：' + (e && e.message || e)); });
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
