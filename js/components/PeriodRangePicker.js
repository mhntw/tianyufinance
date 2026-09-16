/**
 * PeriodRangePicker —— 单期期间选择 popover
 *
 * 设计原则：极简、且只做一件事——点 trigger，弹出 12 月 grid，选一个期间，调 on-change。
 *
 * 契约（已冻结，见 CHANGELOG 2026-09-13）：控件只产出一个「报告期」(YYYY-MM)，永不产出起止区间；
 * 两端 hidden input 恒等（由 tools/check-period-contract.js 机器校验）。理由：
 *   ① 报表已用「本期 + 本年累计」两列表达了区间，控件不需要第二个自由度；
 *   ② 13/16 个页面只读结束期间，多一个用户可改的端点会让「改了没反应」这类问题反复出现；
 *   ③ 将来若要跨期，方向是加「粒度」（月/季/年）由粒度派生区间，
 *      而不是把起止两个端点加回来 —— 后者在资产负债表（时点报表）上无法给出有意义的起点。
 * 两端 input 仍保留：页面取数统一读 End（历史调用方众多），Start 作为契约校验的对照项。
 *
 * index.html 占位符写法：
 *   <div data-period="gl" data-default="currentPeriod" data-on-change="__renderGl"></div>
 *   generatePeriodRanges() 启动时自动展开为完整 DOM。
 */

/* ---------------- 模板展开 ---------------- */

function generatePeriodRanges() {
  document.querySelectorAll('[data-period]').forEach(function (host) {
    // 已经展开过的跳过（data-period 保留在 wrapper 上）
    if (host.classList.contains('ty-period-range')) return;

    var id = host.dataset.period;
    var onChange = host.dataset.onChange || '';
    var startId = id + 'PeriodStart';
    var endId = id + 'PeriodEnd';

    host.outerHTML =
      '<div class="ty-period-range" data-period="' + id + '" data-start-id="' + startId + '" data-end-id="' + endId + '" data-on-change="' + onChange + '">' +
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
  year: 0,             // 当前显示的年份（单面板，已无起止两列）
  selected: null,      // 当前选中的 yyyy-mm
  onChange: ''         // data-on-change 回调字符串
};

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

  grid.innerHTML = '';
  for (var m = 1; m <= 12; m++) {
    (function (month) {
      var ym = state.year + '-' + pad2(month);
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
  state.year = cur ? parseInt(cur.split('-')[0], 10) : new Date().getFullYear();

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
  // 回调按全局函数名查找（不用 eval）：eval 有 CSP unsafe-eval 限制、字符串注入面、
  // 以及严格模式下的作用域差异，而 data-on-change 一律是 __renderXxx 这类全局函数名。
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
  if (!s || !textEl) return;   // textEl 缺失只影响文案，不该抛错打断调用方
  // 单期控件两端恒等（契约），只显示一个期间。
  // 取 end 值：页面取数一律读 End，万一两者不一致（违反契约）时显示与实际取数保持一致。
  textEl.textContent = fmtPeriod(e || s);
  textEl.classList.remove('is-placeholder');
}

export function initPeriodRangePicker() {
  generatePeriodRanges();
  initEvents();
}
