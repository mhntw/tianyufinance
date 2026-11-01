/* 标签栏职责守卫 —— 2026-11-01 重写（原「标签栏固定区 + 更多 ▾ 菜单契约自检」）。
 *
 * 【历史】首页「常用功能」板块下线后，"我常去哪里"的入口一度被塞进标签栏固定区：
 *   主页 + 钉住页（PIN_MAX 上限）+ 「更多 ▾」下拉（含筛选框 / 最近访问 / 键盘导航）
 *   + 「钉住常用页」弹窗（#quickSettingsOverlay）。2026-11-01 导航收回左侧常驻菜单
 *   （.sidenav，6 组 22 页）后，这一整套随之删除，标签栏回到单一职责：只列已打开的页面。
 *
 * 【这个门禁盯什么】那是"标签栏兼职导航"时期的一批补丁，删掉后最容易被善意地加回来，
 *   而加回来 UI 不报错、其它测试也不会红：
 *   ① 钉住 / 「更多 ▾」/ 常用功能弹窗复活 → 又出现第二条导航路径，与侧栏对不上；
 *   ② 标签栏里混进非"已打开页面"的东西（固定区、溢出补丁）→ 关闭逻辑与 openTabs 打架；
 *   ③ 首页「常用功能」板块半删（只删 DOM 不删渲染）→ 两处入口。
 * 纯静态断言（读源码）。分工：verify_command_palette 管命令面板与导航数据源，本文件管标签栏。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const STORAGE_CHECK = fs.readFileSync(path.join(ROOT, 'tools/check_storage_ownership.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const APP_CODE = stripComments(APP);
const CSS_CODE = stripComments(CSS);
/* HTML 只剥 <!-- --> 注释：删除留痕里会写旧类名，那是文档不是 DOM */
const HTML_CODE = HTML.replace(/<!--[\s\S]*?-->/g, '');

/* 截取 renderOpenTabs 函数体：后面的断言只看这一段，避免全文匹配把注释/别处同名文本算进去 */
function sliceFn(src, signature) {
  const i = src.indexOf(signature);
  if (i < 0) return '';
  const j = src.indexOf('\n  }\n', i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}
const RENDER = sliceFn(APP_CODE, 'function renderOpenTabs(activePage)');

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

console.log('=== A. 钉住区 / 「更多 ▾」/ 常用功能弹窗彻底下线 ===');

T('A1 CSS 里已无固定区与下拉的活规则（.tab-pin-* / .tab-more / .tm-*）',
  !/\.tab-pin-/.test(CSS_CODE) && !/\.tab-more\b/.test(CSS_CODE) && !/\.tm-[a-z-]+/.test(CSS_CODE));

T('A2 CSS 里已无常用功能弹窗的活规则（.qs-*）',
  !/\.qs-[a-z-]+/.test(CSS_CODE));

T('A3 index.html 无固定区 / 下拉 / 弹窗的 DOM（tab-pin / tabMoreMenu / quickSettingsOverlay）',
  !/tab-pin|tabMoreMenu|quickSettingsOverlay|qsBody/.test(HTML_CODE));

T('A4 app.js 里已无「更多 ▾」实现（openMoreMenu / renderMoreMenu / pushRecentPage 等）',
  !/openMoreMenu|renderMoreMenu|toggleMoreMenu|closeMoreMenu|ensureMoreMenu|pushRecentPage|readRecentPages/.test(APP_CODE));

T('A5 app.js 里已无钉住配置体系（PIN_MAX / DEFAULT_QUICK_KEYS / getSavedQuickKeys）',
  !/PIN_MAX|DEFAULT_QUICK_KEYS|FIXED_QUICK_KEY|getSavedQuickKeys|saveQuickKeys|orderedQuickKeys/.test(APP_CODE));

T('A6 存储归属白名单已收回两个旧键（quick_menu_keys / cmd_recent_pages）',
  !/'quick_menu_keys'\s*:/.test(stripComments(STORAGE_CHECK)) &&
  !/'cmd_recent_pages'\s*:/.test(stripComments(STORAGE_CHECK)));

console.log('\n=== B. 标签栏回到单一职责：只列已打开的页面 ===');

T('B1 renderOpenTabs 里不再有钉住 / 更多 的分支',
  RENDER.length > 0 && !/pinned|tab-more|moreMenu|quick/i.test(RENDER));

T('B2 「主页」标签固定渲染且不可关闭（.tab-item-home + house 图标、无 tab-close）',
  /tab-item-home/.test(RENDER) &&
  /homeTab\.innerHTML = '<svg/.test(RENDER) &&
  !/homeTab[\s\S]{0,400}?tab-close/.test(RENDER));

T('B3 业务标签带关闭键（.tab-close 仍由 openTabs 渲染）',
  /class="tab-close"/.test(RENDER));

console.log('\n=== C. 首页「常用功能」板块仍下线（不留半套） ===');

T('C1 index.html / js 里无该板块的 DOM 钩子（home-tabs / home-section-content / home-tab-help）',
  !/home-tabs|home-section-content|home-tab-help/.test(HTML_CODE) &&
  !/home-tabs|home-section-content|home-tab-help/.test(APP_CODE));

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
