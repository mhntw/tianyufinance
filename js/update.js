/* ============================================================
 * 更新检查（方案 B 极简版）
 *
 * 设计：
 *   - 启动时静默检查一次（不阻塞主流程、网络不通/API 挂了直接忽略）
 *   - 设置页手动「检查更新」按钮
 *   - 发现新版 → toast + 可点链接去 GitHub Release
 *   - 零服务器、零签名、零 diff，纯靠 GitHub 免费 API
 *
 * 依赖：
 *   - window.__TAURI__.core.invoke → 调 Rust app_version / open_url
 *   - window.showToast → app.js 已注册的全局 toast
 * ============================================================ */

(function () {
  'use strict';

  var REPO_API = 'https://api.github.com/repos/mhntw/tianyufinance/releases/latest';
  var REPO_RELEASE = 'https://github.com/mhntw/tianyufinance/releases';

  // 本地缓存检查结果，避免频繁请求
  var CACHE_KEY = 'ty_update_check';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
  // 避免短时间内重复静默提示（防止用户反复启动应用每次都 toast）
  var NOTIFIED_KEY = 'ty_update_notified';
  var NOTIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天内同版本不重复提示

  // 本地版本号：优先从 Rust 编译时注入，fallback 到硬编码（dev 模式下没编译 Rust）
  function getLocalVersion() {
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (tauri && tauri.invoke) {
      return tauri.invoke('app_version').catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  // 获取最新 Release 信息
  function getLatestRelease() {
    return fetch(REPO_API, {
      headers: { 'Accept': 'application/vnd.github+json' },
      // 6 秒超时，避免网络慢卡住启动
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      return {
        tag: (data.tag_name || '').replace(/^v/, ''),
        url: data.html_url || REPO_RELEASE,
        name: data.name || data.tag_name || '',
        body: (data.body || '').slice(0, 300)
      };
    }).catch(function (e) {
      console.warn('[update] 获取最新版本失败：', e && e.message || e);
      return null;
    });
  }

  // 比较 semver，返回正数 a>b，负数 a<b，0 相等
  function compareSemver(a, b) {
    a = String(a).replace(/^v/, '').split('.').map(Number);
    b = String(b).replace(/^v/, '').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var av = a[i] || 0, bv = b[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  // 调 Rust 打开浏览器（有 Tauri 时），没 Tauri 时 fallback 到 window.open
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

  // 解析 Tauri 返回的版本号：可能是字符串 "0.5.0" 或对象 { version: "0.5.0" }
  function parseVersion(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') return raw.version || raw.pkgVersion || null;
    return null;
  }

  /**
   * 手动检查更新（设置页按钮调用）
   * @param {function} onDone 完成回调 (result) => void
   */
  function checkUpdateManual(onDone) {
    var toast = window.showToast;
    if (toast) toast('正在检查更新…', '', 1500);

    Promise.all([getLocalVersion(), getLatestRelease()])
      .then(function (results) {
        var local = parseVersion(results[0]);
        var latest = results[1];
        if (!latest) {
          if (toast) toast('检查更新失败：无法访问更新服务器，请检查网络', 'error');
          if (onDone) onDone({ ok: false, reason: 'network', local: local });
          return;
        }
        if (!local) {
          if (toast) toast('当前版本未知，请在设置页查看', 'error');
          if (onDone) onDone({ ok: false, reason: 'no_local', latest: latest.tag });
          return;
        }
        var cmp = compareSemver(latest.tag, local);
        if (cmp <= 0) {
          if (toast) toast('已是最新版本 ✓（v' + local + '）', 'success');
          if (onDone) onDone({ ok: true, upToDate: true, local: local });
        } else {
          if (toast) toast('发现新版本 v' + latest.tag + '！点击查看 →', 'success', 0);
          // 让 toast 可点击 → 用 toast 元素绑定
          var tEl = document.getElementById('toast');
          if (tEl) {
            tEl.style.cursor = 'pointer';
            tEl.onclick = function () {
              openUrl(latest.url);
              tEl.onclick = null;
              tEl.style.cursor = '';
              tEl.className = 'toast';
            };
          }
          if (onDone) onDone({
            ok: true, upToDate: false,
            local: local, latest: latest.tag, url: latest.url, name: latest.name, body: latest.body
          });
        }
      });
  }

  /**
   * 启动时静默检查（不阻塞主流程、不报错、有新版才 toast）
   */
  function silentCheckUpdate() {
    // 先查缓存，24h 内已查过就跳过
    try {
      var cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cache && (Date.now() - cache.t) < CACHE_TTL_MS) return;
    } catch (e) {}

    Promise.all([getLocalVersion(), getLatestRelease()])
      .then(function (results) {
        var local = parseVersion(results[0]);
        var latest = results[1];

        // 写缓存（不管成败都写，失败也 24h 内不重试）
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now() }));
        } catch (e) {}

        if (!latest || !local) return;

        var cmp = compareSemver(latest.tag, local);
        if (cmp <= 0) return; // 已是最新，静默

        // 检查是否 7 天内已提示过这个版本
        try {
          var notif = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || 'null');
          if (notif && notif.version === latest.tag && (Date.now() - notif.t) < NOTIFIED_TTL_MS) return;
        } catch (e) {}

        // 没提示过 → toast
        var toast = window.showToast;
        if (toast) {
          toast('发现新版本 v' + latest.tag + '，点击查看更新 →', 'success', 0);
          var tEl = document.getElementById('toast');
          if (tEl) {
            tEl.style.cursor = 'pointer';
            tEl.onclick = function () {
              openUrl(latest.url);
              tEl.onclick = null;
              tEl.style.cursor = '';
              tEl.className = 'toast';
            };
          }
        }
        try {
          localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ t: Date.now(), version: latest.tag }));
        } catch (e) {}
      });
  }

  /**
   * 获取当前版本号（前端显示用）
   * @returns {Promise<string>}
   */
  function getCurrentVersion() {
    return getLocalVersion().then(parseVersion);
  }

  // 暴露到全局
  window.__TY_UPDATE__ = {
    check: checkUpdateManual,
    silentCheck: silentCheckUpdate,
    getVersion: getCurrentVersion,
    openUrl: openUrl,
    REPO_RELEASE: REPO_RELEASE
  };

})();
