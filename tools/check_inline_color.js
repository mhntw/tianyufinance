'use strict';
/* 内联样式里的硬编码色检查 —— 只允许 var(--ty-*) 令牌
 *
 * 【为什么要这个脚本】把色值收敛进 css/style.css 的 --ty-* 之后，"颜色只有一处定义"才成立。
 * 但有两个漏洞一直在漏：① 生成 HTML 的内联 style（js/ 里的字符串）；② el.style.cssText 赋值。
 * 它们写死 #1565c0 / #16a34a / #cf1322 这类**调色板外**的色，于是：
 *   · 调色时必漏（改了令牌，这些地方还是旧色）；
 *   · 对比度审查也漏（check_css_tokens 只审 style.css）；
 *   · 同屏同语义两色（2026-10-04 实测：借贷平衡的绿，一处 var(--ty-green)、一处 #16a34a）。
 * 2026-10-04 已把 js/ 里这类写法清干净，本脚本就是防止它们回来的那道闸。
 *
 * 【判据】js 目录下全部 .js（递归，排除 vendor）里，style="…" 与 style.cssText = '…'
 *   的字面量中出现 #rgb / #rrggbb / #rrggbbaa → 违规。
 *   （注：本行原写成 js 加通配符的路径写法，其中的 "星号斜杠" 会提前终止本块注释 —— 已避开。）
 *   · 只咬 **hex**：不咬 rgba()（阴影/蒙层用的 rgba(0,0,0,.08) 属"不参与调色的中性值"，
 *     全站一致这样写，纳入门禁只会制造噪音），也不咬颜色名。
 *   · 白名单见下方 ALLOW —— 是"有据可查的例外"，不是"懒得修"的集合。
 *
 * 【怎么修】换成调色板令牌（var(--ty-blue-dark) / var(--ty-border) / var(--ty-text-3) …）。
 *   找不到对应令牌 ⇒ 说明缺一个**语义令牌**：应先在 :root 加一个（并由 check_css_tokens
 *   过一遍对比度），而不是就地写死。
 *
 * 用法：node tools/check_inline_color.js
 * 退出码：0 = 无违规；1 = 有违规（run-all / CI 的门禁）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');

/* 白名单：相对路径 → 原因 */
const ALLOW = {
  'js/app.js': '生成**自包含打印件**（不引外部样式表，必须自带色值；见该文件 750-753 行的说明）'
};
const VENDOR = /xlsx|mdb-reader|buffer/i;

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.js$/.test(f.name) && !VENDOR.test(f.name)) out.push(p);
  });
  return out;
}

/* 两种写法都查：内联 style="…"、以及 el.style.cssText = '…' / "…" */
const PATTERNS = [
  { name: '内联 style="…"', re: /style\s*=\s*["']([^"']*)["']/g },
  { name: 'style.cssText', re: /style\.cssText\s*=\s*["']([^"']*)["']/g },
];
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

const violations = [];
walk(JS_DIR, []).forEach(function (p) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  if (ALLOW[rel]) return;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach(function (line, i) {
    PATTERNS.forEach(function (pt) {
      pt.re.lastIndex = 0;
      let m;
      while ((m = pt.re.exec(line))) {
        const body = m[1];
        HEX.lastIndex = 0;
        let h;
        while ((h = HEX.exec(body))) {
          violations.push({ rel: rel, line: i + 1, what: pt.name, color: h[0], ctx: body.slice(Math.max(0, h.index - 24), h.index + 24) });
        }
      }
    });
  });
});

console.log('============================================');
console.log('内联样式硬编码色检查（应一律走 var(--ty-*)）');
console.log('  扫描：js/**/*.js（排除 vendor）　白名单：' + Object.keys(ALLOW).join(', ') + '（打印件自包含 HTML）');
console.log('--------------------------------------------');
if (!violations.length) {
  console.log('✓ 未发现硬编码色（内联样式全部走令牌）');
  console.log('============================================');
  process.exit(0);
}
console.log('✗ 发现 ' + violations.length + ' 处硬编码色：');
violations.forEach(function (v) {
  console.log('  ' + v.rel + ':' + v.line + '  ' + v.color + '  [' + v.what + ']  …' + v.ctx + '…');
});
console.log('');
console.log('修法：换成调色板令牌；缺语义令牌时先往 css/style.css 的 :root 加一个。');
console.log('若确属"自包含 HTML 必须自带色值"（如打印件），请加入本脚本的 ALLOW 并写明原因。');
console.log('============================================');
process.exit(1);
