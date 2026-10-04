'use strict';
/* JS ↔ CSS 类名契约 —— JS 里输出的 class 应当在 css/style.css 里有定义（或显式登记为"纯钩子"）
 *
 * 【为什么要这个脚本】本项目**真踩过**这一类缺陷：结账页检查项的 JS 输出
 *   `.sci-dot / .done / .settle-check-fail`，而 CSS 里只有
 *   `.settle-check-item.is-ok/.is-warn/.is-fail` —— 两边名字对不上，结果是"检查项没有任何颜色，
 *   既看不出通过、也看不出异常"，而**静态搜索查不出来**（各自都"有"那个字符串）。
 *   已有的 tools/check_dead_elements.js 管的是 **id**；**类名**这半边一直空着，本脚本补上。
 *
 * 【判据】从 js/ 里抽取"字面量类名"（只认静态字面量，动态拼接不认）：
 *     · class="a b c"               （生成 HTML 的字符串，含模板字符串的静态部分）
 *     · className = 'a b'
 *     · classList.add|toggle('a')
 *   再与 css/style.css 的选择器里出现过的类名比对。**未定义的**即为可疑：
 *     · 要么是缺陷（本该有样式却名字写错 → 上面那个案子的类型）；
 *     · 要么是**纯 JS 钩子**（只用于 querySelector / 事件委托，本就不该有样式）。
 *   两者静态上无法区分 —— 故用**基线**（tools/_class_contract_baseline.json）把现存钩子登记在案：
 *   基线内的不报，**新出现的**必须二选一（去 CSS 里补样式，或确认是钩子后写进基线）。
 *   这样既拦得住新缺陷，又不会逼着人去给钩子写无用样式。
 *
 * 【刻意不做的事】不做反向检查（"CSS 里的类没用上就报"）：实测那方向误报极多
 *   （JS 拼接生成的类名、伪类/属性选择器、第三方与打印样式…），会变成一个吵人的门禁 ——
 *   宁可人工审计那一侧（见 2026-10-04 对死 CSS 的审查结论：不立那个卡口）。
 *
 * 用法：
 *   node tools/check_class_contract.js           检查（CI / run-all 用；有新增未定义类则退出码 1）
 *   node tools/check_class_contract.js --list    列出全部未定义类（含基线内的）
 *   node tools/check_class_contract.js --write   把当前未定义类写成基线（钩子登记）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'css', 'style.css');
const BASELINE = path.join(__dirname, '_class_contract_baseline.json');
const VENDOR = /xlsx|mdb-reader|buffer/i;

/* ---------- CSS 侧：所有出现过的类名 ---------- */
const cssRaw = fs.readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
const cssClasses = new Set();
cssRaw.replace(/\.(-?[A-Za-z_][\w-]*)/g, function (_, name) { cssClasses.add(name); return ''; });

/* CSS 侧还包括**写在 JS 字符串里的样式**（打印件是自包含 HTML，其 <style> 就在 app.js 里：
   如 '.print-hint{display:none!important}'）—— 否则会把这类"有样式但不在 style.css"的类误报。
   只认"形如 .name{ 的定义式出现"，避免把 JS 里别的 .name 文本当定义。 */
function walkJsDefs(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) return walkJsDefs(p);
    if (!/\.js$/.test(f.name) || VENDOR.test(f.name)) return;
    fs.readFileSync(p, 'utf8').replace(/\.(-?[A-Za-z_][\w-]*)\s*[,{]/g, function (_, name) { cssClasses.add(name); return ''; });
  });
}

walkJsDefs(path.join(ROOT, 'js'));

/* ---------- JS 侧：字面量类名 ---------- */
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.js$/.test(f.name) && !VENDOR.test(f.name)) out.push(p);
  });
  return out;
}
/* 只认"像本项目的类名"的字面量：以字母开头、至少 2 个字符、纯 ASCII。
   （首版实测有两个假报：单字符 `l`（注释里被正则切出）、全角 `②`（中文注释里的序号）——
     本项目的类名一律是 ascii 的 kebab 或 camel，这两条规则足以滤掉。） */
const TOKEN_OK = /^[A-Za-z][\w-]+$/;
const found = new Map();                 // class -> "file:line"

function addTokens(raw, where) {
  raw.split(/\s+/).forEach(function (t) {
    if (!TOKEN_OK.test(t)) return;                       // 动态拼接（+ / ${} / 引号）自然被排除
    /* 排除"动态拼接的尾段"：`className = '"'"'selftest-banner st-level-'"'"' + x` 会切出 st-level- ——
       以连字符结尾的串不可能是完整类名（实测这是首版唯一一类假报）。 */
    if (t.endsWith('-')) return;
    if (!found.has(t)) found.set(t, where);
  });
}

walk(path.join(ROOT, 'js'), []).forEach(function (p) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  fs.readFileSync(p, 'utf8').split('\n').forEach(function (line, i) {
    const where = rel + ':' + (i + 1);
    let m;
    const reClass = /class="([^"$+]*)"|class='([^'$+]*)|className\s*=\s*'([^'$+]*)'|className\s*=\s*"([^"$+]*)"/g;
    while ((m = reClass.exec(line))) addTokens(m[1] || m[2] || m[3] || m[4] || '', where);
    const reList = /classList\.(?:add|toggle)\(\s*'([^']+)'|classList\.(?:add|toggle)\(\s*"([^"]+)"/g;
    while ((m = reList.exec(line))) addTokens(m[1] || m[2] || '', where);
  });
});

/* ---------- 比对 ---------- */
const undefinedClasses = new Map();
found.forEach(function (where, cls) { if (!cssClasses.has(cls)) undefinedClasses.set(cls, where); });

let baseline = { classes: {} };
if (fs.existsSync(BASELINE)) baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const known = baseline.classes || {};

if (process.argv.indexOf('--write') >= 0) {
  const out = {};
  [...undefinedClasses.keys()].sort().forEach(function (c) { out[c] = undefinedClasses.get(c); });
  fs.writeFileSync(BASELINE, JSON.stringify({
    note: 'JS 里输出、但 css/style.css 未定义样式的类名 —— 均为「纯 JS 钩子」（只用于 querySelector/事件委托）。新增项必须二选一：去 CSS 补样式，或确认是钩子后跑 --write 登记。',
    classes: out
  }, null, 2) + '\n', 'utf8');
  console.log('✓ 已把 ' + Object.keys(out).length + ' 个未定义类写入基线 ' + path.relative(ROOT, BASELINE));
  process.exit(0);
}

if (process.argv.indexOf('--list') >= 0) {
  console.log('JS 输出但 CSS 未定义的类（共 ' + undefinedClasses.size + ' 个）：');
  [...undefinedClasses.entries()].sort().forEach(function (e) {
    console.log('  ' + e[0] + '   ' + e[1] + (known[e[0]] ? '   [基线内]' : '   [★ 新增]'));
  });
  process.exit(0);
}

const added = [...undefinedClasses.keys()].filter(function (c) { return !known[c]; });
const stale = Object.keys(known).filter(function (c) { return !undefinedClasses.has(c); });

console.log('============================================');
console.log('JS ↔ CSS 类名契约检查');
console.log('  JS 里输出的字面量类名 ' + found.size + ' 个　CSS 里定义的类名 ' + cssClasses.size + ' 个');
console.log('  未定义（纯钩子）' + undefinedClasses.size + ' 个，其中基线内 ' + (undefinedClasses.size - added.length) + ' 个');
console.log('--------------------------------------------');
if (stale.length) {
  console.log('· 基线里已不复存在（可跑 --write 收缩基线）：' + stale.join(', '));
  console.log('');
}
if (added.length) {
  console.log('✗ 新增 ' + added.length + ' 个「JS 输出但 CSS 未定义」的类名：');
  added.forEach(function (c) { console.log('    ' + c + '   ' + undefinedClasses.get(c)); });
  console.log('');
  console.log('  二选一：① 若本该有样式 → 去 css/style.css 补（很可能是类名写错，'
    + '本项目历史缺陷就是这样：JS 用 .sci-dot 而 CSS 只有 .settle-check-item.is-*）；');
  console.log('          ② 若确为纯 JS 钩子 → 跑 node tools/check_class_contract.js --write 登记进基线。');
  console.log('============================================');
  process.exit(1);
}
console.log('✓ 无新增未定义类名（现有 ' + Object.keys(known).length + ' 个钩子均已登记在案）');
console.log('============================================');
process.exit(0);
