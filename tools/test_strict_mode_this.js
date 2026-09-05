/* 严格模式下 `this` 误用检测
 * 运行：node tools/test_strict_mode_this.js
 *
 * 背景（本文件存在的唯一理由）：
 *   ES module（<script type="module"> 及其 import 的模块）默认处于严格模式。
 *   查凭证「全选」复选框曾写成：
 *       .forEach(function (c) { c.checked = this.checked; })
 *   在严格模式下 forEach 回调的 this 是 undefined，点击即抛
 *   TypeError: Cannot read properties of undefined (reading 'checked')，
 *   被 app.js 的全局兜底捕获，弹成「系统异常已被捕获，数据已自动保存」——
 *   看起来像数据丢失，实际只是 this 绑定问题。
 *
 *   全局兜底会掩盖这类运行时错误，功能测试很难覆盖，故用静态扫描兜住。
 *
 * 判定规则（关键：区分安全与不安全的回调）：
 *   安全：addEventListener / onxxx 等 DOM 事件回调 —— 浏览器会把 this 绑定到 currentTarget，
 *         即便在严格模式下也有效，是常见且正当写法，不应报警。
 *   不安全：forEach / map / filter / some / every / find / sort / then / catch /
 *          setTimeout / setInterval 等的回调 —— 这些调用不给 thisArg，严格模式下 this
 *          为 undefined，使用 this.x 必然抛 TypeError。
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function step(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'backups_audit_20260825-213647', 'backups_cf_fix_20260825-220543', '.git', 'tauri', 'tools']);
const SKIP_FILES = new Set(['xlsx.full.min.js', 'mdb-reader.js', 'buffer.js', 'kis-import.js']);

// 这些方法的回调拿不到 thisArg，严格模式下 this === undefined
const UNSAFE_CALLERS = new Set([
  'forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'sort', 'reduce',
  'then', 'catch', 'finally', 'setTimeout', 'setInterval'
]);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js') && !SKIP_FILES.has(name)) out.push(p);
  }
  return out;
}

// 去掉注释与字符串中的 this.，避免把说明性文字误报为代码
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function isModule(code) {
  return /^\s*(import|export)\s/m.test(code);
}

// 判断该 function 表达式是被谁调用的（取 `function` 之前最近的标识符/方法名）
function callerOf(code, fnIndex) {
  const before = code.slice(Math.max(0, fnIndex - 60), fnIndex);
  const m = before.match(/([A-Za-z0-9_$]+)\s*\(\s*$/);
  return m ? m[1] : null;
}

// 把一段代码里所有"嵌套函数体"挖空（返回同长空格串）。
// 必要性：常见写法是 forEach 里再套 addEventListener：
//     el.forEach(function (x) { x.addEventListener('click', function () { ...this... }) })
// 内层 this 属于事件处理器（= currentTarget，合法），不属于外层 forEach 回调。
// 不挖空就会把大量正确代码误报为问题。
function maskNestedFunctions(body) {
  const chars = body.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < chars.length; k++) chars[k] = ' '; };
  // 嵌套的 function 表达式（跳过 body 开头的外层函数，从下标 1 起找）
  const fnRe = /function\s*[A-Za-z0-9_$]*\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = fnRe.exec(body))) {
    if (m.index === 0) continue;
    const start = body.indexOf('{', m.index);
    let depth = 0, end = -1;
    for (let j = start; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > 0) blank(m.index, end + 1);
  }
  // 箭头函数体（含大括号的）：(...) => { ... }  或  x => { ... }
  const arrowRe = /(?:=>)\s*\{/g;
  while ((m = arrowRe.exec(body))) {
    const start = body.indexOf('{', m.index);
    let depth = 0, end = -1;
    for (let j = start; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > 0) blank(start, end + 1);
  }
  return chars.join('');
}

function findUnsafeThis(code) {
  const clean = stripComments(code);
  const hits = [];
  const re = /function\s*[A-Za-z0-9_$]*\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(clean))) {
    const caller = callerOf(clean, m.index);
    if (!caller || !UNSAFE_CALLERS.has(caller)) continue;
    let i = clean.indexOf('{', m.index), depth = 0, end = -1;
    for (let j = i; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    const body = clean.slice(i, end + 1);
    // 只看直接属于本回调的 this（嵌套函数体已被挖空）
    const t = maskNestedFunctions(body).match(/\bthis\s*\.[A-Za-z0-9_$]+/);
    if (t) {
      hits.push({ line: clean.slice(0, m.index).split('\n').length, caller, snippet: t[0] });
    }
  }
  return hits;
}

(async function () {
  console.log('严格模式 this 误用扫描：');

  // 自检：先确认扫描器确实能抓到目标模式，否则"通过"没有意义
  await step('自检：能检出 forEach 回调里的 this', function () {
    const sample = "export const x = 1;\nlist.forEach(function (c) { c.checked = this.checked; });";
    const hits = findUnsafeThis(sample);
    if (!hits.length) throw new Error('扫描器失效：未检出已知的问题模式');
  });

  await step('自检：不误报 addEventListener 回调里的 this', function () {
    const sample = "export const x = 1;\nel.addEventListener('change', function () { v = this.checked; });";
    const hits = findUnsafeThis(sample);
    if (hits.length) throw new Error('误报：addEventListener 回调的 this 是合法的 currentTarget');
  });

  await step('自检：忽略注释中出现的 this', function () {
    const sample = "export const x = 1;\n// 写 c.checked = this.checked 会抛错\nlist.forEach(function (c) { c.v = 1; });";
    const hits = findUnsafeThis(sample);
    if (hits.length) throw new Error('误报：注释中的 this 被计入');
  });

  // 全站最常见的正确写法：forEach 里套 addEventListener，内层 this 是合法的
  await step('自检：不误报 forEach 内嵌套的事件处理器', function () {
    const sample = "export const x = 1;\nlist.forEach(function (el) {\n  el.addEventListener('click', function () { v = this.getAttribute('a'); });\n});";
    const hits = findUnsafeThis(sample);
    if (hits.length) throw new Error('误报：嵌套事件处理器的 this 合法');
  });

  // 嵌套情况下的真实问题仍要能抓到：this 直接用在 forEach 回调体（不在内层函数里）
  await step('自检：嵌套写法中仍检出外层 forEach 的 this', function () {
    const sample = "export const x = 1;\nlist.forEach(function (el) {\n  var v = this.value;\n  el.addEventListener('click', function () { w = this.getAttribute('a'); });\n});";
    const hits = findUnsafeThis(sample);
    if (!hits.length) throw new Error('漏报：外层 forEach 直接使用 this 未检出');
  });

  const files = walk(ROOT).filter(f => isModule(fs.readFileSync(f, 'utf8')));
  console.log('  （扫描到 ' + files.length + ' 个 ES module）');

  const offenders = [];
  for (const f of files) {
    for (const h of findUnsafeThis(fs.readFileSync(f, 'utf8'))) {
      offenders.push({ file: path.relative(ROOT, f), line: h.line, caller: h.caller, snippet: h.snippet });
    }
  }

  await step('源码中不应存在不安全的 this 用法', function () {
    if (offenders.length) {
      throw new Error('发现 ' + offenders.length + ' 处：\n    ' +
        offenders.map(o => `${o.file}:${o.line}  (${o.caller}) ${o.snippet}`).join('\n    '));
    }
  });

  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
