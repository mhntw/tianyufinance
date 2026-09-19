/* ============================================================
 * js/pages/voucher/Voucher.js — 凭证域（录入 / 汇总 / 查询）
 * B 方案迁移：从 app.js IIFE 中整体剥离凭证域逻辑。
 * 逻辑逐字一致，仅：① 状态变量提升为模块级；② 事件绑定改为
 * setupVoucher() 惰性守卫（首次 refresh 调用时执行一次）；③ 金额
 * 金额位格 helper 自带副本，避免跨模块/跨 IIFE 泄漏。
 * 对外：export refreshVoucher/refreshSum/refreshQuery（main.js 挂 __renderXxx）；
 *       同时挂 globalThis.__VOUCHER__ 供 app.js 路由与查询页点击调用。
 *
 * 依赖桥接：app.js 顶层已把通用 helper 挂到 globalThis.__TY_HELPERS__，
 * 这里优先取桥接，缺失项做轻量 fallback（不影响既有逻辑）。
 * ============================================================ */
const H = globalThis.__TY_HELPERS__ || {};
// 起止期间取值：统一走 app.js 的单点实现（含默认值兜底），页面不再各自决定默认期间
const periodRangeValue = H.periodRangeValue;
const U = H.U || window.util;
const S = H.S || window.S;
const $ = function (id) { return document.getElementById(id); };
import { matchSubjectCode, bindSubjectPicker } from '../../components/SubjectPicker.js?v=dev';
import { subjectFullName } from '../../common/subject-name.js';

/* —— 金额位格 helper（副本，纯函数，逐字自 app.js） —— */
function amtInnerHtml(value, isNumber, activeIndex, red, hideValueLayer, force2) {
  var raw = (value === '' || value == null || value === 0) ? '' : value.toString();
  var t = raw;
  if (force2 && t && parseFloat(t)) t = parseFloat(t).toFixed(2);
  t = t.replace('-', '');
  if (t.length > 12) {
    return '<div class="amt-bg amt-trillion' + (red ? ' amt-red' : '') + '">' +
      (parseFloat(t) ? parseFloat(t).toFixed(2) : t) + '</div>';
  }
  var chars = (Array(12).join('_') + t.replace('.', '')).slice(-11).split('').map(function (e) { return e.replace('_', ''); });
  var cells = '';
  for (var k = 0; k < 11; k++) {
    var active = (activeIndex === k) ? ' amt-cell-active' : '';
    // 数字直接落进各自位格（flex 居中），不依赖 letter-spacing，换字体也不错位
    cells += '<div class="amt-cell' + active + '">' + chars[k] + '</div>';
  }
  return '<div class="amt-bg' + (red ? ' amt-red' : '') + '">' + cells + '</div>';
}
function isRed(val) {
  return (val !== '' && val != null && String(val).indexOf('-') >= 0 && !isNaN(parseFloat(val)));
}
// 金额转中文大写（通用财务口径）：壹万捌仟捌佰壹拾伍元整 / 壹佰贰拾叁元肆角伍分
function numToChinese(n) {
  if (n == null || isNaN(n)) return '';
  var num = Math.round(parseFloat(n) * 100) / 100;
  if (num === 0) return '零元整';
  var neg = num < 0;
  num = Math.abs(num);
  var digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  var units = ['', '拾', '佰', '仟'];
  var bigUnits = ['', '万', '亿', '兆'];
  // 拆整数/小数
  var intPart = Math.floor(num);
  var decPart = Math.round((num - intPart) * 100);
  var decJiao = Math.floor(decPart / 10);
  var decFen = decPart % 10;
  // 整数部分：四位一组
  function intToChinese(v) {
    if (v === 0) return '零';
    var groups = [];
    var cur = v;
    while (cur > 0) { groups.push(cur % 10000); cur = Math.floor(cur / 10000); }
    var parts = [];
    for (var gi = groups.length - 1; gi >= 0; gi--) {
      var g = groups[gi];
      if (g === 0) {
        if (parts.length && parts[parts.length - 1] !== '零') parts.push('零');
        continue;
      }
      var gStr = '';
      var zeroFlag = false;
      var hasNonZero = false;
      for (var i = 3; i >= 0; i--) {
        var d = Math.floor(g / Math.pow(10, i)) % 10;
        if (d === 0) {
          if (hasNonZero) zeroFlag = true;
        }
        else {
          if (zeroFlag) { gStr += '零'; zeroFlag = false; }
          gStr += digits[d] + units[i];
          hasNonZero = true;
        }
      }
      gStr += bigUnits[gi];
      parts.push(gStr);
    }
    return parts.join('');
  }
  var result = '';
  if (intPart > 0) result += intToChinese(intPart) + '元';
  // 小数部分
  if (decJiao === 0 && decFen === 0) {
    result += '整';
  } else {
    if (decJiao === 0) {
      if (intPart > 0) result += '零';
      result += digits[decFen] + '分';
    } else {
      result += digits[decJiao] + '角';
      if (decFen > 0) result += digits[decFen] + '分';
    }
  }
  return (neg ? '负' : '') + result;
}
// 金额「数字位灯」：计算金额最高有效位在 11 位位格中的索引（0=亿 … 10=分；无有效数字返回 -1）
function highestDigitIndex(rawValue) {
  var n = parseFloat(rawValue);
  if (!n || isNaN(n)) return -1;
  var s = n.toFixed(2).replace('-', '').replace('.', ''); // 两位小数，去负号与小数点，右对齐位格
  var chars = (Array(12).join('_') + s).slice(-11).split('');
  for (var k = 0; k < 11; k++) {
    var c = chars[k];
    if (c && c !== '_' && c !== '0') return k;
  }
  return -1;
}
// 表头金额单位行（副本，自 app.js，支持 activeIndex 高亮当前位）
function amtHeaderHtml(title, activeIndex) {
  return '<div class="amt-header">' +
    '<div class="amt-title">' + title + '</div>' +
    '<div class="amt-units-wrap">' + amtInnerHtml('亿千百十万千百十元角分', false, (activeIndex == null ? -1 : activeIndex), false) + '</div>' +
    '</div>';
}
function amtCellHtml(val, cls, i) {
  var field = cls.split(' ')[0];
  var num = parseFloat(val);
  var displayVal = (num > 0) ? num.toFixed(2) : '';
  return '<td class="col-amount has-input" data-field="' + field + '" data-i="' + i + '">' +
    '<div class="amt-bg">' + amtInnerHtml(val, true, -1, isRed(val), true, true) + '</div>' +
    '<input class="amt-edit-input ' + cls + '" data-i="' + i + '" type="text" ' +
    'inputmode="decimal" value="' + displayVal + '">' +
    '</td>';
}
function clearAmtCells(tr, key) {
  if (!tr) return;
  var inp = tr.querySelector('[data-field="v-' + key + '"] .amt-edit-input');
  if (inp) inp.value = '';
}
function trOf(el) { return el ? el.closest('tr') : null; }
function money(n) { return H.money ? H.money(n) : (U ? U.money(n) : String(n)); }
// 用户自由录入文本渲染进 HTML / 属性前转义，避免破坏单元格结构
// HTML 转义统一走 H.esc（单点实现）。
const escHtml = H.esc;
const escAttr = escHtml;
// 金额解析：先剥离千分位逗号（半角,、全角，、顿号、）与货币符号/空格，并把全角小数点．归一为 .，
// 避免中文输入法打出的 "1，23" / "1，0352.25" 被裸 parseFloat 在逗号处截断成 1。
// 优先走桥接 H.num（与 store.num 口径一致），缺失时 fallback 也基于已清洗的字符串解析。
function num(v) {
  var s = (v == null ? '' : String(v))
    .replace(/[,\uFF0C\u3001]/g, '').replace(/\uFF0E/g, '.')
    .replace(/[¥￥\s]/g, '');
  return H.num ? H.num(s) : (parseFloat(s) || 0);
}
// 第三参 ms 透传给桥接层 showToast（长文案需要更长停留时间，否则读不完）
function showToast(msg, type, ms) { if (H.showToast) H.showToast(msg, type, ms); else console.warn('[toast]', msg); }
function syncAll() { if (H.syncAll) H.syncAll(); }
function goPage(p, path) { if (H.goPage) H.goPage(p, path); }
function currentPeriod() { return H.currentPeriod ? H.currentPeriod() : ''; }
function monthOf(d) { return H.monthOf ? H.monthOf(d) : (d || '').slice(0, 7); }

/* —— 凭证域状态 —— */
let vRows = [];
let vEditId = null;
let savingVoucher = false; // 凭证保存防重标志（防止连续点击/网络重发重复生成凭证）
// 本次编辑已上传的附件：[{name, path, size}]。仅存元信息（路径指向 data/attachments/ 下的实体文件），
// 不把文件内容塞进账套 JSON，避免账套体积膨胀与备份/迁移变慢。
let vAttachFiles = [];

function defaultVoucherRow() { return { summary: '', code: '', name: '', dr: 0, cr: 0, cashActivity: '' }; }

/* ============================================================
 * 凭证录入
 * ============================================================ */
function renderVoucherRows() {
  var tb = $('vRows');
  if (!tb) return;
  tb.innerHTML = '';
  vRows.forEach(function (r, i) {
    var tr = document.createElement('tr');
    var ops = '<span class="row-ops">'
      + '<button class="btn-row-op" data-act="add" data-i="' + i + '" title="增加分录">＋</button>'
      + '<button class="btn-row-op btn-row-del" data-act="del" data-i="' + i + '" title="删除此行">－</button>'
      + '</span>';
    tr.innerHTML =
      '<td class="col-num ta-c"><span class="row-num">' + (i + 1) + '</span>' + ops + '</td>' +
      '<td><input class="v-summary" data-i="' + i + '" value="' + (r.summary || '') + '"></td>' +
      // 科目列：编码输入框 + 右侧科目名称（形态：一眼看到「1001 库存现金」）
      // 名称仅作展示、不进输入框，避免 value 混入名称后被当成编码写回。
      '<td class="col-subj">'
      + '<div class="v-subj-main">'
      + '<input class="inp v-code" data-i="' + i + '" value="' + escAttr(r.code || '') + '" size="' + (r.code ? Math.max(5, String(r.code).length + 1) : 12) + '" placeholder="科目编码/名称" autocomplete="off">'
      + '<span class="v-subj-name" data-i="' + i + '">' + escHtml(vchSubjNameOf(r)) + '</span>'
      + '</div>'
      + '<div class="v-subj-bal" data-i="' + i + '"></div>'
      + '</td>' +
      amtCellHtml(r.dr, 'v-dr', i) +
      amtCellHtml(r.cr, 'v-cr', i) + '</tr>';
    tb.appendChild(tr);
    // 初始渲染：金额列 td 默认加 amt-blur，隐藏 input、只显示位格 cells（否则 input.value 和 cells 两层叠一起重叠）
    tr.querySelectorAll('.col-amount.has-input').forEach(function (td) { td.classList.add('amt-blur'); });
    // 科目选择：复用统一科目选择组件（SubjectPicker）的扁平列表弹层（点输入框即展开）
    var codeInput = tb.querySelector('input[data-i="' + i + '"].v-code');
    bindSubjectPicker(codeInput, {
      getSubjects: function () { return (typeof S !== 'undefined' && S.subjects) ? S.subjects() : []; },
      onPick: function (code) {
        codeInput.value = String(code);
        codeInput.dispatchEvent(new Event('input', { bubbles: true }));
        // 选完焦点跳到借方金额
        setTimeout(function () {
          var dr = tb.querySelector('tr:last-child .v-dr');
          if (dr) dr.focus();
        }, 0);
      }
    });
    // 整个科目格（含名称 span / 留白）点击也能弹出选择，而不只输入框
    var subjCell = codeInput.closest('td.col-subj');
    if (subjCell) subjCell.addEventListener('click', function () { codeInput.focus(); });
    // 编码输入框随内容长度自适应宽度，让科目名称紧跟编码；
    // 空状态放宽到 12 以完整显示占位提示，一旦有编码即缩窄
    codeInput.addEventListener('input', function () {
      codeInput.size = codeInput.value ? Math.max(5, codeInput.value.length + 1) : 12;
    });
  });
  updateAmtTotals(); // 合计与借贷平衡提示统一收敛于此，避免与 updateAmtTotals 重复计算
}

// 科目名称展示（完整路径名）：统一走共享实现 common/subject-name.js
// （录凭证科目栏与科目联想下拉共用同一套拼接规则，避免两处逻辑漂移）
function vchSubjNameOf(r) {
  if (!r) return '';
  return subjectFullName(r.code, r.name);
}
// 只更新名称文本节点，不重建整行（避免输入框失焦/光标跳动、下拉被销毁）
function syncSubjName(i) {
  var box = document.querySelector('#vRows .v-subj-name[data-i="' + i + '"]');
  if (box) box.textContent = vchSubjNameOf(vRows[i]);
  syncAllSubjBals();   // 科目变化 → 同步刷新余额提示（式实时显示）
}

/* —— 科目余额提示（科目下方一行小字，随借/贷金额实时变化） ——
 * 口径 = generalLedger 该科目余额（借正贷负，已含下级）
 *      + 本张凭证中该科目已录入金额（借正贷负，含当前正在编辑的行）
 * 展示 = 按科目正常方向取正（资产/成本/费用类看借方、负债/权益/收入类看贷方），
 *        反向余额直接带负号（如资产类出现贷方余额显示 -100.00）。
 * 注：generalLedger 有按月记忆化缓存，此处一次遍历建映射，行数少、开销可忽略。 */
function syncAllSubjBals() {
  if (!vRows || !vRows.length) return;
  // 余额期间取「凭证日期所在期间」（改日期即换期，余额随之变化），无日期时回退当前期间
  var dv = $('vDate');
  var month = (dv && dv.value) ? monthOf(dv.value) : currentPeriod();
  var balMap = {};                                    // code → 借正贷负余额
  (S.generalLedger(month) || []).forEach(function (r) {
    var b = Number(r.balance) || 0;
    balMap[r.code] = (r.dir === '借' ? b : -b);
  });
  var deltaMap = {};                                  // code → 本张凭证已录净额（借正贷负）
  vRows.forEach(function (r) {
    if (!r.code) return;
    deltaMap[r.code] = (deltaMap[r.code] || 0) + (U.num(r.dr) - U.num(r.cr));
  });
  vRows.forEach(function (r, i) {
    var el = document.querySelector('#vRows .v-subj-bal[data-i="' + i + '"]');
    if (!el) return;
    var c = String(r.code || '');
    var s = c ? S.subject(c) : null;
    if (!s) { el.textContent = ''; return; }
    var signed = (balMap[c] || 0) + (deltaMap[c] || 0);
    var disp = (s.normal === 'cr') ? -signed : signed;
    el.textContent = '余额：' + money(disp);
  });
}

function refreshVoucher() {
  setupVoucher();
  if (!vRows.length && !vEditId) resetVoucherEdit();
}

// 填充录凭证"凭证字"下拉：按启用凭证字动态生成（停用字不出现，与设置页停用联动）
function fillVoucherWord() {
  var w = $('vWord'); if (!w) return;
  var words = (S.state.voucherWords && S.state.voucherWords.length)
    ? S.state.voucherWords.filter(function (x) { return x.enabled !== false; })
    : [{ name: '记' }];
  var cur = w.value || S.state.param.voucherWord || '记';
  w.innerHTML = words.map(function (x) { return '<option value="' + (x.name || x.code) + '">' + (x.name || x.code) + '</option>'; }).join('');
  if (words.some(function (x) { return (x.name || x.code) === cur; })) w.value = cur;
  else w.value = words[0] ? (words[0].name || words[0].code) : '记';
}

function resetVoucherEdit() {
  vEditId = null;
  vRows = [defaultVoucherRow(), defaultVoucherRow(), defaultVoucherRow(), defaultVoucherRow()];
  // 新增模式：隐藏删除、显示保存并新增
  var bDel = $('btnDeleteVoucher'); if (bDel) bDel.hidden = true;
  var bSn = $('btnSaveNewVoucher'); if (bSn) bSn.hidden = false;
  fillVoucherWord();
  var w = $('vWord'); if (w) w.value = S.state.param.voucherWord || '记';
  // workMonth = 当前账期（currentPeriod 已统一为：最近已结账+1 / 最近有凭证 / 自然月）
  var workMonth = currentPeriod();
  var today = H.todayStr ? H.todayStr() : todayStr();

  var dt = $('vDate');
  if (dt) {
    var comp = (S.state && S.state.company) || {};
    var sm = comp.startMonth ? (comp.startMonth + '-01') : '';
    if (sm) dt.min = sm;
    dt.max = today;
    // 默认日期：今天在工作期间内 → 今天；否则 → 工作期间最后一天
    var def;
    if (today >= (workMonth + '-01') && today <= (workMonth + '-31')) {
      def = today;
    } else {
      def = U.lastDay(workMonth);
    }
    if (sm && def < sm) def = sm;
    dt.value = def;
  }
  var no = $('vNo'); if (no) no.value = S.nextVoucherNo($('vWord').value, workMonth);

  // 同步凭证头期间文本，和顶部「当前账期」完全一致
  var vpt = $('vPeriodText');
  if (vpt) vpt.textContent = workMonth.slice(0, 4) + '年第' + (+workMonth.slice(5, 7)) + '期';

  var at = $('vAttach'); if (at) at.value = 0;
  vAttachFiles = [];
  renderAttachPanel();
  renderVoucherRows();
}

/* ===================== 凭证附件上传 ===================== */
// 点击「上传附件」→ 唤起文件选择 → 逐个以 base64 送 Rust 落盘到 <数据目录>/attachments/
// → 记录 {name, path, size} 元信息，并回写「附件张数」。
//
// 关键：base64 编码必须走 file-save-bridge 暴露的 bytesToBase64（整段拼完再一次性 btoa）。
// 绝不能分块 btoa 后拼接 —— 那会在串中间产生 padding '='，Rust 端报 Invalid symbol 61。
function bytesToBase64Safe(u8) {
  var bridge = window.__fileSaveBridge;
  if (bridge && typeof bridge.bytesToBase64 === 'function') return bridge.bytesToBase64(u8);
  var bin = '';
  var chunk = 0x8000;
  for (var i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function renderAttachPanel() {
  var panel = $('vAttachPanel');
  if (!panel) return;
  if (!vAttachFiles.length) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  panel.innerHTML = vAttachFiles.map(function (f, i) {
    return '<div class="vh-attach-item" title="' + (f.name || '') + '">' +
      '<span class="vh-attach-name">' + (f.name || '') + '</span>' +
      '<a href="#" class="vh-attach-del" data-i="' + i + '" title="移除">✕</a>' +
      '</div>';
  }).join('');
}

// 附件张数默认跟随实际文件数；用户手工改过则以手工值为准（不再自动覆盖）
function syncAttachCount() {
  var at = $('vAttach');
  if (at) at.value = vAttachFiles.length;
}

async function uploadAttachFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  if (!files.length) return;
  var tauri = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  if (!tauri || !tauri.invoke) {
    showToast('当前环境不支持附件保存，请使用桌面版', 'error');
    return;
  }
  var ok = 0, failMsg = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    try {
      var buf = new Uint8Array(await f.arrayBuffer());
      var path = await tauri.invoke('save_attachment', {
        name: f.name || ('附件' + (i + 1)),
        base64: bytesToBase64Safe(buf)
      });
      vAttachFiles.push({ name: f.name || '', path: path, size: f.size || 0 });
      ok++;
    } catch (e) {
      failMsg = (f.name || '') + '：' + (e && e.message || e);
    }
  }
  syncAttachCount();
  renderAttachPanel();
  if (ok) showToast('已上传 ' + ok + ' 个附件', 'success');
  if (failMsg) showToast('部分附件上传失败：' + failMsg, 'error');
}

function bindAttachUpload() {
  var link = $('vUploadAttach'), input = $('vAttachFile'), panel = $('vAttachPanel');
  if (link && !link.__attachBound) {
    link.__attachBound = true;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      if (input) input.click();
    });
  }
  if (input && !input.__attachBound) {
    input.__attachBound = true;
    input.addEventListener('change', async function () {
      await uploadAttachFiles(this.files);
      this.value = ''; // 清空以便重复选择同一文件也能触发 change
    });
  }
  if (panel && !panel.__attachBound) {
    panel.__attachBound = true;
    panel.addEventListener('click', function (e) {
      var del = e.target.closest('.vh-attach-del');
      if (!del) return;
      e.preventDefault();
      var i = +del.getAttribute('data-i');
      vAttachFiles.splice(i, 1);
      syncAttachCount();
      renderAttachPanel();
    });
  }
}

function updateAmtTotals() {
  var drT = 0, crT = 0;
  vRows.forEach(function (r) { drT += U.num(r.dr); crT += U.num(r.cr); });
  var drTd = $('vDrTotal'), crTd = $('vCrTotal');
  if (drTd) drTd.innerHTML = amtInnerHtml(drT, false, -1, isRed(drT), false, true);
  if (crTd) crTd.innerHTML = amtInnerHtml(crT, false, -1, isRed(crT), false, true);
  // 大写金额（借贷平衡时取合计，不平衡时取借贷差额）
  var cnTd = $('vTotalCn');
  if (cnTd) {
    var bal = Math.abs(drT - crT) < 0.005 ? drT : Math.abs(drT - crT);
    cnTd.textContent = numToChinese(bal);
  }
  var tip = $('vBalanceTip');
  if (vRows.length && Math.abs(drT - crT) >= 0.005) {
    tip.textContent = '借贷不平衡！差 ' + money(Math.abs(drT - crT));
    tip.className = 'voucher-balance warn';
  } else {
    tip.textContent = '借贷平衡';
    tip.className = 'voucher-balance ok';
  }
  // 科目余额提示随金额实时刷新（录入借/贷金额 → 该行科目余额立即变化）
  syncAllSubjBals();
}

/* —— 一次性事件绑定（惰性守卫） —— */
function setupVoucher() {
  var root = document.getElementById('vRows');
  if (root && root.dataset.ready) return;
  if (root) root.dataset.ready = '1';

  bindAttachUpload();   // 附件上传绑定

  // 凭证日期变化 → 科目余额提示换期重算（余额按日期所在期间取）
  // 同时：跨月时凭证号自动取下一月的编号（不跨月不变）
  var dvEl = $('vDate');
  if (dvEl) dvEl.addEventListener('change', function () {
    syncAllSubjBals();
    if (!vEditId) {
      var w = $('vWord'); var no = $('vNo');
      if (w && no) no.value = S.nextVoucherNo(w.value, monthOf(dvEl.value));
    }
  });

  $('vRows').addEventListener('input', function (e) {
    var t = e.target, i = +t.getAttribute('data-i');
    if (t.classList.contains('v-summary')) {
      vRows[i].summary = t.value;
      return; // 摘要输入无需重建 DOM，直接返回，避免重建导致输入框丢失焦点（光标跳动）
    }
    else if (t.classList.contains('v-code')) {
      vRows[i].code = t.value;
      var s = S.subject(t.value); vRows[i].name = s ? s.name : '';
      syncSubjName(i);   // 手输编码时同步右侧名称
      return; // 科目输入无需重建 DOM，直接返回，避免重建导致科目下拉丢失焦点
    } else if (t.classList.contains('v-dr') || t.classList.contains('v-cr')) {
      var field = t.classList.contains('v-dr') ? 'v-dr' : 'v-cr';
      var key = field.replace('v-', '');
      var td = t.closest('td');
      // 金额统一走 num() 解析：自动剥离千分位逗号（1,234.56 → 1234.56），
      // 否则裸 parseFloat 遇逗号截断（1,234 → 1），导致录入金额被莫名改小。
      var cleanVal = String(t.value).replace(/[,\uFF0C\u3001]/g, '').replace(/\uFF0E/g, '.');
      var val = num(cleanVal);
      vRows[i][key] = val;
      var otherKey = key === 'dr' ? 'cr' : 'dr';
      if (val > 0 && vRows[i][otherKey] !== '') {
        vRows[i][otherKey] = '';
        clearAmtCells(trOf(t), otherKey);
      }
      // 数字位灯：输入时高亮当前金额最高有效位（行内位格 + 对应列表头单位行）
      var idx = highestDigitIndex(cleanVal);
      var bg = td && td.querySelector('.amt-bg');
      if (bg) bg.innerHTML = amtInnerHtml(val, true, idx, isRed(val), true, false);
      var thEl = $(field === 'v-dr' ? 'vThDr' : 'vThCr');
      if (thEl) thEl.innerHTML = amtHeaderHtml(field === 'v-dr' ? '借方金额' : '贷方金额', idx);
      updateAmtTotals();
      return;
    }
    renderVoucherRows();
  });
  // Enter 导航：录凭证键盘流 摘要→科目→借方→贷方→下一行摘要；末行金额格(借或贷)回车则追加新行。
  // 金额格先触发 blur（完成金额格式化与位格显示，等价于鼠标点击其他区域），再跳到下一录入位。
  // 科目格：点输入框/整格弹出科目选择（bindSubjectPicker，扁平列表）。弹层内支持键盘
  // 导航（↑↓ 高亮、Enter 选中、Esc 关闭）；当弹层打开时 Enter 由弹层 stopPropagation 接管，
  // 关闭后（或再次按 Enter）才冒泡到此跳到借方金额。
  $('vRows').addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || e.key !== 'Enter') return;
    var tr = t.closest('tr');
    if (t.classList.contains('amt-edit-input')) {
      e.preventDefault();
      t.blur(); // 触发失焦：金额 toFixed(2)、位格显示、清表头高亮
      var isDr = t.classList.contains('v-dr');
      var i = +t.getAttribute('data-i');
      var row = vRows[i] || {};
      var hasAmt = (row.dr || 0) > 0 || (row.cr || 0) > 0;
      var isLast = tr ? !tr.nextElementSibling : true;
      // 末行金额格回车(借或贷,取已填那侧)→ 追加新行并聚焦新行摘要(契合"录完本行→换行"的录入习惯)
      if (isLast && hasAmt && (isDr ? (row.cr || 0) === 0 : true)) {
        vRows.push(defaultVoucherRow());
        renderVoucherRows();
        var tb = $('vRows');
        var newTr = tb.querySelectorAll('tr')[vRows.length - 1];
        if (newTr) { var s = newTr.querySelector('.v-summary'); if (s) s.focus(); }
        return;
      }
      var next = isDr
        ? (tr ? tr.querySelector('.v-cr') : null)
        : (tr && tr.nextElementSibling ? tr.nextElementSibling.querySelector('.v-summary') : null);
      if (next) next.focus();
      return;
    }
    if (t.classList.contains('v-summary')) {
      e.preventDefault();
      var codeInp = tr && tr.querySelector('.v-code');
      if (codeInp) codeInp.focus();
      return;
    }
    if (t.classList.contains('v-code')) {
      // 科目选择为浏览用（点击选中），不拦截 Enter：直接跳到借方金额
      e.preventDefault();
      var drInp = tr && tr.querySelector('.v-dr');
      if (drInp) drInp.focus();
      return;
    }
  });
  $('vRows').addEventListener('change', function (e) {
    var t = e.target, i = +t.getAttribute('data-i');
    if (t.classList.contains('v-code')) {
      // 科目已改为输入框+联想（bindSubjectPicker 负责选中写回）。
      // 这里兜底处理用户手输编码后失焦：反查名称；若编码不存在则给出提示但不清空输入。
      var s = S.subject(t.value);
      vRows[i].code = t.value;
      vRows[i].name = s ? s.name : '';
      syncSubjName(i);   // 失焦兜底：同步右侧名称（编码不存在时显示为空）
      if (t.value && !s) {
        H.showToast && H.showToast('科目编码不存在：' + t.value, 'warn');
      }
    } else if (t.classList.contains('v-cash')) {
      vRows[i].cashActivity = t.value;
    }
  });
  $('vRows').addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-row-op');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var i = +btn.getAttribute('data-i');
    if (act === 'del') {
      if (vRows.length <= 2) { showToast('至少保留两行分录', 'warn'); return; }
      vRows.splice(i, 1);
      renderVoucherRows();
    } else if (act === 'add') {
      vRows.splice(i, 0, defaultVoucherRow());
      renderVoucherRows();
      var tb = $('vRows');
      var newTr = tb.querySelectorAll('tr')[i];
      if (newTr) { var s = newTr.querySelector('.v-summary'); if (s) s.focus(); }
    } else if (act === 'copy') {
      var src = vRows[i];
      var copy = defaultVoucherRow();
      copy.summary = src.summary || '';
      copy.code = src.code || '';
      copy.dr = src.dr || 0;
      copy.cr = src.cr || 0;
      if (src.cashActivity) copy.cashActivity = src.cashActivity;
      vRows.push(copy);
      renderVoucherRows();
    }
  });
  $('vRows').addEventListener('blur', function (e) {
    var t = e.target;
    if (!t.classList.contains('amt-edit-input')) return;
    var td = t.closest('.has-input');
    var i = +t.getAttribute('data-i');
    var field = t.classList.contains('v-dr') ? 'v-dr' : 'v-cr';
    var key = field.replace('v-', '');
    var rawVal = t.value.trim();
    // 剥离千分位逗号（与录入实时解析保持一致），避免逗号导致 toFixed 前被截断
    var val = num(rawVal.replace(/[,\uFF0C\u3001]/g, '').replace(/\uFF0E/g, '.'));
    if (val) {
      t.value = val.toFixed(2);
    } else {
      t.value = '';
    }
    var bg = t.parentElement.querySelector('.amt-bg');
    if (bg) bg.innerHTML = amtInnerHtml(val, false, -1, isRed(val), false, true);
    // 失焦后清除表头单位行高亮
    var thEl = $(field === 'v-dr' ? 'vThDr' : 'vThCr');
    if (thEl) thEl.innerHTML = amtHeaderHtml(field === 'v-dr' ? '借方金额' : '贷方金额', -1);
    if (td) td.classList.add('amt-blur');
  }, true);
  $('vRows').addEventListener('focus', function (e) {
    var t = e.target;
    // 摘要自动延续：聚焦到某行空摘要时，带入上一行摘要（多借多贷同业务共享摘要）
    if (t.classList.contains('v-summary')) {
      var si = +t.getAttribute('data-i');
      if (si > 0 && !t.value.trim() && (vRows[si - 1].summary || '').trim()) {
        t.value = vRows[si - 1].summary;
        vRows[si].summary = t.value; // 直接同步，不触发重建 DOM 以免光标跳动
      }
      return;
    }
    if (!t.classList.contains('amt-edit-input')) return;
    var td = t.closest('.has-input');
    if (td) td.classList.remove('amt-blur');
  }, true);
  // 双击金额格（借/贷）：自动填入使整张凭证借贷平衡的差额（仅当该格为空时）。
  // 金额格折叠态(.amt-blur)显示 .amt-bg、首次单击才聚焦显示输入框，两次点击落不同内层元素，
  // 浏览器不会合成 dblclick，故用「同格两次单击 + <500ms」手动检测；并额外绑原生 dblclick 兜底
  // （格子已聚焦时两次点击都落 input，原生 dblclick 会触发）。
  function fillInto(inp, val) {
    inp.focus();
    inp.value = val.toFixed(2);
    inp.dispatchEvent(new Event('input', { bubbles: true })); // 复用既有逻辑：清对侧 / 格式化 / 刷新合计
    inp.blur();
  }
  var _lastFillT = 0;
  function fillCellBalance(td) {
    var now = Date.now();
    if (now - _lastFillT < 400) return; // 防 click 双击检测与原生 dblclick 重复触发
    var inp = td.querySelector('.amt-edit-input');
    if (!inp) return;
    var i = +inp.getAttribute('data-i');
    var isDr = inp.classList.contains('v-dr');
    var key = isDr ? 'dr' : 'cr';
    var otherKey = isDr ? 'cr' : 'dr';
    if (U.num(vRows[i][key]) > 0) { showToast('该金额已填，未覆盖', 'warn'); return; }
    var drT = 0, crT = 0;
    vRows.forEach(function (r) { drT += U.num(r.dr); crT += U.num(r.cr); });
    var fill = isDr ? (crT - drT) : (drT - crT); // 整张凭证借贷平衡所需差额
    if (fill <= 0.005) { showToast('借贷已平或方向不符，无需补平', 'ok'); return; }
    // 目标行：优先当前空行；若当前行已有对方金额（同行不能既借又贷），则找/建一个空行放补平数
    var target = i;
    if (U.num(vRows[i][otherKey]) > 0) {
      target = -1;
      for (var k = 0; k < vRows.length; k++) {
        if (k !== i && U.num(vRows[k][key]) === 0 && U.num(vRows[k][otherKey]) === 0) { target = k; break; }
      }
      if (target < 0) { vRows.push(defaultVoucherRow()); target = vRows.length - 1; renderVoucherRows(); }
    }
    var tInp = (target === i) ? inp
      : document.querySelector('#vRows .col-amount.has-input[data-field="v-' + key + '"] .amt-edit-input[data-i="' + target + '"]');
    if (!tInp) tInp = inp;
    _lastFillT = Date.now();
    fillInto(tInp, fill);
    if (target !== i) showToast('已在第 ' + (target + 1) + ' 行补平借贷差额', 'ok');
  }
  var _lastAmtKey = null, _lastAmtT = 0;
  $('vRows').addEventListener('click', function (e) {
    var td = e.target.closest('.col-amount.has-input');
    if (!td) return;
    var inp = td.querySelector('.amt-edit-input');
    var i = inp ? +inp.getAttribute('data-i') : -1;
    var key = i + ':' + td.getAttribute('data-field');
    var now = Date.now();
    if (key === _lastAmtKey && (now - _lastAmtT) < 500) { // 双击：补平
      _lastAmtKey = null; _lastAmtT = 0;
      fillCellBalance(td);
      return;
    }
    _lastAmtKey = key; _lastAmtT = now;
    if (inp) inp.focus(); // 单击：聚焦显示输入框
  });
  $('vRows').addEventListener('dblclick', function (e) { // 兜底：格子已聚焦时原生 dblclick 可触发
    var td = e.target.closest('.col-amount.has-input');
    if (td) fillCellBalance(td);
  });
  var bSaveNew = $('btnSaveNewVoucher'); if (bSaveNew) bSaveNew.addEventListener('click', function () {
    var res = saveVoucher();
    if (res && res.ok && !res.unchanged) resetVoucherEdit(); // 无改动时保持当前凭证不误开新表
  });
  var bSave = $('btnSaveVoucher'); if (bSave) bSave.addEventListener('click', function () {
    var res = saveVoucher();
    if (res && res.ok && !res.unchanged) showToast('已保存凭证');
  });
  var bDel = $('btnDeleteVoucher'); if (bDel) bDel.addEventListener('click', async function () {
    if (!vEditId) return;
    if (!(await H.confirmAsync('确认删除该凭证？', { title: '删除凭证' }))) return;
    var r = S.removeVoucher(vEditId);
    if (!r.ok) return showToast(r.msg, 'error');
    syncAll();
    showToast('已删除凭证');
    resetVoucherEdit();
  });
  var bVPrint = $('btnVoucherPrint'); if (bVPrint) bVPrint.addEventListener('click', function () { printCurrentVoucher(); });
  var bBlank = $('btnBlankVoucher'); if (bBlank) bBlank.addEventListener('click', function () { printBlankVoucher(); });
  var bPref = $('btnVoucherPref'); if (bPref) bPref.addEventListener('click', function () {
    var st = S.settings.voucher || {};
    var pt = $('prefThousand'); if (pt) pt.checked = st.thousand !== false;
    var vc = (S.state.param && S.state.param.voucherChecks) || {};
    var dc = $('prefDeficitCheck'); if (dc) dc.checked = !!vc.deficitCheck;
    var m = $('voucherPrefModal'); if (m) m.classList.add('show');
  });
  var bPrefClose = $('btnVoucherPrefClose'); if (bPrefClose) bPrefClose.addEventListener('click', function () { var m = $('voucherPrefModal'); if (m) m.classList.remove('show'); });
  var bPrefCancel = $('btnVoucherPrefCancel'); if (bPrefCancel) bPrefCancel.addEventListener('click', function () { var m = $('voucherPrefModal'); if (m) m.classList.remove('show'); });
  var bPrefSave = $('btnVoucherPrefSave'); if (bPrefSave) bPrefSave.addEventListener('click', function () {
    S.settings.voucher = S.settings.voucher || {};
    var pt = $('prefThousand'); if (pt) S.settings.voucher.thousand = pt.checked;
    var dc = $('prefDeficitCheck'); if (dc) {
      S.state.param = S.state.param || {};
      S.state.param.voucherChecks = S.state.param.voucherChecks || {};
      S.state.param.voucherChecks.deficitCheck = dc.checked;
    }
    S.saveSettings();
    S.persist();
    var m = $('voucherPrefModal'); if (m) m.classList.remove('show');
    showToast('偏好设置已保存');
    syncAll();
  });

  var vWord = $('vWord'); if (vWord) vWord.addEventListener('change', function () {
    var no = $('vNo'); if (no) no.value = S.nextVoucherNo($('vWord').value, currentPeriod());
  });
}

function buildVoucher() {
  var entries = vRows.map(function (r) {
    var e = { code: r.code, name: r.name, summary: r.summary, dr: U.num(r.dr), cr: U.num(r.cr), cashActivity: r.cashActivity || '' };
    return e;
  }).filter(function (e) { return e.code || e.summary || e.dr || e.cr; });
  if (!entries.length) { showToast('请先录入分录', 'warn'); return null; }
  return {
    word: $('vWord').value,
    no: $('vNo').value,
    date: $('vDate').value,
    attach: U.num($('vAttach').value),
    summary: entries[0].summary,
    entries: entries,
    // 附件只存元信息（文件名 + 落盘路径），实体文件在 <数据目录>/attachments/
    attachments: vAttachFiles.map(function (f) {
      return { name: f.name, path: f.path, size: f.size };
    })
  };
}

/* ===================== 单张凭证打印 =====================
 * 不复用 tyPrint 的「克隆数据表格」路径（只带一张 grid，会丢凭证表头/页脚，
 * Tauri 桌面尤其明显）。这里把当前凭证渲染成独立记账凭证纸（自包含 HTML）：
 *   Tauri   → save_export_file + open_in_explorer（与报表打印同一通道）
 *   浏览器 → 新窗口内打印
 * 数据直接取自当前已填充的编辑表单——未保存的临时凭证也能打。
 */
function voucherSheetMoney(n) {
  var v = Math.round((U.num(n) * 100)) / 100;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function voucherSheetDate(dateStr) {
  if (!dateStr) return '';
  var p = String(dateStr).split('-');
  return p[0] + '年' + (parseInt(p[1], 10) || 0) + '月' + (parseInt(p[2], 10) || 0) + '日';
}
function voucherSheetEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderVoucherSheetHtml() {
  var word = ($('vWord') && $('vWord').value) || '记';
  var no = ($('vNo') && $('vNo').value) || '';
  var date = ($('vDate') && $('vDate').value) || '';
  var attach = U.num(($('vAttach') && $('vAttach').value) || 0);
  var company = (S.state && S.state.company) || {};
  var maker = ($('vMakerName') && $('vMakerName').textContent.trim()) || company.bookkeeper || '';
  var period = ($('vPeriodText') && $('vPeriodText').textContent.trim()) || '';
  var rows = (vRows || []).filter(function (r) { return r.code || r.summary || U.num(r.dr) || U.num(r.cr); });
  var drT = 0, crT = 0;
  rows.forEach(function (r) { drT += U.num(r.dr); crT += U.num(r.cr); });

  var trs = rows.map(function (r) {
    return '<tr><td class="c-sum">' + voucherSheetEsc(r.summary) + '</td>'
      + '<td class="c-sub"><span class="sub-code">' + voucherSheetEsc(r.code) + '</span>' + voucherSheetEsc(r.name) + '</td>'
      + '<td class="c-amt">' + (U.num(r.dr) ? voucherSheetMoney(r.dr) : '') + '</td>'
      + '<td class="c-amt">' + (U.num(r.cr) ? voucherSheetMoney(r.cr) : '') + '</td></tr>';
  }).join('');

  var metaLeft = '凭证字号：' + voucherSheetEsc(word) + '-' + voucherSheetEsc(no)
    + '<span style="margin-left:22px">日期：' + voucherSheetDate(date) + '</span>'
    + (period ? '<span style="margin-left:22px">' + voucherSheetEsc(period) + '</span>' : '');
  var metaRight = '附件 ' + attach + ' 张';

  return '<div class="wrap">'
    + '<div class="c-name">记 账 凭 证</div>'
    + '<div class="meta"><span class="l">' + metaLeft + '</span><span>' + metaRight + '</span></div>'
    + '<table>'
    + '<thead><tr><th>摘要</th><th>科目</th><th>借方金额</th><th>贷方金额</th></tr></thead>'
    + '<tbody>' + trs + '</tbody>'
    + '<tfoot class="sum"><tr><td colspan="2" class="ta-r">合计：</td>'
    + '<td class="c-amt">' + voucherSheetMoney(drT) + '</td><td class="c-amt">' + voucherSheetMoney(crT) + '</td></tr></tfoot>'
    + '</table>'
    + '<div class="foot"><span>制单人：' + voucherSheetEsc(maker) + '</span><span>审核人：</span><span></span></div>'
    + '</div>';
}
/* 凭证纸面通用样式（实凭证/空白凭证共用，随打印文件内联，不进主 CSS） */
var VOUCHER_SHEET_CSS = 'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#111;margin:0;padding:22px 26px;}'
  + '.wrap{width:192mm;margin:0 auto;}'
  + '.c-name{text-align:center;font-size:17px;font-weight:700;margin:2px 0 10px;letter-spacing:4px;}'
  + '.meta{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;margin-bottom:4px;}'
  + 'table{width:100%;border-collapse:collapse;font-size:12.5px;}'
  + 'th,td{border:1px solid #333;padding:10px 7px;vertical-align:top;}'
  + 'th{font-weight:600;text-align:center;}'
  + '.c-sum{width:30%;}'
  + '.c-sub{width:42%;}'
  + '.sub-code{display:inline-block;min-width:70px;color:#555;font-variant-numeric:tabular-nums;margin-right:8px;}'
  + '.c-amt{width:14%;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}'
  + '.sum td{font-weight:700;}'
  + '.foot{display:flex;justify-content:space-between;margin-top:34px;font-size:12.5px;}'
  + '.foot2{margin-top:30px;font-size:12.5px;}'
  + '.foot2 span{display:inline-block;white-space:nowrap;}'
  + '.foot2 span:nth-child(1){margin-left:15%;}'
  + '.foot2 span:nth-child(2){margin-left:36%;}'
  + '.u{display:inline-block;}'
  + '.bl-meta{display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;font-size:12.5px;margin:2px 0 14px;}'
  + '.bl-meta span{white-space:nowrap;justify-self:start;}'
  + '.bl-meta span:nth-child(2){justify-self:center;}'
  + '.bl-meta span:nth-child(3){justify-self:end;}'
  + '.vblank td{height:22px;padding-top:10px;padding-bottom:10px;}'
  + '.print-hint{margin-top:18px;font-size:12px;color:#1565c0;background:#e3f2fd;padding:8px 12px;border-radius:4px;}'
  + '@media print{body{padding:0;}.print-hint{display:none!important;}}';

function voucherSheetDoc(innerHtml, docTitle) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>'
    + voucherSheetEsc(docTitle) + '</title><style>' + VOUCHER_SHEET_CSS + '</style></head><body>'
    + innerHtml
    + '<p class="print-hint">这是打印预览页：请按键盘 <b>Ctrl+P</b>（Mac 为 <b>Cmd+P</b>）调出打印对话框，选择打印机或「另存为 PDF」即可完成打印。</p>'
    + '</body></html>';
}

/* 统一出口：桌面写导出文件并打开（与报表打印同通道）；浏览器新窗口打印 */
function openVoucherPrintDoc(innerHtml, baseName) {
  var company = (S.state && S.state.company) || {};
  var stamp = (($('vDate') && $('vDate').value) || '').replace(/[\\/:*?"<>|]/g, '_');
  var fname = ((company.name || '凭证') + '_' + baseName + (stamp ? '_' + stamp : '')).replace(/[\\/:*?"<>|]/g, '_') + '.html';
  var html = voucherSheetDoc(innerHtml, ((company.name || '记账凭证') + '_' + baseName).replace(/[\\/:*?"<>|]/g, '_'));
  var tauri = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  if (tauri && tauri.invoke) {
    try {
      var u8 = new TextEncoder().encode(html);
      var b64 = '';
      for (var i = 0; i < u8.length; i += 0x8000) {
        b64 += btoa(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
      }
      tauri.invoke('save_export_file', { name: fname, base64: b64 })
        .then(function (path) { return tauri.invoke('open_in_explorer', { path: path }); })
        .catch(function (e) { showToast('打印文件已生成，请到导出目录打开：' + (e && e.message || e), 'info', 5000); });
    } catch (e) { showToast('打印失败：' + (e && e.message || e), 'error'); }
  } else {
    var w = window.open('', '_blank');
    if (!w) { showToast('浏览器拦截了弹窗，请允许后重试', 'warn'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  }
}
function printCurrentVoucher() {
  if (!vRows || !vRows.length) { showToast('暂无凭证内容可打印', 'warn'); return; }
  var word = ($('vWord') && $('vWord').value) || '记';
  var no = ($('vNo') && $('vNo').value) || '';
  openVoucherPrintDoc(renderVoucherSheetHtml(), word + '-' + no + '_凭证');
}
/* 空白记账凭证纸：字号/日期/分录/金额全留空，供财务手填或作凭证纸 */
function renderBlankVoucherHtml() {
  var trs = '';
  for (var i = 0; i < 5; i++) {
    trs += '<tr class="vblank"><td></td><td></td><td class="c-amt"></td><td class="c-amt"></td></tr>';
  }
  var u = function (w) { return '<span class="u" style="width:' + w + 'px"></span>'; };
  var sign = function (label) { return '<span>' + label + '：' + u(58) + '</span>'; };
  return '<div class="wrap">'
    + '<div class="c-name">记 账 凭 证</div>'
    + '<div class="bl-meta">'
    + '<span>凭证字 记' + u(22) + '号</span>'
    + '<span>日期：' + u(26) + '年' + u(22) + '月' + u(22) + '日</span>'
    + '<span>附件：' + u(18) + '张</span>'
    + '</div>'
    + '<table>'
    + '<thead><tr><th>摘要</th><th>科目</th><th>借方金额</th><th>贷方金额</th></tr></thead>'
    + '<tbody>' + trs + '</tbody>'
    + '<tfoot class="sum"><tr><td colspan="2" class="ta-r">合计：</td><td class="c-amt"></td><td class="c-amt"></td></tr></tfoot>'
    + '</table>'
    + '<div class="foot2">' + sign('记账') + sign('审核') + '</div>'
    + '</div>';
}
function printBlankVoucher() {
  openVoucherPrintDoc(renderBlankVoucherHtml(), '空白凭证');
}
// 「无改动不落库」比对：编辑表单内容与数据库中该凭证是否完全一致。
// 只比较用户可改字段（字/号/日期/附件/分录摘要科目借贷/附件清单），
// name 为科目冗余展示——宁可判定「有改动」
// 维持原保存逻辑，也不允许把真实改动当无改动吞掉。
function voucherUnchanged(cur, v) {
  if (!cur || !v) return false;
  if ((cur.word || '记') !== (v.word || '记')) return false;
  if (String(cur.no == null ? '' : cur.no) !== String(v.no == null ? '' : v.no)) return false;
  if ((cur.date || '') !== (v.date || '')) return false;
  if (num(cur.attach) !== num(v.attach)) return false;
  var a = cur.entries || [], b = v.entries || [];
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if ((a[i].code || '') !== (b[i].code || '')) return false;
    if ((a[i].summary || '') !== (b[i].summary || '')) return false;
    if (Math.abs(num(a[i].dr) - num(b[i].dr)) > 0.005) return false;
    if (Math.abs(num(a[i].cr) - num(b[i].cr)) > 0.005) return false;
    if ((a[i].cashActivity || '') !== (b[i].cashActivity || '')) return false;
  }
  var fa = cur.attachments || [], fb = v.attachments || [];
  if (fa.length !== fb.length) return false;
  for (var j = 0; j < fa.length; j++) {
    if ((fa[j].name || '') !== (fb[j].name || '')) return false;
    if ((fa[j].path || '') !== (fb[j].path || '')) return false;
    if (num(fa[j].size) !== num(fb[j].size)) return false;
  }
  return true;
}
function saveVoucher() {
  if (savingVoucher) return { ok: false }; // 防止连续点击/网络重发造成重复生成凭证
  var v = buildVoucher();
  if (!v) return { ok: false };
  // 查看跳转打开既存凭证后手滑保存：内容未做任何修改时直接跳过落库，
  // 不写日志、不触发「已审核→撤销审核」的状态变化
  if (vEditId && voucherUnchanged(S.getVoucher(vEditId), v)) {
    showToast('凭证未做修改', 'info');
    return { ok: true, unchanged: true };
  }
  var drT = v.entries.reduce(function (s, e) { return s + e.dr; }, 0);
  var crT = v.entries.reduce(function (s, e) { return s + e.cr; }, 0);
  if (Math.abs(drT - crT) >= 0.005) { showToast('借贷不平衡，无法保存', 'warn'); return { ok: false }; }
  if (drT + crT < 0.01) { showToast('请填写凭证金额后再保存', 'warn'); return { ok: false }; }
  // 科目存在性校验：分录的 code 必须存在于科目表，避免误录用不存在的科目（幽灵科目）
  var badCodes = [];
  v.entries.forEach(function (e) {
    if (!e.code || !S.subject(e.code)) badCodes.push(e.code || '空');
  });
  if (badCodes.length) { showToast('科目不存在：' + badCodes.join('、') + '，请检查科目编码', 'error'); return { ok: false }; }
  var vc = (S.state.param && S.state.param.voucherChecks) || {};
  if (vc.deficitCheck) {
    var cashAccts = S.cashAccounts ? S.cashAccounts() : [];
    var cashCodes = cashAccts.map(function (s) { return s.code; });
    if (cashCodes.length) {
      var month = monthOf(v.date);
      var gl = S.generalLedger(month);
      var hasDeficit = (v.entries || []).some(function (e) {
        if (!e.code || cashCodes.indexOf(e.code) < 0) return false;
        var row = gl.filter(function (r) { return r.code === e.code; })[0];
        if (!row) return false;
        var subj = S.subject(e.code);
        var normal = subj ? subj.normal : 'dr';
        var endDr = num(row.endDr) + num(e.dr);
        var endCr = num(row.endCr) + num(e.cr);
        return normal === 'dr' ? (endCr - endDr > 0.005) : (endDr - endCr > 0.005);
      });
      if (hasDeficit) { showToast('存在现金/银行存款等科目赤字（系统参数已开启赤字检查）', 'error'); return { ok: false }; }
    }
  }
  savingVoucher = true;
  try {
    if (vEditId) {
      var r = S.updateVoucher(vEditId, v);
      if (!r.ok) { showToast(r.msg, 'warn'); return r; }
    } else {
      var ar = S.addVoucher(v);
      // addVoucher 成功时返回凭证对象本身（含 id），失败时返回 { ok: false, msg }；
      // 因此用 ar.ok === false 判断失败，!ar.ok 会把成功路径也误判为失败。
      if (!ar || ar.ok === false) { showToast((ar && ar.msg) || '保存失败', 'warn'); return ar || { ok: false }; }
      vEditId = ar.id;
    }
    // 方案 B：凭证附件同步进原始凭证库（附件台账）。按 path 去重，编辑保存不会重复添加。
    if (vAttachFiles && vAttachFiles.length) {
      var period = monthOf(v.date);
      vAttachFiles.forEach(function (f) {
        S.addOriginalFromAttachment(f, { word: v.word, no: v.no, id: v.id, period: period });
      });
    }
    syncAll();
    return { ok: true };
  } finally {
    savingVoucher = false;
  }
}

function showVoucherEdit() {
  var ed = $('vEditView'); if (ed) ed.style.display = '';
  resetVoucherEdit();
}
function openVoucherPage() {
  var ed = $('vEditView'); if (ed) ed.style.display = '';
  goPage('voucher-noedit');
}
function loadVoucherToEdit(id) {
  var v = S.getVoucher(id);
  if (!v) {
    // 软删除过滤：不加载已删凭证到编辑界面（已删凭证应通过回收站还原后再编辑）
    var vs = (S.state.vouchers || []).filter(function (x) {
      return x.deleted !== 'y' && (((x.word || '记') + '-' + (x.no != null ? x.no : '')) === id || x.id === id);
    });
    v = vs[0] || null;
  }
  if (!v) { showToast('凭证不存在', 'error'); return; }
  vEditId = v.id;
  // 编辑模式：显示删除、隐藏保存并新增
  var bDel = $('btnDeleteVoucher'); if (bDel) bDel.hidden = false;
  var bSn = $('btnSaveNewVoucher'); if (bSn) bSn.hidden = true;
  fillVoucherWord(); // 先确保 options 和 disabled 状态正确
  var w = $('vWord'); if (w) w.value = v.word || '记';
  var no = $('vNo'); if (no) no.value = v.no || '';
  var dt = $('vDate');
  if (dt) {
    // 编辑态：凭证归属月份不可改（对齐 store.updateVoucher 的月份锁定）
    var _month = monthOf(v.date);
    dt.min = _month + '-01';
    dt.max = _month + '-31';
    dt.value = v.date || '';
  }
  var at = $('vAttach'); if (at) at.value = v.attach || 0;
  // 载入该凭证已有的附件元信息（老凭证无此字段时为 []，不影响编辑）
  vAttachFiles = (v.attachments || []).map(function (a) {
    return { name: a.name || '', path: a.path || '', size: a.size || 0 };
  });
  renderAttachPanel();
  vRows = (v.entries || []).map(function (e) {
    var r = defaultVoucherRow();
    r.summary = e.summary || '';
    r.code = e.code || '';
    r.name = e.name || '';
    r.dr = e.dr || 0;
    r.cr = e.cr || 0;
    r.cashActivity = e.cashActivity || '';
    return r;
  });
  while (vRows.length < 4) vRows.push(defaultVoucherRow());
  renderVoucherRows();
  openVoucherPage();
}


/* ============================================================
 * 凭证汇总表
 * ============================================================ */
function refreshSum() {
  setupVoucher();
  // 默认期间由 index.html 的 data-default 声明，periodRangeValue 单点兜底并同步触发器文本。
  // 本页是区间口径（起止都要用），故兜底后各自读取。
  periodRangeValue('sumPeriod');
  var sInp = $('sumPeriodStart'), eInp = $('sumPeriodEnd');
  renderSum(sInp ? sInp.value : '', eInp ? eInp.value : '');
}
// 期间变更由期间控件的 data-on-change 直接回调（组件不派发 change 事件），此处无需再绑监听。

function renderSum(start, end) {
  var tb = $('sumBody'); if (!tb) return;
  tb.innerHTML = '';
  var stat = $('sumStat');
  if (stat) stat.textContent = '';
  if (!start || !end) return;
  var map = {};
  // 起止区间内逐月累计（凭证汇总支持跨期）。
  // 月份列表统一走 store.monthList（此前内联展开一份，与 _shared.js 重复）。
  // （且 `U.monthsBetween &&` 这个守卫是多余的——括号里的 IIFE 并没有用到它）。
  // monthList 在 start === end 时返回单元素数组，原「相等就只取一月」的分支已被它覆盖。
  var months = U.monthList(start, end);
  // 副标题统计（凭证总张数/附件总张数）：
  // 张数 = 区间内凭证条数；附件张数 = 各凭证 attach 字段之和（非附件元信息数组长度，
  // 与凭证上「附件 ___ 张」是同一个值）。
  var vchCount = 0, attachCount = 0;
  months.forEach(function (month) {
    S.periodVouchers(month).forEach(function (v) {
      vchCount++;
      attachCount += num(v.attach);
      v.entries.forEach(function (e) {
        if (!map[e.code]) map[e.code] = { dr: 0, cr: 0 };
        map[e.code].dr += U.num(e.dr); map[e.code].cr += U.num(e.cr);
      });
    });
  });
  if (stat) stat.textContent = '凭证总张数：' + vchCount + '张；附件总张数：' + attachCount + '张';
  S.subjects().forEach(function (s) {
    var m = map[s.code];
    if (!m || (m.dr === 0 && m.cr === 0)) return;
    var tr = document.createElement('tr');
    // 末列 col-spacer：本表只有「科目名称」一个长文本列，若让它吸收剩余会被撑得极宽；
    // 改为让数据列全部保持内容宽、由表尾空白列吃掉剩余宽度（表头同样有这一列，见 index.html sumGrid）。
    tr.innerHTML = '<td><a href="#" class="link-gl-subject" data-code="' + escAttr(s.code) + '">' + escHtml(s.code) + '</a></td><td>' + s.name + '</td><td class="ta-r mono">' + money(m.dr) + '</td><td class="ta-r mono">' + money(m.cr) + '</td><td class="col-spacer"></td>';
    tb.appendChild(tr);
  });
}

/* ============================================================
 * 凭证查询
 * ============================================================ */
function refreshQuery() {
  setupVoucher();
  // 默认期间由 index.html 的 data-default 声明，periodRangeValue 单点兜底并同步触发器文本。
  // 本页是区间口径（起止都要用），故兜底后各自读取。
  periodRangeValue('qPeriod');
  var sInp = $('qPeriodStart'), eInp = $('qPeriodEnd');
  bindQuerySubjectOnce();
  renderQuery(sInp ? sInp.value : '', eInp ? eInp.value : '');
}

// 科目筛选：与总账/多栏账同款「点输入框即弹、点选即生效」的单选组件
// （已统一为唯一科目选择组件 bindSubjectPicker，不再支持范围/多科目表达式）。
// 只绑定一次，之后靠输入框自身的值驱动，避免重复 refresh 时把用户已输入的条件冲掉。
var qSubjPicker = null;
function bindQuerySubjectOnce() {
  if (qSubjPicker) return qSubjPicker;
  var inp = $('qCode');
  if (!inp) return null;
  qSubjPicker = bindSubjectPicker(inp, {
    onPick: function (code) { inp.value = String(code); qRender(); }
  });
  return qSubjPicker;
}
// 取当前科目条件：返回 {codes}；codes 为 null = 全部。
// 口径对齐总账 glCodesFor：选中科目及其全部下级命中；输入非法编码时回落为「全部」。
function qSubjectCodes() {
  var inp = $('qCode');
  var v = inp ? String(inp.value || '').trim() : '';
  if (!v) return { codes: null };
  var set = new Set();
  (S.subjects() || []).forEach(function (s) {
    var sc = String(s.code);
    if (sc === v || sc.indexOf(v) === 0) set.add(sc);
  });
  return { codes: set.size ? set : null };
}

function qRender() { var s = $('qPeriodStart'), e = $('qPeriodEnd'); renderQuery(s ? s.value : '', e ? e.value : ''); }
// 科目/期间输入均实时自动刷新（期间→__renderQuery、科目→qRender），
// 「过滤」「刷新」按钮均为冗余，已删除。
// 期间变更由期间控件的 data-on-change 直接回调（组件不派发 change 事件），此处无需再绑监听。
var qCodeEl = $('qCode'); if (qCodeEl) qCodeEl.addEventListener('change', qRender);
var qSortDir = 0;
var qThNo = $('qThNo');
if (qThNo) qThNo.addEventListener('click', function () {
  qSortDir = (qSortDir + 1) % 3;
  var icon = $('qSortIcon');
  if (icon) {
    icon.textContent = qSortDir === 1 ? '▲' : qSortDir === 2 ? '▼' : '';
    icon.classList.toggle('on', qSortDir !== 0);
  }
  var s = $('qPeriodStart'), e = $('qPeriodEnd'); renderQuery(s ? s.value : '', e ? e.value : '');
});
var bQNew = $('btnQNewVoucher'); if (bQNew) bQNew.addEventListener('click', function () { goPage('voucher'); });
// btnQPrint 已加 data-print，由全局委托统一走 tyPrint()，此处不再单独绑定。
// 查凭证导出：与列表同源（含跨期、科目过滤、字号排序），导出为 Excel
var bQExport = $('btnQExport'); if (bQExport) bQExport.addEventListener('click', exportQuery);
var bQDelete = $('btnQDelete'); if (bQDelete) bQDelete.addEventListener('click', async function () {
  var cks = document.querySelectorAll('#qBody .row-check:checked');
  if (!cks.length) { showToast('请先勾选要删除的凭证', 'warn'); return; }
  // 规则：删除仅进回收站（可还原），属可逆操作 → 无需操作密码，仅二次确认
  if (!(await H.confirmAsync('确认删除选中的 ' + cks.length + ' 张凭证？', { title: '删除凭证' }))) return;
  var n = 0, fail = 0, failMsg = '';
  cks.forEach(function (c) {
    var r = S.removeVoucher(c.getAttribute('data-id'));
    if (r.ok) n++; else { fail++; if (!failMsg) failMsg = r.msg; }
  });
  if (n) { syncAll(); qRender(); }
  if (n && fail) showToast('已删除 ' + n + ' 张，' + fail + ' 张未删：' + failMsg, 'warn');
  else if (n) showToast('已删除 ' + n + ' 张凭证');
  else if (fail) showToast('删除失败：' + failMsg, 'error');
});
var qCheckAll = $('qCheckAll');
if (qCheckAll) qCheckAll.addEventListener('change', function () {
  // 注意：本文件是 ES module（严格模式），forEach 回调里的 `this` 是 undefined，
  // 写 c.checked = this.checked 会抛 TypeError 并被全局兜底捕获成「系统异常」提示。
  // 统一用箭头函数继承外层 this，或直接引用 qCheckAll.checked（此处取后者，最直白）。
  document.querySelectorAll('#qBody .row-check').forEach(function (c) { c.checked = qCheckAll.checked; });
});

// 取当前查询条件下的凭证列表（跨期逐月汇总 + 科目过滤 + 字号排序）。
// 抽成独立函数，供列表渲染与 Excel 导出复用，保证「所见即所导」。
function queryVouchers(start, end, code) {
  if (!start || !end) return [];
  var vs = [];
  // 起止区间内逐月汇总（查凭证支持跨期）。
  // 月份列表统一走 store.monthList（此前内联又展开了一份）。
  // monthList 对 start === end 也返回单元素数组，故原先的「相等则只取一月」分支已被它覆盖。
  U.monthList(start, end).forEach(function (month) {
    S.periodVouchers(month).forEach(function (v) { vs.push(v); });
  });
  // codes 为 null 表示「全部科目」；非空时凭证只要含任一分录即命中
  if (code) {
    vs = vs.filter(function (v) {
      return v.entries.some(function (e) { return matchSubjectCode(code, e.code); });
    });
  }
  if (qSortDir === 1) vs = vs.slice().sort(function (a, b) { return (parseInt(a.no, 10) || 0) - (parseInt(b.no, 10) || 0); });
  else if (qSortDir === 2) vs = vs.slice().sort(function (a, b) { return (parseInt(b.no, 10) || 0) - (parseInt(a.no, 10) || 0); });
  return vs;
}

// 导出查凭证结果（与列表同源，按分录展开，凭证级字段只在首行显示）
function exportQuery() {
  var s = $('qPeriodStart'), e = $('qPeriodEnd');
  var start = s ? s.value : '', end = e ? e.value : '';
  if (!start || !end) { showToast('请先选择查询期间', 'warn'); return; }
  var sc = qSubjectCodes();
  var vs = queryVouchers(start, end, sc.codes);
  if (!vs.length) { showToast('当前条件下没有可导出的凭证', 'warn'); return; }
  if (typeof XLSX === 'undefined') { showToast('导出组件未加载', 'error'); return; }

  function amt(n) { var x = U.num(n); return x ? x : ''; }
  var rows = [['日期', '凭证字号', '摘要', '科目', '借方金额', '贷方金额', '附件', '原单据编号', '制单人']];
  vs.forEach(function (v) {
    var first = true;
    v.entries.forEach(function (en) {
      if (!matchSubjectCode(sc.codes, en.code)) { first = false; return; }
      rows.push([
        first ? (v.date || '') : '',
        first ? ((v.word || '记') + '-' + (v.no != null ? v.no : '')) : '',
        en.summary || v.summary || '',
        (en.code || '') + (en.name ? ' ' + en.name : ''),
        amt(en.dr),
        amt(en.cr),
        first ? (v.attach || '') : '',
        first ? (v.sourceNo || '') : '',
        first ? '本账套' : ''
      ]);
      first = false;
    });
  });

  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 28 }, { wch: 26 }, { wch: 14 }, { wch: 14 }, { wch: 6 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, '凭证列表');
  var fname = '凭证列表_' + (start === end ? start : start + '至' + end);
  __safeExportExcel(wb, fname);
}

function renderQuery(start, end) {
  var tb = $('qBody'); if (!tb) return;
  tb.innerHTML = '';
  var sc = qSubjectCodes();
  var vs = queryVouchers(start, end, sc.codes);
  if (!start || !end) return;
  if (!vs.length) { tb.innerHTML = '<tr><td colspan="12" class="empty-hint">本期无凭证</td></tr>'; return; }
  // 科目名显示口径：取科目表实时名称，科目改名后历史凭证显示同步更新；分录快照名仅作兜底（科目已不存在时）。一次构建 map，避免逐行线性查找。
  var subjName = S.subjectNameMap ? S.subjectNameMap() : {};
  var maker = '本账套';
  vs.forEach(function (v) {
    var first = true;
    v.entries.forEach(function (e) {
      // 只展示命中的分录行；codes 为 null（全部科目）时展示全部分录
      if (!matchSubjectCode(sc.codes, e.code)) { first = false; return; }
      var tr = document.createElement('tr');
      tr.setAttribute('data-vid', v.id);
      var chk = first ? '<input type="checkbox" class="row-check" data-id="' + v.id + '">' : '';
      var dateCell = first ? v.date : '';
      var noCell = first ? ('<a class="link-voucher" href="#" data-id="' + v.id + '">' + v.word + '-' + v.no + '</a>') : '';
      var makerCell = first ? maker : '';
      tr.innerHTML =
        // 复选框列不写内联对齐：对齐统一走「列对齐约定」（除金额列右对齐，其余左对齐）
        '<td>' + chk + '</td>' +
        '<td>' + dateCell + '</td>' +
        '<td>' + noCell + '</td>' +
        // 摘要 / 科目是自由文本，列宽有限：截断显示，完整内容挂 title 悬停可见
        '<td class="cell-ellipsis" title="' + escAttr(e.summary || v.summary || '') + '">' + escHtml(e.summary || v.summary || '') + '</td>' +
        '<td class="cell-ellipsis" title="' + escAttr(e.code + ' ' + (subjName[e.code] || e.name || '')) + '">' + (e.code ? '<a href="#" class="link-gl-subject" data-code="' + escAttr(e.code) + '">' + escHtml(e.code) + '</a> ' : '') + escHtml(subjName[e.code] || e.name || '') + '</td>' +
        '<td class="ta-r mono">' + (U.num(e.dr) ? money(e.dr) : '') + '</td>' +
        '<td class="ta-r mono">' + (U.num(e.cr) ? money(e.cr) : '') + '</td>' +
        '<td>' + (first ? (v.attach || '') : '') + '</td>' +
        '<td>' + (first ? (v.sourceNo || '') : '') + '</td>' +
        '<td>' + makerCell + '</td>';
      tb.appendChild(tr);
      first = false;
    });
  });
  var sumDr = 0, sumCr = 0;
  vs.forEach(function (v) { v.entries.forEach(function (e) { sumDr += U.num(e.dr); sumCr += U.num(e.cr); }); });
  var trt = document.createElement('tr');
  trt.className = 'grp-row';
  trt.innerHTML = '<td></td><td colspan="4" class="ta-r">合 计</td>' +
    '<td class="ta-r mono grp-amt">' + money(sumDr) + '</td>' +
    '<td class="ta-r mono grp-amt">' + money(sumCr) + '</td>' +
    '<td colspan="4"></td>';
  tb.appendChild(trt);
}

/* —— 跨页预填凭证分录（模块隔离，须经全局桥接调用） —— */
function prefillVoucher(entries, summary) {
  vEditId = null;
  vRows = (entries || []).map(function (e) {
    var s = e.code ? S.subject(e.code) : null;
    return {
      summary: e.summary || '', code: e.code || '', name: (s && s.name) || '',
      dr: e.dr || 0, cr: e.cr || 0, cashActivity: ''
    };
  });
  var vs = $('vSummary'); if (vs) vs.value = summary || '';
  renderVoucherRows();
}

/* —— 凭证回收站（软删除还原入口）——
 * 列出所有 deleted==='y' 凭证，提供「还原」操作。
 * 与 jinbooks 软删除设计对应：删除只是打标，凭证留在账套可一键还原。
 */
function refreshRecycleBin() {
  var tb = $('recycleBody');
  if (!tb) return;
  var list = (S.deletedVouchers ? S.deletedVouchers() : []);
  tb.innerHTML = '';
  if (!list.length) {
    // 空状态统一走全局 td.empty-hint（居中灰字），不再写内联对齐/字色
    tb.innerHTML = '<tr><td colspan="6" class="empty-hint">回收站为空</td></tr>';
    return;
  }
  list.forEach(function (v) {
    var tr = document.createElement('tr');
    var drSum = (v.entries || []).reduce(function (s, e) { return s + (e.dr || 0); }, 0);
    tr.innerHTML =
      '<td>' + escHtml(v.date || '') + '</td>' +
      '<td>' + escHtml((v.word || '记') + '-' + (v.no != null ? v.no : '')) + '</td>' +
      '<td>' + num(drSum).toFixed(2) + '</td>' +
      '<td>' + escHtml(v.deletedAt || '') + '</td>' +
      '<td>' + escHtml(v.deletedBy || '') + '</td>' +
      '<td><a class="link-toggle" data-act="restore" data-id="' + v.id + '">还原</a></td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('[data-act="restore"]').forEach(function (a) {
    a.addEventListener('click', async function () {
      var id = this.getAttribute('data-id');
      var v = S.getVoucherIncludeDeleted ? S.getVoucherIncludeDeleted(id) : null;
      if (!v) { H.showToast && H.showToast('凭证不存在', 'error'); return; }
      if (!(await H.confirmAsync('确认还原凭证 ' + (v.word || '记') + '-' + (v.no != null ? v.no : '') + '？', { title: '还原凭证' }))) return;
      var r = S.restoreVoucher(id);
      if (!r.ok) { H.showToast && H.showToast(r.msg, 'error'); return; }
      H.showToast && H.showToast('已还原：' + (v.word || '记') + '-' + (v.no != null ? v.no : ''));
      refreshRecycleBin();
      refreshQuery();
      if (H.refreshAll) H.refreshAll();
    });
  });
}

/* —— 对外暴露：刷新 + 跨页入口 —— */
/* ===================== 日常凭证模板（结构模板：摘要/科目必带，金额选填） ===================== */
// 模板方向三级兜底：①带金额→金额落点；②显式 side（系统/导入模板）；③无金额无 side→按科目常规性质
function tplSideOf(e) {
  if (U.num(e.dr) > 0) return 'dr';
  if (U.num(e.cr) > 0) return 'cr';
  if (e.side === 'cr') return 'cr';
  if (e.side === 'dr') return 'dr';
  var s = S.subject(e.code);
  var cls = s && (s.grpCls || s.cls);
  if (cls === 'liability' || cls === 'equity' || cls === 'revenue') return 'cr';
  return 'dr';
}
// 打开「保存为模板」面板：逐条勾选是否携带金额（金额可填可不填）
function openVchTplSave() {
  var m = $('vchTplSaveModal'); if (!m) return;
  var first = '';
  (vRows || []).some(function (r) {
    if (r.code) { first = (r.summary || '').trim() || ((S.subject(r.code) || {}).name || ''); return true; }
    return false;
  });
  var nm = $('vchTplSaveName'); if (nm) nm.value = first;
  var cat = $('vchTplSaveCat'); if (cat) cat.value = '';
  var amt = $('vchTplSaveAmt'); if (amt) amt.checked = false;
  m.classList.add('show');
}
function commitVchTplSave() {
  var rows = (vRows || []).filter(function (r) { return r.code; });
  if (!rows.length) { showToast('没有带科目的分录，无法保存模板', 'warn'); return; }
  if (!(rows[0].summary || '').trim()) { showToast('请为首行填写摘要才能保存模板', 'warn'); return; }
  var withAmt = !!($('vchTplSaveAmt') || {}).checked;
  var entries = rows.map(function (r) {
    var item = { code: r.code, name: ((S.subject(r.code) || {}).name) || r.name || '', summary: r.summary || '' };
    if (withAmt) {
      var dr = U.num(r.dr), cr = U.num(r.cr);
      if (dr > 0) item.dr = dr; else if (cr > 0) item.cr = cr;
    }
    return item;
  });
  var nm = (($('vchTplSaveName') || {}).value || '').trim();
  var r = S.saveVchTemplate(nm, entries);
  if (!r.ok) return showToast(r.msg, 'error');
  showToast('已保存为模板「' + r.tpl.name + '」（' + entries.length + ' 条分录）', 'success', 3200);
  var m = $('vchTplSaveModal'); if (m) m.classList.remove('show');
  renderVchTplList();
}
function openVchTpl() {
  var m = $('vchTplModal'); if (!m) return;
  m.classList.add('show');
  var s = $('vchTplSearch'); if (s) s.value = '';
  renderVchTplList();
  if (s) { try { s.focus(); } catch (e) {} }
}
function closeVchTpl() { var m = $('vchTplModal'); if (m) m.classList.remove('show'); }
/* —— 系统模板（软件内置，只读）：套用前把基准科目适配到本账套科目 ——
 * 匹配顺序：本账套精确编码 → old/small2013 损益码迁移 → 同名科目 → 名称前缀取最短编码。
 * 匹配不到的行不进模板，避免带空科目行套用；缺行在卡片上红字提示、套用时提醒补录。
 */
var BUILTIN_VCH_TPL = globalThis.STANDARD_VCH_TEMPLATES || [];
function tplSubjectHit(code) {
  var s = S.subject ? S.subject(code) : null;
  return s ? { code: String(s.code), name: s.name || '' } : null;
}
function resolveTplAccount(code, name) {
  var c0 = String(code || '');
  var r = tplSubjectHit(c0); if (r) return r;
  var subs = (S.subjects ? S.subjects() : []) || [];
  if (!subs.length) return null;
  var pick = function (arr) {
    if (!arr || !arr.length) return null;
    arr = arr.slice().sort(function (a, b) {
      return (String(a.code).length - String(b.code).length) || (String(a.code) < String(b.code) ? -1 : 1);
    });
    var s = arr[0];
    return { code: String(s.code), name: s.name || '' };
  };
  var n = String(name || '').trim();
  if (n) {
    var eq = pick(subs.filter(function (s) { return s.name === n; }));
    if (eq) return eq;
    var pf = pick(subs.filter(function (s) { return s.name && s.name.indexOf(n) === 0; }));
    if (pf) return pf;
  }
  return null;
}
function builtinTplResolved() {
  return (BUILTIN_VCH_TPL || []).map(function (t, i) {
    var ok = [], miss = [];
    (t.entries || []).forEach(function (e) {
      var s = resolveTplAccount(e.code, e.name);
      if (s) ok.push({ summary: e.summary || '', code: s.code, name: s.name || '', side: e.side === 'cr' ? 'cr' : 'dr' });
      else miss.push({ code: e.code, name: e.name || '' });
    });
    return { id: 'sys' + i, name: t.name, word: t.word || '记', builtin: true, entries: ok, missing: miss };
  });
}
function renderVchTplList() {
  var box = $('vchTplList'); if (!box) return;
  var mine = S.vchTemplates() || [];
  var sys = builtinTplResolved();
  var q = String(($('vchTplSearch') || {}).value || '').trim().toLowerCase();
  var pass = function (t) { return !q || String(t.name || '').toLowerCase().indexOf(q) >= 0; };
  var sysF = sys.filter(pass), mineF = mine.filter(pass);
  function tplRow(t, builtin) {
    var segs = (t.entries || []).map(function (e) {
      return '<span class="vch-tpl-seg"><i class="vch-tpl-drc">' + (tplSideOf(e) === 'cr' ? '贷' : '借') + '</i>'
        + '<em class="muted">' + escHtml(e.code || '') + '</em> ' + escHtml(e.name || '')
        + (e.summary ? '<span class="muted vch-tpl-sum"> · ' + escHtml(e.summary) + '</span>' : '') + '</span>';
    }).join('<span class="vch-tpl-sep">／</span>');
    var miss = (t.missing && t.missing.length)
      ? '<div class="vch-tpl-miss">缺少 ' + t.missing.length + ' 个科目：'
        + t.missing.map(function (m) { return escHtml(m.code + ' ' + m.name); }).join('、')
        + '，已跳过，套用后请补录</div>' : '';
    var use = t.entries.length
      ? '<button type="button" class="btn btn-xs btn-primary vch-tpl-use" data-id="' + escAttr(t.id) + '">使用</button>'
      : '<span class="muted" style="font-size:12px">不可用</span>';
    return '<div class="vch-tpl-row">'
      + '<div class="vch-tpl-main">'
      + '<div class="vch-tpl-name"><span class="vch-tpl-word">' + escHtml(t.word || '记') + '</span><b>' + escHtml(t.name) + '</b>'
      + (builtin ? '<span class="vch-tpl-tag">内置</span>' : '') + '</div>'
      + (segs ? '<div class="vch-tpl-preview">' + segs + '</div>' : '') + miss
      + '</div>'
      + '<div class="vch-tpl-ops">' + use
      + (builtin ? '' : '<button type="button" class="btn btn-xs vch-tpl-del" data-id="' + escAttr(t.id) + '">删除</button>')
      + '</div>'
      + '</div>';
  }
  function sec(title, count) {
    return '<div class="vch-tpl-sec"><span class="vch-tpl-sec-name">' + title + '</span>'
      + '<span class="vch-tpl-cnt">' + count + ' 个</span></div>';
  }
  var html = '';
  if (mineF.length) html += sec('我的模板', mine.length) + mineF.map(function (t) { return tplRow(t, false); }).join('');
  if (sysF.length) html += sec('系统模板', sys.length) + sysF.map(function (t) { return tplRow(t, true); }).join('');
  if (!html) {
    html = '<div class="empty-hint" style="padding:26px 0;text-align:center;color:var(--ty-text-3)">'
      + (q ? '没有找到名称含「' + escHtml(q) + '」的模板' : '暂无可用模板') + '</div>';
  } else if (!mine.length && !q) {
    html += '<div class="vch-tpl-empty-my">暂无自定义模板：在凭证中录好常用分录后，点「模板 → 保存为凭证模板」加入这里。</div>';
  }
  box.innerHTML = html;
}
function saveCurrentAsTpl() {
  openVchTplSave();
}
function applyVchTpl(t) {
  if (!t) return;
  var dirty = vEditId ? true : (vRows || []).some(function (r) {
    return r.code || U.num(r.dr) || U.num(r.cr) || (r.summary || '').trim();
  });
  function fill() {
    vEditId = null;
    vAttachFiles = [];
    if (renderAttachPanel) renderAttachPanel();
    vRows = (t.entries || []).filter(function (e) { return e.code && S.subject(e.code); }).map(function (e) {
      var r = defaultVoucherRow();
      r.summary = e.summary || '';
      r.code = e.code || '';
      r.name = e.name || ((S.subject(e.code) || {}).name) || '';
      var side = tplSideOf(e);
      if (side === 'dr') { var d = U.num(e.dr); if (d > 0) r.dr = d; }
      else { var c = U.num(e.cr); if (c > 0) r.cr = c; }
      return r;
    });
    while (vRows.length < 4) vRows.push(defaultVoucherRow());
    var w = $('vWord'); if (w) w.value = S.state.param.voucherWord || '记';
    var no = $('vNo'); if (no) no.value = S.nextVoucherNo((w && w.value) || '记', currentPeriod());
    var dt = $('vDate');
    if (dt) {
      var curP = currentPeriod();
      var now = new Date();
      var natM = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
      dt.value = (curP === natM) ? (H.todayStr ? H.todayStr() : todayStr()) : U.lastDay(curP);
    }
    var at = $('vAttach'); if (at) at.value = 0;
    renderVoucherRows();
    closeVchTpl();
    showToast('已套用模板「' + t.name + '」，请填写金额后保存', 'success', 3200);
  }
  if (!dirty) return fill();
  if (H.confirmAsync) {
    H.confirmAsync('套用模板将覆盖当前录入内容，是否继续？', { title: '套用凭证模板' })
      .then(function (ok) { if (ok) fill(); });
  } else fill();
}
(function bindVchTpl() {
  var menu = $('vchTplMenu');
  var bOpen = $('btnVchTpl');
  function hideMenu() { if (menu) menu.hidden = true; }
  if (bOpen && menu) bOpen.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; });
  // 点击其它处关闭下拉
  document.addEventListener('click', hideMenu);
  // 「保存为模板」面板
  var saveModal = $('vchTplSaveModal');
  if (saveModal) {
    function hideSaveTpl() { saveModal.classList.remove('show'); }
    var bSaveOk = $('btnVchTplSaveOk'), bSaveCls = $('btnVchTplSaveClose'), bSaveCal = $('btnVchTplSaveCancel');
    if (bSaveOk) bSaveOk.addEventListener('click', commitVchTplSave);
    if (bSaveCls) bSaveCls.addEventListener('click', hideSaveTpl);
    if (bSaveCal) bSaveCal.addEventListener('click', hideSaveTpl);
    saveModal.addEventListener('click', function (e) { if (e.target === saveModal) hideSaveTpl(); });
  }
  // 下拉两项（形态）
  var sItem = $('vchTplSaveItem'); if (sItem) sItem.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideMenu(); saveCurrentAsTpl(); });
  var uItem = $('vchTplUseItem'); if (uItem) uItem.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideMenu(); openVchTpl(); });
  var bClose = $('btnVchTplClose'); if (bClose) bClose.addEventListener('click', closeVchTpl);
  var tplSearch = $('vchTplSearch');
  if (tplSearch) tplSearch.addEventListener('input', function () { renderVchTplList(); });
  var list = $('vchTplList');
  if (list) list.addEventListener('click', function (e) {
    var use = e.target.closest && e.target.closest('.vch-tpl-use');
    var del = e.target.closest && e.target.closest('.vch-tpl-del');
    if (use) {
      var id = use.getAttribute('data-id');
      var t = null;
      if (id && id.slice(0, 3) === 'sys') {
        (builtinTplResolved() || []).some(function (x) { if (x.id === id) { t = x; return true; } return false; });
      } else {
        (S.vchTemplates() || []).some(function (x) { if (x.id === id) { t = x; return true; } return false; });
      }
      if (!t) return;
      if (!t.entries.length) { showToast('模板「' + t.name + '」没有可套用的分录', 'warn'); return; }
      if (t.missing && t.missing.length) {
        showToast('模板「' + t.name + '」有 ' + t.missing.length + ' 条分录的科目本账套没有，已跳过，套用后请补录', 'warn', 4000);
      }
      applyVchTpl(t);
    } else if (del) {
      H.confirmAsync('确认删除该模板？', { title: '删除凭证模板' })
        .then(function (ok) {
          if (!ok) return;
          var r = S.removeVchTemplate(del.getAttribute('data-id'));
          if (!r.ok) return showToast(r.msg, 'error');
          showToast('模板已删除');
          renderVchTplList();
        });
    }
  });
})();
export { refreshVoucher, refreshSum, refreshQuery, refreshRecycleBin };
// app.js 路由 / 查询页点击调用入口
globalThis.__VOUCHER__ = {
  showVoucherEdit: showVoucherEdit,
  loadVoucherToEdit: loadVoucherToEdit,
  openVoucherPage: openVoucherPage,
  prefillVoucher: prefillVoucher,
  refreshRecycleBin: refreshRecycleBin
};
// 凭证回收站入口：点击弹出 modal 显示已软删凭证列表，可还原
(function bindRecycleBinBtn() {
  var btn = document.getElementById('btnRecycleBin');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var modal = document.getElementById('recycleBinModal');
    if (!modal) return;
    modal.classList.add('show');
    refreshRecycleBin();
  });
  // 关闭按钮
  function closeRecycleBin() {
    var m = document.getElementById('recycleBinModal');
    if (m) m.classList.remove('show');
  }
  var x = document.getElementById('recycleBinClose');
  if (x) x.addEventListener('click', closeRecycleBin);
  var x2 = document.getElementById('btnRecycleBinClose2');
  if (x2) x2.addEventListener('click', closeRecycleBin);
})();
