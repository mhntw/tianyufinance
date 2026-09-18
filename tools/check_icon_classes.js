'use strict';
/* 图标类一致性检查（2026-09-18）
 *
 * 背景：项目里出现过多次「引用了图标类、但 CSS 没有对应字形定义」的问题 ——
 *   · .tyicon / .tyicon-arrow-left / .tyicon-arrow-right：全站 10 处分页箭头渲染成空方块
 *   · .iconcool shanchu：「删除」按钮的图标空白
 *   · .iconcool zidingyi 曾是无定义的死标记
 * 这类缺陷在页面上**只表现为"少了个图标"**，不报错、不影响功能，因此极难发现。
 * 本质与「行内按钮渲染被删、点击处理还在」是同一类问题：引用了不存在的东西。
 *
 * 本脚本一条命令列出全部空图标：
 *   1. 扫描 index.html 与 js/ 下所有 class="iconcool xxx" / class="tyicon tyicon-xxx"
 *   2. 收集 css/style.css 里真正写了 content 的 .xxx:before 字形定义
 *   3. 输出差集（被引用但无定义）
 *
 * 用法：node tools/check_icon_classes.js   （退出码 1 表示存在空图标）
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|\.git|dist|tauri|target)$/.test(e.name)) walk(p, out);
    } else if (/\.(js|html)$/.test(e.name) && !/xlsx\.full\.min|mdb-reader|\.min\.js$/.test(e.name)) {
      out.push(p);
    }
  });
  return out;
}

const files = [path.join(ROOT, 'index.html')].concat(walk(path.join(ROOT, 'js'), []));

// 1) 收集被引用的图标类
const used = new Map();      // 类名 -> Set(相对路径)
function note(cls, rel) {
  if (!used.has(cls)) used.set(cls, new Set());
  used.get(cls).add(rel);
}
// 注释里常提到图标类名（如"此处原为 <i class="iconcool shanchu">，已删"），不该算作"被引用"，
// 否则脚本会把说明文字报成空图标。故先剥离注释再扫描。
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')          // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '')         // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');    // 行注释（避开 http:// 之类）
}

files.forEach(function (f) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  const rel = path.relative(ROOT, f);
  let m;
  // iconcool 系列：class="iconcool guolv" / class="iconcool sousuo icon--search"
  const reIcon = /class="([^"]*\biconcool\b[^"]*)"/g;
  while ((m = reIcon.exec(src))) {
    m[1].split(/\s+/).forEach(function (c) {
      if (!c || c === 'iconcool' || c.indexOf('icon--') === 0) return;   // 基类/无关修饰类跳过
      note(c, rel);
    });
  }
  // tyicon 系列：class="tyicon tyicon-arrow-left" 或单独的 tyicon-arrow-right
  const reTy = /class="([^"]*\btyicon-[A-Za-z0-9-]+[^"]*)"/g;
  while ((m = reTy.exec(src))) {
    m[1].split(/\s+/).forEach(function (c) {
      if (c.indexOf('tyicon-') !== 0) return;
      note(c, rel);
    });
  }
});

// 2) 收集 CSS 里真正定义了字形的类（要求规则体内有 content）
const css = stripComments(fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8'));
const defined = new Set();
const reDef = /\.([A-Za-z0-9_-]+):{1,2}before\s*\{([^}]*)\}/g;
let d;
while ((d = reDef.exec(css))) {
  if (/content\s*:/.test(d[2])) defined.add(d[1]);
}

// 3) 差集
const missing = [];
used.forEach(function (where, cls) { if (!defined.has(cls)) missing.push({ cls: cls, where: Array.from(where) }); });

console.log('图标类一致性检查');
console.log('  被引用的图标类 ' + used.size + ' 个 | CSS 中有字形定义 ' + defined.size + ' 个');

if (!missing.length) {
  console.log('\n✓ 全部图标类都有字形定义，无空图标');
  process.exit(0);
}
console.log('\n★ 以下 ' + missing.length + ' 个图标类被引用但**没有字形定义**（页面上渲染为空）：');
missing.forEach(function (x) {
  console.log('  · ' + x.cls + '   —— 引用于 ' + x.where.join(', '));
});
console.log('\n修法二选一：① 在 css/style.css 补 .' + missing[0].cls + ':before{content:"..."}；');
console.log('            ② 若该图标只是装饰（旁边已有文字），直接删掉引用它的元素。');
process.exit(1);
