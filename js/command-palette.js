/* command-palette.js —— 全局命令面板（Ctrl/Cmd + K 快速跳转）
 * 复用 app.js 暴露的 globalThis.QUICK_MENU_ITEMS 作为唯一导航数据源（与首页常用功能同源，
 * 左侧导航已整体移除）；选中后调用 globalThis.goPage(page) 跳转。
 * 纯前端、零逻辑风险：不碰账套数据，只做"导航"。
 */
(function () {
  'use strict';

  function getItems() {
    var src = globalThis.QUICK_MENU_ITEMS;
    if (!src || !src.length) return [];
    var flat = [];
    src.forEach(function (g) {
      (g.items || []).forEach(function (it) {
        flat.push({ group: g.group, name: it.name, page: it.page, key: it.key });
      });
    });
    return flat;
  }

  var ITEMS = getItems();
  var overlay, input, list;
  var active = -1;
  var filtered = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
          '<input type="text" class="cmd-input" id="cmdInput" placeholder="跳转到模块、账簿、报表…（输入名称筛选）" autocomplete="off">' +
          '<kbd class="cmd-kbd">Esc</kbd>' +
          // 全站弹层统一带 ×（这里没有标题栏，× 落在输入行右端）
          '<button class="modal-x" data-modal-close="1" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="cmd-results" id="cmdResults"></div>' +
        '<div class="cmd-foot">↑↓ 选择 · ↵ 打开 · Esc 关闭</div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('#cmdInput');
    list = overlay.querySelector('#cmdResults');

    input.addEventListener('input', function () { render(input.value); });
    // 遮罩点击关闭由全局 data-backdrop 委托统一处理
    list.addEventListener('click', function (e) {
      var el = e.target.closest('.cmd-item');
      if (el) select(parseInt(el.dataset.idx, 10));
    });
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    filtered = ITEMS.filter(function (it) {
      if (!q) return true;
      return it.name.toLowerCase().indexOf(q) >= 0 || it.group.toLowerCase().indexOf(q) >= 0;
    });
    active = filtered.length ? 0 : -1;
    if (!filtered.length) {
      list.innerHTML = '<div class="empty-hint empty-hint-sm">无匹配项</div>';
      return;
    }
    var html = '';
    var lastGroup = null;
    filtered.forEach(function (it, i) {
      if (it.group !== lastGroup) {
        html += '<div class="cmd-group">' + esc(it.group) + '</div>';
        lastGroup = it.group;
      }
      html += '<div class="cmd-item' + (i === active ? ' active' : '') + '" data-idx="' + i + '">' +
                '<span class="cmd-avatar">' + esc(it.name.charAt(0)) + '</span>' +
                '<span class="cmd-name">' + esc(it.name) + '</span>' +
                '<span class="cmd-tag">' + esc(it.group) + '</span>' +
              '</div>';
    });
    list.innerHTML = html;
  }

  function select(i) {
    var it = filtered[i];
    if (!it) return;
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
    active = (active + d + filtered.length) % filtered.length;
    var els = list.querySelectorAll('.cmd-item');
    els.forEach(function (el, i) { el.classList.toggle('active', i === active); });
    var act = els[active];
    if (act) act.scrollIntoView({ block: 'nearest' });
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
