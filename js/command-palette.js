/* command-palette.js —— 全局命令面板（Ctrl/Cmd + K 快速跳转）
 * 复用 app.js 暴露的 globalThis.QUICK_MENU_ITEMS 作为唯一导航数据源（与首页常用功能同源，
 * 左侧导航已整体移除）；选中后调用 globalThis.goPage(page) 跳转。
 * 纯前端、零逻辑风险：不碰账套数据，只做"导航"。
 *
 * 【2026-10-31 加强】侧栏撤掉之后，只要不在首页，页面之间就只剩这一个入口
 * （常用功能格子只存在于首页），因此把它从"能搜到全部模块"升级成"能当作导航用"：
 *   ① 最近访问置顶（最多 6 条，localStorage 键 cmd_recent_pages，只存页面名，不碰账套数据）
 *   ② 常用功能置顶（读 globalThis.getQuickMenuKeys()，与首页快捷区同一份配置，含默认集与老账套升级）
 *   ③ 全部模块按分组完整列出（不去重 —— 用户是按分组找的，去重会让分组看起来缺项）
 *   ④ 图标改用与首页同一套 iconcool 字形（TY_MENU_ICON_PATHS），缺字形回退「名称首字」
 *   ⑤ 搜索支持空格分词（多关键词 AND），匹配 名称 / 分组 / 页面名 / key
 *   ⑥ 键盘补 Home / End（跳到首条 / 末条），底部显示结果数
 */
(function () {
  'use strict';

  var RECENT_KEY = 'cmd_recent_pages';
  var RECENT_MAX = 6;

  function getItems() {
    var src = globalThis.QUICK_MENU_ITEMS;
    if (!src || !src.length) return [];
    var flat = [];
    src.forEach(function (g) {
      (g.items || []).forEach(function (it) {
        flat.push({ group: g.group, name: it.name, page: it.page, key: it.key, icon: it.icon });
      });
    });
    return flat;
  }

  var ITEMS = null;
  var BY_KEY = {}, BY_PAGE = {};
  var overlay, input, list, footCount;
  var active = -1;
  var filtered = [];

  /* 懒初始化：本文件可能在 app.js 之前解析完，构造时就取 ITEMS 会拿到空表（历史隐患）。 */
  function ensureItems() {
    if (ITEMS) return ITEMS;
    ITEMS = getItems();
    ITEMS.forEach(function (it) { BY_KEY[it.key] = it; BY_PAGE[it.page] = it; });
    return ITEMS;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 最近访问 ---------- */
  function readRecent() {
    try {
      var a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(a) ? a.filter(function (p) { return typeof p === 'string'; }).slice(0, RECENT_MAX) : [];
    } catch (e) { return []; }
  }
  function pushRecent(page) {
    if (!page) return;
    var a = readRecent().filter(function (p) { return p !== page; });
    a.unshift(page);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, RECENT_MAX))); } catch (e) { }
  }
  function recentItems() {
    var out = [];
    readRecent().forEach(function (p) { if (BY_PAGE[p]) out.push(BY_PAGE[p]); });
    return out;
  }
  /* 常用功能：与首页快捷区同源。取不到（老包 / 未加载）时返回空数组，面板退化为「最近 + 全部」。 */
  function quickItems() {
    var keys = (typeof globalThis.getQuickMenuKeys === 'function') ? globalThis.getQuickMenuKeys() : [];
    var out = [];
    (keys || []).forEach(function (k) { if (BY_KEY[k]) out.push(BY_KEY[k]); });
    return out;
  }

  /* ---------- 搜索 ---------- */
  /* 空格分词、逐词 AND；每个词只要命中 名称/分组/页面名/key 任一即算命中。
     为什么纳入 page 与 key：两者是 ASCII（如 asset-card / voucher-edit），
     习惯英文输入时可直接敲 "asset" 定位，不必切中文。 */
  function matchQ(it, q) {
    if (!q) return true;
    var hay = (it.name + ' ' + it.group + ' ' + it.page + ' ' + it.key).toLowerCase();
    var toks = q.split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      if (toks[i] && hay.indexOf(toks[i]) < 0) return false;
    }
    return true;
  }

  function avatarHtml(it) {
    var paths = globalThis.TY_MENU_ICON_PATHS;
    var d = (paths && it.icon && paths[it.icon]) || '';
    if (d) {
      /* escape-ok: d 来自 ty-menu-icons.js 的硬编码字形表，不含用户输入 */
      return '<span class="cmd-avatar"><svg viewBox="0 0 1000 1000" aria-hidden="true"><path d="' + d + '"/></svg></span>';
    }
    return '<span class="cmd-avatar">' + esc(it.name.charAt(0)) + '</span>';
  }
  function itemHtml(it, idx) {
    return '<div class="cmd-item" data-idx="' + idx + '" data-page="' + esc(it.page) + '">' +
             avatarHtml(it) +
             '<span class="cmd-name">' + esc(it.name) + '</span>' +
             '<span class="cmd-tag">' + esc(it.group) + '</span>' +
           '</div>';
  }

  function emitGroup(title, arr, html) {
    if (!arr.length) return html;
    html += '<div class="cmd-group">' + esc(title) + '</div>';
    arr.forEach(function (it) {
      html += itemHtml(it, filtered.length);
      filtered.push(it);
    });
    return html;
  }

  function render(q) {
    var items = ensureItems();
    var qq = (q || '').trim().toLowerCase();
    filtered = [];
    var html = '';
    var last = null;

    if (!qq) {
      var recent = recentItems();
      html = emitGroup('最近访问', recent, html);
      // 常用里已出现在「最近」的项不再重复列出（最近是时间序，重复会让置顶区显得啰嗦）
      var seen = {};
      recent.forEach(function (it) { seen[it.page] = 1; });
      html = emitGroup('常用功能', quickItems().filter(function (it) { return !seen[it.page]; }), html);
      // 全部模块：按分组完整列出，不去重（用户按分组浏览时应看到该组全部条目）
      items.forEach(function (it) {
        if (it.group !== last) { html += '<div class="cmd-group">' + esc(it.group) + '</div>'; last = it.group; }
        html += itemHtml(it, filtered.length);
        filtered.push(it);
      });
    } else {
      items.filter(function (it) { return matchQ(it, qq); }).forEach(function (it) {
        if (it.group !== last) { html += '<div class="cmd-group">' + esc(it.group) + '</div>'; last = it.group; }
        html += itemHtml(it, filtered.length);
        filtered.push(it);
      });
    }

    if (!filtered.length) {
      list.innerHTML = '<div class="empty-hint empty-hint-sm">无匹配项</div>';
      active = -1;
      updateFoot();
      return;
    }
    list.innerHTML = html;
    setActive(0, true);
    updateFoot();
  }

  function updateFoot() {
    if (footCount) footCount.textContent = '共 ' + filtered.length + ' 项';
  }

  function setActive(i, scroll) {
    active = i;
    var els = list.querySelectorAll('.cmd-item');
    els.forEach(function (el, k) { el.classList.toggle('active', k === i); });
    if (scroll && els[i]) els[i].scrollIntoView({ block: 'nearest' });
  }

  function build() {
    overlay = document.createElement('div');
    // 走全站 .modal 体系：遮罩/居中/焦点移入/Esc/Tab 陷阱/遮罩点击 全部由统一入口提供。
    // .modal-cmd 只调层级（1200，可从任意弹窗跳走）+ 顶部对齐的定位。
    overlay.className = 'modal modal-cmd';
    overlay.id = 'cmdPalette';
    overlay.setAttribute('data-backdrop', 'close');
    overlay.innerHTML =
      '<div class="modal-box cmd-box" role="dialog" aria-label="快速跳转">' +
        '<div class="cmd-input-row">' +
          '<span class="iconcool sousuo icon--cmd"></span>' +
          '<input type="text" class="cmd-input" id="cmdInput" placeholder="跳转到模块、账簿、报表…（可空格分词，如「凭证 录入」）" autocomplete="off">' +
          '<kbd class="cmd-kbd">Esc</kbd>' +
          // 全站弹层统一带 ×（这里没有标题栏，× 落在输入行右端）
          '<button class="modal-x" data-modal-close="1" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="cmd-results" id="cmdResults"></div>' +
        '<div class="cmd-foot"><span id="cmdFootCount">共 0 项</span>' +
          '<span>↑↓ 选择 · ↵ 打开 · Home/End 首尾 · Esc 关闭</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('#cmdInput');
    list = overlay.querySelector('#cmdResults');
    footCount = overlay.querySelector('#cmdFootCount');

    input.addEventListener('input', function () { render(input.value); });
    // 遮罩点击关闭由全局 data-backdrop 委托统一处理
    list.addEventListener('click', function (e) {
      var el = e.target.closest('.cmd-item');
      if (el) select(parseInt(el.dataset.idx, 10));
    });
  }

  function select(i) {
    var it = filtered[i];
    if (!it) return;
    pushRecent(it.page);
    close();
    if (globalThis.goPage) globalThis.goPage(it.page);
  }

  // 打开/关闭统一走 TYModal（记录与还原来源焦点、焦点移入、Esc、Tab 陷阱都在那一处）
  function open() {
    if (!overlay) build();
    input.value = '';
    render('');
    if (globalThis.TYModal) globalThis.TYModal.open(overlay);
    else overlay.classList.add('show');
    setTimeout(function () { if (input) input.focus(); }, 0);
  }
  function close() {
    if (!overlay) return;
    if (globalThis.TYModal) globalThis.TYModal.close(overlay);
    else overlay.classList.remove('show');
  }
  function toggle() {
    if (overlay && overlay.classList.contains('show')) close(); else open();
  }
  // 暴露打开入口：首页「全部功能」等按钮复用该面板（显示全部模块分组、可搜索）
  globalThis.openCommandPalette = open;

  function move(d) {
    if (!filtered.length) return;
    var next = (active + d + filtered.length) % filtered.length;
    setActive(next, true);
  }

  document.addEventListener('keydown', function (e) {
    // Ctrl/Cmd + K 切换面板
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
      return;
    }
    if (!overlay || !overlay.classList.contains('show')) return;
    // Esc / Tab 不在这里处理：已由全局模态体系统一（Esc 关闭、Tab 焦点陷阱）
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home' && filtered.length) { e.preventDefault(); setActive(0, true); }
    else if (e.key === 'End' && filtered.length) { e.preventDefault(); setActive(filtered.length - 1, true); }
    else if (e.key === 'Enter') { e.preventDefault(); select(active); }
  });

  // 顶栏可见入口：提示快捷键，点击亦可打开
  function injectTrigger() {
    var right = document.querySelector('.topbar-right');
    if (!right) return;
    if (document.getElementById('cmdTrigger')) return;
    // 用 div[role=button] 而非 <button>：WebKit(WKWebView/Safari) 对 <button> 直接做 flex 布局有怪癖
    // （子元素被裹成匿名盒，space-between 失效、宽度还会塌缩导致内容被截断）。div 的 flex 布局各端一致可靠。
    var btn = document.createElement('div');
    btn.className = 'cmd-trigger';
    btn.id = 'cmdTrigger';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.title = '快速跳转（Ctrl/Cmd + K）';
    // 内层不再套 wrapper：div 自身直接做 flex 两端分布（放大镜贴左、⌘K 贴右）。
    // 多层 inline-flex + flex:1 在收缩容器里会让 space-between 拿不到余量，故保持扁平结构。
    btn.innerHTML =
        '<span class="iconcool sousuo icon--cmd-trigger"></span>' +
        '<span>快速跳转</span>' +
        '<kbd class="cmd-kbd">⌘K</kbd>';
    btn.addEventListener('click', open);
    // div 不像原生 button 会自动把 Enter/Space 转成 click，需手动补，保持键盘可达性
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    right.insertBefore(btn, right.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTrigger);
  } else {
    injectTrigger();
  }
})();
