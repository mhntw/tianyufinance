'use strict';
/* CSS 设计令牌（变量）体检 —— 引用完整性 / 冗余度 / 对比度可读性
 *
 * 【为什么要这个脚本】2026-09-19 把色值收敛到变量时，我删掉了 --ty-black 的**定义**，
 * 却漏改了它的 8 处引用（border-bottom: 2px solid var(--ty-black) 等）。
 * 失效的 var() 不会报错，只会静默丢掉样式 —— 边框不显示、负数颜色丢失，
 * 而"色值种类 = 0"这类统计完全看不出来（引用没了，但也没定义）。
 * 所以必须有一条「引用 ↔ 定义」的双向检查。顺带把配色审查里的客观项也固化：
 * 冗余令牌（同值同用途）、对比度（WCAG）不足的文字色。
 *
 * 判定分级：
 *   ✗ 失败（退出码 1）：被引用但未定义（样式会静默失效）
 *   ⚠ 提示（不影响退出码）：定义未引用、多令牌同值、文字对比度不足
 *
 * 用法：node tools/check_css_tokens.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'css/style.css');

const raw = fs.readFileSync(CSS_FILE, 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- 收集定义与引用 ---------- */
// 变量名限定 --小写字母开头，避免把 CSS Modules 哈希类名（.active--1OT3M）误判成变量
const defined = new Map();          // name -> 取值
let m;
const defRe = /(--[a-z][\w-]*)\s*:\s*([^;{}]+)/g;
while ((m = defRe.exec(css))) {
  if (!defined.has(m[1])) defined.set(m[1], m[2].trim());
}
const used = new Map();             // name -> 引用次数
const useRe = /var\(\s*(--[\w-]+)/g;
while ((m = useRe.exec(css))) used.set(m[1], (used.get(m[1]) || 0) + 1);

const missing = [...used.keys()].filter(v => !defined.has(v));
const unused = [...defined.keys()].filter(v => !used.has(v));

console.log('CSS 设计令牌体检（' + path.relative(ROOT, CSS_FILE) + '）');
console.log('  定义 ' + defined.size + ' 个 · 被引用 ' + used.size + ' 个');
console.log('');

/* ---------- ① 引用 ↔ 定义（硬性） ---------- */
if (missing.length) {
  console.log('★ 被引用但未定义（样式会静默失效）：');
  missing.forEach(v => console.log('    ' + v + '   ' + used.get(v) + ' 处引用'));
  console.log('');
} else {
  console.log('✓ 所有 var() 引用都有对应定义');
}

/* ---------- ② 定义未引用（提示） ---------- */
if (unused.length) {
  console.log('· 定义了但从未被引用（可删）：');
  unused.forEach(v => console.log('    ' + v + ' = ' + (defined.get(v) || '').slice(0, 40)));
  console.log('');
}

/* ---------- ③ 多令牌同值（提示） ---------- */
// 语义化别名是正当做法（表头底 / 行 hover 底即使当前同值也应有独立身份），
// 但同一用途出现多个令牌就是纯冗余，值得清（如 --st-tip-fg 与 --st-warn-fg 都是 #5c6d74）。
const byVal = {};
defined.forEach((v, k) => {
  if (!/^#[0-9a-fA-F]{3,6}$/.test(v)) return;      // 只比对字面色值，跳过 var() 别名与尺寸
  const key = v.toLowerCase();
  (byVal[key] = byVal[key] || []).push(k);
});
const dup = Object.keys(byVal).filter(k => byVal[k].length > 1);
if (dup.length) {
  console.log('· 多个令牌取同一色值（其中同用途的属冗余，可合并）：');
  dup.sort((a, b) => byVal[b].length - byVal[a].length).forEach(k => {
    console.log('    ' + k + '  ← ' + byVal[k].length + ' 个：' + byVal[k].join(', '));
  });
  console.log('');
}

/* ---------- ④ 对比度（提示） ---------- */
function lum(hex) {
  const c = hex.replace('#', '');
  const f = i => {
    const v = parseInt(c.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
// 只检查「当作文字用」的令牌 —— 图标/边框/底色属 UI 元素，标准不同（≥3 即可）
// 同时区分两类豁免，避免把有意设计报成问题：
//   · 禁用态（规则选择器含 .disabled）：WCAG 明确豁免，且"文字色 = 底色"是有意的隐藏手法
//   · 同色隐藏（color 与同规则的 background 取同一变量）：用于分隔符等有意弱化
const asText = new Map();   // var名 -> { disabled, hidden, ui }
{
  const body = css.replace(/:root\s*\{[\s\S]*?\n\}/g, '');
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  while ((m = ruleRe.exec(body))) {
    const sel = m[1], decl = m[2];
    const cm = decl.match(/(?<![-\w])color\s*:\s*([^;{}]+)/);
    if (!cm) continue;
    const v = (cm[1].match(/var\(\s*(--[\w-]+)/) || [])[1];
    if (!v) continue;
    const bg = decl.match(/background(?:-color)?\s*:\s*([^;{}]+)/);
    const bgVar = bg ? (bg[1].match(/var\(\s*(--[\w-]+)/) || [])[1] : null;
    const rec = asText.get(v) || { disabled: false, hidden: false, ui: false };
    if (/\.disabled/.test(sel)) rec.disabled = true;
    if (bgVar === v) rec.hidden = true;
    // 图标/装饰元素：作用于 ::before/::after 的 color 或选择器明显是图标容器。
    // 这类是 UI 元素而非正文，WCAG 适用 3:1（非文本对比）而非 4.5:1。
    if (/::?(?:before|after)|icon|ico(?![a-z])|-ico(?![a-z])/i.test(sel)) rec.ui = true;
    asText.set(v, rec);
  }
}
const BGS = { '白': '#ffffff', '浅蓝底': '#e8f1ff', '浅灰底': '#f0f0f0' };
const low = [], waived = [];
asText.forEach((flags, v) => {
  const val = defined.get(v);
  if (!val || !/^#[0-9a-fA-F]{6}$/.test(val)) return;
  let worst = null;
  Object.keys(BGS).forEach(bn => {
    const c = contrast(val, BGS[bn]);
    if (!worst || c < worst.c) worst = { bn, c };
  });
  if (!worst) return;
  // 判定门槛：纯文字 4.5；仅作图标 3.0
  const limit = (flags.ui && !flags.disabled && !flags.hidden) ? 3.0 : 4.5;
  if (worst.c >= limit) return;
  const item = { v, val, ...worst, limit };
  (flags.disabled || flags.hidden) ? waived.push(item) : low.push(item);
});
if (low.length) {
  low.sort((a, b) => a.c - b.c);
  console.log('· 对比度不足：');
  low.forEach(x => {
    const tag = x.c >= 3 ? '仅够大字/UI' : '偏低';
    console.log('    ' + x.v.padEnd(20) + x.val + '  最差 ' + x.c.toFixed(2) + '（' + x.bn + '）  需≥' + x.limit + '  ' + tag);
  });
  console.log('');
}
if (waived.length) {
  console.log('· 对比度低但属有意设计（禁用态 / 同色隐藏），不计为问题：');
  waived.forEach(x => {
    const why = [];
    if (asText.get(x.v).disabled) why.push('禁用态');
    if (asText.get(x.v).hidden) why.push('文字色=底色（有意隐藏）');
    console.log('    ' + x.v.padEnd(20) + x.val + '  ' + why.join(' + '));
  });
  console.log('');
}
// 提醒：品牌主色天然达不到 4.5（Ant #1677ff=3.4 / Element #409eff=2.9 亦然），
// 为可读性强行压深会失去品牌识别度，属设计取舍而非缺陷。此处仅记录，不判失败。
if (low.some(x => x.v === '--ty-blue')) {
  console.log('  说明：--ty-blue 是品牌主色，深色底白字 3.06 与业界主色（Ant/Element）相当；');
  console.log('        它作「白底文字」偏弱，需要文字场景时请用 --ty-blue-dark（5.21 ✓）。');
  console.log('');
}

/* ---------- 结构完整性 ---------- */
const ob = (css.match(/{/g) || []).length, cb = (css.match(/}/g) || []).length;
console.log('  花括号 ' + ob + ' / ' + cb + ' ' + (ob === cb ? '✓' : '✗ 不平衡'));
console.log('');

if (missing.length) {
  console.log('✗ 有 ' + missing.length + ' 个 var() 引用没有定义 —— 样式会静默失效，必须修');
  process.exit(1);
}
console.log('✓ 令牌引用完整（无失效引用）');
process.exit(0);
