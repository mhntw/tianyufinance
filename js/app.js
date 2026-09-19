/* ============================================================
 * js/app.js — 渲染与交互层
 * 菜单结构：凭证 / 账簿 / 报表 / 固定资产 / 工资 / 结账 / 设置
 * 依赖：store.js（全局 S）、util
 * ============================================================ */
(function () {
  'use strict';

  var U = window.util;
  var S = window.S;
  if (!S || !S.init) {
    document.body.insertAdjacentHTML('afterbegin', '<div style="padding:20px;color:#cf1322">致命错误：核心模块未加载（store.js 加载失败），请检查 js/store.js 是否可访问。</div>');
    return;
  }
  S.init();

  // —— 启动自检：导出/打开文件夹依赖桥接是否在 Tauri 运行时正确加载（便于排查「无反应」）——
  (function selfCheck() {
    try {
      var info = {
        hasTAURI: !!window.__TAURI__,
        hasCore: !!(window.__TAURI__ && window.__TAURI__.core),
        hasInvoke: !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke),
        hasFileSaveBridge: !!window.__fileSaveBridge,
        hasDialogBridge: !!window.__dialogBridge,
        hasXLSX: typeof window.XLSX !== 'undefined'
      };
      window.__TY_SELFCHECK__ = info;
      if (window.__TAURI__ && !window.__fileSaveBridge) {
        console.error('[self-check] 致命：__fileSaveBridge 未加载，导出/打印将失效！请检查 index.html 是否引入了 js/file-save-bridge.js');
        if (window.showToast) window.showToast('初始化异常：文件导出模块未加载，请联系开发者', 'error', 8000);
      }
    } catch (e) { console.error('[self-check] error', e); }
  })();

  /* ============================================================
   * 未保存编辑守卫
   * 点窗口 X 时，若用户有「改了但没点保存」的内容就先确认，没有则原样关闭、不打扰。
   *
   * 只守「批量改、最后统一保存」的录入区（凭证录入、期初余额），容器用
   * data-unsaved-scope 标记，以后哪页需要保护就在 HTML 上加个属性，这里不用改。
   * 弹窗类表单不纳入：它们前面挡着弹窗、旁边就是确定/取消，填一半去点窗口 X 的情况
   * 本来就少，而弹窗里的搜索框、列表勾选带来的误报才是真骚扰——宁可漏，不可滥。
   *
   * 判据用「用户的输入事件」而不是「表单里有值」：后者会把本来带出来的默认值
   * （例如折旧参数上次填的值）误判成未保存，结果每次关窗都弹框。
   * 程序给 input 赋值不会触发 input/change，只有真人敲键盘/点选才会。
   *
   * 再记「最后一次成功落盘的时间」和「每个录入区最后一次被编辑的时间」，
   * 后者晚于前者，就说明有改动还没存。
   * 不去绑定具体的保存按钮：按钮点了也可能校验失败、根本没写盘（凭证借贷不平衡、
   * 科目不存在、赤字检查不过时，点保存都会直接 return 而不落盘），
   * 按按钮清除就会误判成「已保存」，反而把人坑了。
   * ============================================================ */
  var SCOPE_LABEL = { voucher: '凭证', opening: '期初余额' };
  var lastSavedAt = 0;
  var editedAt = Object.create(null);
  (function bindUnsavedTracker() {
    // 落盘成功 = 此前的编辑都已安全。S.persist 写完主账本后会调 _onSaveOk。
    var origOk = S._onSaveOk;
    S._onSaveOk = function () {
      lastSavedAt = Date.now();
      return origOk ? origOk.apply(this, arguments) : undefined;
    };

    // 搜索框、筛选框、列表勾选框不算「录入」
    function isEntryControl(el) {
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'select') return true;
      if (tag !== 'input') return false;
      var type = (el.type || '').toLowerCase();
      // file 不排除：凭证传了附件却没点保存，附件同样是会丢的录入内容。
      // checkbox/radio 排除：弹窗和列表里多是行选择、全选，误报代价大于漏报。
      if (type === 'search' || type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'reset') return false;
      var cls = (el.className && el.className.toString()) || '';
      return !/search/i.test(cls);
    }
    function onEdit(e) {
      var t = e.target;
      if (!t || !t.closest || !isEntryControl(t)) return;
      var scope = t.closest('[data-unsaved-scope]');
      if (scope) editedAt[scope.getAttribute('data-unsaved-scope')] = Date.now();
    }
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
  })();

  // 找出第一个「改了但还没存、且此刻仍看得见」的区域，没有则返回 null。
  function firstUnsavedScope() {
    // 可见性必须沿父链判断：页面容器是 .page.active 机制（非激活页 display:none），
    // 子录入区自身可能仍是可见样式（vEditView 切换时只改父级 class），只看自身会误报。
    function elVisible(el) {
      var n = el;
      while (n && n.nodeType === 1) {
        try {
          if (window.getComputedStyle(n).display === 'none') return false;
        } catch (e) { return false; }
        n = n.parentNode;
      }
      return true;
    }
    for (var k in editedAt) {
      if (!Object.prototype.hasOwnProperty.call(editedAt, k)) continue;
      if (editedAt[k] <= lastSavedAt) continue; // 改完之后又存过盘了
      var el = document.querySelector('[data-unsaved-scope="' + k + '"]');
      if (!el) continue;
      try {
        // 用户早切走了（表单多半也已重置），没道理再拦一道
        if (elVisible(el)) return k;
      } catch (e) {}
    }
    return null;
  }

  // —— 关闭拦截 ——
  // 只在「确实有没保存的内容」时才介入，没有就完全不干预、窗口按原样关掉。
  // 不再做关窗前的额外落盘：主账本本来就是即时写入（原子写 + sync_all），
  // 为那点只在理论上存在的风险去延迟每一次关窗，不划算，也徒增复杂度。
  (function bindCloseGuard() {
    var t = window.__TAURI__;
    if (!t) return;
    var win = null;
    try {
      if (t.webviewWindow && t.webviewWindow.getCurrentWebviewWindow) win = t.webviewWindow.getCurrentWebviewWindow();
      else if (t.window && t.window.getCurrentWindow) win = t.window.getCurrentWindow();
    } catch (e) { return; }
    if (!win || typeof win.onCloseRequested !== 'function') return;

    var closing = false; // destroy 万一失败回退 close 时，避免再弹一次框
    win.onCloseRequested(function (event) {
      // 整个守卫做异常保护：任何环节失败都放行关闭——宁可不提示，也不能报错/关不掉。
      try {
        if (closing) return;
        var scope = firstUnsavedScope();
        if (!scope) return; // 没有未保存内容：完全不干预，窗口按原样关掉
        // 拿不到 preventDefault 就放弃拦截，让窗口正常关掉。
        try { event.preventDefault(); } catch (e) { return; }

        var label = SCOPE_LABEL[scope] || '当前内容';
        var msg = '「' + label + '」有尚未保存的修改，退出后会丢失。确定要退出吗？';
        var ask = (window.__dialogBridge && window.__dialogBridge.confirmAsync)
          ? window.__dialogBridge.confirmAsync(msg, { title: '添钰财务管理系统' })
          : Promise.resolve(window.confirm(msg));
        ask.then(function (ok) {
          if (!ok) return; // 取消：窗口保持不动
          closing = true;
          try { win.destroy(); } catch (e) { try { win.close(); } catch (e2) {} }
        }).catch(function (e) {
          // 原生询问异常（平台/权限/关闭时序等）：放弃拦截，直接关闭，避免关不掉或弹报错
          if (typeof console !== 'undefined') console.warn('[close-guard] 未保存询问失败，放行关闭：', e && (e.message || e));
          closing = true;
          try { win.destroy(); } catch (e3) { try { win.close(); } catch (e4) {} }
        });
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[close-guard] 关闭守卫异常，放行关闭：', e && (e.message || e));
        closing = true;
        try { win.destroy(); } catch (e2) { try { win.close(); } catch (e3) {} }
      }
    });
  })();

  /* ============================================================
   * 全局错误兜底（防白屏：单点 JS 异常不直接让用户以为丢数据）
   * 复用 KDBiz 既有 showToast/弹层，异常仅提示，不阻断其余功能。
   * ============================================================ */
  // 保留最近若干条运行期错误，便于用户反馈 / 开发者定位。
  // 只弹一句「系统异常」而不给任何线索，会让真实错误长期隐身（如查凭证全选框的
  // this 绑定问题），用户只能反复猜。这里把错误摘要一并呈现，可复制上报。
  var _appErrors = [];
  function _errSummary(err) {
    if (err == null) return String(err);
    if (typeof err === 'string') return err;
    // 取第一个业务相关的栈帧，比整段堆栈可读得多
    var loc = '';
    if (err.stack) {
      var line = String(err.stack).split('\n').filter(function (l) {
        return /https?:\/\/|tauri:\/\/|:\d+:\d+/.test(l) && !/app\.js|node_modules/.test(l);
      })[0];
      if (line) loc = ' @ ' + line.trim().replace(/^at\s+/, '');
    }
    return (err.name ? err.name + ': ' : '') + (err.message || String(err)) + loc;
  }
  function _appFatal(raw, kind) {
    try {
      var summary = _errSummary(raw);
      _appErrors.push({ t: Date.now(), kind: kind || 'error', msg: summary });
      if (_appErrors.length > 30) _appErrors.shift();
      console.error('[app-fatal]', kind || 'error', raw);
      if (!window.showToast) return;
      window.showToast('系统异常：' + summary, 'error', 12000);
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    _appFatal(e.error || e.message, 'error');
  });
  window.addEventListener('unhandledrejection', function (e) {
    _appFatal(e.reason, 'promise');
  });
  // 供用户/开发者取用：控制台执行 __APP_ERRORS__ 可拿到最近错误清单
  window.__APP_ERRORS__ = function () { return _appErrors.slice(); };

  /* ============================================================
   * 运行期自检横幅：开机/选账套/结账后调用 S.runSelfTest()
   * 「结账检查 / 试算平衡」，异常顶部红字，绝不掩盖。
   * ============================================================ */
  function runSelfTestBanner() {
    var banner = document.getElementById('selftestBanner');
    if (!banner) return;
    var res;
    try { res = S.runSelfTest(); } catch (e) {
      console.error('[selftest]', e);
      banner.hidden = true; return;
    }
    // info 级只作参考（如三表勾稽这类「软关系」），不进横幅 ——
    // 否则首页会长期挂着一条无法解释的提示，让用户对真实告警脱敏（狼来了效应）。
    // 仍可经 S.runSelfTest() 在控制台查阅完整清单。
    var shown = (res && res.items ? res.items : []).filter(function (x) { return x.level !== 'info'; });
    if (!res || res.skipped || !shown.length) { banner.hidden = true; return; }
    var hasError = shown.some(function (x) { return x.level === 'error'; });
    banner.className = 'selftest-banner st-level-' + (hasError ? 'error' : 'warn');
    var html = '<div class="st-item"><b>运行期自检' + (hasError ? '发现异常（务必核查账套）' : '提示') + '：</b></div>';
    shown.forEach(function (it) {
      html += '<div class="st-item">· <b>' + (it.label || '') + '</b>' + (it.detail ? '：' + it.detail : '') + '</div>';
    });
    banner.innerHTML = html;
    banner.hidden = false;
  }
  window.__runSelfTestBanner = runSelfTestBanner;

  /* ============================================================
   * 存储状态回调（Tauri 桌面版）。
   * 桌面版通过 Rust 后端恒为真实文件模式（数据落在应用数据目录/添钰财务/），
   * 不再有「浏览器存储模式」横幅与「选择数据目录」按钮，故此处为空操作。
   * 保留函数签名以兼容 store.js 内部调用。
   * ============================================================ */
  window.__setServerStatus = function (ok) {
    // Tauri 桌面版恒为文件模式，无需「未获文件权限」横幅；
    // 但保存失败(__onPersistError)必须显性告警，由下方横幅处理。
    if (ok && window.__onPersistOk) window.__onPersistOk();
  };

  /* ============================================================
   * 主账本写盘失败告警（数据安全最后一道防线）
   * 场景：磁盘满 / 目录无写权限 / 文件被占用 / 序列化异常。
   * 若不显性告警，用户会以为"已保存"而继续记账，退出后数据全部丢失——
   * 对财务软件是不可接受的。故失败即弹顶部红条 + Toast，并引导立即导出备份。
   * ============================================================ */
  var _persistBanner = null;
  window.__onPersistError = function (err, count) {
    try {
      if (!_persistBanner || !_persistBanner.parentNode) {
        _persistBanner = document.createElement('div');
        _persistBanner.id = 'persistErrorBanner';
        _persistBanner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;' +
          'background:#c0392b;color:#fff;padding:10px 16px;font-size:13px;line-height:1.7;' +
          'text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35)';
        document.body.appendChild(_persistBanner);
        document.body.style.paddingTop = '0'; // 横幅为 fixed 覆盖，不挤压既有布局
      }
      _persistBanner.innerHTML = '数据保存失败（第 ' + count + ' 次）：账套未能写入磁盘，继续操作可能导致数据丢失。' +
        '请立即到「设置 → 数据与安全」导出备份，并检查磁盘空间与文件权限。' +
        (err ? '<div style="opacity:.85;font-size:12px;margin-top:2px">错误信息：' + String(err).slice(0, 200) + '</div>' : '');
      if (typeof showToast === 'function') showToast('数据保存失败，请立即导出备份！', 'error', 6000);
    } catch (e) {
      console.error('[persist] 告警横幅渲染失败：' + (e && e.message || e));
    }
  };
  window.__onPersistOk = function () {
    if (_persistBanner && _persistBanner.parentNode) _persistBanner.parentNode.removeChild(_persistBanner);
    _persistBanner = null;
  };

  /* 首页右侧「产品公告 / 政策头条」已随本地版改造移除（云端占位，无实际用途），
   * 首页改为左主区单栏全宽。若需在首页展示本地提示，直接在 Home.js 相应区块渲染即可。 */


  /* 科目类别中文名（与 store ACCOUNT_CLASSES 对应） */
  var CLS_NAME = { asset: '资产', liability: '负债', equity: '权益', revenue: '损益(收入)', expense: '损益(费用)', common: '共同' };
  // 暴露给 ESM 页面模块（js/pages/settings/Settings.js 等引用）
  globalThis.__TY_CLS_NAME__ = CLS_NAME;

  /* ---------- 全局：导航分组悬浮预览（「单例 popover」机制） ----------
   * 源码（云会计_files/main.cf2e18af.chunk.js）每个主菜单包一个受控气泡组件
   *   K.a({placement:"rightTop",mouseEnterDelay:.001,mouseLeaveDelay:.001,arrow:!1,trigger:"hover",tip:...})
   * 气泡显隐由组件库托管，物理上同一时刻只有一个浮层，hover 切换时旧浮层自动卸载，不会重叠。
   * 本项目纯 JS 无框架，取其本质：sidenav 下只挂「一个」浮层容器 #navPopover，
   * hover 哪个组就把该组子菜单渲染进这唯一容器并定位到标题右侧；离开才隐藏。
   * 因为只有一个 DOM 节点，从根上杜绝「双层白底重叠」。 */
  var NAV_POP = null;            // 单例浮层容器
  function ensureNavPop() {
    if (NAV_POP) return NAV_POP;
    NAV_POP = document.createElement('div');
    NAV_POP.id = 'navPopover';
    NAV_POP.className = 'nav-pop';
    NAV_POP.style.display = 'none';
    document.body.appendChild(NAV_POP);
    // 浮层自身也是 hover 命中区：进入取消关闭，离开才关
    NAV_POP.addEventListener('mouseenter', cancelNavClose);
    NAV_POP.addEventListener('mouseleave', scheduleNavClose);
    return NAV_POP;
  }
  var navCloseTimer = null;
  function cancelNavClose() { if (navCloseTimer) { clearTimeout(navCloseTimer); navCloseTimer = null; } }
  function scheduleNavClose() {
    cancelNavClose();
    navCloseTimer = setTimeout(hideNavPopover, 120);
  }
  // 把某个分组的子菜单渲染进单例浮层并定位到其标题右侧
  function showNavPopover(group) {
    cancelNavClose();
    var title = group.querySelector('.nav-group-title');
    if (!title) return;
    var data = group.__navData;
    if (!data) return;
    var pop = ensureNavPop();
    var itemsHtml = (data.items || []).map(function (it) {
      return '<a class="nav-pop-item" data-page="' + it.page + '">' + it.name + '</a>';
    }).join('');
    pop.innerHTML = '<div class="nav-pop-grid"><div class="nav-pop-col">' +
      '<div class="nav-pop-title" style="display:none">' + data.group + '</div>' + itemsHtml + '</div></div>';
    // 定位（右侧 + 视口下边界夹取）
    var r = title.getBoundingClientRect();
    pop.style.display = 'block';
    pop.style.left = r.right + 'px';
    var ph = pop.offsetHeight || 0;
    var top = r.top;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - ph);
    pop.style.top = top + 'px';
    // 重新绑定子项点击（事件用委托在 sidenav 已统一处理，这里无需重复）
  }
  function hideNavPopover() {
    cancelNavClose();
    if (NAV_POP) NAV_POP.style.display = 'none';
    document.querySelectorAll('.nav-group.open').forEach(function (g) { g.classList.remove('open'); });
  }

  /* ---------- 启动：单一数据源 ----------
   * 原则：前端只认「当前账套」一个权威数据源，由 store.init() 负责
   * 从磁盘真实文件拉取账本（<应用数据目录>/添钰财务/books/<id>.json）并刷新。
   * 避免「双入口互相覆盖、id 字段不一致」导致查凭证点不开。 */
  refreshAll();
  // 启动时静默检查更新（24h 内已查过就跳过，有新版才 toast 提示）
  if (window.__TY_UPDATE__ && window.__TY_UPDATE__.silentCheck) {
    setTimeout(function () { window.__TY_UPDATE__.silentCheck(); }, 3000);
  }
  // 卡片期间选择状态：fundBalPeriod / cardPeriods 已迁入 js/pages/home/Home.js（模块级 let）
  if (S.state && S.state.vouchers && globalThis.__renderHome) globalThis.__renderHome();

  /* ---------- 通用工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function money(n) { return U.money(n); }
  function fmt(n) { return n == null ? '--' : money(Math.abs(n)); }
  function signed(n) { return (n < 0 ? '-' : '') + money(Math.abs(n)); }
  // 报表金额着色（负数）：按会计惯例显示为 "-1,234.56" 并标红。
  // 历史实现 money(Math.abs(n)) 只染红、丢掉负号，导致资产负债表「未分配利润」等
  // 负值被渲染成正数（如 -2,424,599.93 显示为红色 2,424,599.93），符号方向相反。
  function moneyRed(n) { return n < 0 ? '<span class="ty-red">-' + money(Math.abs(n)) + '</span>' : money(n); }
  function round2(n) { return Math.round(U.num(n) * 100) / 100; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // 期间取值单点实现：此前各页面各自实现、口径雷同，现统一在此，页面经 H.periodRangeValue 引用。
  // 口径：回填默认期间并同步触发器文本，返回该期间。期间控件是单期形态，两端恒等。
  // 第二参 def 已移除：16 个调用方无一传参，默认值一律取控件 data-default 的声明（见下）。
  function periodRangeValue(prefix) {
    var sInp = $(prefix + 'Start'), eInp = $(prefix + 'End');
    if (sInp && eInp) {
      // 默认值取期间控件 data-default 声明（声明在 index.html、解析在组件），页面不再各自决定默认期间。
      // 末尾 || '' 是必要的：账套未加载时 currentPeriod() 可能为 null，
      // 而 input.value = null 会被 WebIDL 转成字符串 "null" 写进输入框。
      var def = (typeof globalThis.__PERIOD_DEFAULT_OF__ === 'function' ? globalThis.__PERIOD_DEFAULT_OF__(prefix) : '')
                || currentPeriod() || '';
      sInp.value = sInp.value || def;
      eInp.value = eInp.value || def;
      if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__(prefix + 'Start', prefix + 'End');
    }
    return eInp ? eInp.value : '';
  }
  // 区间期间取值：返回 {start, end}。供明细账等支持范围选择的页面使用。
  // 同样会在首次调用时回填默认值（两端都取默认期间），之后由控件自身维护。
  function periodRangeValues(prefix) {
    var sInp = $(prefix + 'Start'), eInp = $(prefix + 'End');
    if (sInp && eInp) {
      var def = (typeof globalThis.__PERIOD_DEFAULT_OF__ === 'function' ? globalThis.__PERIOD_DEFAULT_OF__(prefix) : '')
                || currentPeriod() || '';
      sInp.value = sInp.value || def;
      eInp.value = eInp.value || def;
      if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__(prefix + 'Start', prefix + 'End');
    }
    return { start: sInp ? sInp.value : '', end: eInp ? eInp.value : '' };
  }
  // 期间格式化：兼容 "YYYY-MM" 与 "YYYYMM" 两种账套月份格式 -> "YYYY年第N期"
  // 注：本账套月份统一为 "YYYY-MM"（见 store.allMonths/currentPeriod），
  // 旧实现按 "YYYYMM" 取 substring(4,6) 会把 "2026-07" 误解析为 "2026年第0期"，故先去连字符归一。
  function formatPeriod(m) {
    if (!m) return '—';
    var s = String(m).replace(/-/g, '');
    var y = s.substring(0, 4);
    var mo = parseInt(s.substring(4, 6), 10);
    if (!mo) mo = 0;
    return y + '年第' + mo + '期';
  }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function nowTimeStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  // 第三参 ms 为可选停留时长（默认 2200ms）。长文案（如系统异常明细、批量操作结果）
  // 用默认时长根本读不完，故支持按内容长短指定停留时间。
  function showToast(msg, type, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(t._timer);
    // ms===0 表示常驻（如更新提示的“点击下载”），直到被显式清除；其余按指定时长或默认 2200ms 后隐藏
    if (ms !== 0) t._timer = setTimeout(function () { t.className = 'toast'; }, ms > 0 ? ms : 2200);
  }
  globalThis.showToast = showToast;
  function openModal(id) { var m = $(id); if (m) m.classList.add('show'); }
  function closeModal(id) { var m = $(id); if (m) m.classList.remove('show'); }
  globalThis.openModal = openModal;
  globalThis.closeModal = closeModal;
  function currentPeriod() {
    var closed = (S.state && S.state.closedPeriods) || [];
    var natMonth = todayStr().slice(0, 7);
    // 口径（旗舰版「当前账期」一致）：
    // 1. 已结账存在 → 最近已结账月 + 1（工作期间）
    // 2. 没结过账 → 最近有凭证的期间
    // 3. 空账套 → 当前自然月
    // 安全兜底：结果不能晚于当前自然月（未来月闸门）
    var result;
    if (closed.length) {
      var last = closed[closed.length - 1];
      var y = +last.slice(0, 4), m = +last.slice(5, 7);
      m++; if (m > 12) { m = 1; y++; }
      result = y + '-' + String(m).padStart(2, '0');
    } else {
      var vs = (S.state && S.state.vouchers) || [];
      if (vs.length) {
        for (var i = vs.length - 1; i >= 0; i--) {
          var vm = String((U && U.monthOf) ? U.monthOf(vs[i].date) : '').trim();
          if (/^\d{4}-\d{2}$/.test(vm)) { result = vm; break; }
        }
      }
      if (!result) result = natMonth;
    }
    if (result > natMonth) result = natMonth;
    return result;
  }
  // 本期 = 最近一个已结账期间（state.closedPeriods 为升序列表，末位即最近已结账）。
  // 本月 = 当前未结账期间（通常即最近有凭证的期间 currentPeriod）。
  // 默认期间取值口径：优先「本期」；账套从未结账时回退 currentPeriod()（最近有凭证的期间）。
  function lastClosedPeriod() {
    var closed = (S.state && S.state.closedPeriods) || [];
    if (closed.length) return closed[closed.length - 1];
    return currentPeriod();
  }
  // 账套切换 key：换账套才重填下拉，避免每次路由/查询重填重置用户已选期间
  function bookKey() {
    var startMonth = (S.state && S.state.company && S.state.company.startMonth) || '';
    return (S.bookId || '') + '|' + startMonth;
  }

  /* ---------- 高危操作密码（防误删/误清，全局设置） ----------
   * 删除凭证、彻底清除回收站等不可逆或高风险操作，执行前要求输入操作密码。
   * 生效密码：用户在「系统设置 → 操作保护」自定义后以自定义为准；
   * 未自定义时默认 admin（单人场景防误操作的第一道闸）。
   * 存在全局 settings（localStorage kis_settings），与账套数据无关。
   */
  var DEFAULT_OP_PASSWORD = 'admin';
  function effectiveOpPassword() {
    var st = globalThis.S && globalThis.S.settings;
    return (st && st.opOverridden && st.opPassword) ? st.opPassword : DEFAULT_OP_PASSWORD;
  }
  function checkOpPassword(input) {
    return String(input === undefined || input === null ? '' : input) === effectiveOpPassword();
  }
  // 高危操作统一验证入口：弹窗输入密码，通过返回 true，取消/输错返回 false。
  // 页面（删除凭证/彻底清除回收站/清空账套回收站等）只需 await H.askOpPassword('操作名')。
  function askOpPassword(opName, hint) {
    var dlg = window.__dialogBridge && window.__dialogBridge.promptAsync;
    var promptP = dlg || function (m, d) { return Promise.resolve(window.prompt ? window.prompt(m, d) : null); };
    var msg = '「' + opName + '」为高危操作，请输入操作密码确认。';
    if (hint) msg += '\n\n' + hint;
    return promptP(msg, '', { title: '操作密码' }).then(function (input) {
      if (input === null || input === undefined) return false;
      if (checkOpPassword(input)) return true;
      showToast('操作密码不正确', 'error');
      return false;
    });
  }

  /* ---------- 模块桥接层：把通用 helper 暴露给 ESM 页面模块（B 方案解耦） ----------
   * 设计：app.js 仍是传统 IIFE，内部 helper 是局部变量；ESM 页面模块（js/pages/*）
   * 无法 import 这些局部符号。这里统一把它们挂到 globalThis.__TY_HELPERS__，
   * 模块从该全局对象取依赖，实现「只挪窝不改写逻辑」。
   * 注意：本块仅为新增引用，不改变任何既有逻辑；未迁移的页面继续走内部闭包，零影响。 */
  if (typeof globalThis !== 'undefined') {
    // 安全收集：只挂确实存在的局部 helper；缺失项不在此处抛错（模块侧用 || fallback 兜底），
    // 避免某次迁移误删私有 helper 导致整页 ReferenceError 崩溃。
    var pick = function (v) { return (typeof v !== 'undefined') ? v : undefined; };
    globalThis.__TY_HELPERS__ = {
      $: pick($), money: pick(money), fmt: pick(fmt), signed: pick(signed), moneyRed: pick(moneyRed),
      round2: pick(round2), esc: pick(esc), formatPeriod: pick(formatPeriod), todayStr: pick(todayStr),
      nowTimeStr: pick(nowTimeStr), showToast: pick(showToast), openModal: pick(openModal),
      closeModal: pick(closeModal), bookKey: pick(bookKey),
      currentPeriod: pick(currentPeriod), lastClosedPeriod: pick(lastClosedPeriod), num: U && U.num,
      // 起止期间取值统一在此提供单点实现，页面模块直接引用（见 PeriodRangePicker.js）。
      periodRangeValue: pick(periodRangeValue),
      periodRangeValues: pick(periodRangeValues),
      escHtml: pick(esc),   // escHtml 与 esc 本就是同一实现，统一以 esc 为准
      // 打印表头【内容】唯一来源（表名/编制单位/期间/单位），stdRptHeadHtml 与报表页 setRptHead 共用
      rptHeadPartsHtml: pick(rptHeadPartsHtml),
      // 高危操作密码校验与统一验证入口（默认 admin，可在系统设置修改）
      effectiveOpPassword: pick(effectiveOpPassword), checkOpPassword: pick(checkOpPassword),
      askOpPassword: pick(askOpPassword),
      refreshAll: pick(refreshAll), U: U, S: S,
      syncAll: pick(syncAll), goPage: pick(goPage), monthOf: (U && U.monthOf),
      // 异步对话框桥接：委托给 dialog-bridge.js（单点实现，便于复用与测试）。
      confirmAsync: (window.__dialogBridge && window.__dialogBridge.confirmAsync) || function (m) { return Promise.resolve(window.confirm ? window.confirm(m) : false); },
      promptAsync: (window.__dialogBridge && window.__dialogBridge.promptAsync) || function (m, d) { return Promise.resolve(window.prompt ? window.prompt(m, d) : null); }
    };
  }

  /* ---------- 二进制 → base64（唯一正确实现，供 tyPrint 等使用） ---------- */
  // 优先复用 file-save-bridge 的实现（单点维护）；该文件缺失时本地兜底。
  // 关键点：先整段拼 binary string 再一次 btoa。分块 btoa 后拼接会引入中间
  // padding '='，导致 Rust 端 base64 STANDARD 解码失败（Invalid symbol 61）。
  function toBase64(u8) {
    var bridge = window.__fileSaveBridge;
    if (bridge && typeof bridge.bytesToBase64 === 'function') return bridge.bytesToBase64(u8);
    var bin = '';
    var chunk = 0x8000; // 分块仅为避免 String.fromCharCode.apply 的调用栈溢出
    for (var i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /* ---------- 统一打印入口：所有数据页 [data-print] 按钮共用 ---------- */
  // 浏览器环境：直接 window.print()。
  // Tauri 环境：webview 禁用 window.print()，故改为「生成独立 HTML 文件 → 写入 exports → 系统浏览器打开」，
  // 用户在浏览器中 Ctrl/Cmd+P 即可打印（浏览器打印管线完好，且含 @media print 样式）。
  // 标准打印抬头（全局唯一格式）：表名 / 编制单位·报表期间·单位：元。
  // 报表页已在表格前注入 setRptHead 抬头；账簿/日记账等无抬头的页由打印层统一兜底补齐，
  // 保证所有 [data-print] 输出的纸面版式一致。
  // 抬头【内容】的唯一来源（表名 / 编制单位 / 期间 / 单位：元）。
  // 打印层 stdRptHeadHtml 与页面 setRptHead 的屏幕注入，都从这里取值，
  // 只包一层不同的外壳（div.rpt-print-head）——抬头版式不存在第二份定义。
  function rptHeadPartsHtml(reportName, bookName, periodText) {
    var name = escapeHtml(reportName || '财务报表');
    var comp = escapeHtml(bookName || '');
    var per = escapeHtml(periodText || '');
    return '<div class="rph-title">' + name + '</div>'
      + '<div class="rph-line"><span class="rph-left">' + comp + '</span>'
      + '<span class="rph-mid">' + per + '</span>'
      + '<span class="rph-right">单位：元</span></div>';
  }
  function stdRptHeadHtml(reportName, bookName, periodText) {
    return '<div class="rpt-print-head">' + rptHeadPartsHtml(reportName, bookName, periodText) + '</div>';
  }
  // 取打印期间文本：优先页面期间选择器的展示文本（含起止范围），
  // 其次页内月份输入框；都没有则回退到「最近有数据期间」。
  function pickPrintPeriod(scope) {
    if (scope) {
      var el = scope.querySelector('.ty-period-trigger-text') || scope.querySelector('.rpt-period');
      if (el) { var t = (el.textContent || '').trim(); if (t) return t; }
      var mi = scope.querySelector('input[type="month"]');
      if (mi && mi.value) { var pv = String(mi.value).split('-'); if (pv.length === 2) return pv[0] + '年' + pv[1] + '期'; }
    }
    var cp = currentPeriod();
    if (cp && /^\d{4}-\d{2}$/.test(cp)) return cp.slice(0, 4) + '年' + cp.slice(5) + '期';
    return '';
  }
  /* ================== 打印契约（长期稳定基线，勿再打结构性补丁） ==================
   * 可打印数据页只需要满足一条、且唯一一条契约：
   *   「页面里恰有一张 class="grid" 的可见主数据表」
   * tyPrint 只克隆这张表本身，绝不克隆外围容器 —— 期间选择条/筛选/按钮都在表格之外，
   * 因此从结构上就不可能混入打印件，与页面有无 .table-wrap、表格直挂 section 与否均无关。
   *
   * 维护守则（改页面/新增可打印页必须遵守，改完跑 __printSelfTest()）：
   *   1. 主数据表带 class="grid"；
   *   2. 不要在数据表内部放 .page-actions / .ty-period-range / select / input 等 UI；
   *   3. 保持每页恰一张可见数据表。
   * 违反契约不会静默：collectPrintBody 会记录 violations，tyPrint 打印时 console.warn，
   * __printSelfTest() 全量扫描所有 [data-print] 入口并输出"通过/失败"清单。
   */
  // 克隆得到的数据表内部不允许出现的 UI（允许它存在 = 纸面必带残件，必须当场暴露）
  var PRINT_TABLE_UI_BLOCK = '.page-actions, .ty-period-range, .topbar, ' +
    '.content-toolbar, .voucher-toolbar, select, textarea, input';

  // 打印主体收集：唯一且稳定的取数点（打印按钮、直印、自检三路共用）。
  function collectPrintBody(scope) {
    var out = { body: '', tables: [], violations: [] };
    if (!scope) { out.violations.push('无打印作用域'); return out; }
    var tbls = Array.prototype.slice.call(scope.querySelectorAll('table.grid'));
    if (!tbls.length) tbls = Array.prototype.slice.call(scope.querySelectorAll('table'));
    // 只取可见表（跳过弹窗等 display:none 中的表）
    tbls = tbls.filter(function (t) {
      var p = t;
      while (p) {
        if (p.style && p.style.display === 'none') return false;
        p = p.parentElement;
      }
      return true;
    });
    if (!tbls.length) { out.violations.push('页面内没有可打印的数据表格'); return out; }
    out.body = tbls.map(function (t) {
      var clone = t.cloneNode(true);
      // 表名行 tr.grid-title：表名与期间由打印层抬头统一给，从克隆体删除，防纸面重复
      Array.prototype.forEach.call(clone.querySelectorAll('tr.grid-title'), function (tr) { tr.remove(); });
      // 契约守卫：数据表内部不允许残留页面 UI（出现即打印件必带残件）
      var ui = clone.querySelector(PRINT_TABLE_UI_BLOCK);
      if (ui) {
        out.violations.push('数据表内发现界面元素 <' + (ui.tagName || '').toLowerCase() + (ui.id ? '#' + ui.id : ''));
      }
      return clone.outerHTML;
    }).join('');
    out.tables = tbls.map(function (t) { return { id: t.id || '', cls: String(t.className || '') }; });
    return out;
  }

  function tyPrint(btn) {
    var store = globalThis.S;
    var bookName = store && store.state && store.state.company && store.state.company.name ? store.state.company.name : '';
    var active = document.querySelector('.page.active');
    var pageKey = active && active.id ? active.id.replace(/^page-/, '') : '';
    if (!pageKey) {
      var _hk = (location.hash || '').replace(/^#/, '');
      if (_hk) pageKey = _hk;
    }
    // 打印主体：只克隆「数据表格本身」（见 collectPrintBody 契约说明），
    // 期间选择条 / 按钮 / 筛选提示等表格外 UI 从结构上不可能进入打印件。
    // 折旧四页已独立分页（原 page-asset-depr 页内 Tab 拆出），直接以当前激活页为作用域，一页一张表。
    var scope = (btn && btn.closest('.page')) || active;
    // 报表名优先级：页内 h2 标题 > PAGE_NAMES 页面名 > 页面 data-name > 通用兜底。
    var subName = '';
    var h2 = active && active.querySelector('.page-actions h2');
    var reportName = '';
    if (subName) reportName = subName;
    else if (h2 && h2.textContent.trim()) reportName = h2.textContent.trim();
    else if (PAGE_NAMES && PAGE_NAMES[pageKey]) reportName = PAGE_NAMES[pageKey];
    else if (active && active.getAttribute('data-name')) reportName = active.getAttribute('data-name');
    else reportName = '财务报表';
    var docTitle = (bookName ? bookName + '_' : '') + (reportName || '财务报表');
    var collect = collectPrintBody(scope);
    if (collect.violations.length) {
      // 契约破坏不静默：提示并指引自检定位（打印仍继续，避免现场卡死）
      console.warn('[打印] 页面打印契约异常（' + pageKey + '）：' + collect.violations.join('；') + '。请运行 __printSelfTest() 定位。');
    }
    var body = collect.body;

    // 全局统一标准抬头（报表页自带 setRptHead 抬头；缺抬头页打印时用此兜底）
    var periodText = pickPrintPeriod(scope);
    var stdHeadHtml = stdRptHeadHtml(reportName, bookName, periodText);

    var tauri = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
    if (tauri && tauri.invoke) {
      // Tauri：生成自包含 HTML，写入 exports，再打开
      var html = buildPrintHtml(docTitle, body, stdHeadHtml);
      var fname = docTitle + '_' + (new Date()).toISOString().slice(0, 10) + '.html';
      // 文件名中的中文/特殊字符需安全化（与 Rust sanitize 互补，避免路径问题）
      fname = fname.replace(/[\\/:*?"<>|]/g, '_');
      var bin = new TextEncoder().encode(html);
      // 必须先把整段拼成 binary string 再一次性 btoa。
      // 绝不能"分块 btoa 再拼接"：每块独立编码会在块尾产生 '=' 填充符，
      // 拼接后 padding 出现在字符串中间，Rust 的 base64 STANDARD 解码会报
      // "Invalid symbol 61"（'=' 的 ASCII 码）而失败。
      var b64 = toBase64(bin);
      tauri.invoke('save_export_file', { name: fname, base64: b64 })
        .then(function (path) {
          // 用已验证的 open_in_explorer Rust 命令打开（不依赖 opener 插件的 scope/方法名不确定性）
          return tauri.invoke('open_in_explorer', { path: path })
            .catch(function () { showToast('已生成打印文件：' + path, 'success', 5000); });
        })
        .catch(function (e) { showToast('打印生成失败：' + (e && e.message || e), 'error'); });
    } else {
      // 浏览器：直接打印
      var prevTitle = document.title;
      document.title = docTitle;
      // 缺抬头页（账簿/日记账/对账等）打印前临时注入标准抬头，打印后移除，不改屏幕状态
      var injectedHead = null;
      if (scope && !scope.querySelector('.rpt-print-head')) {
        var holder = document.createElement('div');
        holder.innerHTML = stdHeadHtml;
        injectedHead = holder.firstChild;
        var hostTbl = scope.querySelector('.table-wrap, .rpt-table, table');
        if (hostTbl && injectedHead) hostTbl.parentNode.insertBefore(injectedHead, hostTbl);
      }
      function restoreTitle() {
        document.title = prevTitle;
        if (injectedHead && injectedHead.parentNode) injectedHead.parentNode.removeChild(injectedHead);
        window.removeEventListener('afterprint', restoreTitle);
      }
      window.addEventListener('afterprint', restoreTitle);
      window.print();
    }
  }

  // 生成自包含打印 HTML（内联关键样式，含 @media print），保证浏览器打开即是一张可打印报表
  // 抬头来源：bodyHtml 恒为 collectPrintBody 克隆的「纯数据表格」，从不携带抬头，
  // 故纸面抬头一律取调用方传入的 fallbackHead（tyPrint 统一传 stdHeadHtml，
  // 内容出自 rptHeadPartsHtml 单一格式源）；缺省时退回单标题，保证纸面至少有表名。
  function buildPrintHtml(title, bodyHtml, fallbackHead) {
    var leading = fallbackHead
      || '<div class="rpt-print-head">' + rptHeadPartsHtml(title, '', '') + '</div>';
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<title>' + escapeHtml(title) + '</title><style>'
      + 'body{font-family:-apple-system,"Microsoft YaHei",sans-serif;color:#222;padding:24px;}'
      // 统一打印基线：table-layout:auto + 保留 colgroup hint（不覆盖）
      + 'table{border-collapse:collapse;width:100%;table-layout:auto;font-size:11px;}'
      + 'th,td{border:1px solid #666;padding:3px 6px;text-align:left;}'
      + 'th{background:#f0f0f0;font-weight:600;}'
      + 'tr:nth-child(even) td{background:#fafafa;}'
      // 金额/数字/方向/期间列不折行，文本列允许折行
      + 'td.ta-r, td.mono, td.num, td.col-amt, th.ta-r, th.col-amt, td.gl-dir, td.gl-period{white-space:nowrap;}'
      // 保留链接文字（科目编码是 <a>），只去样式
      + 'a{color:inherit;text-decoration:none;}'
      // 树形折叠三角：打印时隐藏（与 style.css @media print 对齐）
      + '.tb-arrow,.subj-arrow,.ed-tree-arrow,.subj-arrow-leaf,.tb-arrow-leaf,.ed-tree-spacer{display:none;}'
      // 标准打印抬头（与页面 @media print 版式一致）
      + '.rpt-print-head{margin-bottom:12px;}'
      + '.rpt-print-head .rph-title{font-size:18px;font-weight:700;text-align:center;margin-bottom:6px;}'
      + '.rpt-print-head .rph-line{display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;}'
      + '.rpt-print-head .rph-left{text-align:left;flex:1;}.rpt-print-head .rph-mid{text-align:center;flex:1;}'
      + '.rpt-print-head .rph-right{text-align:right;flex:1;}'
      // 隐藏表格内重复的表名/账期行（抬头已含表名与期间）
      + '.rpt-print-head + table .grid-title{display:none!important;}'
      + '.rpt-title{font-size:18px;font-weight:700;}'
      + '.rpt-period{font-size:12px;color:#666;margin-top:4px;}'
      + 'input[type=checkbox]{display:none;}'
      + '.btn,.ty-btn,button{display:none!important;}'
      + '@media print{body{padding:0;}.print-hint{display:none!important;}}'
      + '</style></head><body>'
      + leading
      + (bodyHtml || '<p>（无可打印内容）</p>')
      + '<p class="print-hint" style="margin-top:16px;font-size:12px;color:#1565c0;background:#e3f2fd;padding:8px 12px;border-radius:4px;">'
      + '这是打印预览页：请按键盘 <b>Ctrl+P</b>（Mac 为 <b>Cmd+P</b>）调出打印对话框，选择打印机或「另存为 PDF」即可完成打印。</p>'
      + '</body></html>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  globalThis.__TY_HELPERS__.tyPrint = tyPrint;
  globalThis.tyPrint = tyPrint;

  // 打印回归自检：扫描全部 [data-print] 打印入口，逐页走真实收集路径，
  // 断言"恰一张可见数据表、克隆体无 UI 残件、grid-title 已去重"。
  // 任何页面/打印改动后执行本函数，要求 passed === total 再交付。
  // 用法（浏览器/Tauri 前端 console）：__printSelfTest()
  function printSelfTest() {
    var btns = document.querySelectorAll('[data-print]');
    var rows = [], fails = 0;
    Array.prototype.forEach.call(btns, function (btn) {
      // 与 tyPrint 一致：以按钮所在 .page 为作用域（折旧四页已独立分页，一页一张表）
      var pg = btn.closest('.page');
      var hostPage = btn.closest('.page');
      var name = hostPage && hostPage.id ? String(hostPage.id).replace(/^page-/, '') : '(未在任何 .page 内)';
      var label = String((btn.getAttribute('title') || btn.textContent || '').trim()).slice(0, 12);
      var r = collectPrintBody(pg);
      var ok = !r.violations.length && r.tables.length === 1 && !!r.body;
      if (!ok) fails++;
      rows.push({
        page: name,
        btn: label,
        tables: r.tables.length,
        tableId: r.tables[0] ? r.tables[0].id : '',
        pass: ok ? 'OK' : 'FAIL',
        detail: ok ? '' : (r.violations.length ? r.violations.join('；') : '表格数量≠1')
      });
    });
    if (window.console) {
      console.log('[打印自检] 通过 ' + (rows.length - fails) + ' / ' + rows.length + ' 个打印入口' + (fails ? '（失败 ' + fails + ' 个，见下）' : ''));
      if (fails) rows.filter(function (x) { return x.pass !== 'OK'; }).forEach(function (x) { console.warn('[打印自检] FAIL ' + x.page + ' / ' + x.btn + '：' + x.detail); });
    }
    return { total: rows.length, passed: rows.length - fails, rows: rows };
  }
  globalThis.__printSelfTest = printSelfTest;
  // 事件委托：新增数据页只需在 page-actions 放 <button class="btn" data-print>打印</button>，无需各自绑定 JS。
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-print]');
    if (btn) { e.preventDefault(); tyPrint(btn); }
  });

  /* ---------- 导航：左侧菜单，点击主菜单也能展开子菜单（单例浮层） ---------- */
  document.getElementById('sidenav').addEventListener('click', function (e) {
    var title = e.target.closest('.nav-group-title');
    if (title) {
      // 点击主菜单：互斥展开 / 收起当前组（复用单例浮层）
      var group = title.closest('.nav-group');
      if (group.classList.contains('nav-group-direct')) return; // direct 分组由 click 进页面
      if (group.classList.contains('open')) {
        hideNavPopover();
      } else {
        document.querySelectorAll('.nav-group.open').forEach(function (g) { g.classList.remove('open'); });
        group.classList.add('open');
        showNavPopover(group);
      }
      return;
    }
    // 子菜单项渲染在单例浮层（挂在 body），sidenav 内不出现，故此处仅处理标题点击
  });
  // 单例浮层内的子菜单项点击：统一走 goPage
  function bindNavPopClick() {
    var pop = ensureNavPop();
    pop.addEventListener('click', function (e) {
      var a = e.target.closest('.nav-pop-item');
      if (!a) return;
      e.preventDefault();
      var page = a.getAttribute('data-page');
      var path = [];
      var popCol = a.closest('.nav-pop-col');
      if (popCol) {
        var l2 = popCol.querySelector('.nav-pop-title');
        if (l2) path.push(l2.textContent.trim());
      }
      hideNavPopover();
      goPage(page, path);
    });
  }

  /* ---------- 首页按钮事件委托（qk / qk-newvoucher / metric-tab / 工具栏 / 标签页） ---------- */
  (function () {
    var homePage = $('page-home');
    if (!homePage) return;
    // 监听范围：内容区（含工具栏、标签页栏、首页页面）
    document.getElementById('content').addEventListener('click', function (e) {
      // 标签页关闭按钮
      var closeBtn = e.target.closest('.tab-close[data-close]');
      if (closeBtn) {
        e.stopPropagation();
        var closePage = closeBtn.getAttribute('data-close');
        openTabs = openTabs.filter(function (t) { return t.page !== closePage; });
        // 关闭后跳到最后一个标签，没有则回首页（house 按钮）
        if (openTabs.length > 0) goPage(openTabs[openTabs.length - 1].page);
        else goPage('home');
        return;
      }
      // 常用功能 / 标签页点击（data-page 跳转）
      var qk = e.target.closest('[data-page]');
      if (qk) { e.preventDefault(); goPage(qk.getAttribute('data-page')); return; }
      // 编辑按钮 → 打开常用功能设置弹窗
      if (e.target.closest('.home-section-edit')) { openQuickSettings(); return; }
    });
  })();

  /* ============================================================
   * 常用功能设置（弹窗分类 checkbox，可增减图标）
   * ============================================================ */

  /** 所有可选菜单项（按功能分类） */
  var QUICK_MENU_ITEMS = [
    { group: '凭证', items: [
      { key: 'voucher-edit',    name: '录凭证',       page: 'voucher',        color: '#5582f3' },
      { key: 'voucher-query',   name: '查凭证',       page: 'voucher-query',  color: '#06B6D4' },
      { key: 'voucher-sum',     name: '凭证汇总表',   page: 'voucher-sum',    color: '#8B5CF6' },
      { key: 'original',        name: '原始凭证',     page: 'original',       color: '#F59E0B' },
    ]},
    { group: '账簿', items: [
      { key: 'detail-ledger',   name: '明细账',       page: 'detail-ledger',  color: '#6366F1' },
      { key: 'general-ledger',  name: '总账',         page: 'general-ledger', color: '#F97316' },
      { key: 'trial-balance',   name: '科目余额表',   page: 'trial-balance',  color: '#F59E0B' },
      { key: 'multi-column',    name: '多栏账',       page: 'multi-ledger',  color: '#EC4899' },
    ]},
    { group: '报表', items: [
      { key: 'report-balance',  name: '资产负债表',   page: 'report-balance', color: '#EF4444' },
      { key: 'report-profit',   name: '利润表',       page: 'report-profit',  color: '#EC4899' },
      { key: 'cash-flow',       name: '标准现金流量表',page:'report-cashflow',color:'#06B6D4' },
      { key: 'tax-payable',     name: '主要应交税金明细表',page:'report-tax',color:'#E11D48' },
      { key: 'expense-detail',  name: '费用明细表',   page: 'expense-detail',color: '#8B5CF6' },
    ]},
    /* 标准：结账（独立页面，无子菜单，含期末处理/反结账 Tab） */
    { group: '结账', direct: true, page: 'settle', items: [
      { key: 'settle-close', name: '期末处理', page: 'settle', color: '#0EA5E9' },
    ]},
    { group: '资产', items: [
      { key: 'asset-card',          name: '固定资产卡片', page: 'asset-card',          color: '#14B8A6' },
      { key: 'asset-depr-voucher',  name: '折旧凭证',     page: 'asset-depr-voucher',  color: '#F59E0B' },
      { key: 'asset-depr-sum',      name: '折旧汇总表',   page: 'asset-depr-sum',      color: '#0EA5E9' },
      { key: 'asset-depr-detail',   name: '折旧明细表',   page: 'asset-depr-detail',   color: '#6366F1' },
      { key: 'asset-change-log',    name: '资产变动记录', page: 'asset-change-log',    color: '#EC4899' },
    ]},
    { group: '工资', items: [
      { key: 'salary-table', name: '工资',   page: 'salary',           color: '#E11D48' },
      { key: 'salary-statistics', name: '工资统计', page: 'salary-statistics', color: '#F97316' },
    ]},
    { group: '设置', items: [
      { key: 'account-setup',       name: '科目',             page: 'subject',             color: '#64748B' },
      { key: 'init-balance',        name: '期初余额',     page: 'opening',             color: '#0891B2' },
      { key: 'cashflow-init',       name: '现金流量初始余额', page: 'cashflow-init',       color: '#0D9488' },
      { key: 'cashflow-project',    name: '科目现金流量项目', page: 'cashflow-project',    color: '#059669' },
      { key: 'system-settings',     name: '系统设置',         page: 'system-settings',     color: '#475569' },
      { key: 'operation-logs',      name: '操作日志',         page: 'operation-logs',      color: '#7C3AED' },
    ]},
  ];

  /** 默认勾选的菜单项（key 列表，顺序即首页展示顺序；录凭证为固定项，另计大卡片不占 15 个名额）
   *  默认：录凭证（固定）→ 查凭证 → 明细账 → 总账 → 科目余额表 → 资产负债表 → 利润表 → 标准现金流量表 → 费用明细表
   */
  var DEFAULT_QUICK_KEYS = ['voucher-edit','voucher-query','detail-ledger','general-ledger','trial-balance','report-balance','report-profit','cash-flow','expense-detail'];
  // 固定项：始终勾选、不可取消（录凭证是日常第一入口，取消会造成首页无凭证入口）
  var FIXED_QUICK_KEY = 'voucher-edit';

  function getSavedQuickKeys() {
    try { var s = localStorage.getItem('quick_menu_keys'); if (s) return JSON.parse(s); } catch(e){}
    return DEFAULT_QUICK_KEYS.slice();
  }
  function saveQuickKeys(keys) {
    try { localStorage.setItem('quick_menu_keys', JSON.stringify(keys)); } catch(e){}
  }
  function findQuickItem(key) {
    // 旧「折旧」菜单键 → 折旧凭证（资产四页已独立分页，旧快捷图标平滑延续）
    if (key === 'asset-depr') key = 'asset-depr-voucher';
    for (var i = 0; i < QUICK_MENU_ITEMS.length; i++) {
      for (var j = 0; j < QUICK_MENU_ITEMS[i].items.length; j++) {
        if (QUICK_MENU_ITEMS[i].items[j].key === key) return QUICK_MENU_ITEMS[i].items[j];
      }
    }
    return null;
  }

  function openQuickSettings() {
    var overlay = $('quickSettingsOverlay');
    var body = $('qsBody');
    if (!overlay || !body) return;
    var savedKeys = getSavedQuickKeys();
    var html = '<div class="qs-tip">「录凭证」为固定功能，默认勾选且不可取消；其余功能可自由勾选（最多 15 个）。</div>';
    QUICK_MENU_ITEMS.forEach(function (group) {
      html += '<div class="qs-group">';
      html += '<div class="qs-group-title">' + group.group + '</div>';
      html += '<div class="qs-items">';
      group.items.forEach(function (item) {
        var fixed = item.key === FIXED_QUICK_KEY;
        var checked = (fixed || savedKeys.indexOf(item.key) >= 0) ? 'checked' : '';
        var lockAttr = fixed ? ' disabled title="录凭证为固定功能，不可取消"' : '';
        html += '<div class="qs-item' + (fixed ? ' qs-item-fixed' : '') + '">'
          + '<input type="checkbox" id="qsk_' + item.key + '" value="' + item.key + '" ' + checked + lockAttr + '/>'
          + '<label for="qsk_' + item.key + '">' + item.name
          + (fixed ? '<span class="qs-fixed-tag">固定</span>' : '') + '</label></div>';
      });
      html += '</div></div>';
    });
    body.innerHTML = html;
    // 限制常用功能最多 15 个网格图标（不含录凭证大卡片，按非 voucher-edit 计数）
    body.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.value === FIXED_QUICK_KEY) { cb.checked = true; return; } // 固定项兜底：不可取消
        var iconCount = 0;
        body.querySelectorAll('input[type="checkbox"]:checked').forEach(function (c) {
          if (c.value !== FIXED_QUICK_KEY) iconCount++;
        });
        if (iconCount > 15) {
          cb.checked = false;
          showToast('常用功能最多添加 15 个');
        }
      });
    });
    overlay.style.display = 'flex';
  }

  function closeQuickSettings() {
    var overlay = $('quickSettingsOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  // 其他科目指标 swiper 滚动（scrollSubject）已迁入 js/pages/home/Home.js

  function confirmQuickSettings() {
    var body = $('qsBody');
    if (!body) return;
    var cbs = body.querySelectorAll('input[type="checkbox"]:checked');
    var keys = [];
    cbs.forEach(function(cb){ keys.push(cb.value); });
    // 兜底：网格图标（非录凭证）最多 15 个，超出截断
    var icons = keys.filter(function (k) { return k !== FIXED_QUICK_KEY; });
    if (icons.length > 15) {
      icons = icons.slice(0, 15);
      showToast('常用功能最多添加 15 个，已保留前 15 个');
    }
    // 录凭证固定首位且必选（即使被禁用勾选也始终写入）
    keys = [FIXED_QUICK_KEY].concat(icons);
    saveQuickKeys(keys);
    closeQuickSettings();
    renderQuickIcons(keys);
  }

  function renderQuickIcons(keys) {
    var grid = document.querySelector('.home-quick-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var iconKeys = keys.filter(function(k){ return k !== FIXED_QUICK_KEY; });
    iconKeys.forEach(function (key) {
      var item = findQuickItem(key);
      if (!item) return;
      var a = document.createElement('a');
      a.className = 'qk';
      a.setAttribute('data-page', item.page);
      // 用名称首字作为图标文字
      var ch = item.name.charAt(0);
      a.innerHTML = '<span class="qk-circle" style="background:' + item.color + '">' + ch + '</span><span class="qk-label">' + item.name + '</span>';
      grid.appendChild(a);
    });
  }

  /** 左侧导航：依据同一份 QUICK_MENU_ITEMS 数据源渲染，与设置弹窗自动同步 */
  function renderSideNav() {
    var nav = $('sidenav');
    if (!nav) return;
    var html = '';
    // 侧栏顶部 logo：已彻底移除（品牌统一在顶栏 TY 图标 + 「添钰财务管理系统」）。
    // 菜单字形图标：普通/激活双态 SVG（.icon--Jt57- 普通 + .icon_active--3FvIC 激活，
    // hover/active 时 CSS 切换 display，激活字形带青蓝渐变 fill）
    function navIconHtml(groupName, idx) {
      var pairs = (typeof TY_MENU_ICON_PAIRS !== 'undefined') ? TY_MENU_ICON_PAIRS : null;
      var paths = (typeof TY_MENU_ICON_PATHS !== 'undefined') ? TY_MENU_ICON_PATHS : null;
      if (!pairs || !paths || !pairs[groupName]) {
        return '<span class="nav-ico">' + groupName.charAt(0) + '</span>';
      }
      var normal = paths[pairs[groupName][0]] || '';
      var active = paths[pairs[groupName][1]] || normal;
      var gid = 'navGrad' + idx;
      return '<span class="nav-ico">' +
        '<svg class="nav-ico-normal" viewBox="0 0 1000 1000" aria-hidden="true"><path d="' + normal + '"/></svg>' +
        '<svg class="nav-ico-active" viewBox="0 0 1000 1000" aria-hidden="true">' +
          '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="3%" stop-color="#27e6e1"/><stop offset="100%" stop-color="#2f95ff"/>' +
          '</linearGradient></defs>' +
          '<path d="' + active + '" fill="url(#' + gid + ')"/>' +
        '</svg>' +
      '</span>';
    }
    QUICK_MENU_ITEMS.forEach(function (group, gi) {
      var icoHtml = navIconHtml(group.group, gi);
      // 结账等 direct 分组：直接点击进入页面，无子菜单弹出
      if (group.direct) {
        html += '<div class="nav-group nav-group-direct" data-page="' + group.page + '">';
        html += '<div class="nav-group-title nav-direct-title">' + icoHtml + '<span class="nav-text">' + group.group + '</span></div>';
        html += '</div>';
        return;
      }
      // 仅渲染标题；子菜单内容由「单例浮层」在 hover 时按需渲染，
      // 不再为每个组各生成一个 .nav-pop（避免多节点残留重叠）。
      html += '<div class="nav-group">';
      html += '<div class="nav-group-title">' + icoHtml + '<span class="nav-text">' + group.group + '</span></div>';
      html += '</div>';
    });
    // 菜单区包进滚动容器（.sidebarMenuWrapper--1lMd-：flex:1; overflow-y:auto），
    // 使底部 .nav-op-wrapper 的 margin-top:auto 在菜单超长时仍吸底。
    // （logo 已彻底移除，html 现即为纯菜单，无需再切分 logo/菜单）
    html = '<div class="nav-menu-scroll">' + html + '</div>';
    nav.innerHTML = html;
    // 侧栏底部操作区（.opWrapper--1HuXG：已删除「月亮/太阳(暗色主题切换)」，仅保留「左箭头(收起)」）
    var op = document.createElement('div');
    op.className = 'nav-op-wrapper';
    op.innerHTML =
      '<div class="nav-op-btn" id="navCollapseBtn" title="收起导航">' +
        '<svg class="nav-op-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="12" x2="3" y2="12"/><polyline points="8,7 3,12 8,17"/></svg>' +
      '</div>';
    nav.appendChild(op);
    // hover 绑定：进入标题即把该组数据交给单例浮层渲染显示，离开再延时隐藏。
    // 单例浮层物理上只有一个 DOM 节点，从根上保证「同一时刻只显示一个预览气泡」。
    nav.querySelectorAll('.nav-group').forEach(function (group, idx) {
      // direct 分组（结账）：点击直接进页面，不弹子菜单
      if (group.classList.contains('nav-group-direct')) {
        group.addEventListener('click', function () {
          var pg = group.getAttribute('data-page');
          if (pg) goPage(pg);
        });
        return;
      }
      // 把菜单数据挂到 DOM 上，hover 时单例浮层取用
      group.__navData = QUICK_MENU_ITEMS[idx];
      function enter() { cancelNavClose(); group.classList.add('open'); showNavPopover(group); }
      function leave() { group.classList.remove('open'); scheduleNavClose(); }
      group.addEventListener('mouseenter', enter);
      group.addEventListener('mouseleave', leave);
    });
    // 离开整条导航栏才隐藏浮层（浮层自身 hover 时由 ensureNavPop 内的监听接管）
    nav.addEventListener('mouseleave', function () { groupLeaveAll(); });

    // 收起导航（.shouqi-zhankai + title="收起导航"）：切换 .sidenav.collapsed，
    // 侧栏收窄到仅图标宽、隐藏菜单文字，顶栏/内容区 margin-left 跟随变量联动；状态持久化。
    var navEl = nav;
    var collapseBtn = $('navCollapseBtn');
    // 收起导航箭头 SVG：收起时 ← 朝左，展开后 → 朝右（旋转 180°， .shouqi-zhankai）
    var collapseIco = collapseBtn ? collapseBtn.querySelector('.nav-op-ico') : null;
    function applyNavCollapsed(collapsed) {
      var root = document.documentElement;
      if (collapsed) {
        navEl.classList.add('collapsed');
        root.style.setProperty('--nav-w-active', '50px');
        if (collapseIco) collapseIco.style.transform = 'rotate(180deg)';
        if (collapseBtn) collapseBtn.title = '展开导航';
      } else {
        navEl.classList.remove('collapsed');
        root.style.setProperty('--nav-w-active', '120px');
        if (collapseIco) collapseIco.style.transform = '';
        if (collapseBtn) collapseBtn.title = '收起导航';
      }
      try { localStorage.setItem('tyNavCollapsed', collapsed ? '1' : '0'); } catch (e) {}
    }
    // 初始恢复上次状态
    var savedCollapsed = '0';
    try { savedCollapsed = localStorage.getItem('tyNavCollapsed') || '0'; } catch (e) {}
    applyNavCollapsed(savedCollapsed === '1');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function () {
        applyNavCollapsed(!navEl.classList.contains('collapsed'));
      });
    }

    // 删除暗色模式功能（曾由 kdThemeDark 切换 <html>.ty-theme-dark）：
    // 已移除主题按钮与 applyTheme 逻辑；此处清理历史可能残留的 localStorage 键，
    // 并确保 <html> 不残留暗色类（防止旧数据导致侧栏深色样式残留在新界面）。
    try {
      localStorage.removeItem('kdThemeDark');
      document.documentElement.classList.remove('ty-theme-dark');
    } catch (e) {}
  }
  function groupLeaveAll() {
    document.querySelectorAll('.nav-group.open').forEach(function (g) { g.classList.remove('open'); });
    scheduleNavClose();
  }

  // 弹窗事件绑定
  document.addEventListener('DOMContentLoaded', function () {
    var qsClose = $('qsClose');
    if (qsClose) qsClose.addEventListener('click', closeQuickSettings);
    var qsCancel = $('qsCancel');
    if (qsCancel) qsCancel.addEventListener('click', closeQuickSettings);
    var qsConfirm = $('qsConfirm');
    if (qsConfirm) qsConfirm.addEventListener('click', confirmQuickSettings);
    // 「恢复默认」：把弹窗内勾选重置为系统默认（不立即保存，用户点「确定」才生效；点「取消」可放弃）
    var qsReset = $('qsReset');
    if (qsReset) qsReset.addEventListener('click', function () {
      var body = $('qsBody');
      if (!body) return;
      body.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.checked = DEFAULT_QUICK_KEYS.indexOf(cb.value) >= 0;
      });
      showToast('已恢复默认常用功能，点「确定」生效');
    });
    var overlay = $('quickSettingsOverlay');
    if (overlay) overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeQuickSettings();
    });
    // 单一数据源：左侧导航 + 常用功能图标均来自 QUICK_MENU_ITEMS
    renderSideNav();
    bindNavPopClick();
    renderQuickIcons(getSavedQuickKeys());
    // 顶栏品牌 + 侧栏 logo（若显示）点击均返回首页
    document.addEventListener('click', function (e) {
      // 顶栏品牌（TY 图标 + 「添钰财务管理系统」）点击返回首页；侧栏 logo 已彻底移除
      var brand = (e.target && e.target.closest) ? e.target.closest('#topbarBrand') : null;
      if (!brand) return;
      goPage('home');
      e.preventDefault();
    });
    // 录凭证表头金额单位行（复用 Pd 组件，单位与数字位格严格对齐）
    var thDr = $('vThDr'), thCr = $('vThCr');
    if (thDr) thDr.innerHTML = amtHeaderHtml('借方金额');
    if (thCr) thCr.innerHTML = amtHeaderHtml('贷方金额');

    // 首页域逻辑已迁移至 js/pages/home/Home.js（globalThis.__HOME__），此处委托。
    var hm = globalThis.__HOME__ || {};

    // --- 内联事件处理器移除后的委托绑定（B1 收敛） ---
    // .vf-edit-maker 无实际 JS 行为，仅阻止 <a href="#"> 跳转
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.vf-edit-maker')) { e.preventDefault(); }
    });
    // 总账 "展开所有级次" checkbox
    var glExp = $('glExpandAll');
    if (glExp) glExp.addEventListener('change', function () { if (globalThis.__renderGl) globalThis.__renderGl(); });
    // 费用明细表 4 个报表选项 checkbox（函数由页面模块在 bindED 中挂到 window）
    ['edOptYearTotal','edOptRatio','edOptExpand','edOptZero'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('change', function () { if (window.__edOptChange) window.__edOptChange(); });
    });
  });



  /* ---------- 顶部栏账套/期间（.accountName 纯展示标签） ----------
     源码（原始抓取 HTML + main.d261698f.chunk.css）确认：
     账套名(.acctName)+账期(.acctDate) 是 .accountName 内两个纯文本 div，
     .wrapper--n7MvS 仅设 cursor:pointer（手图标），无 onClick、无下拉触发器。
     实测点击无反应——此区域为纯展示，故不放任何点击交互。 */
  function closeSearchDropdown() { var d = $('searchDropdown'); if (d) d.hidden = true; }
  function closeAllTopPop() { closeSearchDropdown(); var o = $('topOverlay'); if (o) o.hidden = true; }

  // 全局遮罩：点击关闭所有顶部浮层
  var topOverlay = $('topOverlay');
  if (topOverlay) topOverlay.addEventListener('click', closeAllTopPop);

  // 右上角：纯本地单机版，显示当前账套的记账员（不依赖云端账号）
  // 点击可改名：用于会计换人/离职场景。保存到 company.bookkeeper 并持久化，
  // 之后新录凭证的制单人、新操作日志的操作人、以及「不允许修改/删除别人录入的凭证」
  // 等权限校验都会按新名字生效；历史凭证 maker 已固化、不受影响（可追溯离职前操作人）。
  function updateTopOperator() {
    var topOperator = $('topOperator');
    if (!topOperator) return;
    var S = window.S;
    var name = (S && S.state && S.state.company && S.state.company.bookkeeper) || '记账员';
    topOperator.textContent = name;
    topOperator.title = '当前账套记账员（点击可修改，本地单机版无需登录）';
  }
  updateTopOperator();

  // 点击右上角记账员：打开居中弹窗改名（单机、单操作员，改账套记账员名即可留痕）
  var topUserEl = $('topUser');
  if (topUserEl && typeof window.S !== 'undefined') {
    topUserEl.addEventListener('click', function (e) {
      e.stopPropagation();
      var S = window.S;
      if (!S || !S.state || !S.state.company) return;
      var cur = S.state.company.bookkeeper || '记账员';
      var inputEl = $('opNameInput');
      if (inputEl) {
        inputEl.value = cur === '记账员' ? '' : cur; // 若为占位默认值，则留空引导填写真实姓名
        inputEl.focus(); inputEl.select();
      }
      openModal('operatorModal');
    });
  }
  // 记账员改名弹窗：确定
  var btnOpSave = $('btnOpSave');
  if (btnOpSave) btnOpSave.addEventListener('click', function () {
    var S = window.S;
    if (!S || !S.state || !S.state.company) return;
    var cur = S.state.company.bookkeeper || '记账员';
    var inputEl = $('opNameInput');
    var name = String(inputEl ? inputEl.value : '').trim();
    if (!name) { showToast('请输入你的真实姓名', 'warn'); return; }
    if (name.length > 20) { showToast('姓名过长（最多20字）', 'warn'); return; }
    // 引导：不允许把「会计/记账员」这类占位默认值当真名保存，必须填真实姓名
    if (name === '会计' || name === '记账员') { showToast('请填写你的真实姓名，不要使用默认名称「' + name + '」', 'warn'); return; }
    if (name === cur) { closeModal('operatorModal'); return; } // 未变化
    S.state.company.bookkeeper = name;
    // 持久化：localStorage + 服务端主账本 + 自动备份
    if (S.persist) S.persist();
    if (S.addLog) S.addLog('修改记账员', '将记账员由「' + cur + '」改为「' + name + '」', '设置');
    updateTopOperator();
    closeModal('operatorModal');
    showToast('记账员已改为「' + name + '」');
  });
  // 记账员改名弹窗：取消 / 关闭
  var btnOpCancel = $('btnOpCancel');
  if (btnOpCancel) btnOpCancel.addEventListener('click', function () { closeModal('operatorModal'); });
  var btnOpX = $('btnOpX');
  if (btnOpX) btnOpX.addEventListener('click', function () { closeModal('operatorModal'); });

  /* ---------- 顶栏账套下拉选择（「账套：」按钮点击弹出，单击即切换账套） ----------
   * 参照搜索下拉：.topbar 有 overflow:hidden，absolute 定位会被裁切，故用 fixed + JS 定位。
   * 数据源：S.listBooks()（磁盘索引快取，打开时 fire-and-forget 刷新 refreshBookIndex），
   * 切换走 S.switchBook(id)（store 铁律：先落盘当前账套 → 读目标权威数据 → 成功后 __refreshAll）。 */
  var topAcctBtn = $('topAcctBtn');
  var bookDropdown = $('bookDropdown');
  function placeBookDropdown() {
    if (!topAcctBtn || !bookDropdown) return;
    var r = topAcctBtn.getBoundingClientRect();
    bookDropdown.style.left = r.left + 'px';
    bookDropdown.style.top = (r.bottom + 2) + 'px';
    bookDropdown.style.minWidth = r.width + 'px';
    bookDropdown.style.maxWidth = Math.max(r.width, 300) + 'px';
  }
  function renderBookDropdown() {
    if (!bookDropdown) return;
    var books = [];
    var cur = '';
    try {
      if (window.S && typeof window.S.listBooks === 'function') books = window.S.listBooks() || [];
      if (window.S && window.S.currentBookId) cur = String(window.S.currentBookId() || '');
    } catch (e) {}
    if (!books.length) {
      bookDropdown.innerHTML = '<div class="book-empty">暂无账套，请到「设置-账套管理」新建或导入</div>';
      return;
    }
    var html = books.map(function (b) {
      var id = String(b.id || '');
      var name = String(b.name || id || '未命名账套');
      var isCur = id === cur;
      var off = false;
      try { off = !!(window.S && typeof window.S.isBookEnabled === 'function' && !window.S.isBookEnabled(id)); } catch (e) {}
      return '<div class="book-item' + (isCur ? ' cur' : '') + '" data-book="' + esc(id) + '"' + (isCur ? '' : ' title="点击切换到该账套"') + '>'
        + '<span class="book-item-name">' + esc(name) + '</span>'
        + (isCur ? '<span class="book-item-cur">当前</span>' : (off ? '<span class="book-item-off">停用</span>' : ''))
        + '</div>';
    }).join('');
    bookDropdown.innerHTML = html;
  }
  function openBookDropdown() {
    if (!bookDropdown) return;
    placeBookDropdown();
    bookDropdown.hidden = false;
    renderBookDropdown();
    // 打开时异步用磁盘刷新账套索引，保证与「账套管理」里新建/导入的账套一致；
    // 成功后再渲染一次补齐新增项（listBooks 为内存快取，刷新为异步）。
    if (window.S && typeof window.S.refreshBookIndex === 'function') {
      try {
        var p = window.S.refreshBookIndex();
        if (p && typeof p.then === 'function') p.then(function () { renderBookDropdown(); }).catch(function () {});
      } catch (e) {}
    }
  }
  function closeBookDropdown() { if (bookDropdown) bookDropdown.hidden = true; }
  if (topAcctBtn) {
    topAcctBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (bookDropdown && bookDropdown.hidden) openBookDropdown(); else closeBookDropdown();
    });
    topAcctBtn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openBookDropdown(); }
      if (e.key === 'Escape') closeBookDropdown();
    });
  }
  if (bookDropdown) {
    bookDropdown.addEventListener('click', function (e) {
      var item = e.target.closest('.book-item');
      if (!item) return;
      var id = item.getAttribute('data-book');
      if (!id || !window.S) return;
      closeBookDropdown();
      var nm = '';
      try {
        nm = String((window.S.listBooks().filter(function (b) { return String(b.id) === id; })[0] || {}).name || id);
      } catch (e) {}
      var r = window.S.switchBook(id);
      if (r && !r.ok) { showToast(r.msg || '切换失败', 'error'); return; }
      // 点击的正是当前账套：switchBook 返回 ok 但不做任何切换，给明确提示
      if (String(window.S.currentBookId()) === id) {
        showToast('已在此账套：' + nm);
        return;
      }
      showToast('正在切换到「' + nm + '」…');
      // 切换加载完成后由 store.switchBook 内部调用 __refreshAll 刷新全页（含 topCompany 更新）
    });
  }
  // 点击页面其他区域关闭下拉
  document.addEventListener('click', function () { closeBookDropdown(); });

  // 纯本地单机版：已移除云端登录门、账号弹窗、登录/退出逻辑。

  function _maybeRemindBackup() {
    try {
      var KEY = 'kis_bk_remind';
      var last = localStorage.getItem(KEY) || '';
      var now = new Date();
      var today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
      if (!last) { localStorage.setItem(KEY, today); return; } // 首次只记录，不打扰
      var d = new Date(String(last).replace(/-/g, '/'));
      var diff = Math.floor((now - d) / 86400000);
      if (diff >= 7) {
        localStorage.setItem(KEY, today);
        showToast('提醒：建议每周到「设置-数据与安全」导出一次备份文件到本地', 'info');
      }
    } catch (e) {}
  }
  _maybeRemindBackup();


  /* ---------- 全局搜索（kp-layout-search 内联展开式） ---------- */
  // 检索范围：凭证（摘要/科目/字号/金额）、科目、账簿（固定搜全部，quick-search 组件）
  var searchInput = $('searchInput');
  var searchResult = $('searchResult');
  var searchToggle = $('searchToggle');
  var searchBar = $('searchBar');
  var searchDropdown = $('searchDropdown');

  // 彻底防浏览器自动填充：动态 name（每次加载随机化，浏览器无法匹配已保存的表单字段）
  ['searchInput'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('name', id + '_' + Math.random().toString(36).slice(2, 8));
  });
  // 兜底：加载完成后清空浏览器可能强填的值（readonly 已拦截，此处防御新版本浏览器）
  setTimeout(function () {
    var el = document.getElementById('searchInput');
    if (el && el.value) el.value = '';
  }, 300);

  // 下拉为 fixed 顶层浮层：显示前按搜索栏当前屏幕位置定位（顶栏不随内容滚动，仅窗口变化时重算）
  function placeSearchDropdown() {
    if (!searchBar || !searchDropdown) return;
    var r = searchBar.getBoundingClientRect();
    searchDropdown.style.left = r.left + 'px';
    searchDropdown.style.top = (r.bottom + 2) + 'px';
    searchDropdown.style.width = r.width + 'px';
  }
  function openSearch() {
    placeSearchDropdown();
    if (searchDropdown) searchDropdown.hidden = false;
    if (searchInput) { searchInput.focus(); }
    runSearch(searchInput ? searchInput.value : '');
  }
  function closeSearch() {
    if (searchDropdown) searchDropdown.hidden = true;
    runSearch('');
  }

  function runSearch(kw) {
    kw = (kw || '').trim();
    var res = { voucher: [], subject: [], ledger: [] };
    if (!kw) { renderSearch(''); return; }
    var k = kw.toLowerCase();

    // 科目匹配口径（全站统一）：编码、名称命中，或「其上级命中」——
    // 等效全路径名匹配（子科目全名含父级名），搜「银行存款」能带出「青岛银行」等下级。
    // 科目 / 账簿 / 凭证明细三处共用下面这套映射。
    // 说明：这是确定性的「字符串包含匹配 + 父级连带」，不是模糊搜索——无相似度/评分/正则，
    // 父链上溯有层数上限（防数据异常成环），同一关键词必得同一结果。
    var subjAll = S.subjects();
    var subjByCode = {};
    subjAll.forEach(function (s) { subjByCode[String(s.code)] = 1; });
    var subjHit = {};
    subjAll.forEach(function (s) {
      if (String(s.code).indexOf(k) >= 0 || String(s.name || '').toLowerCase().indexOf(k) >= 0) subjHit[String(s.code)] = 1;
    });
    // 是否存在「命中的上级科目」（沿真前缀父链上溯）
    var hitWithAncestor = function (code) {
      var c = String(code || ''), g = 0;
      while (c && g++ < 40) {
        var p = '';
        for (var L = c.length - 1; L > 0; L--) { if (subjByCode[c.slice(0, L)]) { p = c.slice(0, L); break; } }
        if (!p) return false;
        if (subjHit[p]) return true;
        c = p;
      }
      return false;
    };
    var subjMatch = function (code) {
      var c = String(code || '');
      return !!subjHit[c] || hitWithAncestor(c);
    };

    // 凭证：摘要 / 科目编码或名称 / 字号(word-no) / 金额
    var numKw = parseFloat(kw);
    S.state.vouchers.forEach(function (v) {
      var hit = false, amt = 0;
      if ((v.word + '-' + v.no).toLowerCase().indexOf(k) >= 0) hit = true;
      v.entries.forEach(function (e) {
        var s = S.subject(e.code);
        if ((e.summary || '').toLowerCase().indexOf(k) >= 0) hit = true;
        if (e.code.indexOf(k) >= 0) hit = true;
        if (s && s.name.toLowerCase().indexOf(k) >= 0) hit = true;
        // 上级科目名命中同样算命中（搜「银行存款」能带出挂在「青岛银行」等子科目下的凭证）
        if (!hit && subjMatch(e.code)) hit = true;
        if (!isNaN(numKw) && (Math.abs(e.dr - numKw) < 0.005 || Math.abs(e.cr - numKw) < 0.005)) { hit = true; amt = e.dr || e.cr; }
      });
      if (hit) res.voucher.push({ id: v.id, date: v.date, no: v.word + '-' + v.no, summary: v.summary || (v.entries[0] && v.entries[0].summary) || '', amount: amt });
    });
    res.voucher.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (res.voucher.length > 20) res.voucher = res.voucher.slice(0, 20);

    // 科目 / 账簿：复用上面统一构建的 subjMatch（编码/名称/上级命中）
    subjAll.forEach(function (s) {
      if (!subjMatch(s.code)) return;
      res.subject.push({ code: s.code, name: s.name, cls: CLS_NAME[s.cls] || s.cls });
    });

    // 账簿（同一匹配口径）
    subjAll.forEach(function (s) {
      if (!subjMatch(s.code)) return;
      res.ledger.push({ code: s.code, name: s.name });
    });
    if (res.ledger.length > 8) res.ledger = res.ledger.slice(0, 8);

    renderSearch(kw, res);
  }
  // 全局搜索里的科目名统一显示「一级-二级-末级」全路径名（与录凭证/科目下拉同口径），
  // 避免搜到「陈小龙」这类末级科目时看不出挂在哪个科目下。
  function subjFullName(s) {
    var fn = globalThis.subjectFullName;
    return fn ? fn(s.code, s.name) : (s.name || '');
  }
  function renderSearch(kw, res) {
    if (!searchResult) return;
    if (!kw) { searchResult.innerHTML = '<div class="search-empty">输入金额 / 科目 / 摘要 / 凭证字号进行搜索</div>'; if (searchDropdown) searchDropdown.hidden = true; return; }
    res = res || { voucher: [], subject: [], ledger: [] };
    if (!res.voucher.length && !res.subject.length && !res.ledger.length) {
      searchResult.innerHTML = '<div class="search-empty">未找到与「' + esc(kw) + '」相关的结果</div>';
      if (searchDropdown) { placeSearchDropdown(); searchDropdown.hidden = false; }
      return;
    }
    var html = '';
    if (res.voucher.length) {
      html += '<div class="search-group-title">凭证</div>';
      res.voucher.forEach(function (v) {
        html += '<div class="search-item" data-go="voucher" data-id="' + v.id + '">' +
          '<div class="si-main"><span class="si-title">' + v.no + ' ' + v.summary + '</span>' +
          (v.amount ? '<span class="si-amt">' + money(v.amount) + '</span>' : '') + '</div>' +
          '<div class="si-sub">' + v.date + (v.amount ? ' · 含金额 ' + money(v.amount) : '') + '</div></div>';
      });
    }
    if (res.subject.length) {
      html += '<div class="search-group-title">科目</div>';
      res.subject.forEach(function (s) {
        html += '<div class="search-item" data-go="subject" data-code="' + s.code + '">' +
          '<div class="si-main"><span class="si-title">' + s.code + ' ' + subjFullName(s) + '</span></div>' +
          '<div class="si-sub">' + s.cls + '</div></div>';
      });
    }
    if (res.ledger.length) {
      html += '<div class="search-group-title">账簿</div>';
      res.ledger.forEach(function (s) {
        html += '<div class="search-item" data-go="ledger" data-code="' + s.code + '">' +
          '<div class="si-main"><span class="si-title">' + s.code + ' ' + subjFullName(s) + '</span></div>' +
          '<div class="si-sub">科目余额表 / 总账 / 明细账</div></div>';
      });
    }
    searchResult.innerHTML = html;
    if (searchDropdown) { placeSearchDropdown(); searchDropdown.hidden = false; }
  }
  // 跳转到查凭证并定位某张凭证
  function locateVoucherInQuery(id) {
    closeSearch();
    goPage('voucher-query');
    var v = S.getVoucher(id);
    // 查凭证页的期间是 qPeriodStart / qPeriodEnd 一对（kis-period-range 组件的隐藏输入），
    // 旧的单一 qPeriod 元素已移除，改用 qPeriodStart/qPeriodEnd 一对隐藏输入（直接取 $('qPeriod') 会对 null 抛 TypeError）。
    var qS = $('qPeriodStart'), qE = $('qPeriodEnd');
    var month = v ? U.monthOf(v.date) : '';
    if (qS && month) qS.value = month;
    if (qE && month) qE.value = month;
    // 刷新查凭证列表：renderQuery 是 Voucher.js 模块私有函数，不可直接调用；
    // 经全局桥 __renderQuery（refreshQuery）读取刚设好的期间输入后渲染，天然含当前科目筛选。
    if (globalThis.__renderQuery) globalThis.__renderQuery();
    setTimeout(function () {
      var row = document.querySelector('#qBody tr[data-vid="' + id + '"]');
      if (row) { row.classList.add('row-hl'); row.scrollIntoView({ block: 'center' }); }
    }, 60);
  }
  // 跳转到账簿并高亮科目行
  function gotoLedgerWithCode(code) {
    closeSearch();
    goPage('trial-balance');
    window.__hlCode = code;
    setTimeout(applySearchHighlight, 80);
  }
  function applySearchHighlight() {
    var code = window.__hlCode; if (!code) return;
    var page = document.querySelector('.page.active'); if (!page) return;
    var rows = page.querySelectorAll('tbody tr');
    var target = null;
    rows.forEach(function (tr) {
      var first = tr.querySelector('td');
      if (first && first.textContent.trim() === code) { target = tr; }
    });
    if (target) { target.classList.add('row-hl'); target.scrollIntoView({ block: 'center' }); }
    window.__hlCode = null;
  }

  // 搜索事件绑定：🔍在搜索框内最右，点击聚焦输入框并搜索
  if (searchToggle) searchToggle.addEventListener('click', function (e) {
    e.stopPropagation();
    openSearch();
  });
  if (searchInput) {
    searchInput.addEventListener('input', function () { runSearch(this.value); });
    searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') runSearch(this.value); if (e.key === 'Escape') closeSearch(); });
  }

  // 结果点击：委托到 searchDropdown（不再用已删除的 searchPop）
  if (searchDropdown) {
    searchDropdown.addEventListener('click', function (e) {
      e.stopPropagation();
      var it = e.target.closest('.search-item');
      if (!it) return;
      var go = it.getAttribute('data-go');
      if (go === 'voucher') locateVoucherInQuery(it.getAttribute('data-id'));
      else if (go === 'subject') { closeSearch(); goPage('subject'); showToast('已定位科目 ' + it.getAttribute('data-code')); }
      else if (go === 'ledger') gotoLedgerWithCode(it.getAttribute('data-code'));
    });
  }
  // 点击外部关闭搜索下拉（但不关闭搜索栏本身，只关结果列表）
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#topSearch')) { if (searchDropdown) searchDropdown.hidden = true; }
  });
  // 窗口尺寸变化时重算下拉位置
  window.addEventListener('resize', function () {
    if (searchDropdown && !searchDropdown.hidden) placeSearchDropdown();
  });

  // 高危操作密码设置（openOpSet）已随基础功能页迁入 js/pages/settings/Tools.js；
  // 屏保功能（openLockSet / startSaver 等）已整体移除（2026-08-14）；
  // 首页科目滚动绑定已迁入 js/pages/home/Home.js。

  // force=true 时无论是否已激活都重渲染整页；默认 false 时若目标页已是 active 页
  // 则只同步导航高亮与标签栏、跳过重渲染——避免切回已打开标签时重复取数+重算、
  // 并保留用户当前滚动位置（多标签行为：已开的标签切回不重算）。
  function goPage(page, force) {
    if (typeof force !== 'boolean') force = false;
    // 先记录目标页「进入前」是否已激活，用于「切回已打开标签不重渲染」优化。
    // 注意：必须在 remove active 之前判断，否则 remove 后再 add 会使 active 恒为真、永远跳过重渲染。
    var _tgt = document.getElementById('page-' + page);
    var wasActive = !!(_tgt && _tgt.classList.contains('active'));
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    // 凭证录入：直接进入编辑表单（绕过入口中间页）
    if (page === 'voucher-edit') { showVoucherEdit(); page = 'voucher'; }
    // 切到凭证页时恢复入口视图（仅当走入口页时）
    else if (page === 'voucher') { showVoucherEdit(); }
    // 加载已有凭证后切换：仅激活页面，不重置表单
    else if (page === 'voucher-noedit') { $('vEditView').style.display = ''; page = 'voucher'; }
    // 数据与安全已并入系统设置页（含历史 book-manage 时代），旧 hash/标签兜底映射到合并页
    else if (page === 'book-manage' || page === 'backup-restore') { page = 'system-settings'; }
    // 导入账套：触发文件选择，不切换页面
    else if (page === 'import-ais') { goPage('system-settings'); return; }
    /* 折旧独立分页：旧宿主键（asset-depr）→ 折旧凭证；旧子页键即新页键，保持直达 */
    var _assetDeprPageAlias = {
      'asset-depr': 'asset-depr-voucher',
      'asset-depr-voucher': 'asset-depr-voucher', 'asset-depr-sum': 'asset-depr-sum',
      'asset-depr-detail': 'asset-depr-detail', 'asset-change-log': 'asset-change-log'
    };
    if (_assetDeprPageAlias[page]) page = _assetDeprPageAlias[page];
    // 资产类别：收敛为固定资产卡片工具条弹窗，旧直达落到卡片页
    else if (page === 'asset-category') { page = 'asset-card'; }
    // 工资收敛：部门职员 / 凭证模板 / 新手导航 已并入工资表页（弹窗），旧直达落工资表
    else if (page === 'department-staff' || page === 'salary-tpl' || page === 'salary-guide') { page = 'salary'; }
    /* 结账：settle-close 映射到已有 page-settle */
    if (page === 'settle-close') page = 'settle';
    var sec = document.getElementById('page-' + page);
    if (sec) sec.classList.add('active');
    // 已激活页且非强制刷新：跳过重渲染，仅做高亮/标签栏同步与搜索高亮
    var alreadyActive = wasActive && !force;
    // 报表/凭证子页面
    if (page === 'original') { if (globalThis.__renderOriginal) globalThis.__renderOriginal(); }
    else if (page === 'expense-detail') { if (globalThis.__renderExpenseDetail) globalThis.__renderExpenseDetail(); }

    // 同步导航 active 状态（nav-group-title / nav-pop-item / home-trigger）
    document.querySelectorAll('.nav-group-title, .nav-pop-item, .home-trigger').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-page') === page);
    });
    // 子页面激活时，也高亮其所属分组标题
    document.querySelectorAll('.nav-group').forEach(function (g) {
      var title = g.querySelector('.nav-group-title');
      var hasActiveChild = g.querySelector('.nav-pop-item.active');
      if (title) title.classList.toggle('active', !!hasActiveChild);
    });
    // 顶部期间同步
    var tp = $('topPeriodText');
    if (tp) tp.textContent = formatPeriod(currentPeriod());
    // 渲染对应页（已激活且非强制刷新则跳过重渲染，保留滚动位置、避免重复取数）
    var refreshers = PAGE_REFRESHERS;
    if (!alreadyActive && refreshers[page]) refreshers[page]();
    // 更新标签页栏（多标签页模式）
    updateTabBar(page);
    // 跳转后收起所有分组浮层（单例浮层一并隐藏，避免残留）
    hideNavPopover();
  }

  // 表头吸顶已由方案 C（纯结构：操作栏为滚动区的静态兄弟、表头 sticky top:0）彻底解决，
  // 任意栏高 / 重建 thead 均自动贴合，不再需要 JS 测量与 --actions-h 变量。

  // 页面显示名称（用于标签页）
  var PAGE_NAMES = {
    'home': '首页',
    'voucher': '录凭证', 'voucher-query': '查凭证', 'voucher-sum': '凭证汇总表',
    'general-ledger': '总账', 'detail-ledger': '明细账', 'multi-ledger': '多栏账',
    'trial-balance': '科目余额表', 'report-balance': '资产负债表', 'report-profit': '利润表',
    'report-cashflow': '标准现金流量表', 'report-tax': '主要应交税金明细表',
    'asset-card': '固定资产卡片',
    'asset-depr-voucher': '折旧凭证', 'asset-depr-sum': '折旧汇总表',
    'asset-depr-detail': '折旧明细表', 'asset-change-log': '资产变动记录',
    'cashflow-init': '现金流量初始余额', 'cashflow-project': '科目现金流量项目',
    'backup-restore': '数据与安全', 'system-settings': '系统设置', 'operation-logs': '操作日志',
    'salary-statistics': '工资统计',
    'salary': '工资', 'settle': '结账', 'subject': '科目', 'opening': '期初余额',
    'param': '账套参数',
    /* 凭证/报表补充子页 */
    'original': '原始凭证',
    'expense-detail': '费用明细表',
    /* 结账（独立页面） */
    'settle-close':'期末处理'
  };
  // 已打开的业务页签列表（首页由顶部 house 图标按钮承担，不占用标签栏位）
  var openTabs = [];
  function updateTabBar(page) {
    var bar = $('tabBar');
    if (!bar) return;
    var prevScroll = bar.scrollLeft; // 清空前记录，重渲染后恢复滚动位置（避免跳回最左）
    bar.innerHTML = '';
    // 首页 / 未知页：不把首页加入标签列表（已有 house 按钮），但保留并渲染已打开的其他业务标签
    if (!PAGE_NAMES[page] || page === 'home') {
      renderOpenTabs('', prevScroll);
      return;
    }
    // 当前页不在列表则追加
    var exists = openTabs.some(function (t) { return t.page === page; });
    if (!exists) openTabs.push({ page: page, name: PAGE_NAMES[page] });
    renderOpenTabs(page, prevScroll);
  }

  // 渲染已打开的业务页签（home 时 activePage 传 ''，使无标签高亮）
  // prevScroll：updateTabBar 在清空前记录的滚动位置，切换已有标签时恢复；
  // 激活的是最后一个标签（新打开/切到最后一个/关闭后）→ 滚到最右让新标签必见。
  function renderOpenTabs(activePage, prevScroll) {
    var bar = $('tabBar');
    if (!bar) return;
    var lastPage = openTabs.length > 0 ? openTabs[openTabs.length - 1].page : '';
    openTabs.forEach(function (t) {
      var tab = document.createElement('div');
      tab.className = 'tab-item' + (t.page === activePage ? ' active' : '');
      tab.setAttribute('data-page', t.page);
      tab.innerHTML = '<span>' + t.name + '</span>';
      tab.innerHTML += '<span class="tab-close" data-close="' + t.page + '">×</span>';
      bar.appendChild(tab);
    });
    // 激活的是最后一个标签（新打开/切到最后一个/关闭后）→ 滚到最右让新标签必见；
    // 否则恢复原滚动位置（滚动条隐藏，靠这里维持标签不跳变）
    if (activePage && activePage === lastPage) {
      bar.scrollLeft = bar.scrollWidth;
    } else {
      bar.scrollLeft = prevScroll;
    }
  }

  /* ============================================================
   * 记账凭证（凭证-记账凭证）
   * 录入/汇总/查询三页逻辑已整体迁移至 js/pages/voucher/Voucher.js（ESM 模块），
   * 经 PAGE_REFRESHERS 字典（renderVia('Voucher'/'Sum'/'Query')）调用；
   * 编辑入口 showVoucherEdit/loadVoucherToEdit 委托到 globalThis.__VOUCHER__。
   * 金额位格纯函数 amtInnerHtml/isRed/amtCellHtml/clearAmtCells/trOf 等仍保留
   * 在下方（被其他模块以全局方式复用，未迁移）。
   * ============================================================ */

  // 金额位格 —— 严格 Pd 组件
  //
  // 源码（main.cf2e18af.chunk.js 的 Pd 函数，逐行对应）：
  // var t = value ? value.toString() : "";
  // t && parseFloat(t) && (t = parseFloat(t).toFixed(2));
  // t = t.replace("-", "");
  // if (t.length > 12) return 万亿模式文本;
  // var n = (Array(12).join("_") + t.replace(".","")).slice(-11)
  // .split("").map(e => e.replace("_",""));
  // DOM:
  // isNumber && <p class="amountValueWrapper"><span>去小数点纯数字</span></p>
  // n.map((t,n) => <div class="amountLine amountLineActive?(activeIndex===n)">
  // isNumber ? " " : t
  // </div>)
  // 负值：容器加 red 类（红字）。
  //
  // 注意：表头的「亿千百十万千百十元角分」单位行，
  // 也是同一个 Pd 组件渲染 value="亿千百十万千百十元角分"（isNumber=false），
  // 因此单位与数字位格天生对齐——本项目表头同样复用本函数。

  // Pd 组件 DOM（严格对应源码）：
  // value:   金额数值（数字/字符串），或单位串"亿千百十万千百十元角分"
  // isNumber:true  → 数字模式，数字层显示去点纯数字，位格放空格
  // isNumber:false → 单位/文本模式，11 个位格直接放字符（用于对账单位行、合计）
  // activeIndex:   当前高亮位（蓝底白字）
  // red:           负值红字
  function amtInnerHtml(value, isNumber, activeIndex, red, hideValueLayer, force2) {
    var raw = (value === '' || value == null || value === 0) ? '' : value.toString();
    var t = raw;
    // 仅当 force2 时强制两位小数（合计行/借贷平衡检查用）；普通位格保持用户输入原样
    if (force2 && t && parseFloat(t)) t = parseFloat(t).toFixed(2);
    t = t.replace('-', '');
    // 万亿模式：超过 12 位直接纯文本显示
    if (t.length > 12) {
      return '<div class="amt-bg amt-trillion' + (red ? ' amt-red' : '') + '">' +
        (parseFloat(t) ? parseFloat(t).toFixed(2) : t) + '</div>';
    }
    var chars = (Array(12).join('_') + t.replace('.', '')).slice(-11).split('').map(function (e) { return e.replace('_', ''); });
    var cells = '';
    for (var k = 0; k < 11; k++) {
      var active = (activeIndex === k) ? ' amt-cell-active' : '';
      // 数字直接落进各自位格（flex 居中），不依赖 letter-spacing，换字体也不错位
      cells += '<div class="amt-cell' + active + '">' + chars[k] + '</div>';
    }
    return '<div class="amt-bg' + (red ? ' amt-red' : '') + '">' + cells + '</div>';
  }

  // 表头金额单位行（复用 Pd 组件渲染"亿千百十万千百十元角分"，非数字模式）
  function amtHeaderHtml(title) {
    return '<div class="amt-header">' +
      '<div class="amt-title">' + title + '</div>' +
      '<div class="amt-units-wrap">' + amtInnerHtml('亿千百十万千百十元角分', false, -1, false) + '</div>' +
      '</div>';
  }

  // 凭证编辑入口（委托到 Voucher.js 挂载的全局 __VOUCHER__）
  function showVoucherEdit() { if (globalThis.__VOUCHER__ && globalThis.__VOUCHER__.showVoucherEdit) globalThis.__VOUCHER__.showVoucherEdit(); }
  function loadVoucherToEdit(id) { if (globalThis.__VOUCHER__ && globalThis.__VOUCHER__.loadVoucherToEdit) globalThis.__VOUCHER__.loadVoucherToEdit(id); }

  // 注：原「.link-audit 单张审核/反审核」通道已移除——全库无任何 UI 渲染该元素（审核走查凭证工具栏批量按钮），
  // 属不可达死通道，委托与样式一并清理，避免误以为还有单张审核入口。
  document.addEventListener('click', function (e) {
    // 查凭证：点击凭证字号链接 → 打开编辑
    var lv = e.target.closest && e.target.closest('.link-voucher');
    if (lv) { e.preventDefault(); loadVoucherToEdit(lv.getAttribute('data-id')); return; }
    // 查凭证：点击编辑图标 → 打开编辑（仅在查凭证表体内生效，避免误捕获其他页 data-edit）
    var ed = e.target.closest && e.target.closest('[data-edit]');
    if (ed && ed.closest('#qBody')) { loadVoucherToEdit(ed.getAttribute('data-edit')); return; }
  });

  /* ============================================================
   * ESM 渲染器统一桥接（架构合并：不再为每页写委托桩）
   * 已迁移页面均由 main.js 挂载到 globalThis.__renderXxx；
   * 此处仅保留一个工厂 renderVia(name) 生成转发，供按钮事件与
   * PAGE_REFRESHERS 字典共用。链路：goPage → renderVia(name) → __renderXxx。
   * ============================================================ */
  function renderVia(name) {
    return function () { var fn = globalThis['__render' + name]; if (fn) fn(); };
  }

  // 账簿域：按钮/下拉刷新
  // 科目余额表：查询按钮
  // 报表域：按钮刷新
  // 报表域：导出（四大标准报表）
  var btnBsExport = $('btnBsExport'); if (btnBsExport) btnBsExport.addEventListener('click', function () { if (globalThis.__exportBs) globalThis.__exportBs(); });
  var btnPlExport = $('btnPlExport'); if (btnPlExport) btnPlExport.addEventListener('click', function () { if (globalThis.__exportPl) globalThis.__exportPl(); });
  var btnCfExport = $('btnCfExport'); if (btnCfExport) btnCfExport.addEventListener('click', function () { if (globalThis.__exportCf) globalThis.__exportCf(); });
  var btnTxExport = $('btnTxExport'); if (btnTxExport) btnTxExport.addEventListener('click', function () { if (globalThis.__exportTx) globalThis.__exportTx(); });
  // 科目余额表导出
  var btnTbExport = $('btnTbExport'); if (btnTbExport) btnTbExport.addEventListener('click', function () { if (globalThis.__exportTb) globalThis.__exportTb(); });


  /* —— 对象式挂载的专用桩（非 __renderXxx 命名，仅此三类保留） —— */
  // 期末结账（Settle.js 挂载 __SETTLE__）
  function refreshSettle() { if (globalThis.__SETTLE__) globalThis.__SETTLE__.refreshSettle(); }
  // 期初余额（Opening.js 挂载 __OPENING__，需先 setup 再 refresh）
  function refreshOpening() {
    if (globalThis.__OPENING__) {
      globalThis.__OPENING__.setupOpening();
      globalThis.__OPENING__.refreshOpening();
    }
  }
  /* ============================================================
   * 设置：系统参数（系统参数页分区）
   * ============================================================ */


  /* ============================================================
   * 同步所有含期间下拉的查询页
   * ============================================================ */
  function syncAll() {
    var tpEl = $('topPeriodText');
    if (tpEl) tpEl.textContent = formatPeriod(currentPeriod());
    var DEFAULT_COMPANY_NAME = '演示账套';
    var fallbackName = '';
    try {
      var meta = (S.state && S.state.meta) || {};
      fallbackName = meta.source || meta.importedFrom || '';
      if (fallbackName) fallbackName = fallbackName.replace(/\.(ais|json)$/i, '');
    } catch (e) {}
    var tcEl = $('topCompany');
    if (tcEl) {
      var name = ((S.state && S.state.company && S.state.company.name) || fallbackName || '').trim();
      tcEl.textContent = name || DEFAULT_COMPANY_NAME;
    }
    updateTopOperator();
  }

  // 统一刷新入口：优先全量刷新（__refreshAll），未定义时降级为顶部期间同步（syncAll）
  function refreshAll() {
    if (window.__refreshAll) window.__refreshAll();
    else syncAll();
  }

  // 账套损坏提示钩子：由 store.js 在从磁盘加载账本失败（文件损坏 / 解析失败）时调用。
  // 不做任何自动切换或导入，仅明确告知用户当前账套磁盘读取失败，由用户自行决定
  // 用「数据恢复」或重新导入账套。
  window.__showBookBroken = function (id) {
    var msg = '当前账套「' + (id || '') + '」服务端读取失败，账套文件可能已损坏。\n\n'
      + '页面已停留在本地缓存数据（可能不完整）。请勿在此账套上继续录入重要凭证。\n\n'
      + '建议：到「设置 - 数据恢复」用备份恢复，或重新导入金蝶账套。';
    showToast('账套读取失败：' + (id || '') + ' 可能已损坏', 'error');
    // Tauri 下 window.confirm 非阻塞/被改写，统一走桥接（原生 confirm / 浏览器降级）
    try { (window.__dialogBridge ? window.__dialogBridge.confirmAsync(msg) : Promise.resolve(window.confirm(msg))).catch(function(){}); } catch (e) {}
  };

  // 账本 schemaVersion 冲突处理钩子：由 store.js 在版本不一致时调用
  // 本软件为纯本地单机版，差异发生在「本地账套文件」与「浏览器本地缓存」之间。
  // serverVer / localVer 为版本号；applyServer 是执行"用账套文件覆盖缓存"的回调。
  window.__onSchemaMismatch = function (serverVer, localVer, applyServer) {
    var msg = '检测到本地账套文件版本（v' + serverVer + '）与浏览器缓存（v' + localVer + '）不一致。\n\n'
      + '· 用账套文件：将以文件数据覆盖当前缓存（可能丢失缓存中较新的改动）。\n'
      + '· 取消：保留浏览器缓存账本，本次不采用账套文件版本。\n\n是否用账套文件覆盖缓存？';
    // Tauri 下 window.confirm 非阻塞/被改写，统一走桥接并 await 结果
    var cf = (window.__dialogBridge ? window.__dialogBridge.confirmAsync(msg) : Promise.resolve(window.confirm(msg)));
    Promise.resolve(cf).then(function (ok) {
      if (ok) {
        applyServer();
        showToast('已用账套文件覆盖缓存', 'info');
      } else {
        showToast('已保留缓存账本（版本不一致）', 'warn');
      }
    });
  };

  // 系统设置（数据与安全已并入）：参数区 __renderSystemSettings + 数据/账套区 __renderBackup
  function refreshSettingsAll() {
    /* 渲染失败必须留痕：静默 catch 会让「设置页空白」变成无从排查的问题（用户只看到空白）。
       这里保留 console.warn 只在**出错路径**触发，不影响正常时的控制台噪音。 */
    if (globalThis.__renderSystemSettings) { try { globalThis.__renderSystemSettings(); } catch (e) { console.warn('[设置页刷新]', e); } }
    if (globalThis.__renderBackup) { try { globalThis.__renderBackup(); } catch (e) { console.warn('[数据区刷新]', e); } }
  }

  // 独立「操作日志」页：当前账套日志（含审计明细）+ 跨账套操作日志
  function refreshOperationLogsPage() {
    if (globalThis.__renderLogs) { try { globalThis.__renderLogs(); } catch (e) { console.warn('[日志页刷新]', e); } }
    if (globalThis.__renderSysEvents) { try { globalThis.__renderSysEvents(); } catch (e) { console.warn('[日志页刷新]', e); } }
  }

  // 页面 -> 刷新函数映射（goPage 与 __refreshAll 共用，避免两处分叉）
  // 全部经 renderVia(name) 转发到 main.js 挂载的 globalThis.__renderXxx
  var PAGE_REFRESHERS = {
    'home': renderVia('Home'),
    'voucher': renderVia('Voucher'), 'voucher-sum': renderVia('Sum'), 'voucher-query': renderVia('Query'),
    'general-ledger': renderVia('Gl'), 'detail-ledger': renderVia('Dl'), 'multi-ledger': renderVia('Ml'),
    'trial-balance': renderVia('TrialBalance'), 'report-balance': renderVia('Bs'), 'report-profit': renderVia('Pl'),
    'report-cashflow': renderVia('Cf'), 'report-tax': renderVia('Tx'),     'asset-card': renderVia('Assets'),
    /* 折旧独立分页：折旧凭证 / 折旧汇总表 / 折旧明细表 / 资产变动记录（原 asset-depr 宿主页内 Tab 拆出）；旧宿主键 asset-depr 兼容映射到折旧凭证 */
    'asset-depr': renderVia('AssetDeprVoucher'),
    'asset-depr-voucher': renderVia('AssetDeprVoucher'), 'asset-depr-sum': renderVia('Das'),
    'asset-depr-detail': renderVia('Dad'), 'asset-change-log': renderVia('AssetChangeLog'),
    'salary': renderVia('Salary'), 'settle': refreshSettle, 'subject': renderVia('Subjects'),
    'opening': refreshOpening, 'param': renderVia('SystemSettings'),
    'salary-statistics': renderVia('SalaryStats'),
    /* 工资收敛：部门职员/凭证模板已并回工资页弹窗，旧键保持可用（渲染到弹窗内表体） */
    'department-staff': renderVia('DeptStaff'), 'salary-tpl': renderVia('SalaryTpl'), 'salary-guide': renderVia('Salary'),
    'cashflow-init': renderVia('CashflowInit'), 'cashflow-project': renderVia('CashflowProject'),
    // 报表扩展页：费用明细表 / 报表中心 / 原始凭证
    'report-expense-detail': renderVia('ExpenseDetail'),
    'original': renderVia('Original'),
    // 系统设置 = 原系统设置 + 并入的数据与安全；旧 backup-restore 键保留并复用同一刷新（旧标签/直达兼容）
    'backup-restore': refreshSettingsAll, 'system-settings': refreshSettingsAll,
    // 操作日志独立页：当前账套日志 + 跨账套操作日志
    'operation-logs': refreshOperationLogsPage
  };

  // 暴露页面刷新字典给 ESM 模块（main.js 兜底 hash 直达时遍历使用）
  globalThis.__PAGE_REFRESHERS__ = PAGE_REFRESHERS;

  // 服务端账本加载完成后统一刷新当前界面
  window.__refreshAll = function () {
    var tp = $('topPeriodText'); if (tp) tp.textContent = formatPeriod(currentPeriod());
    var DEFAULT_COMPANY_NAME = '演示账套';
    var fallbackName = '';
    try {
      var meta = (S.state && S.state.meta) || {};
      fallbackName = meta.source || meta.importedFrom || '';
      if (fallbackName) fallbackName = fallbackName.replace(/\.(ais|json)$/i, '');
    } catch (e) {}
    var tc = $('topCompany');
    if (tc) {
      var name = ((S.state && S.state.company && S.state.company.name) || fallbackName || '').trim();
      tc.textContent = name || DEFAULT_COMPANY_NAME;
    }
    updateTopOperator();
    var active = document.querySelector('.page.active');
    var page = active ? active.id.replace('page-', '') : 'home';
    if (PAGE_REFRESHERS[page]) PAGE_REFRESHERS[page]();
    if (window.__hlCode) applySearchHighlight();
    // 运行期自检：账套加载/刷新后自动核对（期初/凭证/报表恒等式），异常顶部红字
    if (window.__runSelfTestBanner) window.__runSelfTestBanner();
  }

  /* ---------- 初始化：默认进入首页工作台 ---------- */
  try {
    document.body.setAttribute('data-hash', location.hash);
    if (location.hash.indexOf('settle-close') >= 0) {
      goPage('settle');
      document.querySelectorAll('#settleTabs .settle-tab').forEach(function (t) { t.classList.remove('active'); });
      var closeTab = document.querySelector('#settleTabs .settle-tab[data-tab="close"]');
      if (closeTab) closeTab.classList.add('active');
      if ($('settlePaneProcess')) $('settlePaneProcess').style.display = 'none';
      if ($('settlePaneClose')) $('settlePaneClose').style.display = '';
      if ($('settlePaneReopen')) $('settlePaneReopen').style.display = 'none';
    } else {
      // 通用 hash 直达：命中已接入页面（PAGE_REFRESHERS / 报表四页）则直达，否则首页。
      // 此前只认 settle/opening/subject/tools 四 hash，设置子菜单页刷新直达会落到首页、内容"丢失"；现命中已接入页面（PAGE_REFRESHERS/报表四页）则直达，否则首页。
      var _h = (location.hash || '').replace(/^#/, '');
      var _direct = PAGE_REFRESHERS[_h] ||
        _h === 'original' || _h === 'expense-detail';
      goPage(_direct ? _h : 'home');
    }
    syncAll();
  } catch (e) {
    console.error('[初始化失败]', e);
  }
  // 暴露路由中枢给 ESM 模块（main.js 兜底 hash 直达已迁移页时使用）
  globalThis.goPage = goPage;
  globalThis.gotoLedgerWithCode = gotoLedgerWithCode;
  globalThis.locateVoucherInQuery = locateVoucherInQuery;
})();
