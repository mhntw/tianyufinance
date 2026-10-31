/* 全局命令面板（Ctrl/Cmd + K 快速跳转）契约自检 —— 2026-10-31 加强后新增。
 *
 * 【为什么需要这个门禁】
 *   侧栏撤掉之后，"不在首页时切到别的模块"只剩命令面板这一条路（常用功能格子只在首页）。
 *   它的三个能力一旦被后人改回去，用户会直接卡住，且 UI 上不会报错、测试也不会红：
 *     ① 置顶区（最近访问 / 常用功能）—— 这才是"当导航用"的关键，删了面板就退化成"能搜全部模块"；
 *     ② 图标与首页同源 —— 面板与首页换成两套图形，同一功能两处长得不一样；
 *     ③ 空格分词搜索 —— 中文条目靠"凭证 录入"这种组合词定位，退化成单串匹配后长名称很难搜。
 *   纯静态断言（读源码），与 verify_asset_new_flow 的 D/E 段同一风格：这套东西的价值在
 *   "有人把行为悄悄改掉时能红"，而不是替代 UI 测试。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PALETTE = fs.readFileSync(path.join(ROOT, 'js/command-palette.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const STORAGE_CHECK = fs.readFileSync(path.join(ROOT, 'tools/check_storage_ownership.js'), 'utf8');

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

console.log('=== A. 置顶区（无侧栏后它就是导航本体）===');
T('A1 有「最近访问」分组', /emitGroup\('最近访问'/.test(PALETTE));
T('A2 有「常用功能」分组', /emitGroup\('常用功能'/.test(PALETTE));
T('A3 常用功能与首页同源（读 getQuickMenuKeys，不另算一套）',
  /globalThis\.getQuickMenuKeys/.test(PALETTE) && /globalThis\.getQuickMenuKeys = getSavedQuickKeys/.test(APP));
T('A4 最近访问上限 6 条', /RECENT_MAX = 6/.test(PALETTE));
T('A5 最近访问在打开条目时写入', /pushRecent\(it\.page\)/.test(PALETTE));
T('A6 「全部模块」不去重（按分组完整列出，避免分组显示缺项）',
  /全部模块：按分组完整列出，不去重/.test(PALETTE));

console.log('\n=== B. 存储归属 ===');
T('B1 cmd_recent_pages 已在 check_storage_ownership 白名单登记',
  /'cmd_recent_pages'/.test(PALETTE) && /'cmd_recent_pages':/.test(STORAGE_CHECK));
T('B2 只存页面名（JSON 字符串数组），不写账套数据',
  /localStorage\.setItem\(RECENT_KEY, JSON\.stringify/.test(PALETTE));

console.log('\n=== C. 图标与首页同源 ===');
T('C1 面板取 TY_MENU_ICON_PATHS 字形', /TY_MENU_ICON_PATHS/.test(PALETTE));
T('C2 缺字形回退「名称首字」（不留空圆点）', /charAt\(0\)/.test(PALETTE));
T('C3 CSS 有 .cmd-avatar svg 尺寸规则', /\.cmd-avatar svg\{/.test(CSS.replace(/\s+/g, ' ')) || /\.cmd-avatar svg\s*\{/.test(CSS));

console.log('\n=== D. 搜索与键盘 ===');
T('D1 空格分词（多关键词 AND）', /q\.split\(\/\\s\+\/\)/.test(PALETTE) && /hay\.indexOf\(toks\[i\]\) < 0/.test(PALETTE));
T('D2 检索域含 名称/分组/页面名/key',
  /it\.name \+ ' ' \+ it\.group \+ ' ' \+ it\.page \+ ' ' \+ it\.key/.test(PALETTE));
T('D3 Home / End 跳到首末条', /'Home'/.test(PALETTE) && /'End'/.test(PALETTE) && /setActive\(filtered\.length - 1/.test(PALETTE));
T('D4 底部显示结果数', /cmdFootCount/.test(PALETTE) && /'共 ' \+ filtered\.length/.test(PALETTE));
T('D5 懒初始化 ITEMS（避免脚本先于 app.js 解析时拿到空表）', /function ensureItems\(\)/.test(PALETTE));

console.log('\n=== E. 不复用旧代码里的坑 ===');
T('E1 本项目 WebKit 下不能用 <button> 做 flex 容器（顶栏入口仍是 div[role=button]）',
  /createElement\('div'\)/.test(PALETTE) && /setAttribute\('role', 'button'\)/.test(PALETTE));
T('E2 Esc / Tab 仍交给全局模态体系（面板内不重复实现）',
  !/key === 'Escape'/.test(PALETTE) && !/key === 'Tab'/.test(PALETTE));

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
