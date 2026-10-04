/* 界面放大（UI Scale）单点 —— 2026-10-04 新增
 *
 * 【为什么做】窗口最小尺寸已卡到 900×600（见 tauri.conf.json / tools/layout_min.js），
 *   但"字太小看不清"是另一件事：用户需要把**整个界面等比放大**，而不是缩小窗口。
 *   注意两者是不同的东西：调小窗口 = 可用空间变少（会触发降级）；放大界面 = 每个像素变大
 *   （可用空间同样变少！所以放大必须**有上限**，见下）。
 *
 * 【机制为什么选 CSS zoom 而不是 WebView 原生 zoom】
 *   · 原生（__TAURI__.webview.setZoom）依赖该 API 在 withGlobalTauri 下是否导出，版本间有差异；
 *   · CSS `zoom` 在 Chromium/WebKit 上都已标准化并稳定，且**浏览器预览里同样生效** ——
 *     于是 tools/layout_probe.js 能把"放大后布局是否还成立"真正测出来（原生 zoom 测不到）。
 *   代价：zoom 会让有效布局宽度变窄（zoom 1.25 @ 1280px 窗口 → 有效 1024px），故必须有安全上限。
 *
 * 【安全上限（本模块的核心）】放大后的**有效布局宽度**不得低于 LAYOUT_MIN_W（900px）——
 *   那是实测出来的"布局不塌陷"下限（依据与实测数据见 tools/layout_min.js）。即：
 *       cap = clamp(floor(窗口宽 / 900 * 10) / 10, 0.8, 1.5)
 *   例：1280 → 1.4；1024 → 1.1；900 → 1.0（此时不允许再放大，只允许缩小）。
 *   这样"放大"永远不会把用户带进布局坏掉的区间 —— 而不是先放大再让界面崩掉。
 *   ⚠ LAYOUT_MIN_W 与 tools/layout_min.js 的 SAFE_MIN.w 必须一致，
 *     由 tools/check_window_min.js 卡口守住（那两处是跨语言常量，没法共享一个文件）。
 *
 * 【入口】Ctrl/Cmd + `+` / `-` 缩放、Ctrl/Cmd + `0` 复位（与浏览器一致，无需改 index.html）。
 *   设置页的按钮式入口待补（设置页分区是静态 HTML，当前 index.html 正被另一处改动占用）。
 *   任何位置都可调用：globalThis.__TY_UI_SCALE__（与 main.js 里的 __EXTRA_UPDATE_PERIOD_TRIGGER__
 *   同一约定）。⚠ 不挂到 H 上：tools/check_helper_deps.js 分不清"写入 H.xxx"与"读 H.xxx"，
 *   挂上去会被判成"未注册的依赖断裂"（实测确如此 ✗）。
 */
import { showToast } from './helpers.js?v=dev';

const KEY = 'kis_ui_scale';      // 与全站既有键名前缀一致（kis_cur / kis_settings …）
const MIN = 0.8, MAX = 1.5, STEP = 0.1;
/* ⚠ 改动此处必须同步 tools/layout_min.js 的 SAFE_MIN.w（tools/check_window_min.js 会比对，改歪即报错） */
const LAYOUT_MIN_W = 900;

function round1(v) { return Math.round(v * 10) / 10; }

/* 当前窗口宽下允许的最大放大比例 */
function capFor(winW) {
  const w = Number(winW) || LAYOUT_MIN_W;
  return Math.min(MAX, Math.max(MIN, round1(Math.floor((w / LAYOUT_MIN_W) * 10) / 10)));
}

function normalize(v, winW) {
  let n = Number(v);
  if (!isFinite(n)) n = 1;
  n = round1(Math.min(MAX, Math.max(MIN, n)));
  return Math.min(n, capFor(winW === undefined ? window.innerWidth : winW));
}

function read() {
  let v = 1;
  try { const raw = localStorage.getItem(KEY); if (raw != null && raw !== '') v = parseFloat(raw); } catch (e) {}
  return normalize(v);
}

/* ==== 唯一的应用点：所有入口（快捷键 / API / 恢复存储值 / 窗口变化）最终都走这里 ==== */
function apply(v, opt) {
  const scale = normalize(v);
  const root = document.documentElement;
  if (scale === 1) root.style.removeProperty('zoom');
  else root.style.setProperty('zoom', String(scale));
  /* 供自动化读取（tools/layout_probe.js 用它决定"放大后再测一遍"） */
  root.setAttribute('data-ui-scale', String(scale));
  try { localStorage.setItem(KEY, String(scale)); } catch (e) {}
  if (opt && opt.notify) {
    const capped = Number(v) > scale + 1e-9;
    showToast('界面缩放 ' + Math.round(scale * 100) + '%' +
      (capped ? '（已到本窗口宽度的上限）' : ''), capped ? 'warn' : 'info');
  }
  return scale;
}

function set(v, opt) { return apply(v, opt); }
function step(delta, opt) { return apply(read() + delta, Object.assign({ notify: true }, opt || {})); }
function reset(opt) { return apply(1, Object.assign({ notify: true }, opt || {})); }

/* 窗口变窄时自动回落，避免"上次放大过、这次窗口小了"导致布局塌陷 */
function onResize() {
  const cur = read();
  const cap = capFor(window.innerWidth);
  if (cur > cap) apply(cap, { notify: true });
}

function installShortcuts(doc) {
  const d = doc || document;
  d.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key;
    if (k === '=' || k === '+' || e.code === 'NumpadAdd') { e.preventDefault(); step(+STEP); }
    else if (k === '-' || k === '_' || e.code === 'NumpadSubtract') { e.preventDefault(); step(-STEP); }
    else if (k === '0' || e.code === 'Numpad0') { e.preventDefault(); reset(); }
  });
  window.addEventListener('resize', onResize);
}

const api = {
  MIN: MIN, MAX: MAX, STEP: STEP,
  get: function () { return read(); },
  set: set, step: step, reset: reset,
  capFor: capFor,
  apply: apply,
  installShortcuts: installShortcuts,
};

/* 自装：恢复上次的缩放 + 挂快捷键。在模块加载时立即生效（main.js 只 import 本文件）。 */
apply(read());
installShortcuts();

globalThis.__TY_UI_SCALE__ = api;

export { api as uiScale, capFor, apply, LAYOUT_MIN_W };
