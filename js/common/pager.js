// 分页器（全站唯一实现）
// 【为什么有这个文件】此前三张表各写一套，同一件事三种标记三种长相：
//   · 资产卡片：<li> 固定三格（上一页 / 一个页码 / 下一页），靠 aPrev·aNext·aPageNo 三个 id 手工维护
//   · 费用明细：动态生成**全部**页码 <li>，页数一多就撑满一行
//   · 操作日志：「上一页  n / m  下一页」文字按钮（.btn btn-second）
// 现在只有这一份：‹ 页码窗口（超长以 … 折叠） ›，箭头与页码同一套按钮，当前页高亮、首尾置灰。
//
// 用法：
//   import { renderPager } from '../../common/pager.js';
//   renderPager($('xxxPages'), { page: state.page, total: pages, onGo(p) { state.page = p; refresh(); } });
//
// 实现要点：
//   · 监听器只绑一次（绑在容器上），回调从 el.__pagerOnGo 现取 —— 否则首次的闭包会把
//     旧 state 固死，翻第二页就失效。
//   · 点击「当前页」不触发回调（el.__pagerPage 比对），避免无意义重渲染。

export function pagerItems(page, total) {
  var t = Math.max(1, (total | 0));
  var p = Math.min(Math.max(1, (page | 0)), t);
  var items = [];
  if (t <= 7) {
    for (var i = 1; i <= t; i++) items.push(i);
    return { page: p, items: items };
  }
  items.push(1);
  var s = Math.max(2, p - 1);
  var e = Math.min(t - 1, p + 1);
  if (s > 2) items.push('gap');
  for (var j = s; j <= e; j++) items.push(j);
  if (e < t - 1) items.push('gap');
  items.push(t);
  return { page: p, items: items };
}

export function renderPager(el, opts) {
  if (!el) return;
  opts = opts || {};
  var total = Math.max(1, (opts.total | 0));
  var r = pagerItems(opts.page, total);

  // 箭头字符也由 CSS 给（.pager-arrow[data-dir=prev|next]::before），JS 不写字符
  var html = '<button type="button" class="pager-arrow" data-dir="prev" data-page="' + (r.page - 1) + '"' +
    (r.page <= 1 ? ' disabled' : '') + ' aria-label="上一页"></button>';
  html += '<ul class="pager-list">';
  r.items.forEach(function (it) {
    if (it === 'gap') { html += '<li class="pager-gap">…</li>'; return; }
    var active = it === r.page;
    html += '<li class="' + (active ? 'active' : '') + '">' +
      '<button type="button" data-page="' + it + '"' + (active ? ' aria-current="page"' : '') + '>' + it + '</button>' +
      '</li>';
  });
  html += '</ul>';
  html += '<button type="button" class="pager-arrow" data-dir="next" data-page="' + (r.page + 1) + '"' +
    (r.page >= total ? ' disabled' : '') + ' aria-label="下一页"></button>';
  el.innerHTML = html;

  el.__pagerOnGo = opts.onGo;
  el.__pagerPage = r.page;
  if (!el.__pagerBound) {
    el.__pagerBound = true;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-page]');
      if (!b || b.disabled) return;
      var p = parseInt(b.getAttribute('data-page'), 10);
      if (!p || p < 1 || p === el.__pagerPage) return;
      if (typeof el.__pagerOnGo === 'function') el.__pagerOnGo(p);
    });
  }
}
