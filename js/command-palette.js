/* command-palette.js —— 全局命令面板（Ctrl/Cmd + K 快速跳转）
 * 复用 app.js 暴露的 globalThis.QUICK_MENU_ITEMS 作为唯一导航数据源，
 * 与左侧导航、首页快捷菜单同源；选中后调用 globalThis.goPage(page) 跳转。
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
    overlay.className = 'cmd-overlay';
    overlay.id = 'cmdPalette';
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="cmd-modal" role="dialog" aria-label="快速跳转">' +
        '<div class="cmd-input-row">' +
          '<span class="cmd-ico">⌕</span>' +
          '<input type="text" class="cmd-input" id="cmdInput" placeholder="跳转到模块、账簿、报表…（输入名称筛选）" autocomplete="off">' +
          '<kbd class="cmd-kbd">Esc</kbd>' +
        '</div>' +
        '<div class="cmd-results" id="cmdResults"></div>' +
        '<div class="cmd-foot">↑↓ 选择 · ↵ 打开 · Esc 关闭</div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('#cmdInput');
    list = overlay.querySelector('#cmdResults');

    input.addEventListener('input', function () { render(input.value); });
    // 点背景关闭（点列表项不触发，因为 target 不是 overlay）
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
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
      list.innerHTML = '<div class="cmd-empty">无匹配项</div>';
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

  function open() {
    if (!overlay) build();
    overlay.style.display = 'flex';
    input.value = '';
    render('');
    setTimeout(function () { input.focus(); }, 0);
  }
  function close() {
    if (overlay) overlay.style.display = 'none';
  }
  function toggle() {
    if (overlay && overlay.style.display !== 'none') close(); else open();
  }

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
    if (!overlay || overlay.style.display === 'none') return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); select(active); }
  });

  // 顶栏可见入口：提示快捷键，点击亦可打开
  function injectTrigger() {
    var right = document.querySelector('.topbar-right');
    if (!right) return;
    if (document.getElementById('cmdTrigger')) return;
    var btn = document.createElement('button');
    btn.className = 'cmd-trigger';
    btn.id = 'cmdTrigger';
    btn.type = 'button';
    btn.title = '快速跳转（Ctrl/Cmd + K）';
    btn.innerHTML = '<span class="cmd-trigger-ico">⌕</span><span>快速跳转</span><kbd class="cmd-kbd">⌘K</kbd>';
    btn.addEventListener('click', open);
    right.insertBefore(btn, right.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTrigger);
  } else {
    injectTrigger();
  }
})();
