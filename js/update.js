/* ============================================================
 * 更新检查 + 应用内下载（方案 B 极简版 v2）
 *
 * 设计：
 *   - 启动时静默检查一次（不阻塞主流程、网络不通/API 挂了直接忽略）
 *   - 设置页手动「检查更新」按钮
 *   - 发现新版 → toast 提示 → 应用内下载 GitHub Release asset
 *   - 下载完自动打开 Downloads/ty-update/ 文件夹 → 用户双击 dmg/exe 安装
 *   - 零服务器、零签名、零 diff，纯靠 GitHub 免费 API
 *
 * 依赖：
 *   - window.__TAURI__.core.invoke → Rust app_version / save_update_file / open_in_explorer / open_url
 *   - window.showToast → app.js 已注册的全局 toast
 * ============================================================ */

(function () {
  'use strict';

  var REPO_API = 'https://api.github.com/repos/mhntw/tianyufinance/releases/latest';
  var REPO_RELEASE = 'https://github.com/mhntw/tianyufinance/releases';
  // 备选 URL：GitHub API 被内网屏蔽时，走公共 mirror
  // mirror.ghproxy.com 是社区维护的 GitHub 加速镜像，不稳定时可换其他
  var MIRROR_API_LIST = [
    function (url) { return 'https://mirror.ghproxy.com/' + url; },
    function (url) { return 'https://gh-proxy.com/' + url; },
    function (url) { return 'https://gh.api.99988866.xyz/' + url; }
  ];

  // 本地缓存检查结果，避免频繁请求
  var CACHE_KEY = 'ty_update_check';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
  // 避免短时间内重复静默提示（防止用户反复启动应用每次都 toast）
  var NOTIFIED_KEY = 'ty_update_notified';
  var NOTIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天内同版本不重复提示

  // 本地版本号：优先从 Rust 编译时注入
  function getLocalVersion() {
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (tauri && tauri.invoke) {
      return tauri.invoke('app_version').catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  // 单次 fetch（内部函数，被 fetchWithFallback 调用）
  function tryFetch(url) {
    return fetch(url, {
      headers: { 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // 主 URL 失败后自动依次试 mirror（最多 1 次 mirror，避免太慢）
  function fetchWithFallback(primaryUrl) {
    return tryFetch(primaryUrl).catch(function (err) {
      console.warn('[update] 主 API 失败，试 mirror:', err && err.message);
      // 只试前两个 mirror，不循环太多
      for (var i = 0; i < Math.min(2, MIRROR_API_LIST.length); i++) {
        try {
          var mirrorUrl = MIRROR_API_LIST[i](primaryUrl);
          return tryFetch(mirrorUrl);
        } catch (e) { /* continue */ }
      }
      throw err; // 全部失败，抛出原始错误
    });
  }

  // 获取最新 Release 信息（含 assets 列表）
  function getLatestRelease() {
    return fetchWithFallback(REPO_API)
      .then(function (data) {
        return {
          tag: (data.tag_name || '').replace(/^v/, ''),
          url: data.html_url || REPO_RELEASE,
          name: data.name || data.tag_name || '',
          body: (data.body || '').slice(0, 300),
          assets: (data.assets || []).map(function (a) {
            return {
              name: a.name,
              // download_url 也走 mirror（如果主 URL 挂了的话）
              url: a.browser_download_url,
              size: a.size
            };
          })
        };
      }).catch(function (e) {
        console.warn('[update] 获取最新版本失败：', e && e.message || e);
        return null;
      });
  }

  // 根据当前平台从 assets 列表里挑对的安装包
  function pickAsset(assets) {
    if (!assets || !assets.length) return null;
    var isMac = /darwin/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
    var isWin = /win/i.test(navigator.platform) || /windows/i.test(navigator.userAgent);
    var isArmMac = isMac && /arm|aarch64|Apple Silicon/i.test(navigator.userAgent);

    // 精确匹配优先级
    var patterns = [];
    if (isMac) {
      // ARM Mac → 先找 aarch64 dmg，再 arm64，再普通 dmg
      if (isArmMac) patterns = [/aarch64.*\.dmg$/i, /arm64.*\.dmg$/i, /_macos_.*\.dmg$/i, /\.dmg$/i];
      else patterns = [/x64.*\.dmg$/i, /amd64.*\.dmg$/i, /_macos_.*\.dmg$/i, /\.dmg$/i];
    } else if (isWin) {
      patterns = [/x64.*\.exe$/i, /amd64.*\.exe$/i, /_windows_.*\.exe$/i, /\.exe$/i];
    }

    for (var i = 0; i < patterns.length; i++) {
      for (var j = 0; j < assets.length; j++) {
        if (patterns[i].test(assets[j].name)) return assets[j];
      }
    }
    // 兜底：返回第一个 asset
    return assets[0];
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

  // 调 Rust 打开浏览器（fallback 路径：下载失败时让用户去 GitHub 手动下）
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

  // 打开文件夹（下载完后让用户直接看到安装包）
  function openFolder(path) {
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (tauri && tauri.invoke) {
      tauri.invoke('open_in_explorer', { path: path }).catch(function () {
        // 没 Rust 时只能打开包含该文件的目录
        var folder = path.replace(/[\\/][^\\/]+$/, '');
        openUrl(folder);
      });
    }
  }

  // Blob → base64（readAsDataURL 自带 data: 前缀，要去掉）
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        // result = "data:application/octet-stream;base64,AAAA..."
        var r = fr.result;
        var comma = r.indexOf(',');
        resolve(comma >= 0 ? r.slice(comma + 1) : r);
      };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  // fetch asset 二进制（主 URL 失败后自动试 mirror）
  function fetchBlobWithFallback(primaryUrl, fetchOpts) {
    var tryOne = function (url) {
      return fetch(url, fetchOpts).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      });
    };
    return tryOne(primaryUrl).catch(function (err) {
      // 只试第一个 mirror（asset 文件大，多试会等太久）
      if (MIRROR_API_LIST.length > 0) {
        var mirrorUrl = MIRROR_API_LIST[0](primaryUrl);
        console.warn('[update] asset 主下载失败，试 mirror:', err && err.message);
        return tryOne(mirrorUrl);
      }
      throw err;
    });
  }

  /**
   * 从 GitHub Release 下载 asset 到本地 Downloads/ty-update/
   * @param {object} asset { name, url, size }
   * @returns {Promise<string>} 落盘后的完整路径
   */
  function downloadAsset(asset) {
    var toast = window.showToast;
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (!tauri || !tauri.invoke) {
      openUrl(asset.url);
      return Promise.reject(new Error('no_tauri'));
    }

    if (toast) toast('正在下载 ' + asset.name + '…', '', 0);

    var fetchOpts = { signal: AbortSignal.timeout ? AbortSignal.timeout(8 * 60 * 1000) : undefined };

    return fetchBlobWithFallback(asset.url, fetchOpts)
      .then(function (blob) {
        if (toast) toast('正在处理安装包…', '', 0);
        return blobToBase64(blob);
      })
      .then(function (base64) {
        return tauri.invoke('save_update_file', { name: asset.name, base64: base64 });
      })
      .then(function (path) {
        if (toast) toast('下载完成 ✓ 点击打开文件夹', 'success', 0);
        // toast 可点击 → 打开文件夹
        var tEl = document.getElementById('toast');
        if (tEl) {
          tEl.style.cursor = 'pointer';
          tEl.onclick = function () {
            openFolder(path);
            tEl.onclick = null;
            tEl.style.cursor = '';
            tEl.className = 'toast';
          };
        }
        // 2s 后自动打开文件夹（用户也能手动点 toast）
        setTimeout(function () { openFolder(path); }, 2000);
        return path;
      })
      .catch(function (e) {
        console.warn('[update] 下载失败：', e && e.message || e);
        if (toast) toast('下载失败：' + (e && e.message || '未知错误') + '，点击去官网手动下载', 'error', 0);
        var tEl = document.getElementById('toast');
        if (tEl) {
          tEl.style.cursor = 'pointer';
          tEl.onclick = function () {
            openUrl(REPO_RELEASE);
            tEl.onclick = null;
            tEl.style.cursor = '';
            tEl.className = 'toast';
          };
        }
        throw e;
      });
  }

  // 解析 Tauri 返回的版本号
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
          // 有新版 → 直接挑 asset 开始下载
          var asset = pickAsset(latest.assets);
          if (!asset) {
            // 没 asset → fallback 到打开浏览器
            if (toast) toast('发现新版本 v' + latest.tag + '，点击去官网下载', 'success', 0);
            var tEl = document.getElementById('toast');
            if (tEl) {
              tEl.style.cursor = 'pointer';
              tEl.onclick = function () { openUrl(latest.url); };
            }
            if (onDone) onDone({ ok: true, upToDate: false, local: local, latest: latest.tag, noAsset: true });
            return;
          }
          // 开始下载
          downloadAsset(asset).then(function (path) {
            if (onDone) onDone({ ok: true, upToDate: false, local: local, latest: latest.tag, asset: asset, path: path });
          }).catch(function () {
            if (onDone) onDone({ ok: true, upToDate: false, local: local, latest: latest.tag, asset: asset, downloadFailed: true });
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

        // 没提示过 → toast，点击触发下载
        var asset = pickAsset(latest.assets);
        var toast = window.showToast;
        if (toast) {
          var tEl = document.getElementById('toast');
          if (tEl) {
            toast('发现新版本 v' + latest.tag + (asset ? '，点击下载安装包 →' : '，点击去官网 →'), 'success', 0);
            tEl.style.cursor = 'pointer';
            tEl.onclick = function () {
              tEl.onclick = null;
              tEl.style.cursor = '';
              tEl.className = 'toast';
              if (asset) {
                downloadAsset(asset);
              } else {
                openUrl(latest.url);
              }
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
