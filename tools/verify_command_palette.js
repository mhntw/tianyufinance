/* 「命令面板」下线守卫 + 左侧导航数据源自检 —— 2026-11-01 重写。
 *
 * 【历史】命令面板换过三种形态：居中模态面板（.modal-cmd）→ 顶栏按钮（.cmd-trigger）
 *   → 只剩 Ctrl/Cmd+K 唤起 js/command-palette.js 去开标签栏「更多 ▾」。2026-11-01 导航
 *   收回左侧常驻菜单（.sidenav）后，唤起器与「更多 ▾」一并删除，本文件随之从
 *   「契约检查」改为「下线守卫」—— 继续断言旧实现细节只会永久报红。
 *
 * 【这个门禁盯什么】死掉的功能最容易以"再加个入口"的方式回潮，而 UI 不报错、其它测试也不红：
 *   ① 有人把 js/command-palette.js 或 .cmd-* 样式加回来 → 又变成两套入口两套数据；
 *   ② 菜单数据源出现第二份（复制一份 QUICK_MENU_ITEMS）→ 侧栏与别处对不上；
 *   ③ 菜单项指向不存在的页面（page 键与 index.html 的 #page-* 脱节）→ 点了没反应。
 * 纯静态断言（读源码），与 verify_tab_pins 的分工：那边管标签栏（钉住 / 更多 ▾ / 常用功能弹窗），
 * 这边管命令面板与导航数据源。价值在"有人把行为改回去时能红"，不替代 UI 测试。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const APP_CODE = stripComments(APP);
const CSS_CODE = stripComments(CSS);

/* js/ 下全部源码（剥注释后拼一份），用于"换个文件复活"的检查 */
function walkJs(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, acc);
    else if (e.name.endsWith('.js') && e.name !== 'echarts.min.js') acc.push({ path: p, code: stripComments(fs.readFileSync(p, 'utf8')) });
  });
  return acc;
}
const JS_FILES = walkJs(path.join(ROOT, 'js'), []);

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

console.log('=== A. 命令面板彻底下线（文件 / 引用 / 样式 / 快捷键） ===');

T('A1 js/command-palette.js 已删除',
  !fs.existsSync(path.join(ROOT, 'js/command-palette.js')));

T('A2 index.html 不再加载 command-palette.js 或引用其全局',
  !/command-palette/.test(HTML) && !/openCommandPalette|CommandPalette/.test(HTML));

T('A3 js/ 下任何文件都不再出现面板标识（cmd-box / cmd-input / cmd-results / modal-cmd）',
  !JS_FILES.some(function (f) { return /cmd-box|cmd-input|cmd-results|cmd-list|modal-cmd/.test(f.code); }),
  JS_FILES.filter(function (f) { return /cmd-box|cmd-input|cmd-results|cmd-list|modal-cmd/.test(f.code); })
    .map(function (f) { return path.relative(ROOT, f.path); }).join(', '));

T('A4 CSS 里已无 .cmd-* / .modal-cmd 活规则（注释里的删除留痕不算）',
  !/\.cmd-[a-z-]+/.test(CSS_CODE) && !/\.modal-cmd/.test(CSS_CODE));

T('A5 不再有 Ctrl/Cmd + K 唤起（唯一入口已随导航回到侧栏而删除）',
  !/metaKey\s*\|\|\s*e\.ctrlKey/.test(APP_CODE) && !/KEY_K|'K'\s*==/.test(APP_CODE));

T('A6 顶栏不再有「快速跳转 / 全部功能」按钮（无 #cmdTrigger）',
  !/cmdTrigger/.test(HTML) && !/cmdTrigger/.test(APP_CODE));

console.log('\n=== B. 导航唯一数据源（左侧 .sidenav 消费 QUICK_MENU_ITEMS） ===');

T('B1 index.html 有左侧导航容器 <nav class="sidenav" id="sideNav">',
  /<nav class="sidenav" id="sideNav"/.test(HTML));

T('B2 QUICK_MENU_ITEMS 全仓只有一处定义（且有且仅有 app.js 那一份）',
  JS_FILES.filter(function (f) { return /QUICK_MENU_ITEMS\s*=\s*\[/.test(f.code); }).length === 1 &&
  /QUICK_MENU_ITEMS\s*=\s*\[/.test(APP_CODE));

T('B3 renderSideNav 是该数据源的消费方（函数体内按分组遍历）',
  /function renderSideNav\(\)/.test(APP_CODE) &&
  /function renderSideNav\(\)[\s\S]*?QUICK_MENU_ITEMS\.forEach/.test(APP_CODE));

/* 菜单项 → 页面容器：page 键必须真有 #page-<key>，否则点了没反应且只有手点才发现 */
(function () {
  const i = APP_CODE.indexOf('var QUICK_MENU_ITEMS = [');
  const block = i < 0 ? '' : APP_CODE.slice(i, APP_CODE.indexOf('\n  ];', i));
  const pages = [];
  const re = /page\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block))) pages.push(m[1]);
  const missing = pages.filter(function (p) { return HTML.indexOf('id="page-' + p + '"') < 0; });
  T('B4 菜单项的 ' + pages.length + ' 个 page 键都有对应页面容器 #page-*',
    pages.length > 0 && missing.length === 0, missing.join(', '));
})();

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
