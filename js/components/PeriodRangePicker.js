// 起止期间选择器（用于总账/明细账等筛选栏）
// 依赖全局：$（DOM 查询）、currentPeriod、lastClosedPeriod、periodRangeOptions（可外部注入）
// 用法 A（旧，仍支持）：index.html 手写完整 .ty-period-range DOM
// 用法 B（新，推荐）：在占位 div 上只写三个 data 属性，本模块启动时批量生成完整结构：
//     <div data-period="gl" data-single="1" data-on-change="__renderGl"></div>
//   会自动展开为等价的 .ty-period-range + hidden inputs + trigger DOM。
//   优点：index.html 少掉 16×6=96 行重复模板，改样式/加属性改一处即全局生效。

/**
 * 扫描页面所有 data-period 占位 div，批量生成 .ty-period-range 完整 DOM。
 * 调用时机：initPeriodRangePicker() 内部，在 initEvents 之前。
 */
function generatePeriodRanges() {
  document.querySelectorAll('[data-period]').forEach(function (host) {
    if (host.dataset.rangeGenerated) return;  // 已生成过，跳过
    var prefix = host.dataset.period;          // 如 'gl' / 'tb' / 'bs'
    var single = host.dataset.single === '1';   // 默认单期
    var onChange = host.dataset.onChange || '';
    var startId = prefix + 'PeriodStart';
    var endId = prefix + 'PeriodEnd';
    var triggerId = prefix + 'PeriodTrigger';
    var textId = prefix + 'PeriodText';
    host.outerHTML =
      '<div class="ty-period-range"'
      + (single ? ' data-single-period="1"' : '')
      + ' data-start-id="' + startId + '"'
      + ' data-end-id="' + endId + '"'
      + (onChange ? ' data-on-change="' + onChange + '"' : '')
      + '>'
      + '<div class="ty-period-trigger" id="' + triggerId + '">'
      + '<span class="ty-period-trigger-label">期间</span>'
      + '<span class="ty-period-trigger-text" id="' + textId + '">请选择期间</span>'
      + '</div>'
      + '<input type="hidden" id="' + startId + '" />'
      + '<input type="hidden" id="' + endId + '" />'
      + '</div>';
  });
}
//
// ── 单期模式（data-single-period="1"）─────────────────────────────
// 背景：本项目多数页面是【单期】口径（只读结束期间），但控件是范围式（左「开始期间」/右「结束期间」，
//   触发器显示「X期 ~ Y期」），导致用户改左列后点查询「毫无反应」——UI 与真实口径不符，属误导。
//   （见 Report.js / TrialBalance.js 中「口径保持单期间（用结束期间）」的注释）
// 现由本属性显式声明口径，控件据此进入单期模式：
//   · 面板只渲染一列，表头「期间」；
//   · 触发器只显示单个期间（不再出现「X ~ Y」）；
//   · 「今年/去年」这类区间语义的快捷按钮隐藏；
//   · 结束期间与开始期间两个隐藏输入始终同步（右侧写入即同时写左侧），
//     既避免遗留不一致值，也保证任何读 start 的老代码拿到的是同一个期间。
// 未加该属性的容器仍是真范围模式（如查凭证、凭证汇总表、费用明细表），行为不变。
// 口径判定靠 HTML 属性声明，不在本文件里维护页面名单，避免两处漂移。

const $ = globalThis.$ || function (id) { return document.getElementById(id); };
const H = globalThis.__TY_HELPERS__ || {};
const currentPeriod = H.currentPeriod || (() => '2023-01');
const lastClosedPeriod = H.lastClosedPeriod || currentPeriod;
const periodRangeOptions = H.periodRangeOptions || (typeof window !== 'undefined' ? window.__EXTRA_PERIOD_RANGE_OPTIONS__ : undefined);
const storeAllMonths = H.allMonths;   // app.js 的 allMonths() — 账套真实可选月列表

const pad2 = n => String(n).padStart(2, '0');
const PERIOD_RE = /^\d{4}-\d{2}$/;

// 本月 = 当下自然月（会计分期假设：会计期间基于公历月，与账套记账进度无关）；
// 本期 = 最近已结账期间（报告期口径，结账后才能出表）。两者语义分离。
function naturalMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

// 统一的“默认/兜底期间”取法：最近已结账期间 → 当期 → 当前自然月。
// 之前各 fallback 硬编码 '2023-01' / '2026-01'，与真实账期不一致，会造成面板年份错乱（如打开显示 2024）。
function resolveDefault() {
  const cands = [
    (typeof lastClosedPeriod === 'function' ? lastClosedPeriod() : ''),
    (typeof currentPeriod === 'function' ? currentPeriod() : '')
  ];
  for (const c of cands) if (c && PERIOD_RE.test(String(c))) return c;
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

function fmtPeriod(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${y}年${pad2(m)}期`;
}

function parseYM(ym) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  return { y, m, ym: `${y}-${pad2(m)}` };
}

function allAvailablePeriods() {
  // 1. 优先用 store 的真实月份（账套启用月 → 有凭证的最后一个月）
  if (typeof storeAllMonths === 'function') {
    try {
      const real = storeAllMonths();
      if (Array.isArray(real) && real.length) return real;
    } catch (e) { /* ignore */ }
  }
  // 2. 其次用注入的 periodRangeOptions（渲染 <option> 字符串）
  if (typeof periodRangeOptions === 'function') {
    const div = document.createElement('div');
    div.innerHTML = periodRangeOptions();
    return Array.from(div.querySelectorAll('option')).map(o => o.value);
  }
  // 3. fallback：从当前期间向前后各扩展一年
  const cp = resolveDefault();
  const [cy, cm] = cp.split('-').map(Number);
  const list = [];
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let m = 1; m <= 12; m++) list.push(`${y}-${pad2(m)}`);
  }
  return list;
}

function maxAvailablePeriod() {
  const list = allAvailablePeriods();
  return list.length ? list[list.length - 1] : resolveDefault();
}

// 当前打开的面板状态
const state = {
  wrap: null,          // 当前触发器所在的 .ty-period-range
  start: '',
  end: '',
  startYear: 2023,
  endYear: 2023,
  onChange: null,
  isSingle: false      // 单期模式：data-single-period="1" 的容器启用
};

function getPop() { return $('kdPeriodRangePop'); }
function getStartInput() { return state.wrap ? $(state.wrap.dataset.startId) : null; }
function getEndInput() { return state.wrap ? $(state.wrap.dataset.endId) : null; }

function updateTriggerText(wrap) {
  if (!wrap) return;
  const textEl = wrap.querySelector('.ty-period-trigger-text');
  if (!textEl) return;
  const sInp = $(wrap.dataset.startId);
  const eInp = $(wrap.dataset.endId);
  const s = sInp ? sInp.value : '';
  const e = eInp ? eInp.value : '';
  const isSingle = wrap.dataset.singlePeriod === '1';
  if (isSingle) {
    textEl.textContent = e ? fmtPeriod(e) : '请选择期间';
  } else {
    textEl.textContent = s && e ? `${fmtPeriod(s)} ~ ${fmtPeriod(e)}` : '请选择期间';
  }
}

export function updatePeriodRangeTrigger(startId, endId) {
  document.querySelectorAll('.ty-period-range').forEach(wrap => {
    if (wrap.dataset.startId === startId && wrap.dataset.endId === endId) updateTriggerText(wrap);
  });
}

function closePop() {
  const pop = getPop();
  if (pop) pop.hidden = true;
  state.wrap = null;
}

function openPop(wrap) {
  const pop = getPop();
  if (!pop || !wrap) return;
  state.wrap = wrap;
  state.isSingle = wrap.dataset.singlePeriod === '1';
  const sInp = $(wrap.dataset.startId);
  const eInp = $(wrap.dataset.endId);
  state.start = sInp ? sInp.value : '';
  state.end = eInp ? eInp.value : '';
  if (!state.start || !state.end) {
    const def = resolveDefault();
    state.start = state.start || def;
    state.end = state.end || def;
  }
  const _sty = parseYM(state.start), _ety = parseYM(state.end);
  state.startYear = (_sty && _sty.y) || (_ety && _ety.y) || new Date().getFullYear();
  state.endYear = (_ety && _ety.y) || state.startYear;
  state.onChange = wrap.dataset.onChange || null;
  renderPanels();
  renderShortcuts();
  pop.hidden = false;
  positionPop(wrap);
}

function positionPop(wrap) {
  const pop = getPop();
  if (!pop || !wrap) return;
  const box = pop.querySelector('.ty-period-range-box');
  const trigger = wrap.querySelector('.ty-period-trigger');
  if (!box || !trigger) return;
  // pop 为 fixed 全屏容器（视口坐标系），box 相对它定位时直接用视口坐标，勿再加 scrollX/scrollY
  const rect = trigger.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 4;
  // 视口右侧/底部溢出兜底：优先贴左/贴下，空间不足翻到触发框上方
  if (left + boxRect.width > window.innerWidth - 12) left = window.innerWidth - boxRect.width - 12;
  if (left < 12) left = 12;
  if (top + boxRect.height > window.innerHeight - 12) top = Math.max(12, rect.top - boxRect.height - 4);
  box.style.position = 'absolute';
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}

function renderPanels() {
  const pop = getPop();
  if (!pop) return;
  // 可用集合：账套真实有数据的月份，O(1) 查找
  const availableSet = new Set(allAvailablePeriods());
  const panels = pop.querySelectorAll('.ty-period-panel');
  panels.forEach(panel => {
    const side = panel.dataset.side;
    // 单期模式：隐藏 start panel，改 end panel 标题
    if (state.isSingle) {
      if (side === 'start') { panel.style.display = 'none'; return; }
      const head = panel.querySelector('.ty-period-panel-head');
      if (head) head.textContent = '选择期间';
    } else {
      if (side === 'start') { const h = panel.querySelector('.ty-period-panel-head'); if (h) h.textContent = '开始期间'; }
      if (side === 'end') { const h = panel.querySelector('.ty-period-panel-head'); if (h) h.textContent = '结束期间'; }
      panel.style.display = '';
    }
    const year = side === 'start' ? state.startYear : state.endYear;
    panel.querySelector('.ty-period-year-text').textContent = `${year}年`;
    const grid = panel.querySelector('.ty-period-grid');
    grid.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${pad2(m)}`;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ty-period-cell';
      cell.textContent = `${m}期`;
      cell.dataset.ym = ym;
      // 选中态
      if (side === 'start' && ym === state.start) cell.classList.add('selected');
      if (side === 'end' && ym === state.end) cell.classList.add('selected');
      // 禁用态：不在账套真实可用月份列表里 → 灰色不可选
      if (!availableSet.has(ym)) {
        cell.classList.add('disabled');
        cell.disabled = true;
      } else {
        cell.addEventListener('click', () => onCellClick(side, ym));
      }
      grid.appendChild(cell);
    }
  });
}

// 单期模式下隐藏区间语义快捷按钮（今年/去年）
function renderShortcuts() {
  const pop = getPop();
  if (!pop) return;
  pop.querySelectorAll('[data-shortcut="current-year"], [data-shortcut="last-year"]').forEach(btn => {
    btn.style.display = state.isSingle ? 'none' : '';
  });
}

function onCellClick(side, ym) {
  if (side === 'start') {
    state.start = ym;
    if (state.end < state.start) state.end = state.start;
  } else {
    state.end = ym;
    if (state.start > state.end) state.start = state.end;
  }
  renderPanels();
}

function applySelection() {
  // 单期模式：start 与 end 保持一致（避免遗留不一致值）
  if (state.isSingle) state.start = state.end;
  const sInp = getStartInput();
  const eInp = getEndInput();
  if (sInp) sInp.value = state.start;
  if (eInp) eInp.value = state.end;
  updateTriggerText(state.wrap);
  closePop();
  // 触发外部刷新
  const cbName = state.onChange;
  if (cbName) {
    const fn = globalThis[cbName];
    if (typeof fn === 'function') {
      try { fn(); } catch (e) { console.error('[PeriodRangePicker] onChange error', e); }
    }
  }
  // 同时派发原生 change 事件，供老代码监听
  [sInp, eInp].forEach(inp => {
    if (inp) {
      const ev = new Event('change', { bubbles: true });
      inp.dispatchEvent(ev);
    }
  });
}

function onYearNav(side, step) {
  if (side === 'start') {
    state.startYear += step;
  } else {
    state.endYear += step;
  }
  renderPanels();
}

function applyShortcut(key) {
  const cpRaw = typeof currentPeriod === 'function' ? currentPeriod() : '';
  // 兜底：新建账套可能尚无凭证/未设起账期间，currentPeriod() 暂返回 null/''。
  // 此时用「最近已结账期间」兜底，再无则用保守当前年首月。
  const fb = (cpRaw && PERIOD_RE.test(cpRaw)) ? cpRaw : resolveDefault();
  const cp = fb;
  let maxP = maxAvailablePeriod();
  if (!maxP || !/\d{4}-\d{2}/.test(maxP)) maxP = cp;
  const cy = Number(cp.split('-')[0]) || new Date().getFullYear();
  let s = cp, e = cp;
  switch (key) {
    case 'current-period':
      e = typeof lastClosedPeriod === 'function' ? lastClosedPeriod() : cp;
      s = e;
      break;
    case 'last-period': {
      const last = (typeof lastClosedPeriod === 'function' ? lastClosedPeriod() : cp) || cp;
      const [ly, lm] = last.split('-').map(Number);
      const pm = lm === 1 ? 12 : lm - 1;
      const py = lm === 1 ? ly - 1 : ly;
      s = e = `${py}-${pad2(pm)}`;
      break;
    }
    case 'current-month':
      // 本月 = 当下自然月，与账套进度无关（账套未做到该月时显示空表属正常）
      s = e = naturalMonth();
      break;
    case 'last-month': {
      const [ny, nm] = naturalMonth().split('-').map(Number);
      const pm = nm === 1 ? 12 : nm - 1;
      const py = nm === 1 ? ny - 1 : ny;
      s = e = `${py}-${pad2(pm)}`;
      break;
    }
    case 'current-year':
      s = `${cy}-01`;
      e = `${cy}-12`;
      break;
    case 'last-year':
      s = `${cy - 1}-01`;
      e = `${cy - 1}-12`;
      break;
  }
  //  Clamp 到最大可用期间（遇空值不生效，保持原值）
  //  本月/上月按自然月口径，不受账套可用期间限制（与账套无关），其余快捷按钮照常 clamp
  const naturalShortcut = key === 'current-month' || key === 'last-month';
  if (!naturalShortcut && s && maxP && s > maxP) s = maxP;
  if (!naturalShortcut && e && maxP && e > maxP) e = maxP;
  if (e < s) e = s;
  // 防御性取值：输入可能无效导致 parseYM 返回 null（新账套无期间时），全部兜底
  const ps = parseYM(s === null ? cp : s) || parseYM(cp);
  const pe = parseYM(e === null ? cp : e) || parseYM(cp) || ps;
  state.start = (ps && ps.ym) || cp;
  state.end = (pe && pe.ym) || (ps && ps.ym) || cp;
  state.startYear = (ps && ps.y) || cy || 2026;
  state.endYear = (pe && pe.y) || state.startYear;
  renderPanels();
}

function initEvents() {
  document.querySelectorAll('.ty-period-range').forEach(wrap => {
    const trigger = wrap.querySelector('.ty-period-trigger');
    if (!trigger || trigger.dataset.bound) return;
    trigger.dataset.bound = '1';
    trigger.addEventListener('click', () => openPop(wrap));
  });

  const pop = getPop();
  if (!pop || pop.dataset.bound) return;
  pop.dataset.bound = '1';

  pop.addEventListener('click', e => {
    // 关键修复：点击弹窗内部后阻止冒泡到 document 的「点击其它处关闭」逻辑。
    // 否则点击期间格时 onCellClick->renderPanels 会用 innerHTML 重建格子，
    // 把被点击的 cell 从 DOM 移除，事件冒泡到 document 时 pop.contains(已移除节点)
    // 返回 false，被误判为「点击了页面其它处」→ 弹窗秒关且 state.wrap 被清空，
    // 导致「点期间不弹窗 / 选期间后点查询不起作用」。
    e.stopPropagation();
    const closeBtn = e.target.closest('[data-close="kdPeriodRangePop"]');
    if (closeBtn) { closePop(); return; }

    const yearBtn = e.target.closest('.ty-period-year-prev, .ty-period-year-next');
    if (yearBtn) {
      const panel = yearBtn.closest('.ty-period-panel');
      onYearNav(panel.dataset.side, Number(yearBtn.dataset.step));
      return;
    }

    const shortcut = e.target.closest('[data-shortcut]');
    if (shortcut) {
      applyShortcut(shortcut.dataset.shortcut);
      return;
    }

    const confirm = e.target.closest('[data-act="periodRangeConfirm"]');
    if (confirm) { applySelection(); return; }
  });

  // 点击页面其它处关闭
  document.addEventListener('click', e => {
    if (pop.hidden) return;
    const insideTrigger = state.wrap && state.wrap.contains(e.target);
    const insidePop = pop.contains(e.target);
    if (!insideTrigger && !insidePop) closePop();
  });

  window.addEventListener('resize', () => {
    if (!pop.hidden && state.wrap) positionPop(state.wrap);
  });
}

export function initPeriodRangePicker() {
  generatePeriodRanges();  // 先把占位 div 展开成完整 DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEvents);
  } else {
    initEvents();
  }
}

