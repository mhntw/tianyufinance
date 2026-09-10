/* 期末结账业务模块
 * 依赖桥接层 globalThis.__TY_HELPERS__
 */
const H = globalThis.__TY_HELPERS__ || {};
const $ = H.$ || function () { return null; };
const S = H.S;
const U = H.U;
const money = H.money;
import { bindSubjectCombo } from '../../components/SubjectCombo.js';
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const syncAll = H.syncAll;
const openModal = H.openModal;
const closeModal = H.closeModal;
const round2 = H.round2;
const esc = H.esc || function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

// 取卡片对应的模板 id：系统卡用固定 id 映射，自定义卡用 data-id 属性
function cardTplId(card) {
  var map = { cardDepr: 'dep', cardCost: 'cost', cardVat: 'vat', cardSurTax: 'surTax', cardIncTax: 'incTax', cardProfit: 'profit' };
  if (card.id && map[card.id]) return map[card.id];
  var did = card.getAttribute('data-id');
  return did || null;
}

/* ============================================================
 * 期末结账
 * ============================================================ */
var selMonth = currentPeriod(); // 结账 tab 选中期（月份方块导航驱动）
var selReopenMonth = currentPeriod(); // 反结账 tab 选中期（月份方块导航驱动）

// ===== 年份选择器（风格：3列网格 + 左右翻页） =====
var yearPickerTarget = 'close'; // 'close' 或 'reopen'，标记当前为哪个面板服务
var yearPickerBase = 2011; // 选择器起始年（每页15年：3列x5行）

function showYearPicker(targetEl) {
  var picker = $('settleYearPicker');
  if (!picker || !targetEl) return;
  yearPickerTarget = targetEl.getAttribute('data-target') || 'close';
  // 定位到年份栏下方
  var rect = targetEl.getBoundingClientRect();
  var parent = targetEl.closest('.settle-tab-pane,.settle-close-body,.settle-reopen-body');
  var prect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
  picker.style.left = (rect.left + rect.width / 2) + 'px'; // 居中：用 transform 抵消自身宽度，不写死 120
  picker.style.transform = 'translateX(-50%)';
  picker.style.top = (rect.bottom + window.scrollY + 4) + 'px'; // 原 rect.bottom - prect.top + prect.top 抵消即 rect.bottom
  picker.style.display = '';
  renderYearPickerGrid();
}

function hideYearPicker() {
  var p = $('settleYearPicker');
  if (p) p.style.display = 'none';
}

function renderYearPickerGrid() {
  var grid = $('yearPickerGrid');
  var rangeEl = $('yearPickerRange');
  if (!grid) return;
  var curYr = yearPickerTarget === 'close'
    ? +selMonth.slice(0, 4)
    : +selReopenMonth.slice(0, 4);
  // 确保当前年在可视范围内
  if (curYr < yearPickerBase) yearPickerBase = Math.max(2000, Math.floor(curYr / 15) * 15);
  if (curYr >= yearPickerBase + 15) yearPickerBase = Math.floor(curYr / 15) * 15;
  if (rangeEl) rangeEl.textContent = yearPickerBase + ' - ' + (yearPickerBase + 14);
  var html = '';
  for (var y = yearPickerBase; y < yearPickerBase + 15; y++) {
    var active = y === curYr ? ' active' : '';
    html += '<div class="settle-year-picker-item' + active + '" data-y="' + y + '">' + y + '</div>';
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.settle-year-picker-item').forEach(function (el) {
    el.addEventListener('click', function () {
      var ny = +this.getAttribute('data-y');
      pickYear(ny);
      hideYearPicker();
    });
  });
}

function pickYear(year) {
  var mm = yearPickerTarget === 'close'
    ? selMonth.slice(5, 7)
    : selReopenMonth.slice(5, 7);
  var newPer = year + '-' + mm;
  if (yearPickerTarget === 'close') {
    selMonth = newPer;
  } else {
    selReopenMonth = newPer;
  }
  refreshSettle();
}

// 年份栏点击弹出选择器
document.querySelectorAll('.settle-year-clickable').forEach(function (el) {
  el.addEventListener('click', function (e) {
    e.stopPropagation();
    showYearPicker(this);
  });
});
// 结账页年份右箭头 >> 同样打开选择器
var sya = $('settleYearArrow');
if (sya) sya.addEventListener('click', function (e) {
  e.stopPropagation();
  var target = $('settleYearVal');
  if (target) showYearPicker(target);
});

// 翻页
var pp = $('yearPickerPrev');
var pn = $('yearPickerNext');
if (pp) pp.addEventListener('click', function (e) { e.stopPropagation(); yearPickerBase -= 15; renderYearPickerGrid(); });
if (pn) pn.addEventListener('click', function (e) { e.stopPropagation(); yearPickerBase += 15; renderYearPickerGrid(); });

// 点击外部关闭
document.addEventListener('click', function (e) {
  if (e.target.closest('#settleYearPicker') || e.target.closest('.settle-year-clickable')) return;
  hideYearPicker();
});

// 幂等绑定（元素可能晚于模块加载出现，故 refreshSettle 内重复调用安全）
function onBtn(id, fn) {
  var el = $(id);
  if (el && !el._bound) { el._bound = true; el.addEventListener('click', fn); }
}
// 按钮绑定（结账/期末处理/反结账 主按钮，静态元素）
function bindSettleEvents() {
  // 设置弹窗：启用/禁用模板分组均可折叠/展开（默认展开）
  [['settleTmplGroupEnabled', 'settleTmplEnabled'], ['settleTmplGroupDisabled', 'settleTmplDisabled']].forEach(function (pair) {
    var grp = $(pair[0]), ul = $(pair[1]);
    if (grp && ul && !grp._bound) {
      grp._bound = true;
      grp.addEventListener('click', function () {
        var hidden = ul.classList.toggle('settle-tmpl-list-hidden');
        var arr = grp.querySelector('.settle-tmpl-arrow');
        if (arr) arr.style.transform = hidden ? 'rotate(0deg)' : 'rotate(90deg)';
      });
      var arr0 = grp.querySelector('.settle-tmpl-arrow');
      if (arr0) arr0.style.transform = ul.classList.contains('settle-tmpl-list-hidden') ? 'rotate(0deg)' : 'rotate(90deg)';
    }
  });
  // 期末结账三 Tab 切换：期末处理 / 结账 / 反结账（此前未绑定，导致 tab 点不动）
  document.querySelectorAll('#settleTabs .settle-tab').forEach(function (tab) {
    if (tab._bound) return;
    tab._bound = true;
    tab.addEventListener('click', function () {
      var which = tab.getAttribute('data-tab'); // process / close / reopen
      document.querySelectorAll('#settleTabs .settle-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var map = { process: 'settlePaneProcess', close: 'settlePaneClose', reopen: 'settlePaneReopen' };
      ['settlePaneProcess', 'settlePaneClose', 'settlePaneReopen'].forEach(function (id) {
        var p = document.getElementById(id); if (p) p.style.display = 'none';
      });
      var target = document.getElementById(map[which]);
      if (target) target.style.display = '';
      refreshSettle();
    });
  });
  onBtn('btnDepVoucher', function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期（与 btnClosePeriod 一致，避免选 A 期操作 B 期）
    var r = S.depreciateMonth(month);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已生成折旧凭证：' + money(r.total) + '（' + r.count + ' 项资产）');
    refreshSettle(); syncAll();
  });
  onBtn('btnCarryCost', function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    var tpl = getSettleTemplates().filter(function (t) { return t.id === 'cost'; })[0] || {};
    var est = S.costVoucherEstimate(month, tpl);
    var amt = U.num(tpl.costAmount) > 0 ? U.num(tpl.costAmount) : est.amount;
    if (amt < 0.005) return showToast('本期无销售成本可结转', 'error');
    // 查重：连点会重复生成同额成本凭证（虚增成本），与调汇/税费类按钮一致走拦截。
    // 按 v.kind 识别（结构识别），不再依赖摘要正则（对导入凭证恒不命中）。
    var costExisted = S.periodVouchersOfKind(month, S.VOUCHER_KINDS.CARRY_COST);
    if (costExisted.length) {
      return showToast('本期已生成 ' + costExisted.length + ' 张结转销售成本凭证，请勿重复生成；如需重做请先删除旧凭证', 'error');
    }
    var r = S.genCostVoucher(month, tpl, amt);
    if (!r || !r.ok) return showToast(r ? r.msg : '结转失败', 'error');
    showToast('已结转销售成本：' + money(amt));
    refreshSettle(); syncAll();
  });
  onBtn('btnCarryVat', function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    var est = S.profitStatement(month);
    var vat = Math.max(0, U.num(est.totalRevenue) - U.num(est.totalExpense)) * 0.13;
    if (vat < 0.005) return showToast('本期无未交增值税可转出', 'error');
    // 目标科目取「增值税编辑」配置模板（跨账套科目码不同，勿硬编码 222101）
    var vt = (S.vatEditGet(month).entries || [])[0] || {};
    var vatTarget = vt.target || '222101';
    var vatTargetName = vt.name || (S.subject(vatTarget) ? S.subject(vatTarget).name : '未交增值税');
    var rr = genOnceVoucher(month, S.VOUCHER_KINDS.CARRY_VAT, '转出' + month + '未交增值税', [
      { code: '2221', name: S.subject('2221') ? S.subject('2221').name : '应交税费', summary: '转出未交增值税', dr: vat, cr: 0 },
      { code: vatTarget, name: vatTargetName, summary: '转出未交增值税', dr: 0, cr: vat }
    ]);
    if (!rr.ok) return showToast(rr.msg, 'error');
    showToast('已转出未交增值税：' + money(vat));
    refreshSettle(); syncAll();
  });
  onBtn('btnAccrueSurTax', function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    var est = S.profitStatement(month);
    var vat = Math.max(0, U.num(est.totalRevenue) - U.num(est.totalExpense)) * 0.13;
    var amt = vat * 0.12;
    if (amt < 0.005) return showToast('本期无附加税可计提', 'error');
    var rr = genOnceVoucher(month, S.VOUCHER_KINDS.ACCRUE_SURTAX, '计提' + month + '附加税', [
      { code: '6403', name: S.subject('6403') ? S.subject('6403').name : '税金及附加', summary: '计提附加税', dr: amt, cr: 0 },
      { code: '222109', name: '应交附加税', summary: '计提附加税', dr: 0, cr: amt }
    ]);
    if (!rr.ok) return showToast(rr.msg, 'error');
    showToast('已计提附加税：' + money(amt));
    refreshSettle(); syncAll();
  });
  onBtn('btnAccrueIncTax', function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    var est = S.profitStatement(month);
    var amt = Math.max(0, U.num(est.netProfit)) * 0.25;
    if (amt < 0.005) return showToast('本期无所得税可计提', 'error');
    var rr = genOnceVoucher(month, S.VOUCHER_KINDS.ACCRUE_INCTAX, '计提' + month + '所得税', [
      { code: '6801', name: S.subject('6801') ? S.subject('6801').name : '所得税费用', summary: '计提所得税', dr: amt, cr: 0 },
      { code: '222115', name: '应交所得税', summary: '计提所得税', dr: 0, cr: amt }
    ]);
    if (!rr.ok) return showToast(rr.msg, 'error');
    showToast('已计提所得税：' + money(amt));
    refreshSettle(); syncAll();
  });
  onBtn('btnReCarryForward', async function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    if (S.isPeriodClosed(month)) return showToast('该期已结账，请先反结账', 'error');
    // 按 v.kind 定位旧结转凭证（结构识别）：此前用摘要正则，对导入账套恒找不到，
    // 导致「重新结转」在导入账套上完全不可用（删不掉旧凭证，重做必被幂等拦截）。
    var old = S.periodVouchersOfKind(month, S.VOUCHER_KINDS.CARRY_PL);
    // 确认文案按状态区分：未结转=首次结转，已结转=重做（删除旧凭证重新生成）
    var cmsg = old.length
      ? '重新结转将删除本期已有的 ' + old.length + ' 张结转损益凭证并重新生成，确定继续？'
      : '将生成本期结转损益凭证（把收入/费用结转至本年利润），确定继续？';
    if (!(await H.confirmAsync(cmsg, { title: old.length ? '重新结转损益' : '结转损益' }))) return;
    // 重新结转：先删除本期已有的结转损益凭证，避免重复结转本年利润
    var delMsg = '';
    for (var i = 0; i < old.length; i++) {
      var dr = S.removeVoucher(old[i].id);
      if (!dr.ok) return showToast('删除旧结转凭证失败：' + dr.msg, 'error');
    }
    if (old.length) delMsg = '（已删除旧结转凭证 ' + old.length + ' 张）';
    var r = S.carryForwardProfit(month);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已重新结转损益：' + money(r.net) + delMsg, 'success');
    refreshSettle(); syncAll();
    if (window.__runSelfTestBanner) window.__runSelfTestBanner();
  });
  // 年末结转本年利润（3103 → 3104 未分配利润）：此前 S.carryYearEnd() 已实现但零调用（死代码），
  // 导致跨年时 3103 未清零、未分配利润失真。此处接入期末处理入口（仅 12 月可用）。
  onBtn('btnCarryYearEnd', async function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    if (String(month).substring(5, 7) !== '12') return showToast('仅 12 月需结转本年利润', 'error');
    if (S.isPeriodClosed(month)) return showToast('该期已结账，请先反结账', 'error');
    if (!(await H.confirmAsync('确认将本年利润余额结转至「利润分配-未分配利润」？\n结转后本年利润科目清零，跨年资产负债表未分配利润才准确。', { title: '结转本年利润' }))) return;
    var r = S.carryYearEnd(month);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已结转本年利润：' + money(Math.abs(r.bal || 0)), 'success');
    refreshSettle(); syncAll();
  });
  onBtn('btnClosePeriod', async function () {
    var month = selMonth;
    if (S.isPeriodClosed(month)) return showToast('该期已结账', 'error');
    var vs = S.periodVouchers(month);
    if (!vs.length) return showToast('该期无凭证，无法结账', 'error');
    // 结账前是否要求「凭证全部审核」由系统参数控制（单人场景默认不强制）
    var requireAudit = !!(S.state.param && S.state.param.checkBeforeSettle);
    if (requireAudit) {
      var unaudited = vs.filter(function (v) { return !v.status || v.status === 'draft'; });
      if (unaudited.length) return showToast('存在未审核凭证，请先审核（或到系统设置关闭「凭证审核后才允许结账」）', 'error');
    }
    if (!(await H.confirmAsync('确认结账 ' + month + '？\n结账后该期凭证将被锁定，如需修改须反结账。', { title: '期末结账' }))) return;
    var r = S.closePeriod(month);
    if (!r.ok) {
      if (r.warnOnly && r.warns && r.warns.length) {
        // store 对 warn 项（税金测算/折旧等「建议项」）要求 force 二次确认。
        // 此前 UI 未处理 warnOnly：r.msg 为空 → 显示空红条且无法结账（缺陷）。
        // 现展示 warn 明细并让用户选择是否强制结账。
        var wlist = r.warns.map(function (w) { return '· ' + (w.label || w.key || '') + (w.tip ? '：' + w.tip : ''); }).join('\n');
        if (!(await H.confirmAsync('本期存在以下提示项（不阻塞结账，建议先确认）：\n\n' + wlist + '\n\n仍要结账 ' + month + ' 吗？', { title: '结账提示确认' }))) return;
        var r2 = S.closePeriod(month, { force: true });
        if (!r2.ok) return showToast(r2.msg, 'error');
        r = r2;
      } else {
        return showToast(r.msg || '结账被拒绝，请检查提示后重试', 'error');
      }
    }
    showToast('结账成功：' + month);
    refreshSettle(); syncAll();
    if (window.__runSelfTestBanner) window.__runSelfTestBanner();
  });
  onBtn('btnReopenPeriod', async function () {
    // 修复：反结账 tab 有自己的月份导航（selReopenMonth），原代码误用 selMonth（结账 tab 选中期），
    // 会导致在反结账页选 3 月却反结账了结账 tab 选的月份（反错期间）。
    var month = selReopenMonth;
    if (!S.isPeriodClosed(month)) return showToast('该期未结账', 'error');
    // 预检：仅允许反结账最近一期（在用户输入原因前先告知约束，避免输入完才被拒）
    var closeds = (S.state.closedPeriods || []).slice().sort();
    if (closeds.length && month !== closeds[closeds.length - 1]) {
      return showToast('仅允许反结账最近一期（' + closeds[closeds.length - 1] + '）；如需反结账更早期间，请先逐期反结账至目标期', 'error');
    }
    // 审计留痕：反结账前必须填写原因（如"X 月凭证 5001 金额输错"），写入操作日志 reason 字段
    var reason = await H.promptAsync(
      '反结账是违反会计法规的非正常操作，会影响历史报表数据，请慎用！\n\n' +
      '请填写反结账原因（必填，将记入操作日志供事后审计）：',
      '',
      { title: '反结账 · ' + month }
    );
    if (reason === null || reason === undefined) return;
    if (!reason.trim()) return showToast('必须填写反结账原因，未填写则取消操作', 'error');
    if (!(await H.confirmAsync('确认反结账 ' + month + '？\n原因：' + reason.trim() + '\n\n此操作将解锁该期凭证，操作将记入审计日志。', { title: '反结账确认' }))) return;
    var r = S.reopenPeriod(month, reason.trim());
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已反结账：' + month + '（原因已记录）');
    refreshSettle(); syncAll();
  });
}
// 卡片 checkbox / 设置按钮（innerHTML 重建后需每次重绑）
function bindSettleCards() {
  // 注意：.settle-card-check 是 label 容器，change 事件与 checked 状态必须作用在内部 input 上
  document.querySelectorAll('.settle-card-check input').forEach(function (cb) {
    if (cb._bound) return;
    cb._bound = true;
    cb.addEventListener('change', function () {
      var card = cb.closest('.settle-card');
      if (!card) return;
      var id = cardTplId(card);
      if (!id) return;
      var tpl = settleTmplList.filter(function (t) { return t.id === id; })[0];
      if (tpl) { tpl.enabled = cb.checked; persistSettleTemplates(); }
    });
  });
  document.querySelectorAll('.settle-card').forEach(function (card) {
    var id = cardTplId(card);
    if (!id) return;
    card.querySelectorAll('.settle-link[data-act]').forEach(function (link) {
      var act = link.getAttribute('data-act');
      // 禁用/启用：链接文案随模板启用状态切换（每次 refresh 更新）
      if (act === 'disable') {
        var cur = findSettleTemplate(id);
        if (cur) link.textContent = cur.enabled ? '禁用' : '启用';
      }
      if (link._bound) return;
      link._bound = true;
      if (act === 'setting') {
        link.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          selectSettleTemplate(id);
          openSettleTemplateModal();
        });
      } else if (act === 'disable') {
        link.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var t = findSettleTemplate(id);
          if (!t) return;
          t.enabled = !t.enabled;
          persistSettleTemplates();
          refreshSettle();
        });
      } else if (act === 'delete') {
        link.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          var t = findSettleTemplate(id);
          if (!t) return;
          if (!t.custom) return showToast('系统模板不可删除', 'warn');
          if (!(await H.confirmAsync('确认删除自定义模板「' + t.name + '」？', { title: '删除模板' }))) return;
          settleTmplList = settleTmplList.filter(function (x) { return x !== t; });
          persistSettleTemplates();
          // 删除对应 DOM 卡片并重新渲染（自定义卡按 data-id 定位，系统卡无此属性不动）
          if (card.getAttribute('data-custom')) card.remove();
          refreshSettle();
        });
      }
    });
  });
}

// 动态渲染自定义模板卡片：插入到 #settleProcessCards 中（结转损益之后），
// 启用时显示、禁用时隐藏；每个卡片带 checkbox + 设置/禁用/删除 链接，与系统卡一致。
function renderCustomCards(procList, profitCard) {
  if (!procList) return;
  // 先移除上一次渲染的自定义卡片（避免重复叠加）
  procList.querySelectorAll('.settle-card[data-custom]').forEach(function (el) { el.remove(); });
  var customs = settleTmplList.filter(function (t) { return t.custom; });
  customs.forEach(function (t) {
    var enabled = t.enabled !== false;
    var card = document.createElement('div');
    card.className = 'settle-card' + (enabled ? ' settle-card-checked' : '');
    card.setAttribute('data-custom', '1');
    card.setAttribute('data-id', t.id);
    card.innerHTML =
      '<div class="settle-card-head">' +
        '<label class="settle-card-check"><input type="checkbox"' + (enabled ? ' checked' : '') + ' /></label>' +
        '<span class="settle-card-name">' + esc(t.name) + '</span>' +
        '<i class="settle-card-help" title="' + esc(t.summary || t.name) + '">?</i>' +
      '</div>' +
      '<div class="settle-card-body"><div class="settle-card-sub">' + esc(t.summary || t.name) + '</div></div>' +
      '<div class="settle-card-foot">' +
        '<span class="settle-vch"></span>' +
        '<a class="settle-link settle-link-inline" data-act="setting" href="javascript:;">设置</a>' +
        '<a class="settle-link settle-link-inline" data-act="disable" href="javascript:;">' + (enabled ? '禁用' : '启用') + '</a>' +
        '<a class="settle-link settle-link-inline link-del" data-act="delete" href="javascript:;">删除</a>' +
      '</div>';
    // 紧跟结转损益卡片之后插入（保持利润第一、自定义卡依次排列）
    if (profitCard && profitCard.nextSibling) procList.insertBefore(card, profitCard.nextSibling);
    else procList.appendChild(card);
  });
  bindSettleCards();
}

function refreshSettle() {
  // 模板启用状态以 store 为权威（结账检查清单数据源），进入页面/切换账套时同步
  syncTplEnabledFromStore();
  // 绑定结账页交互（幂等，卡片每次重绑）
  bindSettleEvents();
  bindSettleCards();
  // 渲染结账 tab 月份方块导航（让用户可以选期；此前遗漏调用导致无法切换月份）
  renderSettleMonthNav();
  // 结账面板支持跨期结账：月份方块导航选期（selMonth）
  if (!S.isPeriodClosed(selMonth) && !S.periodVouchers(selMonth).length && selMonth !== currentPeriod()) {
    // 选中的月无任何凭证且非当前期，自动回退到当前期，避免空期间
    selMonth = currentPeriod();
  }
  var month = selMonth;
  // 期末处理（结转损益/折旧/调汇/税费等）与结账统一跟随「结账 tab 选期 selMonth」，
  // 避免用户选历史期却对当前期误操作。store 侧各方法均有 isPeriodClosed 拦截，对已结账历史期安全。
  var curMonth = month;
  var closed = S.isPeriodClosed(month);
  // 结账面板数据源（按所选期）
  var vs = S.periodVouchers(month);
  var unaudited = vs.filter(function (v) { return !v.status || v.status === 'draft'; });
  var est = S.profitStatement(month);
  // 期末处理凭证识别：一律按 v.kind（结构识别），不再按摘要正则。
  // 背景：  / Excel 导入的凭证没有凭证级 summary 字段（摘要只落在分录级），
  // 摘要正则对导入凭证恒不命中，导致页面恒显示「未生成 / 待结转」、生成查重形同虚设。
  var K = S.VOUCHER_KINDS;
  function kindVs(list, kind) {
    return list.filter(function (v) { return S.voucherKind(v) === kind; });
  }
  function doneCount(kind) { return kindVs(vs, kind).length; }
  function firstVoucherNo(kind) {
    var v = kindVs(vs, kind)[0];
    return v ? (v.word || '记') + '-' + v.no : '';
  }
  // 期末处理区块数据源（固定当前期）
  var curVs = S.periodVouchers(curMonth);
  var curEst = S.profitStatement(curMonth);
  function curDoneCount(kind) { return kindVs(curVs, kind).length; }
  function curFirstVoucherNo(kind) {
    var v = kindVs(curVs, kind)[0];
    return v ? (v.word || '记') + '-' + v.no : '';
  }

  // 期末处理卡片：checkbox 绑定模板启用状态（每张卡的启用开关）
  var cardTplMap = {
    cardDepr: 'dep', cardCost: 'cost',
    cardVat: 'vat', cardSurTax: 'surTax', cardIncTax: 'incTax', cardProfit: 'profit'
  };
  Object.keys(cardTplMap).forEach(function (cid) {
    var card = $(cid);
    if (!card) return;
    var enabled = S.settleTplEnabled(cardTplMap[cid]);
    var cb = card.querySelector('.settle-card-check input');
    if (cb) { cb.checked = !!enabled; cb.disabled = false; }
    // 默认只显示结转损益，其余模板禁用时自动隐藏卡片（逻辑：设置入口可启用）
    card.style.display = enabled ? '' : 'none';
  });
  // 保证顺序：结转损益永远在模板列表第一个，启用的卡片按固定 DOM 顺序连续排列
  var procList = $('settleProcessCards');
  var profitCard = $('cardProfit');
  if (procList && profitCard && procList.firstElementChild !== profitCard) {
    procList.insertBefore(profitCard, procList.firstElementChild);
  }
  // 动态渲染自定义模板卡片（新增后能在期末处理页显示，并支持删除）
  renderCustomCards(procList, profitCard);
  var rv = $('reopenYearVal');
  if (rv) rv.textContent = selReopenMonth.slice(0, 4) + '年';
  // 期末处理 tab：检查项列表（结账页 7 项）
  var cl = $('closeChecklist');
  if (cl) {
    var rows = [
      { k: 'dep', name: '计提折旧', kind: K.DEPR, hint: '固定资产折旧凭证' },
      { k: 'cost', name: '结转销售成本', kind: K.CARRY_COST, hint: '销售成本结转' },
      { k: 'vat', name: '转出未交增值税', kind: K.CARRY_VAT, hint: '增值税转出' },
      { k: 'surTax', name: '计提附加税', kind: K.ACCRUE_SURTAX, hint: '城建/教育费附加' },
      { k: 'incTax', name: '计提所得税', kind: K.ACCRUE_INCTAX, hint: '企业所得税' },
      { k: 'profit', name: '结转损益', kind: K.CARRY_PL, hint: '损益类科目结转' }
    ];
    var html = '';
    rows.forEach(function (r) {
      var cnt = curDoneCount(r.kind);
      var done = cnt > 0;
      html += '<div class="settle-check-item' + (done ? ' done' : '') + '" data-k="' + r.k + '">' +
        '<span class="sci-dot">' + (done ? '✓' : '') + '</span>' +
        '<span class="sci-name">' + r.name + '</span>' +
        '<span class="sci-info">' + (done ? ('已生成 ' + cnt + ' 张') : r.hint) + '</span>' +
        '</div>';
    });
    // 追加 store 的「结账硬性条件」检查项（凭证已审核/借贷平衡/幽灵科目/损益结转等）。
    // 修复：closePeriod 内部本就会调 S.settleChecklist() 并拦截 fail 项，但 UI 从未展示这些项，
    // 用户只能点了结账才被拦、还看不到原因。此处仅展示 fail/warn 项（ok 项不占位，避免刷屏）。
    try {
      var hard = (typeof S.settleChecklist === 'function') ? S.settleChecklist(month) : [];
      hard.forEach(function (c) {
        if (c.status !== 'fail' && c.status !== 'warn') return; // 仅展示需关注项
        html += '<div class="settle-check-item' + (c.status === 'fail' ? ' settle-check-fail' : ' settle-check-warn') + '" data-k="' + c.key + '">' +
          '<span class="sci-dot">' + (c.status === 'fail' ? '✕' : '!') + '</span>' +
          '<span class="sci-name">' + (c.label || '') + '</span>' +
          '<span class="sci-info">' + (c.tip || '') + '</span>' +
          '</div>';
      });
    } catch (e) { /* 检查项渲染失败不阻断页面 */ }
    cl.innerHTML = html;
  }
  // 期末处理区块：凭证字号显示（已生成的首张凭证号）
  var filler = function (id, kind) {
    var el = $(id);
    if (el) el.textContent = firstVoucherNo(kind);
  };
  filler('depVoucherNo', K.DEPR);
  filler('costVoucherNo', K.CARRY_COST);
  filler('vatVoucherNo', K.CARRY_VAT);
  filler('surTaxVoucherNo', K.ACCRUE_SURTAX);
  filler('incTaxVoucherNo', K.ACCRUE_INCTAX);
  filler('profitVoucherNo', K.CARRY_PL);
  // 结转损益：已结转 / 未结转 统计（真实值，避免恒显 0.00）
  // 应结转额 = 本期利润表净利润（收入-费用）；已结转额 = 已生成结转损益凭证的净额
  var profitDoneEl = $('profitDone'), profitTodoEl = $('profitTodo');
  if (profitDoneEl && profitTodoEl) {
    var netProfit = U.num(curEst.netProfit) || 0; // 正数=盈利
    var carryVch = kindVs(curVs, K.CARRY_PL);
    var carried = 0;
    carryVch.forEach(function (v) {
      v.entries.forEach(function (e) {
        // 本年利润科目（3103）的流入 = 已结转额
        if (String(e.code) === '3103') {
          if (e.dr) carried += U.num(e.dr);
          if (e.cr) carried += U.num(e.cr);
        }
      });
    });
    carried = round2(carried);
    var todo = round2(Math.abs(netProfit) - carried);
    profitDoneEl.textContent = money(carried);
    profitTodoEl.textContent = (todo < 0 ? '0.00' : money(todo));
    var card = $('cardProfit');
    if (card) {
      card.classList.toggle('settle-card-done', Math.abs(todo) < 0.005 && Math.abs(netProfit) > 0.005);
      card.classList.toggle('settle-card-nothing', Math.abs(netProfit) < 0.005);
    }
  }
  // ===== 结账面板（所选期 month） =====
  var btnClose = $('btnClosePeriod');
  if (btnClose) {
    // 与 btnClosePeriod 同一口径：仅当开启「凭证审核后才允许结账」时才要求本期全部审核
    var reqAuditForClose = !!(S.state.param && S.state.param.checkBeforeSettle);
    var canClose = !closed && vs.length > 0 && (!reqAuditForClose || !unaudited.length);
    btnClose.disabled = !canClose;
    btnClose.textContent = closed ? ('已结账 · ' + month) : '检查并结账';
  }
  // 期末处理 / 反结账 区域（固定当前期 curMonth）
  var curClosed = S.isPeriodClosed(curMonth);

  // 反结账页：已结账月列表
  renderReopenMonthNav();

  // 反结账按钮跟随「反结账页导航所选月」(selReopenMonth)，而非结账面板选期 month——
  // 此前绑到结账面板导致切到反结账 tab 却显示结账 tab 选期的状态（如「未结账」禁用）。
  var btnReopen = $('btnReopenPeriod');
  if (btnReopen) {
    var reopenClosed = S.isPeriodClosed(selReopenMonth);
    btnReopen.disabled = !reopenClosed;
    btnReopen.textContent = reopenClosed ? '反结账' : '未结账';
    btnReopen.title = selReopenMonth + (reopenClosed ? '（已结账，可反结账）' : '（未结账，无需反结账）');
  }

  // 结转损益按钮文案随状态切换：未结转→「结转损益」，已结转且未锁→「重新结转」，已结账→禁用「已结转」
  // （此前固定「重新结转」，未结转月点它会先弹「删除 0 张旧凭证再生成」，语义误导）
  var rcb = $('btnReCarryForward');
  if (rcb) {
    rcb.disabled = closed;
    if (closed) rcb.textContent = '已结转';
    else rcb.textContent = (kindVs(curVs, K.CARRY_PL).length > 0) ? '重新结转' : '结转损益';
  }

  // 「结转本年利润」仅在 12 月显示（年末结转 3103 → 3104，跨年未分配利润才准确）
  var cye = $('btnCarryYearEnd');
  if (cye) {
    var isDec = String(curMonth || '').substring(5, 7) === '12';
    cye.style.display = isDec ? '' : 'none';
    cye.disabled = closed;
  }

  // 增值税编辑入口
  var btnVatew = $('btnVatew');
  if (btnVatew && !btnVatew._bound) {
    btnVatew._bound = true;
    btnVatew.addEventListener('click', openVatEditModal);
  }
}

// 增值税编辑弹窗（结账页 转出未交增值税 凭证设置）
function openVatEditModal() {
  var month = currentPeriod();
  currentVat = S.vatEditGet(month);
  renderVatEdit();
  openModal('vatEditModal');
}
function closeVatEditModal() { closeModal('vatEditModal'); }
function renderVatEdit() {
  var b = $('vatEditBody');
  if (!b) return;
  var rows = currentVat.entries;
  var html = '';
  rows.forEach(function (e, idx) {
    html += '<div class="vat-edit-row" data-idx="' + idx + '">' +
      '<input class="vet-code" type="text" value="' + (e.code || '') + '" placeholder="科目编码">' +
      '<input class="vet-name" type="text" value="' + (e.name || '') + '" placeholder="科目名称">' +
      '<span class="vet-arrow">→</span>' +
      '<input class="vet-target" type="text" value="' + (e.target || '') + '" placeholder="目标科目">' +
      '<button class="vet-del" data-idx="' + idx + '">删除</button>' +
      '</div>';
  });
  b.innerHTML = html;
  b.querySelectorAll('.vet-del').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var i = +this.getAttribute('data-idx');
      currentVat.entries.splice(i, 1);
      renderVatEdit();
    });
  });
  b.querySelectorAll('.vet-code,.vet-name,.vet-target').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var i = +this.closest('.vat-edit-row').getAttribute('data-idx');
      var cls = this.className.indexOf('vet-code') >= 0 ? 'code'
        : this.className.indexOf('vet-name') >= 0 ? 'name' : 'target';
      currentVat.entries[i][cls] = this.value;
    });
  });
}
var currentVat = { entries: [] };
if ($('btnVatEditAdd')) $('btnVatEditAdd').addEventListener('click', function () {
  currentVat.entries.push({ code: '', name: '', target: '' });
  renderVatEdit();
});
if ($('btnVatEditSave')) $('btnVatEditSave').addEventListener('click', function () {
  S.vatEditSet(currentPeriod(), currentVat);
  showToast('增值税凭证设置已保存');
  closeVatEditModal();
  refreshSettle();
});
if ($('btnVatEditClose')) $('btnVatEditClose').addEventListener('click', closeVatEditModal);
if ($('btnVatEditClose2')) $('btnVatEditClose2').addEventListener('click', closeVatEditModal);

// 结账 tab 月份方块导航渲染（已结账月 / 当前期 / 未结账月 三种状态）
function renderSettleMonthNav() {
  var nav = $('settleMonthNav');
  if (!nav) return;
  var yr = selMonth.slice(0, 4);
  var yv = $('settleYearVal');
  if (yv) yv.textContent = yr + '年';
  var html = '';
  for (var i = 1; i <= 12; i++) {
    var mm = (i < 10 ? '0' + i : '' + i);
    var per = yr + '-' + mm;
    var closed = S.isPeriodClosed(per);
    var isCur = per === currentPeriod();
    var cls = 'settle-month';
    if (closed) cls += ' checked';
    if (isCur) cls += ' current';
    if (per === selMonth) cls += ' select';
    html += '<div class="' + cls + '" data-per="' + per + '">'
      + '<div class="settle-month-head">' + i + '月</div>'
      + '<div class="settle-month-body">'
      + '<span class="settle-month-num">' + i + '</span>'
      + (closed ? '<span class="settle-month-gou">✓</span>' : '')
      + (closed ? '<span class="settle-month-tag">已结账</span>' : (isCur ? '<span class="settle-month-tag cur">当前期</span>' : ''))
      + '</div></div>';
  }
  // 菜单区包进滚动容器（.sidebarMenuWrapper--1lMd-：flex:1; over  }
  // 直接渲染月份方块网格（结账页月份导航，仅含 12 个月方块，不混入全局侧栏结构）
  nav.innerHTML = html;
  // 绑定点击：选中期，刷新结账面板
  Array.prototype.forEach.call(nav.querySelectorAll('.settle-month'), function (el) {
    el.addEventListener('click', function () {
      selMonth = el.getAttribute('data-per');
      refreshSettle();
    });
  });
}

// 反结账 tab 月份方块导航渲染（已结账月可点选反结账，未结账月置灰）
function renderReopenMonthNav() {
  var nav = $('reopenMonthNav');
  if (!nav) return;
  var yr = selReopenMonth.slice(0, 4);
  var yv = $('reopenYearVal');
  if (yv) yv.textContent = yr + '年';
  var html = '';
  for (var i = 1; i <= 12; i++) {
    var mm = (i < 10 ? '0' + i : '' + i);
    var per = yr + '-' + mm;
    var closed = S.isPeriodClosed(per);
    var disabled = !closed; // 仅已结账期间可反结账
    var cls = 'settle-month';
    if (closed) cls += ' checked';
    if (disabled) cls += ' disabled';
    if (per === selReopenMonth) cls += ' select';
    html += '<div class="' + cls + '" data-per="' + per + '"' + (disabled ? ' data-disabled="1"' : '') + '>'
      + '<div class="settle-month-head">' + i + '月</div>'
      + '<div class="settle-month-body">'
      + '<span class="settle-month-num">' + i + '</span>'
      + (closed ? '<span class="settle-month-gou">✓</span>' : '')
      + (closed ? '<span class="settle-month-tag">已结账</span>' : '')
      + '</div></div>';
  }
  // 菜单区包进滚动容器（.sidebarMenuWrapper--1lMd-：flex:1; over  }
  // 直接渲染月份方块网格（反结账页月份导航，仅含 12 个月方块，未结账月置灰不可点）
  nav.innerHTML = html;
  Array.prototype.forEach.call(nav.querySelectorAll('.settle-month'), function (el) {
    if (el.getAttribute('data-disabled')) return; // 未结账月不可点
    el.addEventListener('click', function () {
      selReopenMonth = el.getAttribute('data-per');
      refreshSettle();
    });
  });
}

// 通用：生成单张 demo 凭证（期末处理生成凭证后强制立即备份，防丢失/可回滚）
// kind：期末业务类型标记（S.VOUCHER_KINDS），写入 v.kind 供后续查重/结账检查识别。
function makeSimpleVoucher(month, summary, entries, kind) {
  var v = S.addVoucher({ word: '转', date: U.lastDay(month), attach: 0, summary: summary, kind: kind, entries: entries });
  if (v && S.backupNow) S.backupNow();
  return v;
}

// 期末处理「生成凭证」统一查重入口（财务大忌：重复点击生成多张同额凭证）。
// 此前 结转成本/转出增值税/计提附加税/计提所得税 四个按钮直接 makeSimpleVoucher，无查重，
// 连点 N 次会生成 N 张同额凭证，虚增费用与负债。此处统一拦截：
// 本期已存在同类凭证则拒绝，须先删除旧凭证再重做。
// 查重按 v.kind（结构识别）而非摘要正则——导入凭证无 summary，摘要匹配恒不命中。
// 返回 { ok, v } 或 { ok:false, msg }
function genOnceVoucher(month, kind, summary, entries) {
  // 已结账期间禁止再生成凭证（否则会向已锁定期间写入，破坏账务一致性）。
  // 对齐同文件其它期末处理按钮（结转损益/反结账）已有的 isPeriodClosed 拦截。
  if (S.isPeriodClosed(month)) return { ok: false, msg: '该期已结账，请先反结账再操作', month: month };
  var existed = S.periodVouchersOfKind(month, kind);
  if (existed.length) {
    return { ok: false, msg: '本期已生成 ' + existed.length + ' 张同类凭证（' + (existed[0].word || '转') + '-' + existed[0].no + '），请勿重复生成；如需重做请先删除旧凭证', vouchers: existed };
  }
  var v = makeSimpleVoucher(month, summary, entries, kind);
  // 修复：原实现忽略 addVoucher 返回，写盘被拒（借贷不平衡等）时仍提示成功。
  if (!v || v.ok === false) return { ok: false, msg: (v && v.msg) || '凭证生成失败，请稍后重试' };
  return { ok: true, v: v };
}

// 计提附加税「查看金额计算逻辑」浮层（结账页 计提附加税 链接浮层）
function renderSurTaxCalc() {
  var month = currentPeriod();
  // 增值税：取「应交税费_未交增值税」222102 本期贷方发生额（正数）
  var unpayVat = S.subjectPeriod('222102', month);
  var vat = Math.max(0, unpayVat ? U.num(unpayVat.periodCr) : 0);
  // 消费税：取「应交税费_应交消费税」222121 本期贷方发生额
  var consumeSubj = S.subjectPeriod('222121', month);
  var consumeTax = consumeSubj ? Math.max(0, U.num(consumeSubj.periodCr)) : 0;
  var base = round2(vat + consumeTax); // 合计值(正数)
  // 减免比例统一为 0%
  var items = [
    { drSubj: '税金及附加_教育费附加', crSubj: '应交税费_教育费附加', rate: 0.03 },
    { drSubj: '税金及附加_城市维护建设税', crSubj: '应交税费_应交城市维护建设税', rate: 0.07 },
    { drSubj: '税金及附加_地方教育费附加', crSubj: '应交税费_地方教育费附加', rate: 0.02 }
  ];
  function lineDrCr(drSubj, crSubj, rate) {
    var amt = base * rate * (1 - 0);
    var f = money(base) + ' * ' + (rate * 100) + '% * (1 - 0%) = ' + money(amt);
    return '<div class="line--1izHk"><p>借：' + drSubj + '</p><p class="p--2Q6HZ">' + f + '</p></div>' +
           '<div class="line--1izHk"><p>贷：' + crSubj + '</p><p class="p--2Q6HZ">' + f + '</p></div>';
  }
  var html =
    '<div class="header--1z_e8">计税基础：</div>' +
    '<div class="list--Gy482">' +
      '<div class="line--1izHk"><p>增值税：应交税费_未交增值税【本期贷方发生额(正数)】</p><p class="p--2Q6HZ">' + money(vat) + '</p></div>' +
      '<div class="line--1izHk"><p>消费税：通常取数科目为“应交税费_应交消费税”的本期贷方发生额</p><p class="p--2Q6HZ">' + money(consumeTax) + '</p></div>' +
      '<div class="line--1izHk"><p></p><p class="p--2Q6HZ">合计值(正数)：' + money(base) + '</p></div>' +
    '</div>' +
    '<div class="header--1z_e8">凭证分录：</div>' +
    '<div class="list--Gy482">' +
      lineDrCr('税金及附加_教育费附加', '应交税费_教育费附加', 0.03) +
      lineDrCr('税金及附加_城市维护建设税', '应交税费_应交城市维护建设税', 0.07) +
      lineDrCr('税金及附加_地方教育费附加', '应交税费_地方教育费附加', 0.02) +
    '</div>';
  var body = $('surTaxCalcBody');
  if (body) body.innerHTML = html;
  openModal('surTaxCalcModal');
}
if ($('surTaxCalc')) $('surTaxCalc').addEventListener('click', renderSurTaxCalc);
if ($('btnSurTaxCalcClose')) $('btnSurTaxCalcClose').addEventListener('click', function () { closeModal('surTaxCalcModal'); });

// 计提所得税「查看金额计算逻辑」浮层（结账页 计提所得税 链接浮层）
function renderIncTaxCalc() {
  var month = currentPeriod();
  var est = S.profitStatement(month);
  var profit = U.num(est.totalRevenue) - U.num(est.totalExpense); // 利润总额
  var nonTaxable = 0; // 不征税收入和免税收入（本账套无取数科目）
  var priorLoss = 0; // 弥补以前年度亏损
  var taxable = Math.max(0, profit - nonTaxable - priorLoss); // 应纳税所得额
  var rate = 0.25; // 固定税率 25%
  var ytdTax = taxable * rate; // 本年累计应纳所得税额
  var paidTax = 0; // 本年实际已缴纳所得税额
  var prepayTax = 0; // 特定业务预缴所得税额
  var dueTax = Math.max(0, ytdTax - paidTax - prepayTax); // 本期应补(退)税额

  function f(v) { return money(v); }
  function row(label, value, formula) {
    return '<div class="it-row"><span class="it-label">' + label + '</span>' +
      '<div class="it-right"><span class="it-val">' + value + '</span>' +
      (formula ? '<span class="it-formula">' + formula + '</span>' : '') + '</div></div>';
  }
  function subRow(label, value, hint) {
    return '<div class="it-row it-sub"><span class="it-label">' + label + '</span>' +
      '<div class="it-right"><span class="it-val it-placeholder">' + (value || (hint || '')) + '</span></div></div>';
  }

  var html =
    '<div class="it-header"><span class="it-rate-label">税率：</span>' +
      '<label class="it-radio"><input type="radio" name="incTaxRateType" disabled> 按小微企业标准</label>' +
      '<label class="it-radio checked"><input type="radio" name="incTaxRateType" disabled checked> 按固定税率：</label>' +
      '<input class="it-rate-input" type="text" value="' + (rate * 100) + '" readonly> %</div>' +
    '<div class="it-summary"><span class="it-summary-label">本期应计提所得税额：</span><span class="it-summary-val">' + f(dueTax) + '</span>' +
      '<span class="it-summary-hint">取自本期应补（退）税额</span></div>' +
    '<div class="it-section-title">计算逻辑</div>' +
    '<div class="it-body">' +
      row('利润总额 <i class="it-help" title="利润表 收入-费用">②</i>', f(profit), '') +
      subRow('减：不征税收入和免税收入：', '', '请选择科目') +
      subRow('减：弥补以前年度亏损：', f(priorLoss)) +
      row('应纳税所得额 <i class="it-help" title="利润总额 - 不征税收入 - 弥补以前年度亏损">②</i>', f(taxable),
        f(profit) + ' - ' + f(nonTaxable) + ' - ' + f(priorLoss) + ' = ' + f(taxable)) +
      row('本年累计应纳所得税额 <i class="it-help" title="应纳税所得额 × 税率">②</i>', f(ytdTax),
        f(taxable) + ' * ' + (rate * 100) + '% = ' + f(ytdTax)) +
      subRow('减：本年实际已缴纳所得税额 <i class="it-help" title="">②</i>', '') +
      subRow('减：特定业务预缴（征）所得税额：', '', '企税申报表未取数，请确认申报表数据或手工填写') +
      row('本期应补（退）税额 <i class="it-help" title="本年累计应纳所得税额 - 已缴 - 预缴">②</i>', f(dueTax),
        f(ytdTax) + ' - ' + f(paidTax) + ' - ' + f(prepayTax) + ' = ' + f(dueTax)) +
    '</div>';

  var body = $('incTaxCalcBody');
  if (body) body.innerHTML = html;
  openModal('incTaxCalcModal');
}
if ($('incTaxCalc')) $('incTaxCalc').addEventListener('click', renderIncTaxCalc);
if ($('btnIncTaxCalcClose')) $('btnIncTaxCalcClose').addEventListener('click', function () { closeModal('incTaxCalcModal'); });
if ($('btnIncTaxCalcClose2')) $('btnIncTaxCalcClose2').addEventListener('click', function () { closeModal('incTaxCalcModal'); });

// 注：原「出纳结账」整套功能已随出纳板块整体移除（产品定位为纯账务复式记账），
// 相关 DOM（page-cashier-settle）与 store 出纳方法已同步清理。

/* ============================================================
 * 结账模板（结账设置：凭证模板 7 项 + 启用开关）
 * ============================================================ */
var SETTLE_TMPL_KEY = 'settle_templates_v1';

function defaultSettleTemplates() {
  // 默认只启用「结转损益」，其余模板默认禁用（禁用后卡片自动隐藏，可在设置入口启用）
  return [
    { id: 'dep', name: '计提折旧', enabled: false, summary: '计提本月固定资产折旧', template: [], hasEntries: false },
    { id: 'cost', name: '结转销售成本', enabled: false, summary: '按收入比例结转销售成本', template: [], hasEntries: false, costRate: '80', costAmount: '' },
    { id: 'vat', name: '转出未交增值税', enabled: false, summary: '结转未交增值税', template: [], hasEntries: false },
    { id: 'surTax', name: '计提附加税', enabled: false, summary: '计提城建/教育费附加', template: [], hasEntries: false },
    { id: 'incTax', name: '计提所得税', enabled: false, summary: '计提企业所得税', template: [], hasEntries: false },
    { id: 'profit', name: '结转损益', enabled: true, summary: '结转损益类科目至本年利润', template: [], hasEntries: false }
  ];
}

// 模板启用状态以 store（S.state.settleTemplates）为唯一权威：
// 结账检查清单（store.settleChecklist）按它判断、卡片 checkbox 显示也按它，两处从此一致。
function syncTplEnabledFromStore() {
  if (!S || !S.settleTplEnabled || !settleTmplList) return;
  settleTmplList.forEach(function (t) { t.enabled = !!S.settleTplEnabled(t.id); });
}
// 把当前启用状态写回 store（随账套持久化，供结账检查清单读取）
function syncTplEnabledToStore() {
  if (!S || !S.state) return;
  // 过滤已下线的期末调汇（fx）残留记录，避免写入账套后继续占用状态
  var arr = Array.isArray(S.state.settleTemplates) ? S.state.settleTemplates.slice() : [];
  arr = arr.filter(function (t) { return t && t.id !== 'fx'; });
  settleTmplList.forEach(function (t) {
    var hit = null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === t.id) { hit = arr[i]; break; }
    }
    if (hit) hit.enabled = !!t.enabled;
    else arr.push({ id: t.id, enabled: !!t.enabled });
  });
  S.state.settleTemplates = arr;
  if (S.persist) S.persist();
}

// 加载模板配置：优先合并本地已保存配置（摘要/凭证字/汇率/分录），enabled 以 store 为准
function loadSettleTemplates() {
  var list = defaultSettleTemplates();
  try {
    var saved = JSON.parse(localStorage.getItem(SETTLE_TMPL_KEY) || 'null');
    if (saved && Array.isArray(saved) && saved.length) {
      var byId = {};
      list.forEach(function (t) { byId[t.id] = t; });
      saved.forEach(function (s) {
        if (!s || !s.id) return;
        // 已下线的期末调汇（fx）模板历史残留一律丢弃，避免复活
        if (s.id === 'fx') return;
        if (byId[s.id]) {
          // 合并业务配置（摘要/凭证字/分录等），但 enabled 以默认/store 为准，不读本地旧值
          var keepEnabled = byId[s.id].enabled;
          Object.assign(byId[s.id], s);
          byId[s.id].enabled = keepEnabled;
        } else { byId[s.id] = s; list.push(s); }
      });
    }
  } catch (e) {}
  return list;
}
var settleTmplList = loadSettleTemplates();
// 首次同步：模板启用状态以 store 为权威（与结账检查清单一致）
syncTplEnabledFromStore();
var settleTmplSelectedId = 'profit';

function getSettleTemplates() { return settleTmplList; }
function persistSettleTemplates() {
  try { localStorage.setItem(SETTLE_TMPL_KEY, JSON.stringify(settleTmplList)); } catch (e) {}
  syncTplEnabledToStore();
}

// 期末处理卡片 checkbox 与模板启用状态联动
function applySettleTemplateStates() {
  var map = { cardDepr: 'dep', cardCost: 'cost', cardVat: 'vat', cardSurTax: 'surTax', cardIncTax: 'incTax', cardProfit: 'profit' };
  Object.keys(map).forEach(function (cid) {
    var card = $(cid);
    if (!card) return;
    var tpl = settleTmplList.filter(function (t) { return t.id === map[cid]; })[0];
    var enabled = tpl ? tpl.enabled : true;
    var cb = card.querySelector('.settle-card-check input');
    if (cb) { cb.checked = !!enabled; cb.disabled = false; }
    card.classList.toggle('settle-card-disabled', !enabled);
  });
}

// 结账模板弹窗（对账结设置）
function openSettleTemplateModal() { renderSettleTmplList(); openModal('settleTmplModal'); }
function closeSettleTemplateModal() { closeModal('settleTmplModal'); }

function findSettleTemplate(id) {
  return settleTmplList.filter(function (t) { return t.id === id; })[0];
}

// 模板面板：左侧列表（启用 / 禁用两个分组，对接 HTML settleTmplEnabled / settleTmplDisabled）
function renderSettleTmplTree() {
  var enUl = $('settleTmplEnabled'), disUl = $('settleTmplDisabled');
  if (!enUl && !disUl) return;
  var enHtml = '', disHtml = '';
  settleTmplList.forEach(function (t) {
    var cls = 'stm-item' + (t.id === settleTmplSelectedId ? ' select' : '') + (t.custom ? ' stm-custom' : '');
    var li = '<li class="' + cls + '" data-id="' + t.id + '">' +
      '<span class="stm-check">' + (t.enabled ? '✓' : '') + '</span>' +
      '<span class="stm-name">' + t.name + '</span></li>';
    if (t.enabled) enHtml += li; else disHtml += li;
  });
  if (enUl) {
    enUl.innerHTML = enHtml || '<li class="stm-empty">暂无启用的模板</li>';
    bindTmplTreeItems(enUl);
  }
  if (disUl) {
    disUl.innerHTML = disHtml || '<li class="stm-empty">暂无禁用的模板</li>';
    bindTmplTreeItems(disUl);
  }
}

function bindTmplTreeItems(ul) {
  ul.querySelectorAll('.stm-item').forEach(function (el) {
    el.addEventListener('click', function () {
      var id = el.getAttribute('data-id');
      selectSettleTemplate(id);
    });
  });
}

function selectSettleTemplate(id) {
  settleTmplSelectedId = id;
  var t = findSettleTemplate(id);
  // 切换右侧面板：系统/已有模板走表单面板，新增自定义走 newPanel
  var formPanel = $('settleTmplFormPanel');
  var newPanel = $('settleTmplNewPanel');
  if (newPanel) newPanel.style.display = 'none';
  if (formPanel) formPanel.style.display = '';
  renderSettleTmplTree();
  fillSettleTmplForm(t);
}

// 特殊模板字段填充（期末调汇 / 结转销售成本）
// 结账模板科目选择：统一用共享组件 SubjectCombo（输入框+联想）。
// 此前是硬编码 8 个损益科目的下拉，科目表改了就不同步；现改为从 S.subjects() 取全部科目，
// 并支持联想输入（对齐参考实现）。首次绑定一次（dataset 守卫），之后只回填 value。
function fillCostSubjSelect(selId, selected) {
  var sel = $(selId);
  if (!sel) return;
  if (!sel.dataset.comboBound) {
    sel.dataset.comboBound = '1';
    bindSubjectCombo(sel);
  }
  sel.value = selected || '';
}

function updateCostEstimate() {
  var out = $('settleTmplCostRevAmt');
  if (!out) return;
  var month = currentPeriod();
  var tpl = findSettleTemplate('cost') || {};
  var est = S.costVoucherEstimate ? S.costVoucherEstimate(month, tpl) : { amount: 0, revenue: 0 };
  out.textContent = '本期金额：' + money(est.revenue || 0);
  var invBal = $('settleTmplCostInvBal');
  if (invBal) invBal.textContent = '余额：' + money(est.amount || 0);
}

// 右侧表单面板填充（对接 HTML settleTmplForm* / settleTmplFx* / settleTmplCost*）
function fillSettleTmplForm(t) {
  var formPanel = $('settleTmplFormPanel');
  if (!formPanel || !t) return;
  setText('settleTmplFormName', t.name);
  setText('settleTmplFormTag', t.custom ? '自定义' : '系统');
  // 删除按钮仅自定义模板可见（系统模板不可删）
  var delBtn = $('btnSettleTmplDelete');
  if (delBtn) delBtn.style.display = t.custom ? '' : 'none';
  var en = $('settleTmplFormEnabled'); if (en) en.checked = !!t.enabled;
  var dt = $('settleTmplFormDate'); if (dt) dt.value = t.date || currentPeriod();
  var wd = $('settleTmplFormWord'); if (wd) { if (!wd.options.length) fillWordOptions(wd); wd.value = t.word || ''; }
  var sm = $('settleTmplFormSummary'); if (sm) sm.value = t.summary || '';

  // 结转销售成本专属
  var costExtra = $('settleTmplCostExtra');
  if (costExtra) costExtra.style.display = (t.id === 'cost') ? '' : 'none';
  if (t.id === 'cost') {
    fillCostSubjSelect('settleTmplCostRevSubj', t.costRevSubj || '5001');
    fillCostSubjSelect('settleTmplCostInvSubj', t.costInvSubj || '1405');
    fillCostSubjSelect('settleTmplCostProdSubj', t.costProdSubj || '5001');
    var rate = $('settleTmplCostRate'); if (rate) rate.value = t.costRate || '80';
    var amt = $('settleTmplCostAmt'); if (amt) amt.value = t.costAmount || '';
    var csm = $('settleTmplCostSummary'); if (csm) csm.value = t.costSummary || '';
    updateCostEstimate();
  }
}

// 凭证字下拉同步「凭证字设置」页面数据（S.state.voucherWords）
function fillWordOptions(sel) {
  if (!sel) return;
  var words = (S.state.voucherWords && S.state.voucherWords.length) ? S.state.voucherWords.filter(function (w) { return w.enabled !== false; }) : [{ name: '记', title: '记账凭证' }];
  var html = '';
  words.forEach(function (w) { html += '<option value="' + (w.name || w.code) + '">' + (w.name || w.code) + '</option>'; });
  sel.innerHTML = html;
  // 默认选中账套默认凭证字（param.voucherWord，通常为"记"）；无匹配则选第一个
  var def = (S.state.param && S.state.param.voucherWord) || (words.length ? (words[0].name || words[0].code) : '记');
  sel.value = (words.some(function (w) { return (w.name || w.code) === def; })) ? def : (words.length ? (words[0].name || words[0].code) : '记');
}

function setText(id, txt) { var el = $(id); if (el) el.textContent = txt; }

// 显示新增模板面板
function showSettleTmplNewPanel() {
  var formPanel = $('settleTmplFormPanel');
  var newPanel = $('settleTmplNewPanel');
  if (formPanel) formPanel.style.display = 'none';
  if (newPanel) newPanel.style.display = '';
  var wd = $('settleTmplNewWord'); if (wd && !wd.options.length) fillWordOptions(wd);
}

// 模板列表（弹窗打开时）
function renderSettleTmplList() {
  renderSettleTmplTree();
  var t = findSettleTemplate(settleTmplSelectedId) || settleTmplList[0];
  if (t) selectSettleTemplate(t.id);
}

// 单行模板分录构建
function buildSettleTmplRow(e) {
  return { summary: e.summary || '', code: e.code || '', dr: U.num(e.dr) || 0, cr: U.num(e.cr) || 0 };
}

// 保存模板（含分录）
function saveSettleTemplate(id, data) {
  var t = findSettleTemplate(id);
  if (!t) return;
  t.summary = data.summary || t.summary;
  t.enabled = !!data.enabled;
  if (data.template) t.template = data.template.map(buildSettleTmplRow);
  persistSettleTemplates();
}

// 从新增面板创建自定义模板（名称 + 凭证字；分录表格为阶段二能力）
function addSettleTemplateFromPanel() {
  var nameEl = $('settleTmplNewName');
  var wordEl = $('settleTmplNewWord');
  var name = nameEl ? nameEl.value.trim() : '';
  if (!name) { showToast('请输入模板名称', 'error'); return; }
  var id = 'custom_' + Date.now();
  settleTmplList.push({ id: id, name: name, enabled: true, custom: true, summary: name, word: wordEl ? wordEl.value : '', template: [], hasEntries: false });
  settleTmplSelectedId = id;
  persistSettleTemplates();
  renderSettleTmplTree();
  refreshSettle(); // 新增后立即在期末处理页渲染卡片
  showToast('已新增模板：' + name);
}

// 保存当前表单面板（系统/已有模板的字段改动）
function saveSettleTmplForm() {
  var t = findSettleTemplate(settleTmplSelectedId);
  if (!t) return;
  var en = $('settleTmplFormEnabled'); if (en) t.enabled = en.checked;
  var dt = $('settleTmplFormDate'); if (dt) t.date = dt.value;
  var wd = $('settleTmplFormWord'); if (wd) t.word = wd.value;
  var sm = $('settleTmplFormSummary'); if (sm) t.summary = sm.value;
  if (t.id === 'cost') {
    var rev = $('settleTmplCostRevSubj'); if (rev) t.costRevSubj = rev.value;
    var inv = $('settleTmplCostInvSubj'); if (inv) t.costInvSubj = inv.value;
    var prod = $('settleTmplCostProdSubj'); if (prod) t.costProdSubj = prod.value;
    var rate = $('settleTmplCostRate'); if (rate) t.costRate = rate.value;
    var amt = $('settleTmplCostAmt'); if (amt) t.costAmount = amt.value;
    var csm = $('settleTmplCostSummary'); if (csm) t.costSummary = csm.value;
  }
  persistSettleTemplates();
  applySettleTemplateStates();
  renderSettleTmplTree();
  refreshSettle(); // 启用/禁用后同步结账页卡片显隐
  showToast('已保存模板：' + t.name);
}

// 模板弹窗事件绑定
if ($('btnSettleTmpl')) $('btnSettleTmpl').addEventListener('click', openSettleTemplateModal);
if ($('btnSettleTmplClose')) $('btnSettleTmplClose').addEventListener('click', closeSettleTemplateModal);
// 弹窗内：新增模板 / 保存 / 取消
if ($('btnSettleTmplNew')) $('btnSettleTmplNew').addEventListener('click', showSettleTmplNewPanel);
if ($('btnSettleTmplSave')) $('btnSettleTmplSave').addEventListener('click', function () {
  // 若处于新增面板则建自定义模板，否则保存表单
  var newPanel = $('settleTmplNewPanel');
  if (newPanel && newPanel.style.display !== 'none') { addSettleTemplateFromPanel(); }
  else { saveSettleTmplForm(); }
  closeSettleTemplateModal();
});
if ($('btnSettleTmplCancel')) $('btnSettleTmplCancel').addEventListener('click', closeSettleTemplateModal);
if ($('btnSettleTmplDelete')) $('btnSettleTmplDelete').addEventListener('click', async function () {
  var t = findSettleTemplate(settleTmplSelectedId);
  if (!t) return;
  if (!t.custom) return showToast('系统模板不可删除', 'warn');
  if (!(await H.confirmAsync('确认删除自定义模板「' + t.name + '」？', { title: '删除模板' }))) return;
  settleTmplList = settleTmplList.filter(function (x) { return x !== t; });
  persistSettleTemplates();
  closeSettleTemplateModal();
  refreshSettle();
});

/* 结账业务模块：对外暴露（路由刷新 + 委托桩转发） */
globalThis.__SETTLE__ = {
  refreshSettle: refreshSettle,
  renderYearPickerGrid: renderYearPickerGrid,
  showYearPicker: showYearPicker,
  hideYearPicker: hideYearPicker,
  openSettleTemplateModal: openSettleTemplateModal,
  closeSettleTemplateModal: closeSettleTemplateModal,
  getSettleTemplates: getSettleTemplates,
  // 其余函数供模块内部引用，这里一并挂载以便 app.js 委托桩完整转发
  pickYear: pickYear,
  renderSettleMonthNav: renderSettleMonthNav,
  renderReopenMonthNav: renderReopenMonthNav,
  renderSurTaxCalc: renderSurTaxCalc,
  renderIncTaxCalc: renderIncTaxCalc,
  renderSettleTmplList: renderSettleTmplList,
  saveSettleTemplate: saveSettleTemplate,
  applySettleTemplateStates: applySettleTemplateStates
};

export { refreshSettle };
