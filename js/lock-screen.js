'use strict';
/* ============================================================
 * lock-screen.js —— 闲置/手动锁屏（仅防顺手误点，非安全边界）
 *
 * 设计取舍（简单优先，对应「只防顺手点/误点」需求）：
 *  - 复用现有「操作密码」(S.settings.opPassword) 解锁，无独立锁屏密码。
 *  - 锁状态仅存内存（session-only）：本功能只防「app 开着、人离开、别人顺手点」，
 *    对方不会去重开 app；会重开的已属「有本机权限」一层，纯前端锁屏本就防不住
 *    （账套文件可直接读 / 可改 settings / 可 devtools 绕过），故不持久化、也不复杂化。
 *  - 触发：① 闲置超时（screenLockTimeout 分钟，可配）② 手动锁屏（按钮 + Ctrl/⌘+L）。
 *  - 默认关闭（screenLockEnabled=false）：出厂零行为变化。
 *  - 自动锁豁免：模态框(.modal.show)打开中，或焦点在输入框/可编辑区时不自动锁，
 *    避免打断录账。手动锁不受豁免限制。
 *  - 与财务引擎完全解耦：只动 UI 闸门，不碰 store 数据 / 导入 / 渲染 / 任何计算。
 * ============================================================ */
(function () {
  var H = globalThis.__TY_HELPERS__;
  if (!H) return;                       // 依赖未就绪则静默放弃，绝不影响主程序

  var locked = false;
  var lastActivity = Date.now();
  var overlay = null;

  function settings() {
    return (globalThis.S && globalThis.S.settings) || {};
  }
  function idleMs() {
    var m = parseInt(settings().screenLockTimeout, 10);
    if (!(m > 0)) m = 5;
    return m * 60000;
  }
  function enabled() {
    return !!settings().screenLockEnabled;
  }

  function onActivity() { lastActivity = Date.now(); }
  ['mousemove', 'mousedown', 'keydown', 'click', 'scroll', 'touchstart', 'wheel']
    .forEach(function (ev) {
      document.addEventListener(ev, onActivity, { passive: true });
    });

  function clearMsg() {
    var m = overlay && overlay.querySelector('#lockMsg');
    if (m) m.textContent = '';
  }

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'lockOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '屏幕已锁定');
    overlay.innerHTML =
      '<div style="background:var(--ty-white);border-radius:12px;padding:28px 32px;width:300px;max-width:86vw;' +
        'box-shadow:0 12px 40px rgba(0,0,0,.35);text-align:center;font-family:inherit;">' +
        '<div style="font-size:18px;font-weight:600;color:var(--ty-text-1);margin-bottom:4px;">已锁定</div>' +
        '<div style="font-size:13px;color:var(--ty-text-3);margin-bottom:16px;">输入操作密码以解锁</div>' +
        '<input id="lockPw" type="password" placeholder="操作密码" autocomplete="off" ' +
          'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--ty-border-2);' +
          'border-radius:8px;font-size:14px;outline:none;">' +
        '<button id="lockBtn" type="button" ' +
          'style="width:100%;margin-top:14px;padding:10px 12px;border:none;border-radius:8px;' +
          'background:var(--ty-blue);color:var(--ty-white);font-size:14px;cursor:pointer;">解锁</button>' +
        '<div id="lockMsg" style="margin-top:10px;font-size:12px;color:var(--ty-red);min-height:14px;"></div>' +
      '</div>';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:none;' +
      'background:rgba(20,24,31,.62);backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);' +
      'align-items:center;justify-content:center;';
    document.body.appendChild(overlay);

    var input = overlay.querySelector('#lockPw');
    var btn = overlay.querySelector('#lockBtn');
    function tryUnlock() {
      var v = input.value;
      if (H.checkOpPassword && H.checkOpPassword(v)) {
        unlock();
      } else {
        var msg = overlay.querySelector('#lockMsg');
        if (msg) msg.textContent = '密码不正确';
        input.value = '';
        input.focus();
      }
    }
    btn.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
    });
  }

  function lock() {
    if (locked || !enabled()) return;
    locked = true;
    if (!overlay) buildOverlay();
    overlay.style.display = 'flex';
    var input = overlay.querySelector('#lockPw');
    if (input) { input.value = ''; clearMsg(); input.focus(); }
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    if (overlay) overlay.style.display = 'none';
    lastActivity = Date.now();
  }

  // 手动锁屏：绕过闲置判定，立即锁定（未开启功能时给提示）
  function manualLock() {
    if (!enabled()) {
      if (H.showToast) H.showToast('请先在「操作保护」中开启闲置锁屏', 'warn');
      return;
    }
    lastActivity = 0;
    lock();
  }

  // 闲置巡检：每 5s 一次
  setInterval(function () {
    if (locked || !enabled()) return;
    // 豁免：模态框打开中，或焦点在输入框/可编辑区（避免打断录账）
    if (document.querySelector('.modal.show')) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (Date.now() - lastActivity > idleMs()) lock();
  }, 5000);

  // 手动锁屏快捷键 Ctrl/⌘+L（webview 无地址栏，无原生冲突）
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      manualLock();
    }
  });

  globalThis.__LOCK__ = {
    lock: lock, unlock: unlock, manualLock: manualLock,
    isLocked: function () { return locked; }
  };
})();
