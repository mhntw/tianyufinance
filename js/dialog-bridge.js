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

// 未关闭浮层的栈（关闭时用于回落），以及"当前响应键盘的那一个"。
// 刻意用单独的 _activeClose，而不是每次去比较"栈顶是不是我"：若历史上某个弹窗异常退出、
// 没从栈里摘干净，栈顶判断会**永久失效** —— 表现为回车/Esc 全部静默无反应（实测反馈）。
// 而新弹窗一打开就接管 _activeClose，不受任何陈旧残留影响，天然自愈。
var _dlgStack = [];
var _activeClose = null;

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
    var html = b.lines.join('<br>');
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
    overlay.className = 'modal';            // 复用 .modal / .modal-box / .modal-actions
    overlay.style.zIndex = '2147483647';    // 必须盖住任何已打开的业务模态
    overlay.innerHTML =
      '<div class="modal-box" style="width:460px">' +
        '<div class="modal-title">' + safeTitle + '</div>' +
        // 正文整体左缩进：层次 =「标题顶格 ↔ 正文缩进」，一次设置覆盖所有内容，不必逐段判断
        '<div class="modal-body" style="max-height:60vh;overflow:auto;line-height:1.75;word-break:break-word;padding-left:1em;">' +
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
    overlay.classList.add('show');           // .modal 默认 display:none
    var input = isInput ? overlay.querySelector('.ty-dlg-input') : null;
    var okBtn = overlay.querySelector('.ty-dlg-ok');
    var cancelBtn = overlay.querySelector('.ty-dlg-cancel');
    if (input) { input.focus(); if (input.value) input.select(); }
    else if (okBtn) okBtn.focus();
    var closed = false;
    function valueOf(kind) {                 // kind: 'ok' | 'cancel'
      if (!isInput) return kind === 'ok';
      return kind === 'ok' ? (input ? input.value.trim() : '') : null;
    }
    function close(kind) {
      if (closed) return;                    // 防重复关闭（连点按钮 + 按键 + 遮罩）
      closed = true;
      var i = _dlgStack.indexOf(close);
      if (i >= 0) _dlgStack.splice(i, 1);
      if (_activeClose === close) _activeClose = _dlgStack[_dlgStack.length - 1] || null;
      if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onKey, false);
      if (input && input.removeEventListener) input.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(valueOf(kind));
    }
    function onKey(e) {
      // 多道判断，任何一道失灵都不该让键盘整体无响应：
      //   ① 自己是否还在栈里（已关闭就忽略）；
      //   ② 是否最上层（嵌套时只有最上层响应）；
      //   ③ 回车/ESC 用 e.key 与 keyCode **双判定** —— 中文输入法组合状态或个别 webview 下
      //      e.key 可能为空或为 'Process'，只认 e.key 就会出现「回车没反应、Esc 没反应」。
      if (_activeClose !== close) return;   // 只有当前弹窗响应键盘
      var k = e.key || '';
      var code = e.keyCode || e.which || 0;
      if (k === 'Enter' || code === 13) { e.preventDefault(); close('ok'); }
      else if (k === 'Escape' || k === 'Esc' || code === 27) { e.preventDefault(); close('cancel'); }
    }
    _dlgStack.push(close);
    _activeClose = close;                    // 新弹窗接管键盘（自愈：不惧栈内陈旧残留）
    if (okBtn) okBtn.onclick = function () { close('ok'); };
    if (cancelBtn) cancelBtn.onclick = function () { close('cancel'); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close('cancel'); });
    // 键盘监听挂 document（不依赖焦点），用**冒泡阶段**（捕获阶段在个别 webview 里不可靠）；
    // 输入框再单独挂一份双保险 —— 两处都会触发 onKey，靠 closed 守卫保证只生效一次。
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onKey, false);
    if (input && input.addEventListener) input.addEventListener('keydown', onKey);
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
