// 异步对话框桥接：桌面版（Tauri v2）走原生系统对话框插件，浏览器降级到原生 confirm/prompt。
// 统一返回 Promise，便于把既有同步 confirm/prompt 逐步改造成 async/await，不破坏业务。
// 单点定义，app.js / 各页面模块 / 单元测试 都从这里取，避免逻辑分散与缓存不一致。
//
// 说明：Tauri v2 的 dialog.confirm（系统原生「确认」框）已在桌面端验证可用（含 Win/macOS 打包后）；
// 而官方 dialog 插件**不含 prompt**（仅 ask/confirm/message/open/save），故文本输入一律用自建
// HTML 浮层 ty-prompt-*（此类 Web 应用本就是网页风格，三平台体验一致且可靠）。

function getDialogApi() {
  var t = (typeof window !== 'undefined') && window.__TAURI__;
  return t && ((t.plugin && t.plugin.dialog) || t.dialog) || null;
}

// message: 提示文本；opts: { title?: string }
function confirmAsync(message, opts) {
  var dlg = getDialogApi();
  if (dlg && typeof dlg.confirm === 'function') {
    return dlg.confirm(message, (opts && opts.title) || '确认');
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return Promise.resolve(window.confirm(message));
  }
  return Promise.resolve(false);
}

// 轻量 HTML 浮层输入框（Tauri 与降级场景共用），返回 Promise<string|null>，取消/ESC 返回 null。
// 使用独有 class 名（ty-prompt-*）并关键样式内联，避免与页面既有 .modal/.modal-overlay 样式冲突。
function promptModal(message, def, opts) {
  return new Promise(function (resolve) {
    if (typeof document === 'undefined') { resolve(null); return; }
    var safeMsg = String(message == null ? '' : message)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var safeDef = String(def == null ? '' : def)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    var overlay = document.createElement('div');
    overlay.className = 'ty-prompt-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2147483647;';
    overlay.innerHTML =
      '<div class="ty-prompt-modal" style="background:#fff;border-radius:10px;max-width:420px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden;">' +
        '<div class="ty-prompt-hd" style="padding:14px 18px;font-weight:600;border-bottom:1px solid #eee;font-size:15px;">' + (opts && opts.title ? opts.title : '输入') + '</div>' +
        '<div class="ty-prompt-bd" style="padding:18px;">' +
          (safeMsg ? '<p style="margin:0 0 10px;color:#444;font-size:14px;">' + safeMsg + '</p>' : '') +
          '<input class="ty-prompt-input" type="text" value="' + safeDef + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccd;border-radius:6px;font-size:14px;outline:none;">' +
        '</div>' +
        '<div class="ty-prompt-ft" style="padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #eee;">' +
          '<button class="ty-prompt-cancel" style="padding:7px 16px;border:1px solid #ccd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">取消</button>' +
          '<button class="ty-prompt-ok" style="padding:7px 16px;border:none;background:#2f7d3a;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">确定</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var input = overlay.querySelector('.ty-prompt-input');
    input.focus();
    if (input.value) input.select();
    function close(val) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(val);
    }
    overlay.querySelector('.ty-prompt-ok').onclick = function () { close(input.value.trim()); };
    overlay.querySelector('.ty-prompt-cancel').onclick = function () { close(null); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') close(input.value.trim());
      else if (e.key === 'Escape') close(null);
    });
  });
}

// message: 提示文本；def: 默认值；opts: { title?: string }
// 重要：Tauri v2 官方 dialog 插件（@tauri-apps/plugin-dialog）只有 ask/confirm/message/open/save
// 五个函数，**没有 prompt**（官方文档明确"文本输入需自行用前端 HTML 或 Rust 实现"）。
// 因此本桥接一律用自建 HTML 浮层 ty-prompt-* 获取文本输入，不依赖任何系统原生 prompt，
// 保证 macOS / Windows / Linux 三平台（含打包后）行为一致、不会"无反应无报错"。
// 纯浏览器（无 __TAURI__）下仍可用 window.prompt 作为轻量兜底。
function promptAsync(message, def, opts) {
  var t = (typeof window !== 'undefined') && window.__TAURI__;
  if (t) {
    // Tauri 的 webview 里 window.prompt 被禁用且 dialog 无 prompt，必须用 HTML 浮层
    return promptModal(message, def, opts);
  }
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    return Promise.resolve(window.prompt(message, def == null ? '' : def));
  }
  return promptModal(message, def, opts);
}

// UMD：浏览器（传统脚本/ESM）与 Node（测试）均可取。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { confirmAsync: confirmAsync, promptAsync: promptAsync, getDialogApi: getDialogApi, promptModal: promptModal };
} else if (typeof window !== 'undefined') {
  window.__dialogBridge = { confirmAsync: confirmAsync, promptAsync: promptAsync, getDialogApi: getDialogApi, promptModal: promptModal };
}
