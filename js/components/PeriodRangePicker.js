/**
 * PeriodRangePicker —— 期间选择 popover
 *
 * 默认模式（单期）：点 trigger，弹出 12 月 grid，选一个期间，调 on-change。
 *   两端 hidden input 恒等（start === end），控件产出单个「报告期」。
 *
 * 范围模式（data-range="true"）：支持选起止两个月份。
 *   第一次点击设为起始期，第二次点击设为结束期（若结束 < 起始则自动交换）；
 *   两端 hidden input 可能不同（start !== end），控件产出真正的区间。
 *
 * index.html 占位符写法：
 *   单期模式：<div data-period="gl" data-default="currentPeriod" data-on-change="__renderGl"></div>
 *   范围模式：<div data-period="dl" data-default="currentPeriod" data-range="true" data-on-change="__renderDl"></div>
 *   generatePeriodRanges() 启动时自动展开为完整 DOM。
 */

/* ---------------- 模板展开 ---------------- */

function generatePeriodRanges() {
  document.querySelectorAll('[data-period]').forEach(function (host) {
    // 已经展开过的跳过（data-period 保留在 wrapper 上）
    if (host.classList.contains('ty-period-range')) return;

    var id = host.dataset.period;
    var onChange = host.dataset.onChange || '';
    var def = host.dataset.default || 'currentPeriod';
    var range = host.dataset.range === 'true' ? 'true' : '';
    var startId = id + 'PeriodStart';
    var endId = id + 'PeriodEnd';

    host.outerHTML =
      '<div class="ty-period-range" data-period="' + id + '" data-start-id="' + startId + '" data-end-id="' + endId + '" data-on-change="' + onChange + '" data-default="' + def + '"' + (range ? ' data-range="' + range + '"' : '') + '>' +
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
  // 期数补零（2026年08期）：与报表抬头 setRptHead 的 "YYYY年MM期" 保持一致，
  // 否则同一屏里触发器写「2026年8期」、报表标题写「2026年08期」两种写法。
  return parts[0] + '年' + pad2(parseInt(parts[1], 10)) + '期';
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

/* ---------------- 默认期间（由 data-default 声明，组件单点解析） ---------------- */
// 默认期间统一由 index.html 的 data-default 声明、组件单点解析；页面调用 periodRangeValue(prefix) 时不再传 def。
// 解析时机放在「页面读取时」而非「DOM 展开时」：展开发生较早、账套可能尚未加载，currentPeriod() 会拿空值；读取时与渲染同步，取值才可靠。
function wrapOfPrefix(prefix) {
  var sInp = $(prefix + 'Start');
  return sInp ? sInp.closest('.ty-period-range') : null;
}
function periodDefaultOf(prefix) {
  var wrap = wrapOfPrefix(prefix);
  var kind = (wrap && wrap.dataset.default) || 'currentPeriod';
  var H = globalThis.__TY_HELPERS__ || {};
  if (kind === 'lastClosedPeriod' && typeof H.lastClosedPeriod === 'function') {
    var lc = H.lastClosedPeriod();
    if (lc) return lc;
  }
  if (typeof H.currentPeriod === 'function') {
    var cp = H.currentPeriod();
    if (cp) return cp;
  }
  // 兜底一律返回字符串：账套尚未加载时 currentPeriod() 可能为 null，
  // 而 input.value = null 会被 WebIDL 转成字符串 "null" 写进输入框，属脏值。
  return currentPeriod() || '';
}
// 供 app.js 的 periodRangeValue(prefix) 在未显式传 def 时回查声明的默认值
globalThis.__PERIOD_DEFAULT_OF__ = periodDefaultOf;

function allAvailablePeriods() {
  var S = globalThis.S;
  if (!S || !S.state) return [];
  // store 里的 allMonths() 返回账套真实存在的所有 YYYY-MM
  if (typeof S.allMonths === 'function') {
    return S.allMonths();
  }
  // fallback：从启用年 1 月展开到 currentPeriod 所在月（无 currentPeriod 时取启用年整年）。
  // 月份展开统一走 store 暴露的 util.monthList —— 此处原本也内联了一份重复实现。
  var U = globalThis.util || {};
  if (typeof U.monthList !== 'function') return [];
  var startY = (S.state.company && S.state.company.startYear) || new Date().getFullYear();
  var cur = currentPeriod();
  return U.monthList(startY + '-01', cur || (startY + '-12'));
}

/* ---------------- state ---------------- */

var state = {
  wrap: null,          // 当前打开的 .ty-period-range
  year: 0,             // 当前显示的年份
  selected: null,      // 单期模式：当前选中的 yyyy-mm
  rangeStart: null,    // 范围模式：起始期
  rangeEnd: null,      // 范围模式：结束期
  onChange: ''         // data-on-change 回调字符串
};

function isRangeMode() {
  return !!(state.wrap && state.wrap.dataset.range === 'true');
}

function fmtRangeText(start, end) {
  if (!start && !end) return '请选择期间';
  if (start && end && start === end) return fmtPeriod(start);
  return (start ? fmtPeriod(start) : '…') + ' ~ ' + (end ? fmtPeriod(end) : '…');
}

/* ---------------- pop 操作 ---------------- */

function getPop() { return $('kdPeriodRangePop'); }

function renderGrid() {
  var pop = getPop();
  if (!pop || !state.wrap) return;
  var yearText = pop.querySelector('.ty-period-year-text');
  if (yearText) yearText.textContent = state.year + '年';
  var grid = pop.querySelector('.ty-period-grid');
  if (!grid) return;

  var available = allAvailablePeriods();
  var availableSet = {};
  available.forEach(function (ym) { availableSet[ym] = 1; });

  var range = isRangeMode();
  var rs = state.rangeStart, re = state.rangeEnd;

  grid.innerHTML = '';
  for (var m = 1; m <= 12; m++) {
    (function (month) {
      var ym = state.year + '-' + pad2(month);
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ty-period-cell';
      cell.textContent = month + '期';
      cell.dataset.ym = ym;

      if (range) {
        // 范围模式：高亮 start/end/in-range
        if (rs && ym === rs) cell.classList.add('range-start');
        if (re && ym === re) cell.classList.add('range-end');
        if (rs && re && ym > rs && ym < re) cell.classList.add('in-range');
        if (rs && !re && ym === rs) cell.classList.add('selected');
      } else {
        if (ym === state.selected) cell.classList.add('selected');
      }

      if (!availableSet[ym]) {
        cell.classList.add('disabled');
        cell.disabled = true;
      } else {
        cell.addEventListener('click', function (e) {
          e.stopPropagation(); // 防止冒泡到 document 的 click-outside 监听，导致 renderGrid 后 popover 被意外关闭
          handleCellClick(ym);
        });
      }
      grid.appendChild(cell);
    })(m);
  }

  // 范围模式：更新 popover 顶部的提示/已选显示
  updateRangeHeader();
}

function updateRangeHeader() {
  var pop = getPop();
  if (!pop) return;
  var wrap = state.wrap;
  if (!wrap || !isRangeMode()) {
    // 移除 header（如果存在）
    var oldHdr = pop.querySelector('.ty-period-range-hint');
    if (oldHdr) oldHdr.remove();
    return;
  }
  var rs = state.rangeStart, re = state.rangeEnd;
  var hdr = pop.querySelector('.ty-period-range-hint');
  if (!hdr) {
    hdr = document.createElement('div');
    hdr.className = 'ty-period-range-hint';
    var panel = pop.querySelector('.ty-period-panel');
    if (panel) panel.insertBefore(hdr, panel.firstChild);
  }
  if (!rs) hdr.textContent = '请选择起始期间';
  else if (!re) hdr.textContent = '起始：' + fmtPeriod(rs) + '  请选择结束期间';
  else hdr.textContent = '已选：' + fmtPeriod(rs) + ' ~ ' + fmtPeriod(re);
}

function handleCellClick(ym) {
  if (!isRangeMode()) {
    state.selected = ym;
    applySelection();
    return;
  }
  var rs = state.rangeStart, re = state.rangeEnd;
  if (!rs) {
    // 第一次点击 → 设为起始
    state.rangeStart = ym;
    state.rangeEnd = null;
    renderGrid();
  } else if (!re) {
    // 第二次点击 → 设为结束；若 end < start 则自动交换
    if (ym < rs) {
      state.rangeStart = ym;
      state.rangeEnd = rs;
    } else if (ym === rs) {
      state.rangeEnd = rs;
    } else {
      state.rangeEnd = ym;
    }
    applySelection();
  } else {
    // 已选完整范围后再次点击 → 重置为新起始
    state.rangeStart = ym;
    state.rangeEnd = null;
    renderGrid();
  }
}

function openPop(wrap) {
  var pop = getPop();
  if (!pop || !wrap) return;
  state.wrap = wrap;
  state.onChange = wrap.dataset.onChange || '';

  var sInp = $(wrap.dataset.startId);
  var eInp = $(wrap.dataset.endId);
  var sVal = sInp ? sInp.value : '';
  var eVal = eInp ? eInp.value : sVal;

  if (isRangeMode()) {
    state.rangeStart = sVal || currentPeriod();
    state.rangeEnd = eVal || state.rangeStart;
    state.selected = null;
    state.year = state.rangeStart
      ? parseInt(state.rangeStart.split('-')[0], 10)
      : new Date().getFullYear();
  } else {
    state.selected = sVal || currentPeriod();
    state.rangeStart = null;
    state.rangeEnd = null;
    state.year = state.selected
      ? parseInt(state.selected.split('-')[0], 10)
      : new Date().getFullYear();
  }

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
  if (!state.wrap) { closePop(); return; }
  var wrap = state.wrap;
  var startInput = $(wrap.dataset.startId);
  var endInput = $(wrap.dataset.endId);
  var textEl = $(wrap.dataset.period + 'Text');

  var sVal, eVal, displayText;
  if (isRangeMode()) {
    sVal = state.rangeStart;
    eVal = state.rangeEnd;
    if (!sVal || !eVal) return; // 范围模式需起止都有才能 apply
    displayText = fmtRangeText(sVal, eVal);
  } else {
    sVal = state.selected;
    eVal = state.selected;
    displayText = fmtPeriod(sVal);
  }

  if (!sVal) { closePop(); return; }
  if (startInput) startInput.value = sVal;
  if (endInput) endInput.value = eVal;
  if (textEl) {
    textEl.textContent = displayText;
    textEl.classList.remove('is-placeholder');
  }
  closePop();
  // 回调按全局函数名查找（不用 eval）
  if (state.onChange) {
    var fn = globalThis[state.onChange];
    if (typeof fn !== 'function') {
      console.warn('[PeriodRangePicker] data-on-change 未找到对应全局函数：' + state.onChange);
    } else {
      try { fn(); } catch (e) { console.warn('[PeriodRangePicker] onChange 执行失败：', e); }
    }
  }
}

/* ---------------- 事件 ---------------- */

function onYearNav(step) {
  state.year += step;
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
  if (!s || !textEl) return;

  var range = wrap.dataset.range === 'true';
  if (range && e && s !== e) {
    textEl.textContent = fmtRangeText(s, e);
  } else {
    textEl.textContent = fmtPeriod(e || s);
  }
  textEl.classList.remove('is-placeholder');
}

/* 幂等保护（2026-09-19）——
 * initEvents() 在 document 上注册点击监听，若本函数被调用两次，监听会重复注册：
 * 表现为「点一下浮层打开、立刻又被第二个监听关掉」，且不报错、极难定位。
 * 当前只在 js/main.js 调用一次，但那是调用侧的约定；组件自身应保证幂等。 */
var _periodPickerInited = false;
export function initPeriodRangePicker() {
  if (_periodPickerInited) return;
  _periodPickerInited = true;
  generatePeriodRanges();
  initEvents();
}
