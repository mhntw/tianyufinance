'use strict';
/* 图标 emoji 检查 —— UI 里不得用 emoji 当图标（2026-10-06）
 *
 * 【为什么要这个脚本】项目图标体系统一为三档：① iconcool 字体字形（css/style.css 的 .xxx:before）；
 *   ② Unicode 字符（直写，缺字形会显示成方框、一眼可见）；③ 内联 SVG（左侧导航 / 首页常用功能）。
 *   emoji 混进来会同时踩两个坑：
 *     · **不随 CSS color 着色** —— emoji 自带配色（🔍 的金属质感、📎 的彩色），与旁边灰色字形对不上；
 *     · **跨平台字形不同** —— macOS / Windows 长相不一，桌面端观感不可控。
 *   2026-10-06 实测就是这个问题：顶栏搜索框用 🔍、紧邻的"快速跳转"用 ⌕，
 *   同屏两个"放大镜"字形完全不同（既然要做图标一致性，就得有个闸门防它回来）。
 *
 * 【判据】index.html + js/（排除 vendor）+ css/style.css 里，出现**默认 emoji 呈现**的字符 → 违规。
 *   用 Unicode 属性 \p{Emoji_Presentation} 判定，而不是"看着像 emoji 的区间"——
 *   区别很关键：
 *     · 命中：🔍 📎 😀 🚀 ✅ ❌ ⚠️(带变体选择符) 这类**默认彩色呈现**的字符；
 *     · 不命中：✓ ✗ → ← ↑ ↓ ▲ ▼ ▸ ▾ × ‹ › « » 等**默认文字呈现**的符号 ——
 *       它们随 color 着色、跨平台一致，是项目**正在用**的图标档位
 *       （见 style.css 的 .tyicon-arrow-*、.tmpl-op-add/::before）。
 *   若改用区间正则（如 U+2600–U+27BF），会把上面这些正当符号全咬成"违规"，制造噪音。
 *   另外单独咬 U+FE0F（变体选择符，强制 emoji 呈现）：如 "⚠️" 会把文字符号变成彩色 emoji。
 *
 * 【白名单】确属**文案里的表情**（不是图标位）时写注释豁免，两种位置：
 *     ① 本行行内：  var s = '保存成功 🎉';   // emoji-ok: 提示语表情，非图标
 *     ② 上一行为**纯注释行**：  // emoji-ok: 理由   ← 只豁免紧跟其后的那一行
 *   （注释会先被剥离再判定，故豁免标记必须写在注释里；豁免要带理由，不做无理由放行。
 *     ② 限定"纯注释行"是为了防止上一行的行内豁免连带放过下一行。）
 *
 * 【怎么修】四选一：① 换 iconcool 字形（先查 css/style.css 有没有现成 :before，如 .sousuo）；
 *   ② 换 Unicode 文字符号（能随 color 着色）；③ 内联 SVG；④ 旁边已有文字时，直接删掉这个装饰图标。
 *
 * 用法：node tools/check_icon_emoji.js
 * 退出码：0 = 无违规；1 = 有违规（由 run-all.js 按 check_*.js 自动收录，属门禁脚本）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = /xlsx|mdb-reader|buffer/i;

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;   // 默认 emoji 呈现
const VARIATION_SELECTOR_16 = '\uFE0F';                 // 强制 emoji 呈现
const SKIP_MARK = /emoji-ok/;                           // 注释豁免标记

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (!/^(node_modules|\.git|dist|tauri|target)$/.test(f.name)) walk(p, out);
    } else if (/\.js$/.test(f.name) && !VENDOR.test(f.name) && !/\.min\.js$/.test(f.name)) {
      out.push(p);
    }
  });
  return out;
}

/* 剥离注释，但**保留换行与列位置**（注释内容逐字符换成空格）——
   这样行号与原文一一对应，报错能直接指到源码行；同时注释里的 emoji 示例不会误报。 */
function maskComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, function (m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/(^|[^:])\/\/[^\n]*/g, function (m, p1) { return p1 + ' '.repeat(m.length - p1.length); });
}

function cp(ch) { return 'U+' + ch.codePointAt(0).toString(16).toUpperCase(); }

const files = [path.join(ROOT, 'index.html'), path.join(ROOT, 'css', 'style.css')]
  .concat(walk(path.join(ROOT, 'js'), []));

const violations = [];
let scanned = 0;
files.forEach(function (f) {
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
  scanned++;
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const rawLines = raw.split('\n');
  const cleanLines = maskComments(raw).split('\n');
  cleanLines.forEach(function (line, i) {
    /* 豁免两种写法：① 本行行内注释 `… // emoji-ok: 理由`；
       ② **上一行是纯注释行**（剥离注释后为空）时的 `// emoji-ok: 理由`。
       ② 必须限定"纯注释行"：否则上一行的行内豁免会连带放过下一行
       （实测：`var b='🚀'; // emoji-ok` 之后那一行的 ⚠️ 会被误放过）。 */
    const prevIsPureCommentLine = i > 0 && SKIP_MARK.test(rawLines[i - 1]) && cleanLines[i - 1].trim() === '';
    if (SKIP_MARK.test(rawLines[i]) || prevIsPureCommentLine) return;
    const hits = [];
    for (const ch of line) {
      if (EMOJI_PRESENTATION.test(ch)) hits.push(ch + ' (' + cp(ch) + ')');
      else if (ch === VARIATION_SELECTOR_16) hits.push('U+FE0F（变体选择符，会把文字符号强制成彩色 emoji）');
    }
    if (hits.length) {
      violations.push({
        rel: rel, line: i + 1,
        chars: Array.from(new Set(hits)),
        snippet: rawLines[i].trim().slice(0, 90),
      });
    }
  });
});

console.log('图标 emoji 检查');
console.log('  扫描 ' + scanned + ' 个文件（index.html + js/ 全量 + css/style.css，注释已剥离）');

if (!violations.length) {
  console.log('\n✓ 通过：未发现用 emoji 当图标');
  process.exit(0);
}

console.log('\n✗ 发现 ' + violations.length + ' 行用了 emoji（不随 color 着色、跨平台字形不同）：');
violations.forEach(function (v) {
  console.log('  · ' + v.chars.join('、') + '   —— ' + v.rel + ':' + v.line);
  console.log('      ' + v.snippet);
});
console.log('\n修法四选一：① 换 iconcool 字形（css/style.css 里查现成 :before，如 .sousuo）；');
console.log('            ② 换 Unicode 文字符号（随 color 着色）；③ 内联 SVG；');
console.log('            ④ 旁边已有文字时，直接删掉这个装饰图标。');
console.log('豁免：确属文案表情（非图标位）时，加注释 `emoji-ok: 理由`（本行行内，或上一行纯注释行）。');
process.exit(1);
