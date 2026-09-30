#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_update_status.js —— 「检查更新」的结果必须**就地**显示，且可操作
 *
 * 【为什么有这个脚本】2026-09-30 用户反馈：点「检查更新」后，更新相关的文字出现在
 *   **屏幕正中央**、却不可点击、一闪而过，"没有意义"。查证属实：
 *     · 反馈一律走 showToast，而 .toast 是 `position:fixed; left:50%; top:50%`
 *       —— 固定屏幕正中，视觉上像个弹窗；
 *     · "正在检查…"、"已是最新"这些 toast **没有任何点击行为**（只有"发现新版本"那条绑了点击）；
 *     · 默认 2.2 秒消失，长文案根本读不完。
 *   另外 update.js 还会把 `#aboutCheckUpdate` 的文案**改写成「下载 vX →」** ——
 *   改完"检查更新"四个字就永久消失，用户再也点不到第二次。
 *
 * 【现在的要求（本脚本守的就是它）】
 *   A. 手动检查的**所有**结果都写进 #aboutUpdateStatus（「检查更新」右侧），**一次 toast 都不弹**；
 *   B. 「检查更新」这四个字**不得被改写**（否则入口消失）；
 *   C. "发现新版本"必须在就地文本里给一个**真的可点**的「下载 →」，点了会去下载；
 *   D. 失败要写清"下一步怎么办"，不能只扔一句"失败"；
 *   E. 连点只发一个请求（否则后一次的结果会把前一次覆盖掉，状态看起来乱跳）。
 *   启动时的静默检查保留 toast（那时用户不在"关于"卡里，需要一个看得见的提示）——
 *   但它与手动检查共用同一套"发现新版本"文案。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail ? '   → ' + detail : '')); }
}

/* ---------- DOM mock（只做本模块用到的部分） ---------- */
function mkEl(id) {
  return {
    id: id, _text: '', className: '', children: [], style: {}, onclick: null, attrs: {},
    get textContent() { return this._text + this.children.map(function (c) { return c._text; }).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild: function (c) { this.children.push(c); return c; },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; }
  };
}
let ELS = {};
/* Node 26 里 navigator / localStorage 是**只读 getter**（直接赋值会 TypeError）—— 统一走 defineProperty。
   （这是本脚本第二次踩同一个坑的类型：之前是 navigator，这次连 localStorage 一起处理。） */
function defGlobal(name, value) {
  Object.defineProperty(global, name, { value: value, writable: true, configurable: true });
}
defGlobal('window', global);
defGlobal('document', {
  getElementById: function (id) { return ELS[id] || null; },
  createElement: function () { return mkEl(''); },
  createTextNode: function (t) { return { _text: String(t) }; }
});
defGlobal('navigator', {
  platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Apple Silicon'
});

/* ---------- 可控的 fetch / Tauri / localStorage ---------- */
const invoked = [];
let fetchCalls = 0, fetchMode = 'ok', payload = null, LOCAL = '0.6.19';
global.fetch = function () {
  fetchCalls++;
  if (fetchMode === 'reject') return Promise.reject(new Error('network down'));
  if (fetchMode === 'http500') return Promise.resolve({ ok: false, status: 500 });
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve(payload); } });
};
global.__TAURI__ = {
  core: {
    invoke: function (cmd, args) {
      invoked.push({ cmd: cmd, args: args });
      if (cmd === 'app_version') return Promise.resolve(LOCAL);
      return Promise.resolve();
    }
  }
};
const store = {};
defGlobal('localStorage', {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
});

/* ---------- 装载被测源码 ---------- */
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'update.js'), 'utf8'));
const UPD = global.__TY_UPDATE__;
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); };

function release(version, assetName) {
  return { tag_name: 'v' + version, html_url: 'https://example.com/rel', assets: [{ name: assetName || '添钰财务_' + version + '_aarch64.dmg', browser_download_url: 'https://example.com/dl', size: 123 }] };
}
function freshEls() {
  ELS = { aboutUpdateStatus: mkEl('aboutUpdateStatus'), aboutCheckUpdate: mkEl('aboutCheckUpdate'), toast: mkEl('toast') };
  ELS.aboutCheckUpdate.textContent = '检查更新';
  const toasts = [];
  global.showToast = function (msg) { toasts.push(msg); };
  return toasts;
}

(async function main() {
  check(UPD && typeof UPD.check === 'function', '应能加载 js/update.js 并取到 __TY_UPDATE__.check');

  console.log('\n【A】已是最新：结果就地显示，且**一次 toast 都不弹**');
  let toasts = freshEls();
  LOCAL = '0.6.19'; payload = release('0.6.19');
  UPD.check(); await wait(40);
  const st = ELS.aboutUpdateStatus;
  check(st.textContent.indexOf('已是最新') >= 0, '状态写在 #aboutUpdateStatus 里', '实际="' + st.textContent + '"');
  check(st.className.indexOf('ok') >= 0, '通过时用语义绿色类（.about-status.ok）', '实际 class="' + st.className + '"');
  check(toasts.length === 0, '**不得**再弹屏幕中央的 toast（这正是用户反馈的问题）', '实测弹了 ' + toasts.length + ' 条：' + toasts.join(' | '));
  check(ELS.aboutCheckUpdate.textContent === '检查更新', '「检查更新」四个字不得被改写（否则入口永久消失）',
    '实际="' + ELS.aboutCheckUpdate.textContent + '"');

  console.log('\n【B】发现新版本：就地文本里必须有**真的可点**的「下载 →」');
  toasts = freshEls();
  LOCAL = '0.6.19'; payload = release('0.7.0');
  UPD.check(); await wait(40);
  const st2 = ELS.aboutUpdateStatus;
  check(st2.textContent.indexOf('发现新版本 v0.7.0') >= 0, '就地显示新版本号', '实际="' + st2.textContent + '"');
  // ⚠ 子元素里第一个是**文本节点**（"发现新版本 vX"），链接在其后 —— 找"带 onclick 的那个"才稳
  const link = st2.children.filter(function (c) { return typeof c.onclick === 'function'; })[0];
  check(!!link, '文本里应含一个可点子元素（不是只有文字）',
    '子元素=' + st2.children.map(function (c) { return JSON.stringify(c._text); }).join(','));
  check(!!link && link.textContent === '下载 →', '该子元素就是「下载 →」', link ? link.textContent : '');
  check(ELS.aboutCheckUpdate.textContent === '检查更新', '此时「检查更新」仍不得被改成"下载 vX →"',
    '实际="' + ELS.aboutCheckUpdate.textContent + '"');
  invoked.length = 0;
  if (link && link.onclick) link.onclick();
  check(invoked.some(function (c) { return c.cmd === 'open_url' && /example\.com\/dl/.test(c.args && c.args.url || ''); }),
    '点「下载 →」应真的去下载（open_url 收到该 Release 资产地址）', JSON.stringify(invoked));
  check(toasts.length === 0, '发现新版本同样不弹 toast（就地文本已可直接点）', '实测 ' + toasts.length + ' 条');

  console.log('\n【C】失败：写清下一步怎么办，且不弹 toast');
  toasts = freshEls();
  fetchMode = 'reject';
  UPD.check(); await wait(40);
  const st3 = ELS.aboutUpdateStatus;
  check(st3.textContent.indexOf('检查失败') >= 0, '失败时状态就地显示"检查失败"', '实际="' + st3.textContent + '"');
  check(st3.textContent.indexOf('重试') >= 0, '要告诉用户下一步（可重试）', '实际="' + st3.textContent + '"');
  check(st3.className.indexOf('err') >= 0, '失败用语义红色类（.about-status.err）', '实际 class="' + st3.className + '"');
  check(toasts.length === 0, '失败也不弹 toast', '实测 ' + toasts.length + ' 条');
  fetchMode = 'http500';
  UPD.check(); await wait(40);
  check(ELS.aboutUpdateStatus.textContent.indexOf('检查失败') >= 0,
    'HTTP 非 2xx 同样报"检查失败"（不得静默无反应）', '实际="' + ELS.aboutUpdateStatus.textContent + '"');

  console.log('\n【D】连点只发一个请求（否则结果会互相覆盖、状态乱跳）');
  toasts = freshEls(); fetchMode = 'ok'; payload = release('0.9.9');
  fetchCalls = 0;
  UPD.check(); UPD.check(); UPD.check();
  await wait(60);
  check(fetchCalls === 1, '连点三次只应发 1 个请求', '实测 ' + fetchCalls + ' 次');
  check(ELS.aboutUpdateStatus.textContent.indexOf('发现新版本 v0.9.9') >= 0, '最终状态是第一次检查的结果',
    '实际="' + ELS.aboutUpdateStatus.textContent + '"');

  console.log('\n【E】启动静默检查：保留 toast（用户不在"关于"卡，需要一个看得见的提示）');
  toasts = freshEls(); delete store.ty_update_check; delete store.ty_update_notified;
  LOCAL = '0.6.19'; payload = release('0.8.0');
  UPD.silentCheck(); await wait(50);
  check(toasts.length === 1, '静默检查发现新版本应弹一条提示（这是它在别处唯一可见的渠道）',
    '实测 ' + toasts.length + ' 条');
  check(ELS.aboutUpdateStatus.textContent.indexOf('发现新版本 v0.8.0') >= 0,
    '同时把就地状态也写好（用户之后打开"关于"仍能看到可点下载）',
    '实际="' + ELS.aboutUpdateStatus.textContent + '"');

  console.log('\n【F】静态卡口（防复发）');
  // ⚠ 查静态模式前先剥注释：本项目的注释里会（也应该）写出反模式的样子，否则卡口会被自己的说明命中
  const srcRaw = fs.readFileSync(path.join(ROOT, 'js', 'update.js'), 'utf8');
  const src = srcRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/\/\/.*$/gm, ' ');
  check(src.indexOf('aboutCheckUpdate') < 0,
    'update.js 的代码里不得再出现 aboutCheckUpdate（不得改写「检查更新」的文案）');
  const manual = src.slice(src.indexOf('function checkUpdateManual'), src.indexOf('function silentCheckUpdate'));
  check(manual.indexOf('showToast') < 0 && manual.indexOf('toast(') < 0,
    '手动检查路径里不得出现任何 toast 调用（改为就地显示）');
  check(manual.indexOf('setStatus') >= 0, '手动检查的每条出口都应经过 setStatus（就地显示的单点）');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const iChk = html.indexOf('id="aboutCheckUpdate"'), iSt = html.indexOf('id="aboutUpdateStatus"');
  check(iChk >= 0 && iSt > iChk, 'index.html 里 #aboutUpdateStatus 应紧跟在 #aboutCheckUpdate **右侧**（DOM 顺序=视觉顺序）',
    'iChk=' + iChk + ' iSt=' + iSt);

  console.log('');
  console.log(fail === 0 ? ('✓ 检查更新的就地状态：' + pass + ' 项全部通过')
    : ('✗ 通过 ' + pass + ' / 不符 ' + fail));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('脚本自身异常：' + (e && e.stack || e));
  process.exit(1);
});
