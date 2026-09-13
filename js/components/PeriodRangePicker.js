/**
 * PeriodRangePicker —— 单期期间选择 popover
 *
 * 设计原则：极简。只做一件事——点 trigger，弹出 12 月 grid，选一个期间，调 on-change。
 * 范围模式：2 个页面用原生 <select> 处理，不在这里。
 *
 * index.html 占位符写法：
 *   <div data-period="gl" data-single="1" data-on-change="__renderGl"></div>
 *   generatePeriodRanges() 启动时自动展开为完整 DOM。
 */

/* ---------------- 模板展开 ---------------- */

function generatePeriodRanges() {
  document.querySelectorAll('[data-period]').forEach(function (host) {
    // 已经展开过的跳过（data-period 保留在 wrapper 上）
    if (host.classList.contains('ty-period-range')) return;

    var id = host.dataset.period;
    var single = host.dataset.single || '1';
    var onChange = host.dataset.onChange || '';
    var startId = id + 'PeriodStart';
    var endId = id + 'PeriodEnd';

    host.outerHTML =
      '<div class="ty-period-range" data-period="' + id + '" data-single-period="' + single + '" data-start-id="' + startId + '" data-end-id="' + endId + '" data-on-change="' + onChange + '">' +
      '  <div class="ty-period-trigger" id="' + id + 'Trigger">' +
      '    <span class="ty-period-trigger-label">期间</span>' +
      '    <span class="ty-period-trigger-text is-placeholder" id="' + id + 'Text">请选择期间</span>' +
      '  </div>' +
      '  <input type="hidden" id="' + startId + '" />' +
      '  <input type="hidden" id="' + endId + '" />' +
      '</div>';
  });
}

/* ---------------- 工具 ---------------- */

var $ = globalThis.$ || function (id) { return document.getElementById(id); };

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function fmtPeriod(ym) {
  if (!ym) return '';
  var parts = ym.split('-');
  return parts[0] + '年' + parseInt(parts[1], 10) + '期';
}

function currentPeriod() {
  var S = globalThis.S;
  if (!S || !S.state) return null;
  var s = S.state;
  if (typeof s.currentPeriod === 'function') return s.currentPeriod();
  if (s.currentPeriod) return s.currentPeriod;
  if (s.startYear && s.startMonth) return s.startYear + '-' + pad2(s.startMonth);
  var now = new Date();
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1);
}

function allAvailablePeriods() {
  var S = globalThis.S;
  if (!S || !S.state) return [];
  // store 里的 allMonths() 返回账套真实存在的所有 YYYY-MM
  if (typeof S.allMonths === 'function') {
    return S.allMonths();
  }
  // fallback：从 startYear 到 currentPeriod 所在年
  var startY = (S.state.company && S.state.company.startYear) || new Date().getFullYear();
  var cur = currentPeriod();
  var curY = cur ? parseInt(cur.split('-')[0], 10) : startY;
  var list = [];
  for (var y = startY; y <= curY; y++) {
    var maxM = (y === curY && cur) ? parseInt(cur.split('-')[1], 10) : 12;
    for (var m = 1; m <= maxM; m++) {
      list.push(y + '-' + pad2(m));
    }
  }
  return list;
}

/* ---------------- state ---------------- */

var state = {
  wrap: null,          // 当前打开的 .ty-period-range
  startYear: 0,
  selected: null,      // 当前选中的 yyyy-mm
  onChange: ''         // data-on-change 回调字符串
};

/* ---------------- pop 操作 ---------------- */

function getPop() { return $('kdPeriodRangePop'); }

function renderGrid() {
  var pop = getPop();
  if (!pop || !state.wrap) return;
  var yearText = pop.querySelector('.ty-period-year-text');
  if (yearText) yearText.textContent = state.startYear + '年';
  var grid = pop.querySelector('.ty-period-grid');
  if (!grid) return;

  var available = allAvailablePeriods();
  var availableSet = {};
  available.forEach(function (ym) { availableSet[ym] = 1; });

  grid.innerHTML = '';
  for (var m = 1; m <= 12; m++) {
    (function (month) {
      var ym = state.startYear + '-' + pad2(month);
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ty-period-cell';
      cell.textContent = month + '期';
      cell.dataset.ym = ym;
      if (ym === state.selected) cell.classList.add('selected');
      if (!availableSet[ym]) {
        cell.classList.add('disabled');
        cell.disabled = true;
      } else {
        cell.addEventListener('click', function () {
          state.selected = ym;
          grid.querySelectorAll('.ty-period-cell.selected').forEach(function (el) { el.classList.remove('selected'); });
          cell.classList.add('selected');
          applySelection();
        });
      }
      grid.appendChild(cell);
    })(m);
  }
}

function openPop(wrap) {
  var pop = getPop();
  if (!pop || !wrap) return;
  state.wrap = wrap;
  state.onChange = wrap.dataset.onChange || '';

  // 初始化选中值：从 hidden input 读，或者 currentPeriod
  var startInput = $(wrap.dataset.startId);
  var cur = (startInput && startInput.value) || currentPeriod();
  state.selected = cur;
  state.startYear = cur ? parseInt(cur.split('-')[0], 10) : new Date().getFullYear();

  renderGrid();

  // popover 定位：position:fixed，用 trigger 的视口坐标算
  var trigger = wrap.querySelector('.ty-period-trigger');
  var rect = trigger.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = rect.left + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
  // 右侧溢出修正
  var popW = pop.offsetWidth;
  if (rect.left + popW > window.innerWidth - 8) {
    pop.style.left = Math.max(8, window.innerWidth - popW - 8) + 'px';
  }
}

function closePop() {
  var pop = getPop();
  if (!pop) return;
  pop.hidden = true;
  state.wrap = null;
}

function applySelection() {
  if (!state.wrap || !state.selected) { closePop(); return; }
  var wrap = state.wrap;
  var startInput = $(wrap.dataset.startId);
  var endInput = $(wrap.dataset.endId);
  var textEl = $(wrap.dataset.period + 'Text');
  var ym = state.selected;
  if (startInput) startInput.value = ym;
  if (endInput) endInput.value = ym;
  if (textEl) {
    textEl.textContent = fmtPeriod(ym);
    textEl.classList.remove('is-placeholder');
  }
  closePop();
  if (state.onChange) {
    try { eval(state.onChange + '()'); } catch (e) { console.warn('[PeriodRangePicker] onChange eval failed:', e); }
  }
}

/* ---------------- 事件 ---------------- */

function onYearNav(step) {
  state.startYear += step;
  renderGrid();
}

function initEvents() {
  // trigger 点击 → 打开/切换 popover
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('.ty-period-trigger');
    if (trigger) {
      var wrap = trigger.closest('.ty-period-range');
      if (!wrap) return;
      e.stopPropagation();
      var pop = getPop();
      if (pop && state.wrap === wrap && !pop.hidden) {
        closePop();
      } else {
        openPop(wrap);
      }
      return;
    }
    // 点击 popover 外部 → 关闭
    var pop = getPop();
    if (pop && !pop.hidden && !pop.contains(e.target)) {
      closePop();
    }
  });

  // 年份翻页
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.ty-period-year-nav button');
    if (!btn) return;
    e.stopPropagation();
    var step = parseInt(btn.dataset.step, 10) || 0;
    onYearNav(step);
  });
}

/* ---------------- public ---------------- */

export function updatePeriodRangeTrigger(startId, endId) {
  var startEl = $(startId);
  var endEl = $(endId);
  if (!startEl) return;
  var wrap = startEl.closest('.ty-period-range');
  if (!wrap) return;
  var textEl = $(wrap.dataset.period + 'Text');
  var s = startEl.value;
  var e = endEl ? endEl.value : s;
  if (!s) return;
  textEl.textContent = (s === e) ? fmtPeriod(s) : fmtPeriod(s) + ' ~ ' + fmtPeriod(e);
  textEl.classList.remove('is-placeholder');
}

export function initPeriodRangePicker() {
  generatePeriodRanges();
  initEvents();
}
