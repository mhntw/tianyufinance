// 弹窗桥接：全软件唯一的对话框实现（确认 / 输入共用同一套）。
//
// 设计要点：
//   ① 不用系统原生框 —— Tauri 的 dialog.confirm 与浏览器 window.confirm 都不支持换行排版，
//      多段说明会被挤成一整段；三平台外观也各异，与网页风格的软件不协调。
//      （官方 dialog 插件本就不含 prompt，输入框一直只能自建。）
//   ② 复用页面既有的 .modal / .modal-box / .modal-actions 样式 —— 与全部业务模态框同一套外观，
//      全软件只保留一种弹窗长相。
//   ③ 确认与输入**合并为一个 showDialog**（用 input 参数区分），避免两套实现各自漂移 ——
//      此前 prompt 走 window.prompt、confirm 走自建浮层，行为就不一致过。
//
// 对外 API（app.js 的 H 对象与各页面模块都从这里取）：
//   confirmAsync(message, { title })      → Promise<boolean>
//   promptAsync(message, def, { title })  → Promise<string|null>
//   showDialog({ title, message, input }) → 通用实现（input 省略即为确认框）
//   renderDialogBody(text)                → 正文 HTML（分段 / 缩进 / 列表）

// 【2026-10-31 收敛】原来自建了 _dlgStack + _activeClose 第二套"只关最上层"机制，
// 与 app.js 的 TYModal/全局 Esc 栈并行。现在全部交给统一入口：
//   · Esc / 遮罩 / × → 全局 closeModal → overlay.__onClose → 本文件的 finish()
//   · 回车 = 确定 → 本文件只保留这一条（全局没有 Enter 语义）
// 因此不再需要独立栈。

// 正文渲染：把各调用点现有的纯文本文案转成有版面层次 HTML（**不改任何调用点的文案写法**）。
//   ① 空行断块；连续普通行合成一段（段内 <br> 保持原有行距）
//   ② 列表项（以 · / • / * / - 开头）→ 一项一块，供渲染层做悬挂缩进
//   ③ 「（」开头必须另起一块：文案普遍写成「问句\n（补充说明）」，括号前是单换行而非空行，
//      若等空行才断块，旁注会被并进问句段；且块类型只由首行决定，后续行延续该块
//      （多行括号说明的第二行并不以「（」开头）
// 缩进统一由容器给（见 showDialog 的 .modal-body padding-left），这里只管块划分。
// 文本一律先做 HTML 转义（文案里嵌的是卡片名等用户数据）。
function renderDialogBody(msg) {
  function esc1(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  var blocks = [];   // { type: 'para' | 'list' | 'note', lines: [] }
  var cur = null;
  esc1(msg).split('\n').forEach(function (ln) {
    var t = ln.trim();
    if (t === '') { cur = null; return; }                                  // 空行断块
    if (/^[·•*\-]\s+/.test(t)) {                                           // 列表项：一项一块
      cur = { type: 'list', lines: [ln] }; blocks.push(cur); cur = null; return;
    }
    if (/^[（(]/.test(t) || !cur) {
      cur = { type: /^[（(]/.test(t) ? 'note' : 'para', lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(ln);
  });
  if (!blocks.length) return '';
  return blocks.map(function (b, i) {
    var last = (i === blocks.length - 1);
    var html = b.lines.join('<br>');   /* escape-ok: lines 来自第 40 行 esc1(msg) 之后的切分，整段文本已转义 */
    if (b.type === 'list') {
      // 列表项：在正文缩进之上再挂一级（符号凸出、文字对齐、多项成列）
      return '<p style="' + (last ? 'margin:0;' : 'margin:0 0 4px;') +
        'padding-left:1em;text-indent:-1em;">' + html + '</p>';
    }
    return '<p style="' + (last ? 'margin:0;' : 'margin:0 0 10px;') + '">' + html + '</p>';
  }).join('');
}

// 唯一对话框实现。opts: { title?, message, input? }；input 存在即为输入框模式。
// 返回 Promise：确认 → 输入模式返回输入值（已 trim），确认模式返回 true；
//              取消 / Esc / 点遮罩 → 输入模式返回 null，确认模式返回 false。
function showDialog(opts) {
  opts = opts || {};
  var isInput = !!opts.input;
  return new Promise(function (resolve) {
    if (typeof document === 'undefined') { resolve(isInput ? null : false); return; }
    function esc(s, quote) {
      var t = String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return quote ? t.replace(/"/g, '&quot;') : t;
    }
    var safeTitle = esc(opts.title || (isInput ? '输入' : '确认'));
    var overlay = document.createElement('div');
    overlay.className = 'modal modal-top';         // 层级走 .modal-top 类，不再内联 zIndex
    overlay.setAttribute('data-backdrop', 'close'); // 点遮罩 = 取消（全局委托统一处理）
    overlay.innerHTML =   /* escape-ok: safeTitle 走 esc()，正文走 renderDialogBody()（内部 esc1），输入值 esc(..., true) */
      // 宽度交给 .modal-box 的常规档 400px（全站 5 档宽度之一），长文案交给 .modal-body 折行。
      '<div class="modal-box">' +
        // 标题栏必须带 ×（全站统一）：data-modal-close 由全局委托接管 → closeModal → __onClose
        '<div class="modal-title">' + safeTitle +
          '<button class="modal-x" data-modal-close="1" aria-label="关闭">×</button></div>' +
        // 正文整体左缩进：层次 =「标题顶格 ↔ 正文缩进」，一次设置覆盖所有内容，不必逐段判断
        // "超高可滚动"由样式表 .modal-body 统一提供（max-height:60vh + overflow:auto）。
        '<div class="modal-body" style="line-height:1.75;word-break:break-word;padding-left:1em;">' +
          renderDialogBody(opts.message) +
          (isInput
            ? '<input class="inp ty-dlg-input" type="text" value="' + esc(opts.input.value, true) +
              '" style="width:100%;box-sizing:border-box;margin-top:6px;">'
            : '') +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-primary ty-dlg-ok">确定</button>' +
          '<button class="btn ty-dlg-cancel">取消</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var input = isInput ? overlay.querySelector('.ty-dlg-input') : null;
    var okBtn = overlay.querySelector('.ty-dlg-ok');
    var cancelBtn = overlay.querySelector('.ty-dlg-cancel');
    var closed = false;
    var _closeKind = null;                   // 本次关闭意图（'ok' / 'cancel'），供 __onClose 取值
    function valueOf(kind) {                 // kind: 'ok' | 'cancel'
      if (!isInput) return kind === 'ok';
      return kind === 'ok' ? (input ? input.value.trim() : '') : null;
    }
    // 业务收尾：只负责移除 DOM + resolve；隐藏/焦点还原已由 closeModal 统一完成
    function finish(kind) {
      if (closed) return;                    // 防重复（连点按钮 + 按键 + 遮罩/×/Esc）
      closed = true;
      if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onKey, false);
      if (input && input.removeEventListener) input.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(valueOf(kind));
    }
    // 统一关闭入口：所有路径都先进 closeModal（移除 show + 焦点还原），再由 __onClose 收尾
    function close(kind) {
      if (closed) return;
      _closeKind = kind;
      if (overlay.classList.contains('show') && globalThis.TYModal) globalThis.TYModal.close(overlay);
      else finish(kind);
    }
    overlay.__onClose = function () { finish(_closeKind || 'cancel'); };
    function onKey(e) {
      // 只保留「回车 = 确定」；Esc/遮罩/× 已由 TYModal 统一处理，不再重复判定。
      // 回车用 e.key 与 keyCode 双判定：中文输入法组合态或个别 webview 下 e.key 可能为空/'Process'。
      if (closed) return;
      var t = globalThis.TYModal && globalThis.TYModal.top && globalThis.TYModal.top();
      if (t && t !== overlay) return;        // 嵌套对话框时只有最上层响应回车
      var k = e.key || '';
      var code = e.keyCode || e.which || 0;
      if (k === 'Enter' || code === 13) { e.preventDefault(); close('ok'); }
    }
    if (okBtn) okBtn.onclick = function () { close('ok'); };
    if (cancelBtn) cancelBtn.onclick = function () { close('cancel'); };
    // 键盘监听挂 document（不依赖焦点），用**冒泡阶段**（捕获阶段在个别 webview 里不可靠）；
    // 输入框再单独挂一份双保险 —— 两处都会触发 onKey，靠 closed 守卫保证只生效一次。
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onKey, false);
    if (input && input.addEventListener) input.addEventListener('keydown', onKey);
    // 打开：统一入口负责显示 + 焦点移入前的记录；随后自行聚焦更合适的目标（输入框/确定键）
    if (globalThis.TYModal) globalThis.TYModal.open(overlay);
    else overlay.classList.add('show');
    if (input) { input.focus(); if (input.value) input.select(); }
    else if (okBtn) okBtn.focus();
  });
}

// message: 提示文本（支持 \n 换行）；opts: { title? }；返回 Promise<boolean>
function confirmAsync(message, opts) {
  return showDialog({ title: opts && opts.title, message: message });
}

// message: 提示文本；def: 默认值；opts: { title? }；返回 Promise<string|null>
function promptAsync(message, def, opts) {
  return showDialog({
    title: opts && opts.title,
    message: message,
    input: { value: def == null ? '' : def }
  });
}

// UMD：浏览器（传统脚本/ESM）与 Node（测试）均可取。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { showDialog: showDialog, confirmAsync: confirmAsync, promptAsync: promptAsync, renderDialogBody: renderDialogBody };
} else if (typeof window !== 'undefined') {
  window.__dialogBridge = { showDialog: showDialog, confirmAsync: confirmAsync, promptAsync: promptAsync, renderDialogBody: renderDialogBody };
}
