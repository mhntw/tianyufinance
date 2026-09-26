/* 期末结账业务模块
 * 依赖桥接层 globalThis.__TY_HELPERS__
 */
const H = globalThis.__TY_HELPERS__ || {};
const $ = H.$ || function () { return null; };
const S = H.S;
const U = H.U;
const money = H.money;
import { bindSubjectPicker } from '../../components/SubjectPicker.js?v=dev';
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const syncAll = H.syncAll;
const openModal = H.openModal;
const closeModal = H.closeModal;
const round2 = H.round2;
// 账套作用域守卫（单点实现，见 app.js 的 bookScopeChanged）：换账套时复位本页模块级状态
const bookScopeChanged = H.bookScopeChanged || function () { return false; };
const esc = H.esc || function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

// 取卡片对应的模板 id：系统卡用固定 id 映射，预置摊销/自定义卡用 data-id 属性
function cardTplId(card) {
  // vat / surTax / incTax 三个模板已下线（2026-09-18），不再参与卡片映射
  var map = { cardDepr: 'dep', cardCost: 'cost', cardProfit: 'profit' };
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
  // 设置弹窗：启用 / 凭证模板 / 禁用 三个分组均可折叠
  [['settleTmplGroupEnabled', 'settleTmplEnabled'], ['settleTmplGroupVch', 'settleTmplVch'], ['settleTmplGroupDisabled', 'settleTmplDisabled']].forEach(function (pair) {
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
    var month = selMonth;
    var tpl = getSettleTemplates().filter(function (t) { return t.id === 'dep'; })[0] || {};
    var r = S.depreciateMonth(month, { word: tpl.word, summary: tplSummary(tpl, month), date: tmplVoucherDate(month, tpl) });
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
    // 查重：连点会重复生成同额凭证虚增成本；按 v.kind 识别（导入凭证无 summary，摘要正则恒不命中）。
    var costExisted = S.periodVouchersOfKind(month, S.VOUCHER_KINDS.CARRY_COST);
    if (costExisted.length) {
      return showToast('本期已生成 ' + costExisted.length + ' 张结转销售成本凭证，请勿重复生成；如需重做请先删除旧凭证', 'error');
    }
    var r = S.genCostVoucher(month, tpl, amt);
    if (!r || !r.ok) return showToast(r ? r.msg : '结转失败', 'error');
    showToast('已结转销售成本：' + money(amt));
    refreshSettle(); syncAll();
  });
  // 「转出未交增值税 / 计提附加税 / 计提所得税」三个按钮已随模板下线（2026-09-18）。
  // 真实账套从未使用增值税转出；附加税与所得税按「利润×税率」测算的金额与申报口径不符，
  // 自动生成不可信，税款一律由会计按实际申报数手工录入。
  onBtn('btnReCarryForward', async function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    if (S.isPeriodClosed(month)) return showToast('该期已结账，请先反结账', 'error');
    // 按 v.kind 定位旧结转凭证（结构识别）；此前用摘要正则对导入账套恒找不到，重做被幂等拦截。
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
    var tpl = getSettleTemplates().filter(function (t) { return t.id === 'profit'; })[0] || {};
    var r = S.carryForwardProfit(month, { word: tpl.word, targetSubj: tpl.targetSubj, summary: tplSummary(tpl, month), separate: tpl.separate !== false, date: tmplVoucherDate(month, tpl) });
    if (!r.ok) return showToast(r.msg, 'error');
    var numV = (r.vouchers || []).length;
    showToast('已' + (old.length ? '重新' : '') + '结转损益：' + money(r.net) + delMsg + '（生成 ' + numV + ' 张凭证）', 'success');
    refreshSettle(); syncAll();
    if (window.__runSelfTestBanner) window.__runSelfTestBanner();
  });
  // 年末结转本年利润（3103 → 3104 未分配利润），仅 12 月可用。此前 carryYearEnd 已实现却零调用（死代码），跨年 3103 未清零、未分配利润失真，此处接入入口。
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
  onBtn('btnProfitDist', async function () {
    var month = selMonth; // 期末处理跟随结账 tab 选期
    if (String(month).substring(5, 7) !== '12') return showToast('仅 12 月可进行利润分配', 'error');
    if (S.isPeriodClosed(month)) return showToast('该期已结账，请先反结账', 'error');
    var old = S.periodVouchersOfKind(month, S.VOUCHER_KINDS.PROFIT_DIST);
    var cmsg = old.length
      ? '重新分配将删除本期已有的 ' + old.length + ' 张利润分配凭证并重新生成，确定继续？'
      : '确认按净利润的 20% 提取盈余公积、30% 分配股利（默认比例）？\n余额将转入「利润分配-未分配利润」对应明细。';
    if (!(await H.confirmAsync(cmsg, { title: old.length ? '重新分配利润' : '利润分配' }))) return;
    // 重新分配：先删除旧凭证，避免重复生成错账（同结转损益/本年利润）
    for (var i = 0; i < old.length; i++) {
      var dr = S.removeVoucher(old[i].id);
      if (!dr.ok) return showToast('删除旧利润分配凭证失败：' + dr.msg, 'error');
    }
    var r2 = S.carryProfitDistribute(month);
    if (!r2.ok) return showToast(r2.msg, 'error');
    showToast('已分配利润：' + money(r2.amount), 'success');
    refreshSettle(); syncAll();
  });
  onBtn('btnClosePeriod', async function () {
    var month = selMonth;
    if (S.isPeriodClosed(month)) return showToast('该期已结账', 'error');
    var vs = S.periodVouchers(month);
    if (!vs.length) return showToast('该期无凭证，无法结账', 'error');
    if (!(await H.confirmAsync('确认结账 ' + month + '？\n结账后该期凭证将被锁定，如需修改须反结账。', { title: '期末结账' }))) return;
    var r = S.closePeriod(month);
    if (!r.ok) {
      if (r.warnOnly && r.warns && r.warns.length) {
        // warn 项（税金测算/折旧等建议项）需 force 二次确认；此前 UI 未处理 warnOnly，r.msg 为空会显示空红条且无法结账。现展示 warn 明细并让用户决定是否强制结账。
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
    // 反结账 tab 用自身月份导航 selReopenMonth；原代码误用 selMonth（结账 tab 选期），会在反结账页选 3 月却反结账结账 tab 选的月份。
    var month = selReopenMonth;
    if (!S.isPeriodClosed(month)) return showToast('该期未结账', 'error');
    // 预检：仅允许反结账最近一期（在用户输入原因前先告知约束，避免输入完才被拒）
    var closeds = (S.state.closedPeriods || []).slice().sort();
    if (closeds.length && month !== closeds[closeds.length - 1]) {
      return showToast('仅允许反结账最近一期（' + closeds[closeds.length - 1] + '）；如需反结账更早期间，请先逐期反结账至目标期', 'error');
    }
    // 审计留痕：反结账前必须填写原因（如"X 月凭证 5001 金额输错"），写入操作日志 reason 字段
    // 文案里必须点出「红冲是更规范的替代」及其适用边界：否则用户会顺手用反结账去抹历史账，
    // 而反结账会解锁历史凭证、影响历史报表，是三条更正路径里唯一违规的一条。
    var reason = await H.promptAsync(
      '反结账会解锁 ' + month + ' 的凭证、并改写历史报表，是违反会计法规的非正常操作，请慎用！\n\n' +
      '【请先确认是否真的需要反结账】已结账期间的凭证错误，更规范的做法是「红字冲销」——\n' +
      '它不动历史账，只在当前工作期间生成一张红字反向凭证，符合审计要求。\n' +
      '反结账只应用于红冲解决不了的情况：期初余额录错、科目体系需调整、\n' +
      '结转凭证本身的规则出错、或跨多期的结构性错误。\n\n' +
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

  // ===== 顶部批量操作按钮 =====
  onBtn('settleCheckAll', function () {
    var cb = $('settleCheckAll');
    var checked = cb.checked;
    document.querySelectorAll('#settleProcessCards .settle-card').forEach(function (card) {
      if (card.style.display === 'none' || card.classList.contains('settle-add-card')) return;
      var inpp = card.querySelector('input[type=checkbox]');
      if (inpp && !inpp.disabled) {
        inpp.checked = checked;
        card.classList.toggle('settle-card-checked', checked);
      }
    });
  });
  onBtn('btnSettleRecalc', function () {
    // 重新测算 = 强制刷新卡片状态（已结转/未结转金额来自 store，无额外测算逻辑）
    showToast('已刷新测算');
    refreshSettle();
  });
  onBtn('btnSettleBatchGen', async function () {
    // 批量生成：遍历所有勾选的卡片，逐个生成凭证
    var cards = document.querySelectorAll('#settleProcessCards .settle-card input[type=checkbox]:checked');
    if (!cards.length) return showToast('请先勾选要生成凭证的卡片', 'warn');
    var month = selMonth;
    if (S.isPeriodClosed(month)) return showToast('该期已结账，请先反结账', 'error');
    var okCount = 0, skipCount = 0, errCount = 0, msgs = [];
    // 收集勾选的模板（去重，因为自定义卡和系统卡都走 settleTplList）
    var doneIds = {};
    var toGenerate = [];
    cards.forEach(function (cb) {
      var card = cb.closest('.settle-card');
      var id = cardTplId(card);
      if (!id || doneIds[id]) return;
      doneIds[id] = true;
      toGenerate.push({ id: id, card: card });
    });
    if (!toGenerate.length) return showToast('没有可生成的卡片', 'warn');
    for (var i = 0; i < toGenerate.length; i++) {
      var g = toGenerate[i];
      // vat / surTax / incTax 已下线（2026-09-18），批量生成不再包含这三项
      var sysMap = { dep: 'btnDepVoucher', cost: 'btnCarryCost', profit: 'btnReCarryForward' };
      if (sysMap[g.id]) {
        // 系统模板：检查是否已生成，未生成则触发对应按钮逻辑
        var sysKindMap = { dep: S.VOUCHER_KINDS.DEPR, cost: S.VOUCHER_KINDS.CARRY_COST, profit: S.VOUCHER_KINDS.CARRY_PL };
        var existed = S.periodVouchersOfKind(month, sysKindMap[g.id]);
        if (existed.length) { skipCount++; continue; }
        // 直接调各按钮的处理函数（复用已有逻辑）
        var tpl = getSettleTemplates().filter(function (t) { return t.id === g.id; })[0] || {};
        if (g.id === 'profit') {
          var rPL = S.carryForwardProfit(month, { word: tpl.word, targetSubj: tpl.targetSubj, summary: tplSummary(tpl, month), separate: tpl.separate !== false, date: tmplVoucherDate(month, tpl) });
          if (rPL.ok) okCount++; else { errCount++; msgs.push('结转损益：' + rPL.msg); }
        } else if (g.id === 'dep') {
          var rD = S.depreciateMonth(month, { word: tpl.word, summary: tplSummary(tpl, month), date: tmplVoucherDate(month, tpl) });
          if (rD.ok) okCount++; else { errCount++; msgs.push('计提折旧：' + rD.msg); }
        } else if (g.id === 'cost') {
          var estC = S.costVoucherEstimate(month, tpl);
          var amtC = U.num(tpl.costAmount) > 0 ? U.num(tpl.costAmount) : estC.amount;
          if (amtC < 0.005) { skipCount++; continue; }
          var costExisted = S.periodVouchersOfKind(month, S.VOUCHER_KINDS.CARRY_COST);
          if (costExisted.length) { skipCount++; continue; }
          var rC = S.genCostVoucher(month, Object.assign({}, tpl, { date: tmplVoucherDate(month, tpl) }), amtC);
          if (rC && rC.ok) okCount++; else { errCount++; msgs.push('结转销售成本：' + (rC ? rC.msg : '失败')); }
        }
      } else {
        // 预置摊销/自定义模板：走 genVoucherFromTpl
        var tpl = findSettleTemplate(g.id);
        if (!tpl) { errCount++; msgs.push('模板「' + g.id + '」不存在'); continue; }
        var oldCust = S.periodVouchersOfKind(month, 'settleTpl:' + tpl.id);
        if (oldCust.length) { skipCount++; continue; }
        var ok = genVoucherFromTpl(tpl, true); // 静默模式，不弹 toast
        if (ok) okCount++; else { errCount++; }
      }
    }
    refreshSettle(); syncAll();
    // 汇总结果
    var summary = '批量完成：成功 ' + okCount + ' 张，跳过 ' + skipCount + ' 张，失败 ' + errCount + ' 张';
    showToast(summary, errCount > 0 ? 'warn' : 'success');
    if (msgs.length) showToast(msgs.slice(0, 3).join('；'), 'error');
  });
}
// 同步全选 checkbox 状态：所有可见卡片都勾选 = 全选勾选；部分勾选 = 半选(indeterminate)；都不勾 = 不勾
function syncCheckAllState() {
  var ca = $('settleCheckAll');
  if (!ca) return;
  var visibleCbs = [];
  document.querySelectorAll('#settleProcessCards .settle-card').forEach(function (card) {
    if (card.style.display !== 'none' && !card.classList.contains('settle-add-card')) {
      var cb = card.querySelector('.settle-card-check input');
      if (cb) visibleCbs.push(cb);
    }
  });
  if (!visibleCbs.length) { ca.checked = false; ca.indeterminate = false; return; }
  var allChecked = visibleCbs.every(function (cb) { return cb.checked; });
  var someChecked = visibleCbs.some(function (cb) { return cb.checked; });
  ca.checked = allChecked;
  ca.indeterminate = !allChecked && someChecked;
}
// 卡片 checkbox / 设置按钮（innerHTML 重建后需每次重绑）
function bindSettleCards() {
  document.querySelectorAll('.settle-card').forEach(function (card) {
    var id = cardTplId(card);
    if (!id) return;
    // 单个 checkbox 勾选联动卡片高亮 + 同步全选状态
    var cb = card.querySelector('.settle-card-check input');
    if (cb && !cb._bound) {
      cb._bound = true;
      cb.addEventListener('change', function () {
        card.classList.toggle('settle-card-checked', cb.checked);
        syncCheckAllState();
      });
    }
    card.querySelectorAll('[data-act]').forEach(function (el) {
      var act = el.getAttribute('data-act');
      // 禁用/启用：链接文案随模板启用状态切换（每次 refresh 更新）
      if (act === 'disable') {
        var cur = findSettleTemplate(id);
        if (cur) el.textContent = cur.enabled ? '禁用' : '启用';
      }
      if (el._bound) return;
      el._bound = true;
      if (act === 'setting') {
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          selectSettleTemplate(id);
          openSettleTemplateModal();
        });
      } else if (act === 'disable') {
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var t = findSettleTemplate(id);
          if (!t) return;
          t.enabled = !t.enabled;
          persistSettleTemplates();
          refreshSettle();
        });
      } else if (act === 'delete') {
        el.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          var t = findSettleTemplate(id);
          if (!t) return;
          if (!t.custom) return showToast('系统模板不可删除', 'warn');
          if (!(await H.confirmAsync('确认删除自定义模板「' + t.name + '」？', { title: '删除模板' }))) return;
          settleTmplList = settleTmplList.filter(function (x) { return x !== t; });
          // 预置摊销模板删除后记入 dismissed，防止刷新后复活
          if (t.preset) {
            try {
              var DISMISS_KEY = 'settle_preset_dismissed';
              var d = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
              if (!Array.isArray(d)) d = [];
              if (d.indexOf(t.id) < 0) { d.push(t.id); localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); }
            } catch (e) {}
          }
          persistSettleTemplates();
          // 删除对应 DOM 卡片并重新渲染（自定义卡按 data-id 定位，系统卡无此属性不动）
          if (card.getAttribute('data-custom')) card.remove();
          refreshSettle();
        });
      } else if (act === 'gen') {
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          genVoucherFromTpl(findSettleTemplate(id));
        });
      }
    });
  });
}

// 动态渲染自定义/预置摊销模板卡片：插入到 #settleProcessCards 中（结转损益之后），
// 每个卡片带 checkbox + 禁用/设置/删除 链接，与系统卡一致。
// 列表末尾追加 "+ 新增自定义模板" 占位卡。
// 注意：fromVchTpl 模板（从录凭证页同步来的日常凭证模板）由 store.saveVchTemplate 写入时
// 带 custom:true + enabled:false（默认禁用），因此默认不出卡片；它与自定义模板走同一套
// 「启用才出卡」逻辑 —— 在模板弹窗的「凭证模板」分组里启用后，就会与自定义模板一样出卡片。
// （旧注释曾写「不生成卡片」，与实际逻辑不符，已更正。）
function renderCustomCards(procList, profitCard) {
  if (!procList) return;
  // 先移除上一次渲染的卡片（避免重复叠加）
  procList.querySelectorAll('.settle-card[data-custom]').forEach(function (el) { el.remove(); });
  procList.querySelectorAll('.settle-add-card').forEach(function (el) { el.remove(); });
  // 只有 enabled=true 的自定义模板才在期末处理页生成卡片
  // （系统卡由 refreshSettle 单独渲染，按各自启用状态显示/隐藏）
  var customs = settleTmplList.filter(function (t) { return t.custom && t.enabled; });
  // 排序：预置摊销模板在前，用户自定义在后，按 id 顺序
  customs.sort(function (a, b) {
    if (a.preset && !b.preset) return -1;
    if (!a.preset && b.preset) return 1;
    return (a.id || '').localeCompare(b.id || '');
  });
  var insertAnchor = profitCard ? profitCard : procList.firstElementChild;
  customs.forEach(function (t) {
    var enabled = t.enabled !== false;
    var done = S.periodVouchersOfKind(selMonth, 'settleTpl:' + t.id);
    // 已结转金额 = 已生成摊销凭证的借方合计（取第一张凭证即可，一张模板一期只允许一张）
    var carried = 0;
    if (done.length) {
      done[0].entries.forEach(function (e) { carried += U.num(e.dr); });
      carried = round2(carried);
    }
    // 模板分录借方合计 = 应结转总额
    var totalDr = 0;
    (t.template || []).forEach(function (r) { totalDr += U.num(r.dr); });
    totalDr = round2(totalDr);
    var todo = round2(Math.max(0, totalDr - carried));
    // 已生成时只显示凭证字号本身（可点击蓝色链接，与系统卡片同一套 .link-voucher 机制 → 点击打开该凭证编辑）
    var vchTxt = done.length
      ? (done[0].id
          ? '<a href="#" class="link-voucher" data-id="' + esc(done[0].id) + '">' + esc((done[0].word || '记') + '-' + done[0].no) + '</a>'
          : esc((done[0].word || '记') + '-' + done[0].no))
      : (totalDr > 0 ? '未结转' : '未设置分录金额');
    var cardBodyHtml;
    if (done.length || totalDr > 0) {
      // 有金额/已生成：显示已结转/未结转 两行统计
      cardBodyHtml =
        '<div class="settle-stat"><span class="settle-stat-label">已结转：</span><span class="val">' + money(carried) + '</span></div>' +
        '<div class="settle-stat"><span class="settle-stat-label">未结转：</span><span class="val">' + money(todo) + '</span></div>';
    } else {
      // 空模板：提示语
      cardBodyHtml = '<div class="settle-card-sub" style="color:var(--ty-text-3)">' + esc(t.summary || t.name) + '（请设置分录金额）</div>';
    }
    var card = document.createElement('div');
    card.className = 'settle-card' + (enabled ? '' : ' settle-card-disabled');
    card.setAttribute('data-custom', '1');
    card.setAttribute('data-id', t.id);
    var presetTag = t.preset ? '<span class="settle-card-preset-tag">预置</span>' : '';
    card.innerHTML =
      '<div class="settle-card-head">' +
        '<label class="settle-card-check"><input type="checkbox" /></label>' +
        '<span class="settle-card-name">' + esc(t.name) + '</span>' + presetTag +
        '<i class="settle-card-help" title="' + esc(t.summary || t.name) + '">?</i>' +
        '<span class="settle-card-op">' +
          '<a class="settle-link" data-act="disable">' + (enabled ? '禁用' : '启用') + '</a>' +
          '<a class="settle-link" data-act="setting">设置</a>' +
          '<a class="settle-link link-del" data-act="delete">删除</a>' +
        '</span>' +
      '</div>' +
      '<div class="settle-card-body">' + cardBodyHtml + '</div>' +
      '<div class="settle-card-foot">' +
        '<span class="settle-vch">' + vchTxt + '</span>' +
        '<button class="btn btn-sm btn-ghost" data-act="gen">生成凭证</button>' +
      '</div>';
    if (insertAnchor && insertAnchor.nextSibling) procList.insertBefore(card, insertAnchor.nextSibling);
    else procList.appendChild(card);
    insertAnchor = card;
  });
  // "+ 新增自定义模板" 占位卡（点击打开模板弹窗）
  var addCard = document.createElement('div');
  addCard.className = 'settle-add-card';
  addCard.innerHTML =
    '<div class="settle-add-icon">+</div>' +
    '<div>新增自定义模板</div>';
  // 与弹窗内「新增模板」一致：打开弹窗并直接进入新建自定义模板编辑态
  addCard.addEventListener('click', function () { openSettleTemplateModal(); showSettleTmplNewPanel(); });
  procList.appendChild(addCard);
  bindSettleCards();
}

function refreshSettle() {
  // 换账套：结账/反结账的选期属于上一本账套，一律回到新账套的当前期。
  // （下面的「空期间回退」只兜 selMonth 的一部分情形 —— 若新账套该月有凭证就不回退；
  //   selReopenMonth 此前完全无回退。）
  if (bookScopeChanged('settle')) { selMonth = currentPeriod(); selReopenMonth = currentPeriod(); }
  // 每次刷新都重新加载模板列表（导入账套/切换账套后 settleTemplates 会变）
  settleTmplList = loadSettleTemplates();
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
  var est = S.profitStatement(month);
  // 期末处理凭证一律按 v.kind（结构识别）而非摘要正则：导入凭证无凭证级 summary，摘要正则恒不命中，页面恒显「未生成」、查重形同虚设。
  var K = S.VOUCHER_KINDS;
  function kindVs(list, kind) {
    return list.filter(function (v) { return S.voucherKind(v) === kind; });
  }
  // 期末处理区块数据源（固定当前期）
  var curVs = S.periodVouchers(curMonth);
  var curEst = S.profitStatement(curMonth);
  // 注意保留 curDoneCount（在用的），仅上面两个同期同名的 doneCount/firstVoucherNo 已废弃
  function curDoneCount(kind) { return kindVs(curVs, kind).length; }

  // 期末处理卡片：checkbox 绑定模板启用状态（每张卡的启用开关）
  var cardTplMap = {
    cardDepr: 'dep', cardCost: 'cost', cardProfit: 'profit'
  };
  Object.keys(cardTplMap).forEach(function (cid) {
    var card = $(cid);
    if (!card) return;
    var enabled = S.settleTplEnabled(cardTplMap[cid]);
    var cb = card.querySelector('.settle-card-check input');
    if (cb) { cb.checked = false; cb.disabled = false; } // 默认全不勾选，由用户手动选
    // 禁用即隐藏（基本设置）：期末处理页只呈现启用中的模板。
    // 重新启用的入口在「模板设置」弹窗的「禁用」分组（renderSettleTmplTree → settleTmplDisabled），
    // 故隐藏不会让禁用变成单向不可逆操作。
    card.style.display = enabled ? '' : 'none';
    card.classList.toggle('settle-card-disabled', !enabled);
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
    // 只列出「已启用」的模板项：模板被禁用后应从检查清单里消失。
    // 此前是硬编码 3 项、不看启用状态 —— 于是「结转销售成本」禁用后仍挂在清单上，
    // 看起来像禁用没生效。数据层 settleChecklist 已采用同一口径（禁用则不加入）。
    var rows = [
      { k: 'dep', name: '计提折旧', kind: K.DEPR, hint: '固定资产折旧凭证' },
      { k: 'cost', name: '结转销售成本', kind: K.CARRY_COST, hint: '销售成本结转' },
      { k: 'profit', name: '结转损益', kind: K.CARRY_PL, hint: '损益类科目结转' }
    ].filter(function (r) { return S.settleTplEnabled(r.k); });
    var html = '';
    // 系统模板项：已生成 → 打勾（绿）；未生成 → 叹号（黄）提醒
    // 类名必须与 css/style.css 的 .settle-check-item.is-ok / .is-warn / .is-fail 及
    // .settle-check-icon / .settle-check-label / .settle-check-tip 一致，
    // 此前 JS 用的是 .sci-dot / .done / .settle-check-fail —— CSS 里全不存在，
    // 导致检查项没有任何颜色（既看不出通过、也看不出异常）。
    rows.forEach(function (r) {
      var cnt = curDoneCount(r.kind);
      var done = cnt > 0;
      html += '<div class="settle-check-item ' + (done ? 'is-ok' : 'is-warn') + '" data-k="' + r.k + '">' +
        '<span class="settle-check-icon">' + (done ? '✓' : '!') + '</span>' +
        '<span class="settle-check-label">' + esc(r.name) + '</span>' +
        '<span class="settle-check-tip">' + esc(done ? ('已生成 ' + cnt + ' 张') : r.hint) + '</span>' +
        '</div>';
    });
    // store 硬性检查项：全部展示（含 ok —— 通过项打勾绿色，一眼能看出「已核过」）。
    // ok=✓绿；warn=!黄（仅提醒）；fail=!红（会阻止结账，故与提醒区分开）。
    try {
      var chk = (typeof S.settleChecklist === 'function') ? S.settleChecklist(month) : [];
      chk.forEach(function (c) {
        var st = c.status;
        var cls = st === 'ok' ? 'is-ok' : (st === 'fail' ? 'is-fail' : 'is-warn');
        html += '<div class="settle-check-item ' + cls + '" data-k="' + esc(c.key) + '">' +
          '<span class="settle-check-icon">' + (st === 'ok' ? '✓' : '!') + '</span>' +
          '<span class="settle-check-label">' + esc(c.label || '') + '</span>' +
          '<span class="settle-check-tip">' + esc(c.tip || '') + '</span>' +
          '</div>';
      });
    } catch (e) { /* 检查项渲染失败不阻断页面 */ }
    cl.innerHTML = html;
  }
  // 期末处理区块：凭证字号显示（已生成的首张凭证号）
  // 已生成凭证的字号渲染为可点击的蓝色链接：复用全局 .link-voucher 委托（app.js），
  // 点击即打开该凭证的编辑弹窗，可直接查看/调整。原先只渲染纯文本 —— 看得到字号却点不动。
  // 多张时用「、」分隔且各自可点；老数据若无 id 则退化为纯文本（避免点了没反应）。
  var filler = function (id, kind) {
    var el = $(id);
    if (!el) return;
    var list = kindVs(vs, kind);
    if (!list.length) { el.textContent = ''; return; }
    el.innerHTML = list.map(function (v) {
      var no = esc((v.word || '记') + '-' + v.no);
      if (!v.id) return no;
      return '<a href="#" class="link-voucher" data-id="' + esc(v.id) + '">' + no + '</a>';
    }).join('、');
  };
  // id 必须与 index.html 完全一致（曾用 depVoucherNo / costVoucherNo / profitVoucherNo，
  // 而 HTML 里是 depVchNo / costVchNo / profitVchNo —— 不匹配导致 $() 取不到元素、
  // 凭证字号永远不显示，且不报任何错。tools/_diag_settle_tpl.js 已加契约检查防回归。
  filler('depVchNo', K.DEPR);
  filler('costVchNo', K.CARRY_COST);
  filler('profitVchNo', K.CARRY_PL);
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
    btnClose.disabled = !(vs.length > 0) || closed;
    btnClose.textContent = closed ? ('已结账 · ' + month) : '检查并结账';
  }
  // 期末处理 / 反结账 区域（固定当前期 curMonth）
  var curClosed = S.isPeriodClosed(curMonth);

  // 反结账页：已结账月列表
  renderReopenMonthNav();

  // 反结账按钮跟随反结账页导航所选月 selReopenMonth，而非结账面板选期；此前绑到结账面板，切到反结账 tab 会显示结账 tab 选期状态。
  var btnReopen = $('btnReopenPeriod');
  if (btnReopen) {
    var reopenClosed = S.isPeriodClosed(selReopenMonth);
    btnReopen.disabled = !reopenClosed;
    btnReopen.textContent = reopenClosed ? '反结账' : '未结账';
    btnReopen.title = selReopenMonth + (reopenClosed ? '（已结账，可反结账）' : '（未结账，无需反结账）');
  }

  // 结转损益按钮文案随状态切换：未结转→「结转损益」，已结转且未锁→「重新结转」，已结账→「已结转」（此前固定「重新结转」，未结转月点会弹删除 0 张旧凭证，语义误导）。
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

  // 「利润分配」仅 12 月显示（年末提取盈余公积/分配股利），已分配显示「重新分配」
  var pd = $('btnProfitDist');
  if (pd) {
    var isDecPd = String(curMonth || '').substring(5, 7) === '12';
    pd.style.display = isDecPd ? '' : 'none';
    pd.disabled = closed;
    if (closed) pd.textContent = '已分配';
    else pd.textContent = (kindVs(curVs, K.PROFIT_DIST).length > 0) ? '重新分配' : '利润分配';
  }

  // 同步全选 checkbox 状态（刷新后可见卡片集合可能变了）
  syncCheckAllState();
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

// 通用：生成单张凭证（期末处理凭证生成后强制立即备份，防丢失/可回滚）
// kind：期末业务类型标记（S.VOUCHER_KINDS），写入 v.kind 供后续查重/结账检查识别。
// word：可选凭证字（自定义结账模板带自己的凭证字，如「记」）；不传则沿用历史默认「转」。
function makeSimpleVoucher(month, summary, entries, kind, word, date) {
  var v = S.addVoucher({ word: word || S.state.param.voucherWord || '记', date: date || U.lastDay(month), attach: 0, summary: summary, kind: kind, entries: entries });
  if (v && S.backupNow) S.backupNow();
  return v;
}

// 结账模板「凭证日期」选项 → 实际凭证日期
// 'period'    → 当期日期（今天落在本期则用今天，否则取期末最后一天）
// 'periodEnd' → 期末最后一天（与历史默认行为一致）
// 结转模板摘要渲染：模板文本支持 {month} 占位符（如「计提{month}固定资产折旧」）。
// 历史上该占位符从未被替换 —— 实测生成的折旧凭证摘要直接是「计提{month}固定资产折旧」，
// 看着像模板没生效。凡把 tpl.summaryText 交给生成函数的地方，都走这里。
function tplSummary(t, month) {
  var s = (t && (t.summaryText || t.summary || t.name)) || '';
  return String(s).replace(/\{month\}/g, month || '');
}

function tmplVoucherDate(month, t) {
  if (t && t.voucherDate === 'period') {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var td = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    if (td.slice(0, 7) === month) return td; // 今天落在本期 → 用当期日期
    return U.lastDay(month);
  }
  return U.lastDay(month);
}

// 期末处理「生成凭证」统一查重入口：按 v.kind 识别本期是否已存在同类凭证，已存在则拒绝（须先删旧凭证再重做），
// 避免连点重复生成同额凭证虚增费用/负债。导入凭证无 summary，故用结构识别而非摘要正则。返回 { ok, v } 或 { ok:false, msg }
function genOnceVoucher(month, kind, summary, entries, word, date) {
  // 已结账期间禁止再生成凭证（否则会向已锁定期间写入，破坏账务一致性）。
  // 对齐同文件其它期末处理按钮（结转损益/反结账）已有的 isPeriodClosed 拦截。
  if (S.isPeriodClosed(month)) return { ok: false, msg: '该期已结账，请先反结账再操作', month: month };
  var existed = S.periodVouchersOfKind(month, kind);
  if (existed.length) {
    return { ok: false, msg: '本期已生成 ' + existed.length + ' 张同类凭证（' + (existed[0].word || '转') + '-' + existed[0].no + '），请勿重复生成；如需重做请先删除旧凭证', vouchers: existed };
  }
  var v = makeSimpleVoucher(month, summary, entries, kind, word, date);
  // 写盘被拒（借贷不平衡等）时 addVoucher 返回失败，原实现忽略返回值仍提示成功，此处修正。
  if (!v || v.ok === false) return { ok: false, msg: (v && v.msg) || '凭证生成失败，请稍后重试' };
  return { ok: true, v: v };
}


// 注：原「出纳结账」整套功能已随出纳板块整体移除（产品定位为纯账务复式记账），
// 相关 DOM（page-cashier-settle）与 store 出纳方法已同步清理。

/* ============================================================
 * 结账模板（结账设置：凭证模板 7 项 + 启用开关）
 * ============================================================ */
var SETTLE_TMPL_KEY = 'settle_templates_v1';

function defaultSettleTemplates() {
  // 系统模板共 3 个（dep / cost / profit）；各自的默认启用状态由 store.settleTplDefaultEnabled 决定，
  // 此处 enabled 仅作为「账套里没有该模板记录」时的兜底初值。用户可在模板设置里停用/启用。
  return [
    { id: 'dep', name: '计提折旧', enabled: true, summary: '计提本月固定资产折旧', template: [], hasEntries: false, summaryText: '计提折旧费用' },
    // cost 默认关闭：借方科目（5401 主营业务成本各明细）因账套而异，默认值指向的「4001 生产成本」
    // 在真实账套里零发生额，自动生成会把成本记歪。由用户在期末处理页显式「启用」并指定科目后再用。
    { id: 'cost', name: '结转销售成本', enabled: false, summary: '按收入比例结转销售成本', template: [], hasEntries: false, costRate: '80', costAmount: '' },
    // vat / surTax / incTax 三个默认模板已下线（2026-09-18），不再预置
    { id: 'profit', name: '结转损益', enabled: true, summary: '结转损益类科目至本年利润', template: [], hasEntries: false, targetSubj: '3103', summaryText: '结转{month}损益', separate: true }
  ];
}

// 系统默认模板（6 个，跟账套无关、全局共享）；其余模板一律跟随账套（删除账套时按 bookId 清理）
function isSystemSettleTmpl(t) {
  return ['dep', 'cost', 'profit'].indexOf(t && t.id) >= 0;
}
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
  // 先从 store 里移除已不在 settleTmplList 的模板（删除操作后同步清理）
  var liveIds = {};
  settleTmplList.forEach(function (t) { if (t && t.id) liveIds[t.id] = true; });
  arr = arr.filter(function (t) { return t && liveIds[t.id]; });
  // 再把当前所有模板的 enabled 状态写回 store
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

// 加载模板配置：defaultSettleTemplates（3 个系统模板） + localStorage 本地覆盖 + state.settleTemplates 里的完整自定义模板
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
        // 除系统默认模板外，其余模板按账套归属过滤：只加载属于当前账套的，删除账套后不再随全局残留串台显示
        if (!isSystemSettleTmpl(s)) {
          var curBid = (typeof S !== 'undefined' && S && S.bookId) || '';
          if (s.bookId && s.bookId !== curBid) return; // 归属其它账套，跳过
          if (!s.bookId) s.bookId = curBid;            // 旧数据无归属标记：归入当前账套，下次保存即打标
        }
        if (byId[s.id]) {
          // 合并业务配置（摘要/凭证字/分录等），但 enabled 以默认/store 为准，不读本地旧值
          var keepEnabled = byId[s.id].enabled;
          Object.assign(byId[s.id], s);
          byId[s.id].enabled = keepEnabled;
        } else { byId[s.id] = s; list.push(s); }
      });
    }
  } catch (e) {}
  // 从 store 里的 settleTemplates 合并 custom=true 完整模板（导入账套带进来的期末处理模板）
  if (typeof S !== 'undefined' && S && S.state && Array.isArray(S.state.settleTemplates)) {
    var byId2 = {};
    list.forEach(function (t) { byId2[t.id] = t; });
    S.state.settleTemplates.forEach(function (st) {
      if (!st || !st.id) return;
      // 只合并有完整 template 分录的自定义模板（系统模板已在 defaultSettleTemplates 里）
      if (st.custom && st.template && st.template.length) {
        if (!byId2[st.id]) { byId2[st.id] = st; list.push(st); }
      }
    });
  }
  // 凭证字规范化：任何模板 word 为空一律默认「记」
  list.forEach(function (t) { if (!t.word) t.word = '记'; });
  return list;
}
var settleTmplList = loadSettleTemplates();
// 首次同步：模板启用状态以 store 为权威（与结账检查清单一致）
syncTplEnabledFromStore();
var settleTmplSelectedId = 'profit';

function getSettleTemplates() { return settleTmplList; }
function persistSettleTemplates() {
  // 除系统默认模板外，其余模板归属当前账套：打 bookId 标记，使其跟随账套（删除账套时一并清理，不再跨账套串台）
  var bid = (typeof S !== 'undefined' && S && S.bookId) || '';
  settleTmplList.forEach(function (t) { if (!isSystemSettleTmpl(t)) t.bookId = bid; });
  try { localStorage.setItem(SETTLE_TMPL_KEY, JSON.stringify(settleTmplList)); } catch (e) {}
  syncTplEnabledToStore();
}

// applySettleTemplateStates 已合并进 refreshSettle（此前两处重复控制系统卡 display，refreshSettle 为权威），不再单独存在。

// 结账模板弹窗（对账结设置）
function openSettleTemplateModal() { renderSettleTmplList(); openModal('settleTmplModal'); }
function closeSettleTemplateModal() { closeModal('settleTmplModal'); }

function findSettleTemplate(id) {
  return settleTmplList.filter(function (t) { return t.id === id; })[0];
}

// 模板面板：左侧列表（启用 / 凭证 / 禁用 三个分组）
function renderSettleTmplTree() {
  var enUl = $('settleTmplEnabled'), vchUl = $('settleTmplVch'), disUl = $('settleTmplDisabled');
  var enHtml = '', vchHtml = '', disHtml = '';
  settleTmplList.forEach(function (t) {
    var cls = 'stm-item' + (t.id === settleTmplSelectedId ? ' select' : '') + (t.custom ? ' stm-custom' : '');
    var li = '<li class="' + cls + '" data-id="' + t.id + '">' +
      '<span class="stm-check">' + (t.enabled ? '✓' : '') + '</span>' +
      '<span class="stm-name">' + t.name + '</span></li>';
    if (t.fromVchTpl) vchHtml += li;       // 录凭证页保存的模板 → 独立分组
    else if (t.enabled) enHtml += li;      // 启用
    else disHtml += li;                     // 禁用
  });
  if (enUl) { enUl.innerHTML = enHtml || '<li class="stm-empty">暂无启用的模板</li>'; bindTmplTreeItems(enUl); }
  if (vchUl) { vchUl.innerHTML = vchHtml || '<li class="stm-empty">暂无凭证模板</li>'; bindTmplTreeItems(vchUl); }
  if (disUl) { disUl.innerHTML = disHtml || '<li class="stm-empty">暂无禁用的模板</li>'; bindTmplTreeItems(disUl); }
}

function bindTmplTreeItems(ul) {
  ul.querySelectorAll('.stm-item').forEach(function (el) {
    el.addEventListener('click', function () {
      var id = el.getAttribute('data-id');
      selectSettleTemplate(id);
    });
  });
}

function selectSettleTemplate(id, t0) {
  settleTmplSelectedId = id;
  var t = findSettleTemplate(id) || t0;
  renderSettleTmplTree();
  // 所有模板都走同一个 FormPanel，只根据 t.custom 切换 extra 区域（成本参数 vs 分录表格）
  var formPanel = $('settleTmplFormPanel');
  if (formPanel) formPanel.style.display = '';
  fillSettleTmplForm(t);
  if (t && t.custom) {
    // 预置摊销/自定义模板：隐藏成本参数和系统参数，显示分录表格
    var costExtra = $('settleTmplCostExtra'); if (costExtra) costExtra.style.display = 'none';
    var custExtra = $('settleTmplCustomExtra'); if (custExtra) custExtra.style.display = '';
    var sysExtra0 = $('settleTmplSystemExtra'); if (sysExtra0) sysExtra0.style.display = 'none';
    editingCustomId = id;
    // 把当前模板的分录加载到 newTplRows 供 renderNewTplRows 使用
    newTplRows = (t.template || []).map(function (r) { return tplToUiRow(r, t.ruleType); });
    if (!newTplRows.length) newTplRows = [
      { summary: '', code: '', dc: 'D', amount: 0, ratio: 0 },
      { summary: '', code: '', dc: 'C', amount: 0, ratio: 0 }
    ];
    renderNewTplRows();
  } else {
    // 系统模板：隐藏分录表格，显示通用参数区（按模板类型显示子项）
    var custExtra2 = $('settleTmplCustomExtra'); if (custExtra2) custExtra2.style.display = 'none';
    var sysExtra = $('settleTmplSystemExtra'); if (sysExtra) sysExtra.style.display = '';
    // 全部子项先隐藏，再按模板 id 逐个显示
    // 只有 profit / dep 有系统参数区；cost 用专属 costExtra；vat/surTax/incTax 已下线（2026-09-18）
    var show = {
      profit: { profitTarget: true, summaryText: true, separate: true },
      dep: { summaryText: true },
      cost: {} // cost 用专属的 costExtra，不走 systemExtra
    }[t.id] || {};
    function toggle(id, on) { var el = $(id); if (el) el.style.display = on ? '' : 'none'; }
    toggle('settleTmplProfitParams', !!show.profitTarget);
    toggle('settleTmplProfitSeparate', !!show.separate);
    // 回填值（科目字段统一用 fillSubjectField 绑定联想选择器）
    fillSubjectField('settleTmplProfitTarget', t.targetSubj || '');
    var ps = $('settleTmplProfitSeparateSel'); if (ps) ps.value = (t.separate !== false) ? 'true' : 'false';
  }
}

// 结账模板科目选择统一用 bindSubjectPicker（输入框+联想），从 S.subjects() 取全部科目。
// 首次绑定一次，之后回填 value；同时处理所有结账模板的科目配置字段。
function fillSubjectField(id, selected) {
  var el = $(id);
  if (!el) return;
  if (!el.dataset.comboBound) {
    el.dataset.comboBound = '1';
    bindSubjectPicker(el, { onPick: function (code) { el.value = code; } });
  }
  el.value = selected || '';
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
  // 模板名称：系统模板显示为标题（不可改名），自定义/预置为可编辑输入框
  var isSystem = !t.custom && !t.preset;
  var nm = $('settleTmplFormName');
  var nmLabel = $('settleTmplFormNameLabel');
  var ftitle = $('settleTmplFormTitle');
  var ftitleText = $('settleTmplFormTitleText');
  if (nm) { nm.value = t.name || ''; nm.style.display = isSystem ? 'none' : ''; }
  if (nmLabel) nmLabel.style.display = isSystem ? 'none' : '';
  if (ftitle) ftitle.style.display = isSystem ? '' : 'none';
  if (ftitleText) ftitleText.textContent = t.name || '';
  // 删除按钮：自定义/预置模板显示，系统模板隐藏
  var delBtn = $('btnSettleTmplDelete');
  if (delBtn) delBtn.style.display = (t.custom || t.preset) ? '' : 'none';
  // 系统模板角标：随标题一起，仅系统模板显示
  var fbadge = $('settleTmplFormBadge'); if (fbadge) fbadge.style.display = isSystem ? '' : 'none';
  var en = $('settleTmplFormEnabled'); if (en) en.checked = !!t.enabled;
  var wd = $('settleTmplFormWord'); if (wd) { if (!wd.options.length) fillWordOptions(wd); wd.value = t.word || '记'; }
  // 凭证日期：系统模板显示真实计算日期（如 2026-08-31）并锁定；自定义/预置保留下拉可选
  var dt = $('settleTmplFormDate');
  var dtText = $('settleTmplFormDateText');
  if (dt) dt.value = t.voucherDate || 'period';
  if (dtText) {
    if (isSystem) { dtText.value = tmplVoucherDate(selMonth, t); dtText.style.display = ''; dtText.classList.add('stm-name-ro'); }
    else { dtText.style.display = 'none'; }
  }
  if (dt) dt.style.display = isSystem ? 'none' : '';
  var sm = $('settleTmplSummaryText'); if (sm) { sm.value = t.summaryText || ''; sm.readOnly = false; if (sm.classList) sm.classList.remove('stm-name-ro'); sm.placeholder = isSystem ? '留空则按系统规则自动生成摘要' : '留空则用模板名称作为默认摘要'; }

  // 结转销售成本专属
  var costExtra = $('settleTmplCostExtra');
  if (costExtra) costExtra.style.display = (t.id === 'cost') ? '' : 'none';
  if (t.id === 'cost') {
    fillSubjectField('settleTmplCostRevSubj', t.costRevSubj || '5001');
    fillSubjectField('settleTmplCostInvSubj', t.costInvSubj || '1405');
    fillSubjectField('settleTmplCostProdSubj', t.costProdSubj || '5001');
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

// 显示新增模板面板（分录表格：模板名称 + 凭证字 + 摘要/科目/方向/金额）
// 草稿仅保留在内存（不进 settleTmplList、不落库），点「保存」才由 saveSettleTmplForm 写入；
// 取消/关闭则自然丢弃，不会留下空白模板。
function showSettleTmplNewPanel() {
  var id = 'custom_' + Date.now();
  var draft = { id: id, name: '自定义模板', enabled: true, custom: true, summary: '', word: '记', template: [], hasEntries: false };
  editingCustomId = id;
  settleTmplSelectedId = id;
  selectSettleTemplate(id, draft);
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

/* 结账模板「分录表格」：自定义模板的多行固定金额分录。
 * 行模型 newTplRows={summary, code, dr, cr}，落盘口径 buildSettleTmplRow 与历史数据兼容；
 * 借贷平衡在「保存」与「生成凭证」两处均校验（不平的模板绝不生成凭证）。 */
var newTplRows = [];
var editingCustomId = null; // 新建面板当前编辑的自定义模板 id；null = 新建

// 行模型 {summary, code, dc:'D'|'C', amount, ruleType} → 落盘 {summary, code, dr, cr, ruleType}
// 取数规则（四选一）
// 'none'       → 不设置取数（金额在模板分录里手填固定值，生成时带出，如每月固定电话费 500）
// 'manual'     → 按统一金额(手填)分摊（模板级 totalAmount × 每行 ratio）
// 'subject'    → 按统一金额(科目余额)分摊（S.subjectEndBalance × 每行 ratio）
// 'per_row'    → 按凭证分录逐行指定（每行独立填 amount）
var RULE_OPTIONS = [
  { key: 'none',    label: '不设置取数' },
  { key: 'manual',  label: '按统一金额(手填金额)分摊' },
  { key: 'subject', label: '按统一金额(任一科目金额)分摊' },
  { key: 'per_row', label: '按凭证分录逐行指定' }
];
function normRuleType(v) {
  var s = String(v == null ? '' : v).trim();
  // 老数据兼容：fixed → per_row，balance/amount/formula → per_row（降级处理）
  if (s === 'fixed' || s === 'per_row') return 'per_row';
  if (s === 'none' || s === 'manual' || s === 'subject') return s;
  if (s === 'balance' || s === 'amount' || s === 'formula') return 'per_row';
  return 'none'; // 默认：不设置取数
}

// 行模型 → 落盘模型（统一走 buildSettleTmplRow）
// ⚠️ 分支必须按【模板的 ruleType】判断，不能按 `r.ratio != null` 判断 ——
// tplToUiRow 读回时总会给 ratio 赋数字（非分摊模板赋 0），而 `0 != null` 恒为真，
// 于是"手填金额"的行会被当成分摊行，amount 被静默丢掉 ——
// 表现就是「自定义模板里填了金额，保存后不生效（金额永远是 0）」。
function uiRowToTpl(r, ruleType) {
  var rt = normRuleType(r.ruleType || ruleType || 'none');
  var o;
  if (rt === 'manual' || rt === 'subject') {
    // 分摊规则：只存 ratio（百分比小数，如 0.3 表示 30%）
    o = buildSettleTmplRow({ summary: r.summary, code: String(r.code || '').trim(), dr: 0, cr: 0 });
    o.ratio = U.num(r.ratio);
  } else {
    // 不设置取数 / 逐行指定：存 dc + amount → 拆成 dr/cr
    var a = U.num(r.amount);
    o = buildSettleTmplRow({ summary: r.summary, code: String(r.code || '').trim(), dr: r.dc === 'C' ? 0 : a, cr: r.dc === 'C' ? a : 0 });
  }
  o.dc = r.dc || 'D';
  return o;
}
// 落盘模型 → 行模型（读 ruleType 决定用 ratio 还是 amount）
function tplToUiRow(r, ruleType) {
  ruleType = normRuleType(ruleType);
  var base = { summary: r.summary || '', code: r.code || '', dc: r.dc || ((U.num(r.cr) > 0 && U.num(r.dr) <= 0) ? 'C' : 'D') };
  if (ruleType === 'manual' || ruleType === 'subject') {
    base.ratio = r.ratio != null ? U.num(r.ratio) : 0;
    base.amount = 0;
  } else {
    var dr = U.num(r.dr), cr = U.num(r.cr);
    base.amount = (cr > 0 && dr <= 0) ? cr : dr;
    base.ratio = 0;
  }
  return base;
}

function _tmplAmt(v) { var n = U.num(v); return n ? money(round2(n)) : ''; }

function renderNewTplRows() {
  var tb = $('settleTmplNewBody');
  if (!tb) return;
  // 当前模板的 ruleType（决定金额列显示什么）
  var curTpl = findSettleTemplate(settleTmplSelectedId);
  var ruleType = normRuleType(curTpl ? curTpl.ruleType : 'none');
  // 预查科目名称表
  var subjMap = {};
  try { (S.subjects ? S.subjects() : []).forEach(function (s) { subjMap[String(s.code)] = s.name; }); } catch(e) {}
  var html = '';
  newTplRows.forEach(function (r, i) {
    var name = subjMap[String(r.code || '')];
    var codeText = r.code ? (name ? r.code + ' ' + name : r.code) : '';
    // 金额列：按 ruleType 切换显示
    var amtCell;
    if (ruleType === 'manual' || ruleType === 'subject') {
      // 分摊规则：显示比例输入框（百分比）
      var pctVal = r.ratio != null ? (round2(r.ratio * 100)) : '';
      amtCell = '<div class="tmpl-amount-wrap">'
        + '<input class="tmpl-cell-inp" data-f="ratio" value="' + pctVal + '" placeholder="0">%'
        + '</div>';
    } else {
      // 不设置取数 / 逐行指定：金额输入框（金额在模板里手填，生成时带出）
      amtCell = '<input class="tmpl-cell-inp" data-f="amount" value="' + _tmplAmt(r.amount) + '" placeholder="0.00">';
    }
    html += '<tr data-idx="' + i + '">'
      + '<td class="col-op">'
      +   '<span class="tmpl-op tmpl-op-add" data-op="add" title="在下方插入一行"></span>'
      +   '<span class="tmpl-op tmpl-op-del" data-op="del" title="删除本行"></span>'
      + '</td>'
      + '<td><input class="tmpl-cell-inp" data-f="summary" value="' + esc(r.summary) + '" placeholder="摘要"></td>'
      + '<td><span class="tmpl-subj-wrap"><input class="tmpl-cell-inp" data-f="code" value="' + esc(codeText) + '" placeholder="输入科目编码或名称"><span class="tmpl-subj-bal" data-i="' + i + '"></span></span></td>'
      + '<td class="col-dc"><span class="tmpl-dc-toggle" data-f="dc" data-dc="' + r.dc + '">' + S.dirName(r.dc) + '</span></td>'
      + '<td class="col-amount">' + amtCell + '</td>'
      + '</tr>';
  });
  tb.innerHTML = html;
  tb.querySelectorAll('input[data-f="code"]').forEach(function (inp) {
    bindSubjectPicker(inp, { onPick: function (code, s) {
      inp.value = s && s.name ? (code + ' ' + s.name) : code;
      syncTplRowFromInput(inp);
    } });
  });
  updateNewTplBals();
  updateNewTplTotal();
}

/* 每行科目余额提示（与录凭证页同款「余额：X」，见 pages/voucher/Voucher.js 的 syncAllSubjBals）。
 * 口径差异：录凭证会把本张凭证已录金额算进去（因为它即将入账），模板是"计划"，故只显示
 * 结账当选期间的科目余额本身，不含模板内金额。
 * 借贷符号统一为"按科目正常方向为正"（贷方科目贷余为正），与科目余额表一致。 */
function updateNewTplBals() {
  var tb = $('settleTmplNewBody');
  if (!tb) return;
  var month = selMonth || currentPeriod();
  var balMap = {};
  try {
    (S.generalLedger(month) || []).forEach(function (r) {
      var b = Number(r.balance) || 0;
      balMap[r.code] = (r.dir === '借' ? b : -b);
    });
  } catch (e) {}
  newTplRows.forEach(function (r, i) {
    var el = tb.querySelector('.tmpl-subj-bal[data-i="' + i + '"]');
    if (!el) return;
    var c = String(r.code || '');
    var s = (c && S.subject) ? S.subject(c) : null;
    if (!s) { el.textContent = ''; return; }
    var disp = (s.normal === 'cr') ? -(balMap[c] || 0) : (balMap[c] || 0);
    el.textContent = '余额：' + money(disp);
  });
}

// 表格事件：加/删行走重建；输入就地同步
function bindNewTplBodyEvents() {
  var tb = $('settleTmplNewBody');
  if (!tb || tb.dataset.bound) return;
  tb.dataset.bound = '1';
  tb.addEventListener('click', function (e) {
    // 方向 popover：点击「借/贷」文字 → 弹小 popover 选
    var dcEl = e.target.closest && e.target.closest('.tmpl-dc-toggle');
    if (dcEl) {
      e.preventDefault();
      var tr = dcEl.closest('tr');
      var idx = tr ? parseInt(tr.getAttribute('data-idx'), 10) : -1;
      if (idx >= 0) openDcPopover(idx, dcEl);
      return;
    }
    var op = e.target && e.target.getAttribute ? e.target.getAttribute('data-op') : '';
    if (!op) return;
    var tr = e.target.closest('tr');
    if (!tr) return;
    var idx = parseInt(tr.getAttribute('data-idx'), 10);
    if (isNaN(idx) || !newTplRows[idx]) return;
    if (op === 'del') {
      newTplRows.splice(idx, 1);
      if (!newTplRows.length) newTplRows.push({ summary: '', code: '', dc: 'D', amount: 0, ratio: 0 });
    } else {
      // 在当前行下方插入，默认方向：上一行是借则插贷，否则插借（一借一贷配对）
      var prevDc = newTplRows[idx] ? newTplRows[idx].dc : 'D';
      newTplRows.splice(idx + 1, 0, { summary: '', code: '', dc: prevDc === 'D' ? 'C' : 'D', amount: 0, ratio: 0 });
    }
    renderNewTplRows();
  });
  var onEdit = function (e) { syncTplRowFromInput(e.target); };
  tb.addEventListener('input', onEdit);
  tb.addEventListener('change', onEdit);
  // 金额失焦即格式化（千分位 + 两位小数），与录凭证页的显示习惯一致
  tb.addEventListener('blur', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || el.getAttribute('data-f') !== 'amount') return;
    syncTplRowFromInput(el);
    var tr = el.closest('tr');
    var idx = tr ? parseInt(tr.getAttribute('data-idx'), 10) : -1;
    var v = U.num((newTplRows[idx] || {}).amount);
    el.value = v ? money(v) : '';
  }, true);
  /* Enter 流转（与录凭证页同款，见 pages/voucher/Voucher.js 的 vRows keydown）：
   *   摘要 → 科目 → 金额；末行填完金额回车 → 自动追加一行并聚焦新行摘要（"录完本行换行"的录入习惯）。
   * 模板金额只有一列（按方向决定借贷），故金额格回车后直接换行，不再分借/贷两格。 */
  tb.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    var f = el && el.getAttribute ? el.getAttribute('data-f') : '';
    if (!f) return;
    var tr = el.closest('tr');
    if (!tr) return;
    e.preventDefault();
    if (f === 'summary') { var c = tr.querySelector('input[data-f="code"]'); if (c) c.focus(); return; }
    if (f === 'code') { var a = tr.querySelector('input[data-f="amount"], input[data-f="ratio"]'); if (a) a.focus(); return; }
    if (f === 'amount' || f === 'ratio') {
      el.blur();                                   // 先失焦：格式化金额并写回行模型
      var idx = parseInt(tr.getAttribute('data-idx'), 10);
      var cur = newTplRows[idx] || {};
      if (!tr.nextElementSibling && String(cur.code || '').trim()) {
        newTplRows.push({ summary: '', code: '', dc: cur.dc === 'D' ? 'C' : 'D', amount: 0, ratio: 0 });
        renderNewTplRows();
        var tb2 = $('settleTmplNewBody');
        var ntr = tb2 ? tb2.querySelectorAll('tr')[newTplRows.length - 1] : null;
        var s2 = ntr && ntr.querySelector('input[data-f="summary"]');
        if (s2) s2.focus();
        return;
      }
      var ntr2 = tr.nextElementSibling;
      var s3 = ntr2 && ntr2.querySelector('input[data-f="summary"]');
      if (s3) s3.focus();
    }
  });
}

function syncTplRowFromInput(el) {
  var f = el && el.getAttribute ? el.getAttribute('data-f') : '';
  if (!f) return;
  var tr = el.closest('tr');
  if (!tr) return;
  var r = newTplRows[parseInt(tr.getAttribute('data-idx'), 10)];
  if (!r) return;
  if (f === 'summary') r.summary = el.value;
  else if (f === 'code') {
    var raw = String(el.value || '').trim();
    // 编码 + 名称一起存，但只把空格前的编码写入 r.code
    r.code = raw.split(/\s+/)[0] || raw;
    updateNewTplBals();      // 科目变了 → 该行「余额：」提示同步刷新
  }
  else if (f === 'dc') r.dc = (el.value === 'C') ? 'C' : 'D';
  else if (f === 'amount') r.amount = U.num(String(el.value || '').replace(/[,¥\s]/g, ''));
  else if (f === 'ratio') r.ratio = round2(U.num(String(el.value || '').replace(/[,¥\s%]/g, '')) / 100);
  updateNewTplTotal();
}

// 合计提示：按 ruleType 切换显示
function updateNewTplTotal() {
  var tb = $('settleTmplNewBody'); if (!tb) return;
  var curTpl = findSettleTemplate(settleTmplSelectedId);
  var ruleType = normRuleType(curTpl ? curTpl.ruleType : 'none');
  var out = $('settleTmplNewTotal');
  if (!out) return;

  if (ruleType === 'manual' || ruleType === 'subject') {
    // 分摊规则：显示比例合计
    var ratioSum = round2(newTplRows.reduce(function (s, r) { return s + U.num(r.ratio); }, 0));
    out.innerHTML = '比例合计 <b>' + round2(ratioSum * 100) + '%</b>　';
    out.innerHTML += Math.abs(ratioSum - 1) < 0.005
      ? '<span style="color:var(--ty-green)">分摊完整 ✓</span>'
      : '<span style="color:var(--ty-red)">合计 ≠ 100%，请检查分摊比例</span>';
    return;
  }
  // 不设置取数 / 逐行指定：借贷平衡（金额在模板里手填）
  // per_row：借贷平衡
  var dr = 0, cr = 0;
  newTplRows.forEach(function (r) { var a = U.num(r.amount); if (r.dc === 'C') cr += a; else dr += a; });
  dr = round2(dr); cr = round2(cr);
  var diff = round2(dr - cr);
  out.innerHTML = '借方合计 <b>' + money(dr) + '</b>　贷方合计 <b>' + money(cr) + '</b>　';
  out.innerHTML += Math.abs(diff) < 0.005
    ? '<span style="color:#16a34a">借贷平衡 ✓</span>'
    : '<span style="color:var(--ty-red)">差额 ' + money(Math.abs(diff)) + ' ' + (diff > 0 ? '（贷方少 ' : '（借方少 ') + money(Math.abs(diff)) + '）</span>';
}

// ─── 方向 popover（点击「借/贷」弹出） ───────────────────────────────
var _dcPopDocClick = function (e) { if (!e.target.closest('.tmpl-dc-popover')) closeDcPopover(); };
function closeDcPopover() {
  document.removeEventListener('click', _dcPopDocClick, true);
  var pop = document.querySelector('.tmpl-dc-popover');
  if (pop) pop.remove();
}
function openDcPopover(idx, anchor) {
  closeDcPopover();
  var cur = (newTplRows[idx] && newTplRows[idx].dc === 'C') ? 'C' : 'D';
  var pop = document.createElement('div');
  pop.className = 'tmpl-dc-popover';
  pop.innerHTML =
    '<div class="tmpl-dc-opt' + (cur === 'D' ? ' active' : '') + '" data-dc="D">借</div>'
    + '<div class="tmpl-dc-opt' + (cur === 'C' ? ' active' : '') + '" data-dc="C">贷</div>';
  document.body.appendChild(pop);
  var rect = anchor.getBoundingClientRect();
  pop.style.top = (rect.bottom + 2) + 'px';
  pop.style.left = (rect.left - 12) + 'px';
  pop.querySelectorAll('.tmpl-dc-opt').forEach(function (optEl) {
    optEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (newTplRows[idx]) newTplRows[idx].dc = optEl.getAttribute('data-dc');
      closeDcPopover();
      renderNewTplRows();
    });
  });
  setTimeout(function () { document.addEventListener('click', _dcPopDocClick, true); }, 0);
}

// 模板级取数规则 popover（表头「设置」链接触发）
function openTplRulePopover(anchor) {
  closeTplRowSettingPopover();
  var tpl = findSettleTemplate(settleTmplSelectedId) || {};
  var curRule = normRuleType(tpl.ruleType || 'none');

  var pop = document.createElement('div');
  pop.className = 'tmpl-setting-popover';
  pop.innerHTML =
    '<div class="tmpl-setting-row">'
    + '<span class="tmpl-setting-label">取数规则：</span>'
    + '<select class="tmpl-setting-sel" id="tmplPopRule">'
    +   RULE_OPTIONS.map(function (o) { return '<option value="' + o.key + '"' + (curRule === o.key ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('')
    + '</select></div>'
    + '<div id="tmplPopExtra"></div>'
    + '<div class="tmpl-setting-actions">'
    +   '<button class="btn btn-sm" id="tmplPopCancel">取消</button>'
    +   '<button class="btn btn-sm btn-primary" id="tmplPopOk">确定</button>'
    + '</div>';
  document.body.appendChild(pop);

  // 动态渲染 extra 区域
  function renderExtra(rule) {
    var box = pop.querySelector('#tmplPopExtra');
    if (!box) return;
    var h = '';
    if (rule === 'manual') {
      var ta = U.num(tpl.totalAmount);
      h += '<div class="tmpl-setting-row">'
        + '<span class="tmpl-setting-label">统一金额：</span>'
        + '<input class="tmpl-setting-inp" id="tmplPopTotal" value="' + (ta ? money(ta) : '') + '" placeholder="如 5000.00" style="width:140px"></div>'
        + '<div class="tmpl-setting-hint" style="font-size:var(--fs-xs);color:var(--ty-text-3)">将按下方各行比例分摊此金额</div>';
    } else if (rule === 'subject') {
      var sc = tpl.sourceSubject || '';
      var subjMap = {};
      try { (S.subjects ? S.subjects() : []).forEach(function (s) { subjMap[String(s.code)] = s; }); } catch(e) {}
      var sn = sc && subjMap[sc] ? (sc + ' ' + subjMap[sc].name) : sc;
      h += '<div class="tmpl-setting-row">'
        + '<span class="tmpl-setting-label">取金额科目：</span>'
        + '<input class="tmpl-setting-inp" id="tmplPopSubj" value="' + esc(sn) + '" placeholder="输入科目编码或名称" style="width:180px"></div>'
        + '<div class="tmpl-setting-row">'
        + '<span class="tmpl-setting-label">取数方式：</span>'
        + '<select class="tmpl-setting-sel" id="tmplPopDir" style="width:140px">'
        +   '<option value="end_balance"' + (!tpl.sourceDirection || tpl.sourceDirection === 'end_balance' ? ' selected' : '') + '>期末余额</option>'
        +   '<option value="period_dr"' + (tpl.sourceDirection === 'period_dr' ? ' selected' : '') + '>本期借方发生额</option>'
        +   '<option value="period_cr"' + (tpl.sourceDirection === 'period_cr' ? ' selected' : '') + '>本期贷方发生额</option>'
        + '</select></div>'
        + '<div class="tmpl-setting-hint" style="font-size:var(--fs-xs);color:var(--ty-text-3)">将按下方各行比例分摊该科目金额</div>';
    } else if (rule === 'per_row') {
      h += '<div class="tmpl-setting-hint" style="font-size:var(--fs-xs);color:var(--ty-text-3);margin:4px 0 8px">在下方表格每行独立填写金额</div>';
    } else { // none
      h += '<div class="tmpl-setting-hint" style="font-size:var(--fs-xs);color:var(--ty-text-3);margin:4px 0 8px">金额在下方表格每行手填，生成凭证时直接带出（适用于每月固定计提，如电话费 500）</div>';
    }
    box.innerHTML = h;
    // subject 规则：绑定 SubjectPicker
    if (rule === 'subject') {
      var subjInp = pop.querySelector('#tmplPopSubj');
      if (subjInp) bindSubjectPicker(subjInp, {
        bareInput: true,
        onPick: function (code, s) { subjInp.value = s && s.name ? (code + ' ' + s.name) : code; }
      });
    }
  }
  renderExtra(curRule);
  pop.querySelector('#tmplPopRule').addEventListener('change', function () { renderExtra(this.value); });

  // 定位
  var rect = anchor.getBoundingClientRect();
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.left = Math.max(8, rect.right - 260) + 'px';

  // 保存
  pop.querySelector('#tmplPopOk').addEventListener('click', function () {
    var rule = pop.querySelector('#tmplPopRule').value;
    var t = findSettleTemplate(settleTmplSelectedId);
    if (!t) { closeTplRowSettingPopover(); return; }
    t.ruleType = normRuleType(rule);
    // 按规则读额外字段
    if (rule === 'manual') {
      var taEl = pop.querySelector('#tmplPopTotal');
      t.totalAmount = U.num(String(taEl ? taEl.value : '').replace(/[,¥\s]/g, ''));
      t.sourceSubject = '';
    } else if (rule === 'subject') {
      var saEl = pop.querySelector('#tmplPopSubj');
      var raw = String(saEl ? saEl.value : '').trim();
      t.sourceSubject = raw.split(/\s+/)[0] || raw;
      var drEl = pop.querySelector('#tmplPopDir');
      t.sourceDirection = drEl ? drEl.value : 'end_balance';
      t.totalAmount = 0;
    } else {
      t.totalAmount = 0; t.sourceSubject = ''; t.sourceDirection = '';
    }
    persistSettleTemplates();
    closeTplRowSettingPopover();
    showToast('取数规则已更新：' + RULE_OPTIONS.filter(function (o) { return o.key === rule; })[0].label);
    renderNewTplRows();
    updateNewTplTotal();
  });
  pop.querySelector('#tmplPopCancel').addEventListener('click', closeTplRowSettingPopover);
  setTimeout(function () { document.addEventListener('click', _tplPopDocClick, true); }, 0);
}
function _tplPopDocClick(e) {
  if (!e.target.closest('.tmpl-setting-popover')) closeTplRowSettingPopover();
}
function closeTplRowSettingPopover() {
  document.removeEventListener('click', _tplPopDocClick, true);
  var pop = document.querySelector('.tmpl-setting-popover');
  if (pop) pop.remove();
}

// 收集有效分录（有科目编码的行）
function collectCustomTplRows() {
  // 带上当前模板的 ruleType：决定每行存「比例」还是存「金额」（详见 uiRowToTpl）
  var curTpl = findSettleTemplate(settleTmplSelectedId);
  var ruleType = normRuleType(curTpl ? curTpl.ruleType : 'none');
  return newTplRows.filter(function (r) { return String(r.code || '').trim(); })
    .map(function (r) { return uiRowToTpl(r, ruleType); });
}

// 分录校验：只要有金额，就必须一借一贷且借贷相等
function validateCustomTplRows(rows) {
  var dr = 0, cr = 0, withAmt = 0;
  rows.forEach(function (r) { var d = U.num(r.dr), c = U.num(r.cr); dr += d; cr += c; if (d || c) withAmt++; });
  dr = round2(dr); cr = round2(cr);
  if (!dr && !cr) return ''; // 纯结构模板（金额留待生成时补录）允许保存
  if (withAmt < 2) return '已填金额时至少需要两行分录（一借一贷）';
  if (Math.abs(dr - cr) >= 0.005) return '借贷合计不相等（借 ' + money(dr) + ' / 贷 ' + money(cr) + '），请检查金额';
  return '';
}

// 由模板分录生成凭证（支持四种取数规则）
function genVoucherFromTpl(t, silent) {
  if (!t) return false;
  var month = selMonth;
  if (S.isPeriodClosed(month)) { if (!silent) showToast('该期已结账，请先反结账再操作', 'error'); return false; }
  var ruleType = normRuleType(t.ruleType || 'none');
  var rows = (t.template || []).filter(function (r) { return String(r.code || '').trim(); });
  if (rows.length < 2) { if (!silent) showToast('模板「' + t.name + '」分录不完整：至少需要一借一贷两行，请先在「设置」里补全', 'error'); return false; }

  // ── 第一步：按 ruleType 计算每行的真实金额 ──
  var computed = rows.map(function (r) {
    return { code: r.code, summary: r.summary || t.summary || t.name, dc: r.dc || 'D', dr: 0, cr: 0 };
  });
  var totalAmount = 0;
  var srcLabel = '';

  if (ruleType === 'none' || ruleType === 'per_row') {
    // 不设置取数 / 逐行指定：直接读每行的 dr/cr（金额在模板分录里手填，生成时带出）
    computed.forEach(function (e, i) {
      e.dr = U.num(rows[i].dr); e.cr = U.num(rows[i].cr);
    });
    totalAmount = round2(computed.reduce(function (s, e) { return s + e.dr; }, 0));
    if (!totalAmount) { if (!silent) showToast('模板「' + t.name + '」尚未填写分录金额，请先在「设置」里填金额', 'error'); return false; }
    var crSum = round2(computed.reduce(function (s, e) { return s + e.cr; }, 0));
    if (Math.abs(totalAmount - crSum) >= 0.005) { if (!silent) showToast('模板「' + t.name + '」借贷不平（借 ' + money(totalAmount) + ' / 贷 ' + money(crSum) + '），请先修正模板', 'error'); return false; }

  } else if (ruleType === 'manual') {
    // 按统一金额(手填)分摊
    totalAmount = U.num(t.totalAmount);
    if (!totalAmount) { if (!silent) showToast('请先在「设置」里填统一金额', 'error'); return false; }
    srcLabel = '手填金额 ' + money(totalAmount);

  } else {
    // 按统一金额(科目金额)分摊
    var srcCode = String(t.sourceSubject || '').trim();
    if (!srcCode || !S.subject(srcCode)) { if (!silent) showToast('请先在「设置」里指定取金额科目', 'error'); return false; }
    var dir = t.sourceDirection || 'end_balance';
    if (dir === 'end_balance') {
      totalAmount = Math.abs(S.subjectEndBalance(srcCode, month));
    } else {
      var pa = S.subjectPeriodAmount(srcCode, month);
      totalAmount = (dir === 'period_dr') ? U.num(pa.dr) : U.num(pa.cr);
    }
    if (!totalAmount) { if (!silent) showToast('科目「' + srcCode + '」当期无可用金额', 'error'); return false; }
    srcLabel = S.subject(srcCode).name + ' ' + money(totalAmount);
  }

  // ── 第二步：分摊规则（manual / subject） → 算每行金额 ──
  if (ruleType === 'manual' || ruleType === 'subject') {
    // 校验比例合计
    var ratioSum = round2(rows.reduce(function (s, r) { return s + U.num(r.ratio); }, 0));
    if (Math.abs(ratioSum - 1) >= 0.005) { if (!silent) showToast('分摊比例合计需等于 100%（当前 ' + round2(ratioSum * 100) + '%），请修正模板', 'error'); return false; }
    // 按比例算金额，最后一行补差额防浮点误差
    var allocated = 0;
    computed.forEach(function (e, i) {
      if (i < computed.length - 1) {
        var amt = round2(totalAmount * U.num(rows[i].ratio));
        allocated += amt;
      } else {
        var amt = round2(totalAmount - allocated);
      }
      if (e.dc === 'C') e.cr = amt; else e.dr = amt;
    });
  }

  // ── 第三步：科目存在性检查 ──
  var missing = [];
  computed.forEach(function (e) {
    if (!S.subject(e.code) && missing.indexOf(e.code) < 0) missing.push(e.code);
  });
  if (missing.length) { if (!silent) showToast('模板里的科目在当前账套不存在：' + missing.slice(0, 5).join('、') + '，请先在「设置」里改掉', 'error'); return false; }

  // ── 第四步：生成凭证 ──
  var entries = computed.map(function (e) {
    var s = S.subject(e.code);
    return { code: e.code, name: s ? s.name : '', summary: e.summary, dr: e.dr, cr: e.cr };
  });
  var rr = genOnceVoucher(month, 'settleTpl:' + t.id, t.summaryText || t.summary || t.name, entries, t.word || '记', tmplVoucherDate(month, t));
  if (!rr.ok) { if (!silent) showToast(rr.msg, 'error'); return false; }
  if (!silent) {
    var baseMsg = srcLabel ? ('来源：' + srcLabel + '　') : '';
    showToast('已生成凭证 ' + (rr.v.word || '记') + '-' + rr.v.no + '（' + t.name + ' ' + money(totalAmount) + '）　' + baseMsg);
    refreshSettle();
    syncAll();
  }
  return true;
}














// 保存当前表单面板（系统/已有模板的字段改动）
function saveSettleTmplForm() {
  var t = findSettleTemplate(settleTmplSelectedId);
  // 新增模板（custom 且 editingCustomId 找不到）：自动创建
  if (!t && editingCustomId) {
    settleTmplList.push({
      id: editingCustomId, name: settleTmplSelectedId || '自定义模板', enabled: true, custom: true,
      summary: '', word: '记', template: [], hasEntries: false
    });
    t = findSettleTemplate(editingCustomId);
  }
  if (!t) return;
  // 从 input 读模板名称（仅自定义/预置模板可改名）
  var nm = $('settleTmplFormName'); if ((t.custom || t.preset) && nm && nm.value.trim()) t.name = nm.value.trim();
  var en = $('settleTmplFormEnabled'); if (en) t.enabled = en.checked;
  var wd = $('settleTmplFormWord'); if (wd) t.word = wd.value || '记';
  if (t.id === 'cost') {
    var rev = $('settleTmplCostRevSubj'); if (rev) t.costRevSubj = rev.value;
    var inv = $('settleTmplCostInvSubj'); if (inv) t.costInvSubj = inv.value;
    var prod = $('settleTmplCostProdSubj'); if (prod) t.costProdSubj = prod.value;
    var rate = $('settleTmplCostRate'); if (rate) t.costRate = rate.value;
    var amt = $('settleTmplCostAmt'); if (amt) t.costAmount = amt.value;
    var csm = $('settleTmplCostSummary'); if (csm) t.costSummary = csm.value;
  }
  // 系统模板通用参数（profit / dep；vat / surTax / incTax 已下线 2026-09-18）
  if (t.id === 'profit') {
    var pt = $('settleTmplProfitTarget'); if (pt) t.targetSubj = pt.value.trim();
    var ps = $('settleTmplProfitSeparateSel'); if (ps) t.separate = ps.value === 'true';
  }
  // 凭证摘要（通用卡片头）：所有模板均可编辑并保存
  var sm = $('settleTmplSummaryText'); if (sm) t.summaryText = sm.value;
  // 凭证日期（当期日期 / 期末最后一天）
  var dt = $('settleTmplFormDate'); if (dt) t.voucherDate = dt.value || 'period';
  // custom=true 模板：保存分录表格数据（校验借贷平衡）
  if (t.custom) {
    var rows = collectCustomTplRows();
    var bad = validateCustomTplRows(rows);
    if (bad) { showToast(bad, 'error'); return false; }
    t.template = rows;
    t.hasEntries = rows.length > 0;
    // 预置摊销模板：用摘要作为默认名称（如果未显式改过）
    if (t.preset && (!t.summary || t.summary === '')) t.summary = t.name;
  }
  persistSettleTemplates();
  renderSettleTmplTree();
  refreshSettle();
  showToast('已保存模板：' + t.name);
}

if ($('btnSettleTmplClose')) $('btnSettleTmplClose').addEventListener('click', closeSettleTemplateModal);
// 弹窗启用开关：改了立即生效（persist + 刷新左侧分组 + 页面卡片）
var _tmplEnCb = $('settleTmplFormEnabled');
if (_tmplEnCb) _tmplEnCb.addEventListener('change', function () {
  var t = findSettleTemplate(settleTmplSelectedId);
  if (!t) return;
  t.enabled = _tmplEnCb.checked;
  persistSettleTemplates();
  renderSettleTmplList();  // 左侧启用/禁用分组重排
  refreshSettle();         // 页面卡片显隐刷新
  showToast((t.enabled ? '已启用' : '已禁用') + '：' + t.name, 'success');
});
// 检查项设置弹窗
if ($('btnSettleCheck')) $('btnSettleCheck').addEventListener('click', openSettleCheckModal);
if ($('btnSettleCheckClose')) $('btnSettleCheckClose').addEventListener('click', closeSettleCheckModal);
if ($('btnSettleCheckCancel')) $('btnSettleCheckCancel').addEventListener('click', closeSettleCheckModal);

function openSettleCheckModal() {
  var month = selMonth;
  var body = $('settleCheckBody');
  if (!body) return;
  var all = (typeof S.settleChecklist === 'function') ? S.settleChecklist(month) : [];
  var ov = (S.state.param && S.state.param.checkOverrides) || {};
  var html = '<div class="scc-head">根据业务需求选择，选择「仅提醒」后该项不再拦截结账。</div>';
  if (!all.length) html += '<div class="scc-empty">本期无检查项</div>';
  all.forEach(function (c) {
    var cur = ov[c.key] || (c.status === 'warn' ? 'warn' : 'block');
    if (cur === 'off') cur = 'block';
    html += '<div class="scc-row"><span class="scc-name">' + esc(c.label) + '</span>' +
      '<select class="scc-sel" data-key="' + c.key + '">' +
      '<option value="block"' + (cur === 'block' ? ' selected' : '') + '>未通过则拦截</option>' +
      '<option value="warn"' + (cur === 'warn' ? ' selected' : '') + '>仅提醒</option>' +
      '</select></div>';
  });
  body.innerHTML = html;
  body.querySelectorAll('.scc-sel').forEach(function (sel) {
    sel.addEventListener('change', function () {
      S.state.param = S.state.param || {};
      S.state.param.checkOverrides = S.state.param.checkOverrides || {};
      S.state.param.checkOverrides[sel.getAttribute('data-key')] = sel.value;
      S.persist();
      refreshSettle();
    });
  });
  openModal('settleCheckModal');
}
function closeSettleCheckModal() { closeModal('settleCheckModal'); }
// 弹窗内：新增模板 / 保存 / 取消 / 导入 / 导出
if ($('btnSettleTmplNew')) $('btnSettleTmplNew').addEventListener('click', showSettleTmplNewPanel);
if ($('btnSettleTmplSave')) $('btnSettleTmplSave').addEventListener('click', function () {
  // 统一走 saveSettleTmplForm（现在 custom=true 模板也走 FormPanel）
  var ok = saveSettleTmplForm();
  if (ok !== false) closeSettleTemplateModal();
});
if ($('btnSettleTmplCancel')) $('btnSettleTmplCancel').addEventListener('click', closeSettleTemplateModal);
// 分录表格事件（tbody 事件委托，绑定一次）
bindNewTplBodyEvents();
// 表头「设置」链接 → 模板级取数规则 popover
document.addEventListener('click', function (e) {
  var el = e.target;
  if (!el || !el.classList || !el.classList.contains('tmpl-setting-link')) return;
  if (el.getAttribute('data-op') !== 'setting') return;
  e.preventDefault();
  openTplRulePopover(el);
});
if ($('btnSettleTmplDelete')) $('btnSettleTmplDelete').addEventListener('click', async function () {
  var t = findSettleTemplate(settleTmplSelectedId);
  if (!t) return;
  if (!t.custom && !t.preset) return showToast('系统模板不可删除', 'warn');
  if (!(await H.confirmAsync('确认删除模板「' + t.name + '」？', { title: '删除模板' }))) return;
  settleTmplList = settleTmplList.filter(function (x) { return x !== t; });
  // 预置摊销模板删除后记入 dismissed，防止刷新后复活（与卡片删除逻辑一致）
  if (t.preset) {
    try {
      var DISMISS_KEY = 'settle_preset_dismissed';
      var d = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
      if (!Array.isArray(d)) d = [];
      if (d.indexOf(t.id) < 0) { d.push(t.id); localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); }
    } catch (e) {}
  }
  persistSettleTemplates();
  // 删除后留在设置弹窗内：刷新左侧列表，并自动选中下一个模板（无则清空表单）
  renderSettleTmplTree();
  if (settleTmplList.length) selectSettleTemplate(settleTmplList[0].id);
  else { settleTmplSelectedId = null; var fp = $('settleTmplFormPanel'); if (fp) fp.style.display = 'none'; }
  refreshSettle();
  showToast('已删除模板「' + t.name + '」');
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
  renderSettleTmplList: renderSettleTmplList,
  saveSettleTemplate: saveSettleTemplate
};

export { refreshSettle };
