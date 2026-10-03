#!/usr/bin/env node
/* ============================================================================
 * 静默失败防线（2026-10-04 新增卡口）
 *
 * 【为什么有这个卡口】
 *   本项目最贵的一类缺陷是「**失败传不出去**」——它不报错、不崩溃，只是什么都不发生，
 *   而"卡住不报错"比报错难查得多。已发生过的同源案例：
 *     · kis-import.js 的 parse 把 convert 放在 then 回调里 resolve → 外层 promise 永不结算，
 *       调用方的 .catch 成了死代码（用户只看到全局兜底的英文栈）；
 *     · store.js 的 _flushOnExit 读 _persistBusy / _persistPending，而这两个字段**从无赋值点**
 *       → 注释承诺的"关窗兜底重发"从未触发；
 *     · Settings.js 三处 S.importExternalBook(...).then(...) **没写 return** → 拒绝逃出外层
 *       .catch（try/catch 抓不到 promise 拒绝）；
 *     · CloudSync.js 的 doPush/doPull 只有正常路径复位 busy，一处 await 失败 → 按钮永久禁用；
 *     · store.js writeBookMeta(...).then(function () {}) 把 {ok:false} 整个丢掉。
 *   修完不算完：**把判据写成规则**，否则三个月后同样写法会再长出来（本项目已有先例）。
 *
 * 【规则（每条都对应一次真实缺陷）】
 *   R1 importExternalBook-not-returned —— 该调用必须 `return`（或同行接 .catch），
 *      否则拒绝逃出上游 catch（Settings.js 曾有三处）。
 *   R2 busy-without-finally —— 含 busy(true 的 async 函数必须有 finally，
 *      否则按钮可能永久停在"同步中…"。
 *   R3 silent-update-no-catch —— update.js 的静默检查链尾必须有 .catch，
 *      否则一次后台检查会冒到全局弹「系统异常」。
 *   R4 then-result-dropped —— 不许 `.then(function () {})`（把结果整个丢掉，
 *      写盘失败将无人知晓；writeBookMeta 曾三处如此）。
 *   R5 utc-date-in-name —— 不许 `.toISOString().slice(0,10)` 当作**日期名**（UTC 会让
 *      东八区凌晨的文件名/账套 id 落到前一天）。
 *
 * ⚠ 查静态模式前**先剥注释**：本文件与业务注释里会引用反模式的样子，不剥就会被自己的说明命中
 *   （这个坑在 check_single_source / verify_import_failure 上各踩过一次）。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const SKIP = [/xlsx\.full\.min\.js$/, /mdb-reader\.js$/, /buffer\.js$/];

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.js$/.test(f.name) && !SKIP.some(function (r) { return r.test(p); })) out.push(p);
  });
  return out;
}

let checks = 0, fails = 0;
function check(ok, desc, detail) {
  checks++;
  if (!ok) { fails++; console.log('  ✗ ' + desc + (detail ? '　→ ' + detail : '')); }
  else console.log('  ✓ ' + desc);
}

const files = walk(JS_DIR, []).sort();
const SRC = {};
files.forEach(function (p) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  const raw = fs.readFileSync(p, 'utf8');
  // 块注释 → 等长空白（保留行号）；行注释在按行处理时跳过
  SRC[rel] = raw.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
});
function eachCodeLine(rel, fn) {
  SRC[rel].split('\n').forEach(function (line, i) {
    const t = line.trim();
    if (t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0) return;
    fn(line, i + 1, t);
  });
}
// 取某个函数体（含名字与花括号配对），用于"函数内必须有 X"这类规则
function bodyOf(rel, nameRe) {
  const src = SRC[rel], m = nameRe.exec(src);
  if (!m) return null;
  const b = src.indexOf('{', m.index);
  if (b < 0) return null;
  let depth = 0;
  for (let j = b; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return { body: src.slice(b, j), line: src.slice(0, m.index).split('\n').length }; }
  }
  return null;
}

console.log('静默失败防线检查（"失败传不出去"这类缺陷的规则化）');
console.log('─'.repeat(72));

/* R1 导入账套：内层链必须 return（或同行 .catch） */
(function () {
  const bad = [];
  Object.keys(SRC).forEach(function (rel) {
    eachCodeLine(rel, function (line, ln, t) {
      if (t.indexOf('importExternalBook(') < 0) return;
      if (/\breturn\s+S\.importExternalBook\(/.test(t)) return;
      if (/\.catch\(/.test(t)) return;
      bad.push(rel + ':' + ln);
    });
  });
  check(bad.length === 0,
    'R1 importExternalBook(...) 必须 return（否则拒绝逃出上游 catch，错误提示成死代码）',
    bad.join('、'));
})();

/* R2 含 busy(true 的 async 函数必须有 finally */
(function () {
  const bad = [];
  Object.keys(SRC).forEach(function (rel) {
    const re = /async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(SRC[rel]))) {
      const got = bodyOf(rel, new RegExp('async\\s+function\\s+' + m[1] + '\\s*\\('));
      if (!got) continue;
      if (got.body.indexOf('busy(true') < 0) continue;
      if (/finally\s*\{/.test(got.body)) continue;
      bad.push(rel + ':' + got.line + ' ' + m[1] + '()');
    }
  });
  check(bad.length === 0,
    'R2 含 busy(true 的 async 函数必须有 finally（否则按钮/permanent 禁用，只能重启）',
    bad.join('、'));
})();

/* R3 update.js 静默检查链尾必须 .catch */
(function () {
  const rel = 'js/update.js';
  const got = SRC[rel] ? bodyOf(rel, /function\s+silentCheckUpdate\s*\(/) : null;
  check(!!got && /\.catch\(/.test(got.body),
    'R3 silentCheckUpdate 的链尾必须有 .catch（后台检查不该冒到全局弹「系统异常」）');
})();

/* R4 不许把 .then 的结果整个丢掉 */
(function () {
  const bad = [];
  Object.keys(SRC).forEach(function (rel) {
    eachCodeLine(rel, function (line, ln, t) {
      if (/\.then\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)/.test(t) || /\.then\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(t)) {
        bad.push(rel + ':' + ln);
      }
    });
  });
  check(bad.length === 0,
    'R4 不得 .then(function () {})（结果被丢弃 → 写盘/写 meta 失败无人知晓）',
    bad.join('、'));
})();

/* R5 日期名不得用 UTC */
(function () {
  const bad = [];
  Object.keys(SRC).forEach(function (rel) {
    eachCodeLine(rel, function (line, ln, t) {
      if (/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/.test(t)) bad.push(rel + ':' + ln);
    });
  });
  check(bad.length === 0,
    'R5 不得用 toISOString().slice(0,10) 当日期名（UTC 会让东八区凌晨落到前一天）',
    bad.join('、'));
})();

console.log('─'.repeat(72));
if (fails) {
  console.log('❌ 静默失败防线：' + fails + ' / ' + checks + ' 条不符（这些写法已被证明会导致"失败传不出去"）');
  process.exit(1);
}
console.log('✅ 静默失败防线：' + checks + ' 条全部通过 ✓');
