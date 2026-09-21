#!/usr/bin/env node
'use strict';
/* ============================================================
 * check_money_sign.js —— 金额「负号」守卫（静态契约检查）
 *
 * 【为什么要这个脚本】「负值被显示成正数」在本项目已至少发作 4 次：
 *   · 资产负债表「未分配利润」：money(Math.abs(n)) 只染红、丢负号，
 *     -2,424,599.93 被渲染为红色 2,424,599.93，符号方向相反（见 app.js moneyRed 注释）；
 *   · 首页财务指标：借用 fmt() 抹掉贷方余额 / 亏损 / 净流出的负号（见 Home.js 注释）；
 *   · 异常余额方向（亏损年 3103 借记、资产出现贷方余额）下丢失负号（见 store.js）；
 *   · 凭证录入金额框：回填只认正数，红字金额聚焦时显示成空白。
 *   共同根源是同一个动作：**用 Math.abs() 格式化，然后只染红、忘了补负号**。
 *   而 app.js 里那个函数原叫 fmt() —— 名字完全看不出会丢符号，所以被反复顺手误用
 *   （2026-09-21 已改名 absFmt，让「取绝对值」在调用处显式可见）。
 *   这类 bug 不抛错、不改数字，只把**方向弄反** —— 而方向错误在财务上比数字错误更危险。
 *   血泪教训是「写了但没有断言守着」。故必须有这条自动守卫。
 *
 * 【判定分级】
 *   ✗ 失败（退出码 1）
 *     1. app.js 出现「抹符号、但名字看不出来」的金额格式化函数
 *        —— 判据：函数体含 money(Math.abs(…))，且**无**（形参 < 0）负号补丁，名字又不含 abs
 *     2. 应保号的函数真的保号：signed / moneyRed 必须含（形参 < 0）；money 不得含 Math.abs
 *     3. 页面引用的金额族 helper 必须在 __TY_HELPERS__ 里存在；且不得再引用已废弃的 H.fmt
 *        —— 防「改名只改一半」：2026-09-21 改 fmt→absFmt 时，
 *           _shared.js 的 export 与两个页面的 import 差点漏改（ESM 会直接报错）。
 *     4. 打印件的自包含样式里必须有 .ty-red
 *        —— 打印件不引 css/style.css，缺这条则打印出的报表负数不标红、与正数难分辨。
 *   ⚠ 提示（不影响退出码）
 *     5. 页面里的 absFmt(…) / money(Math.abs(…)) 调用点 —— 列出供人工确认
 *        方向确已由上下文（标签 / Tab / 文字）表达
 *
 * 【2026-09-21 扩大排查的结论（已在下方固化为规则）】
 *   除本脚本已守护的部分外，以下「可能丢符号」的路径经逐一核查【均安全】，
 *   故不再重复设规则，仅此备案，避免日后重复排查：
 *     · 金额显示出口 store.js money()：实测 toLocaleString('zh-CN',…) 对负数输出
 *       "-1,234.56"（负号前缀，不会变成括号形式）；
 *     · Excel 导出共 9 处（科目余额表/总账/明细账/凭证/报表/费用明细/原始凭证/折旧表）：
 *       走原始数值或 U.num()，金额为数字类型；科目余额表导出无 Math.abs
 *       且注释明示「反向余额带负号，与屏幕同口径」；
 *     · 总账/明细账大量 Math.abs：均配独立方向变量（obDir/endDir/runDir），
 *       属「金额取正 + 方向列」的标准借贷分列口径，导出 Excel 亦带方向列；
 *     · 持久化：JSON.stringify(state)，JSON 保留负号；
 *     · 保存凭证：e.dr = num(e.dr)，不取绝对值；
 *     · CSS 金额列：.grid td.ta-r 仅 white-space:nowrap、未声明宽度、
 *       .grid-wrap 为 overflow:visible —— 不存在「右对齐时裁掉左侧负号」；
 *     · 打印件负号【文本】随 DOM 克隆保留，仅【配色】曾缺失（已修为规则 4）。
 *
 * 用法：node tools/check_money_sign.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'js', 'app.js');
const PAGES = path.join(ROOT, 'js', 'pages');

const appSrc = fs.readFileSync(APP, 'utf8');
const fails = [];
const warns = [];

/* ---------------- 工具 ---------------- */
// 取某函数定义的 { 形参, 函数体 }。函数体用 [^}]* 截取——
// 足以覆盖本文件的金额工具（money/absFmt/signed/moneyRed 体内无 } ），
// 而含对象字面量的 esc 等因不含 Math.abs 自然被规则 1 跳过。
function bodyOf(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{([^}]*)\\}');
  const m = re.exec(src);
  return m ? { arg: m[1].trim(), body: m[2] } : null;
}

function walkJs(dir, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walkJs(p, out);
    else if (/\.js$/.test(d.name)) out.push(p);
  });
  return out;
}

function rel(p) { return path.relative(ROOT, p); }

/* ---------------- 规则 1：抹符号的函数必须「名字看得出来」 ---------------- */
const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([^}]*)\}/g;
let m1;
while ((m1 = fnRe.exec(appSrc))) {
  const name = m1[1];
  const arg = m1[2];
  const body = m1[3];
  if (!/Math\.abs\s*\(/.test(body)) continue;                 // 不抹符号，与本规则无关
  const hasSignGuard = new RegExp('\\b' + arg + '\\s*<\\s*0').test(body); // 有「负数走另一支」的补丁
  const nameSaysAbs = /abs/i.test(name);                      // 名字已明示「取绝对值」
  if (!hasSignGuard && !nameSaysAbs) {
    fails.push('js/app.js  '
      + '函数 ' + name + '() 内部用 Math.abs 抹掉了符号，但既没有负号补丁，名字也看不出 —— '
      + '这正是历史上被反复误用的那个坑。请改名（如 ' + name + ' → abs' + name.charAt(0).toUpperCase() + name.slice(1) + '）'
      + '或改用 signed() / moneyRed()。');
  }
}

/* ---------------- 规则 2：应保号的函数必须真的保号 ---------------- */
[['signed', true], ['moneyRed', true]].forEach(function (pair) {
  const name = pair[0];
  const f = bodyOf(appSrc, name);
  if (!f) { fails.push('js/app.js  找不到 ' + name + '() 的定义 —— 守护对象缺失，规则失效。'); return; }
  if (!new RegExp('\\b' + f.arg + '\\s*<\\s*0').test(f.body)) {
    fails.push('js/app.js  ' + name + '() 未保留负号（体内找不到 "' + f.arg + ' < 0" 分支）。'
      + '它是「显示带符号金额」的默认出口，丢了负号会把负值显示成正数。');
  }
});
(function () {
  const f = bodyOf(appSrc, 'money');
  if (!f) { fails.push('js/app.js  找不到 money() 的定义 —— 守护对象缺失，规则失效。'); return; }
  if (/Math\.abs\s*\(/.test(f.body)) {
    fails.push('js/app.js  money() 体内出现了 Math.abs —— 它会抹掉金额负号。'
      + '要显示绝对值请显式用 absFmt()，不要在 money 里静默抹符号。');
  }
})();

/* ---------------- 规则 3：helpers 契约（金额族） ---------------- */
const MONEY_FAMILY = ['money', 'absFmt', 'signed', 'moneyRed'];
(function () {
  const hm = /globalThis\.__TY_HELPERS__\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(appSrc);
  if (!hm) { fails.push('js/app.js  找不到 __TY_HELPERS__ 字面量 —— 规则 3 无法执行。'); return; }
  const block = hm[1];
  MONEY_FAMILY.forEach(function (k) {
    const re = new RegExp('\\b' + k + '\\s*:\\s*pick\\(\\s*' + k + '\\s*\\)');
    if (!re.test(block)) {
      fails.push('js/app.js  __TY_HELPERS__ 缺少 ' + k + ' 的注册（应为 ' + k + ': pick(' + k + ')）。'
        + '页面从该全局对象取依赖，缺一项即整块功能静默失效。');
    }
  });
})();

/* 规则 3b：页面不得再引用已废弃的 H.fmt；引用的金额族 helper 必须已注册 */
(function () {
  const registered = new Set(MONEY_FAMILY);
  walkJs(PAGES).forEach(function (file) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /H\.([A-Za-z_$][\w$]*)/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(src))) {
      const key = m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      if (key === 'fmt') {
        fails.push(rel(file) + '  仍在引用 H.fmt —— 该名字已废弃（它内部抹负号，'
          + '已于 2026-09-21 改名 H.absFmt）。ESM 下还会直接报「导出名不存在」。');
      } else if (MONEY_FAMILY.indexOf(key) >= 0 && !registered.has(key)) {
        fails.push(rel(file) + '  引用了 H.' + key + '，但它不在 __TY_HELPERS__ 里。');
      }
    }
  });
})();

/* ---------------- 规则 4（提示）：抹符号的调用点，人工确认方向已由上下文表达 ---------------- */
walkJs(PAGES).forEach(function (file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach(function (line, i) {
    // 跳过纯注释行：注释里「提到」absFmt 不等于「调用」它（否则守卫会把自己的说明文字报成问题）。
    if (line.trim().indexOf('//') === 0) return;
    if (/absFmt\s*\(/.test(line) || /money\s*\(\s*Math\.abs\s*\(/.test(line)) {
      // 上下文取「上方 2 行 + 本行 + 下方 1 行」：
      // 负号补丁常写在下一行（如 Report.js moneyRed 的 fallback：本行取绝对值、下行按 n<0 补负号）。
      const ctx = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 2)).join(' ');
      const guarded = /<\s*0\s*\?/.test(ctx) || /signed\s*\(/.test(ctx);
      warns.push(rel(file) + ':' + (i + 1)
        + (guarded ? '  [已带负号处理]' : '  [⚠ 未见负号处理，请确认方向由上下文表达]')
        + '  ' + line.trim().slice(0, 90));
    }
  });
});

/* ---------------- 规则 4：打印件必须自带负数配色 ---------------- */
(function () {
  // 打印件是「自包含 HTML」：buildPrintHtml 自己拼 <style>，不引 css/style.css。
  // 于是页面里的 .ty-red 不会自动生效 —— 打印出的报表负数不标红，与正数长得一样。
  // 这类问题在屏幕上完全看不出来（屏幕有 style.css），只有打出来才发现，故必须静态守住。
  // 注意：不能用 bodyOf 提取函数体 —— 其 body 含 CSS 的 { }，会被首个 } 截断，
  // 而 .ty-red 声明在样式拼接的后段，必然漏检。故从定义处按固定长度截取。
  const at = appSrc.indexOf('function buildPrintHtml');
  if (at < 0) {
    fails.push('js/app.js  找不到 buildPrintHtml() —— 打印件样式契约无法校验。');
    return;
  }
  const seg = appSrc.slice(at, at + 6000);
  // 判据必须精确：只认「真正拼进样式的 CSS 规则」（形如 + '….ty-red{…}'）。
  // 不能只找 ".ty-red" —— 本函数上方的说明注释里也会出现该字样，
  // 用 indexOf 会命中注释、让检查永远通过（自测时已踩过这个坑）。
  if (!/\+\s*'[^']*\.ty-red\s*\{/.test(seg)) {
    fails.push('js/app.js  buildPrintHtml() 的样式里没有 .ty-red —— 打印件不引 css/style.css，'
      + '缺这条会让打印出来的报表负数不标红、与正数难以分辨。'
      + '请在样式拼接中加入 ".ty-red{color:#cf2e2e;}"（色值同 --ty-red）。');
  }
})();

/* ---------------- 输出 ---------------- */
console.log('════ 金额负号守卫（check_money_sign.js）════');
console.log('');
if (warns.length) {
  console.log('⚠ 提示 ' + warns.length + ' 处「取绝对值」调用点（不影响退出码）：');
  warns.forEach(function (w) { console.log('   · ' + w); });
  console.log('');
}
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项：');
  fails.forEach(function (f) { console.log('   · ' + f); });
  console.log('');
  console.log('结果：FAIL');
  process.exit(1);
}
console.log('结果：PASS —— 金额族函数均保留负号口径，无「抹符号却不显眼」的函数，helpers 契约完整。');
process.exit(0);
