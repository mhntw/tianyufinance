// 页面模块（B 方案解耦）：设置-期初余额
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__TY_HELPERS__（app.js 注册）、globalThis.__TY_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

const H = globalThis.__TY_HELPERS__ || {};
const EX = globalThis.__TY_EXPORT__ || {};
const $ = H.$;
const money = H.money;
import { exportTable } from './_shared.js'; // 修复：此前 H.exportTable 未挂全局，期初导出是 undefined 会抛错
const showToast = H.showToast;
const S = H.S || (EX && EX.store);
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);

// 幂等绑定：避免模块延迟执行导致的重复/失败绑定
function onBtn(id, fn) {
  var el = $(id);
  if (el && !el._bound) { el._bound = true; el.addEventListener('click', fn); }
}

/* ============================================================
 * 设置：期初余额
 * ============================================================ */
function refreshOpening() { renderOpening(); }
function renderOpening() {
  var tb = $('openBody'); tb.innerHTML = '';
  S.subjects().forEach(function (s) {
    var o = S.opening(s.code);
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + s.code + '</td><td>' + s.name + '</td><td>' + ACCOUNT_CLASSES[s.cls].side + '</td>' +
      '<td><input class="inp open-yb num" data-code="' + s.code + '" type="number" step="0.01" value="' + o.yb + '"></td>' +
      '<td><input class="inp open-ytddr num" data-code="' + s.code + '" type="number" step="0.01" value="' + o.ytdDr + '"></td>' +
      '<td><input class="inp open-ytdcr num" data-code="' + s.code + '" type="number" step="0.01" value="' + o.ytdCr + '"></td>' +
      '<td><input class="inp open-dr num" data-code="' + s.code + '" type="number" step="0.01" value="' + o.dr + '"></td>' +
      '<td><input class="inp open-cr num" data-code="' + s.code + '" type="number" step="0.01" value="' + o.cr + '"></td>';
    tb.appendChild(tr);
  });
  renderOpenCheck();
}

function bindOpeningEvents() {
  // openBody 的 input 监听绑定在父元素（事件委托），innerHTML 重建子元素不影响父监听，仅绑一次
  var tb = $('openBody');
  if (tb && !tb._bound) {
    tb._bound = true;
    tb.addEventListener('input', function (e) {
      var t = e.target;
      if (t.classList.contains('open-yb') || t.classList.contains('open-ytddr') || t.classList.contains('open-ytdcr') || t.classList.contains('open-dr') || t.classList.contains('open-cr')) {
        var code = t.getAttribute('data-code');
        var row = t.parentElement.parentElement;
        var yb = row.querySelector('.open-yb').value;
        var ytdDr = row.querySelector('.open-ytddr').value;
        var ytdCr = row.querySelector('.open-ytdcr').value;
        var dr = row.querySelector('.open-dr').value;
        var cr = row.querySelector('.open-cr').value;
        var r = S.setOpening(code, dr, cr, yb, ytdDr, ytdCr);
        if (r && !r.ok) {
          showToast(r.msg, 'error');
          // 拒绝录入父科目自身期初后，清空该行避免残留半填状态
          row.querySelector('.open-yb').value = ''; row.querySelector('.open-ytddr').value = '';
          row.querySelector('.open-ytdcr').value = ''; row.querySelector('.open-dr').value = '';
          row.querySelector('.open-cr').value = '';
        }
        renderOpenCheck();
      }
    });
  }
  onBtn('btnSaveOpening', function () {
    // 保存前先校验借贷平衡：不平衡即阻断落盘并明确提示差额，
    // 避免"看着保存成功、回头试算失衡"这类假象（期初表已能实时显示平衡状态）。
    var c = S.openingBalanceCheck();
    if (!c.balanced) {
      showToast('期初借贷不平衡，无法保存（借 ' + money(c.dr) + ' / 贷 ' + money(c.cr) + '，差 ' + money(Math.abs(c.dr - c.cr)) + '）', 'error');
      return;
    }
    S.persist();
    showToast('期初余额已保存');
  });
  // 「试算平衡」：校验期初借贷是否平衡
  onBtn('btnOpenCheck', function () {
    var c = S.openingBalanceCheck();
    if (c.balanced) showToast('试算平衡：借 ' + money(c.dr) + ' = 贷 ' + money(c.cr));
    else showToast('试算不平衡，差 ' + money(Math.abs(c.dr - c.cr)), 'error');
  });
  onBtn('btnOpenExport', function () {
    var rows = S.subjects().map(function (s) {
      var o = S.opening(s.code);
      return { 科目编码: s.code, 科目名称: s.name, 方向: ACCOUNT_CLASSES[s.cls].side, 年初余额: o.yb, 本年累计借: o.ytdDr, 本年累计贷: o.ytdCr, 期初借方: o.dr, 期初贷方: o.cr };
    });
    exportTable(rows, '期初余额');
  });
}

function renderOpenCheck() {
  var c = S.openingBalanceCheck();
  var el = $('openCheck');
  if (c.balanced) { el.innerHTML = '借贷平衡：借 ' + money(c.dr) + ' = 贷 ' + money(c.cr); el.className = 'open-check ok'; }
  else { el.innerHTML = '借贷不平衡：借 ' + money(c.dr) + ' ≠ 贷 ' + money(c.cr) + '（差 ' + money(Math.abs(c.dr - c.cr)) + '）'; el.className = 'open-check warn'; }
}

// 入口：每次打开期初余额页均重绑一次（按钮用 onBtn 幂等，openBody 仅绑一次）
function setupOpening() { bindOpeningEvents(); }

// 自挂载 + 导出（供 main.js 注册）
globalThis.__OPENING__ = {
  refreshOpening: refreshOpening,
  renderOpening: renderOpening,
  setupOpening: setupOpening
};
