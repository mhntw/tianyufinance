#!/usr/bin/env node
'use strict';
/* ============================================================
 * audit_escape_gaps.js —— HTML 拼接的**逐值**转义审计（只出清单，不做门禁）
 *
 * 【为什么另起一份】check_html_escape.js 有两条已知盲区：
 *   ① 整行只要出现一次 esc 就判整行安全 → 同一行里"部分转义"的值永远看不见；
 *   ② 只分析 `innerHTML =` 所在行 → `var li = '<li>' + t.name` 这种先拼后赋的完全在视野外。
 * 本脚本按"语句"而不是"行"来分析，并按"每个插入值"判定，因此能覆盖上述两类。
 *
 * 【判定方式】
 *   把 `X.innerHTML = EXPR` / `X.innerHTML += EXPR` / `var x = EXPR`（EXPR 含标签字面量）
 *   取出完整表达式，按顶层 `+` / `?:` / `||` 拆成单个插入值，逐个判断：
 *     · 字符串字面量、数字、已知数值字段            → 安全
 *     · esc()/escHtml()/escAttr()/money()/num() 等 → 安全
 *     · 其他属性访问或裸标识符                     → 未转义（HIGH：命中用户可编辑字段）
 *   同一语句里已有 esc 但仍有漏网值 → 额外标注「部分转义」，这是最典型的疏漏形态。
 *
 * 【为什么只出清单不 exit 1】
 *   当前已知欠账尚未修复。此脚本用于"一次拿全清单"，修完后再把判据并入
 *   check_html_escape.js 并清空基线，才是真正的门禁。
 *
 * 用法：node tools/audit_escape_gaps.js [--json]
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
// 第三方打包产物不做审计：内部拼接对象不是业务用户输入，扫进去只会淹没真问题
const SKIP = /node_modules|mdb-reader\.js|buffer\.js|echarts\.min\.js|xlsx\.full\.min\.js/;
const JSON_OUT = process.argv.includes('--json');

/* 用户可编辑 / 可导入，命中即 HIGH。导入的账套文件来自他人，故同样按用户输入对待。 */
const USER_TEXT_FIELDS = new Set([
  'name', 'title', 'summary', 'word', 'sourceNo', 'remark', 'memo', 'note', 'desc',
  'text', 'label', 'unit', 'bookkeeper', 'address', 'phone', 'account', 'bank',
  'employee', 'dept', 'person', 'company', 'companyName', 'bookName', 'subjectName',
  'content', 'message', 'reason', 'placeholder', 'typeName', 'tplName'
]);

/* 账套 schema 中确定是数值的字段：拼接进 HTML 不会带标签（导入数据异常时仍建议复核，故只降级不豁免）。 */
const NUMERIC_FIELDS = new Set([
  'attach', 'dr', 'cr', 'amount', 'qty', 'price', 'rate', 'total', 'sum', 'balance',
  'debit', 'credit', 'level', 'count', 'length', 'size', 'idx', 'index', 'no'
]);

/* 产出固定格式、不含 HTML 的格式化函数 */
const SAFE_CALL = /^(esc|escHtml|escAttr|escapeHtml|escape|money|round2|fmt|amtCell|signed|dirText|balText|yuan|num|U\.num|U\.yuan|H\.esc|H\.money|H\.num|encodeURIComponent|Number|parseInt|parseFloat)\s*\(/;

const NUMERIC_IDENT = /^(i|j|k|n|m|idx|index|count|length|size|colspan|rowspan|width|height|total|sum|pct|rate|min|max|noA|noB|noC)$/;

/* ---------- 词法工具（注释/字符串/正则字面量） ---------- */

// i 指向 `/`，判断是否为正则字面量起点
function looksLikeRegex(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  return '([{,;:=!&|?{}~+-*%<>'.indexOf(prev) >= 0;
}

function skipQuoted(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

function skipRegex(src, i) {
  i++; // 跳过起始 /
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === ']') { inClass = false; i++; continue; }
    if (c === '/' && !inClass) return i + 1;
    if (c === '\n') return i; // 未闭合，按普通字符处理
    i++;
  }
  return i;
}

/* 生成等长掩码：注释与字符串内容换成空格（保留引号与换行），便于用正则找"结构"，
   同时不破坏偏移量 —— 表达式文本仍从原文按同一偏移切取。 */
function maskStructural(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === c) { out += c; i++; break; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    if (c === '/') {
      if (looksLikeRegex(src, i)) {
        const end = skipRegex(src, i);
        for (let k = i; k < end; k++) out += src[k] === '\n' ? '\n' : ' ';
        i = end;
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

/* 从 start 起取一条完整表达式：到顶层分号结束；无分号时到顶层换行（上一字符是运算符则续行）。
   注释按词法跳过，绝不能当作表达式终点 —— 否则会把后续整段代码吞进表达式（实测）。 */
function readExpression(src, start) {
  let i = start;
  let depth = 0;
  const MAX_LEN = 4000;   // 兜底：括号计数一旦被异常字符带偏，不至于把整个文件吞进一条表达式
  while (i < src.length && i - start < MAX_LEN) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = skipQuoted(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') {
      // 行注释出现在「续行」位置（上一行以 + 结尾）时，注释只是夹在拼接中间，
      // 必须跨过换行继续读；否则一条多行 innerHTML 会被拦腰截断 —— 实测
      // Voucher.js 的 v.sourceNo / v.attach 就是这样被漏掉的。
      const beforeCmt = src.slice(start, i).trim();
      while (i < src.length && src[i] !== '\n') i++;
      if (beforeCmt && /[+\-*/%?:&|,.=(]$/.test(beforeCmt)) { i++; continue; }
      return { text: beforeCmt, end: i };
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/') {
      if (looksLikeRegex(src, i)) { i = skipRegex(src, i); continue; }
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) return { text: src.slice(start, i), end: i };
    else if (c === '\n' && depth === 0) {
      const before = src.slice(start, i).trim();
      if (before && !/[+\-*/%?:&|,.=(]$/.test(before)) return { text: before, end: i };
    }
    i++;
  }
  return { text: src.slice(start), end: src.length };
}

/* 按顶层分隔符拆分（支持多字符分隔符） */
function splitTopLevel(expr, delims) {
  const parts = [];
  let depth = 0, last = 0, i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === '`') { i = skipQuoted(expr, i); continue; }
    if (c === '/' && looksLikeRegex(expr, i)) { i = skipRegex(expr, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const d = delims.find(x => expr.startsWith(x, i));
      if (d && (d !== '||' || (expr[i + 2] !== '='))) {
        parts.push(expr.slice(last, i));
        i += d.length;
        last = i;
        continue;
      }
    }
    i++;
  }
  parts.push(expr.slice(last));
  return parts.length > 1 ? parts : [expr];
}

function stripOuterParens(s) {
  let t = s.trim();
  for (;;) {
    if (t[0] !== '(' || t[t.length - 1] !== ')') return t;
    let depth = 0, ok = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') {
        depth--;
        if (depth === 0 && i !== t.length - 1) { ok = false; break; }
      }
    }
    if (!ok) return t;
    t = t.slice(1, -1).trim();
  }
}

/* 顶层三目：返回 {test, yes, no} 或 null */
function splitTernary(expr) {
  let depth = 0, q = -1, colon = -1, nestedQ = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === '`') { i = skipQuoted(expr, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?') {
      if (expr[i + 1] === '?' || expr[i + 1] === '.') continue;
      if (q === -1) q = i; else nestedQ++;
    } else if (depth === 0 && c === ':' && q !== -1) {
      if (expr[i + 1] === ':' || expr[i - 1] === ':') continue;
      if (nestedQ > 0) { nestedQ--; continue; }
      colon = i;
      break;
    }
  }
  if (q === -1 || colon === -1) return null;
  return { test: expr.slice(0, q), yes: expr.slice(q + 1, colon), no: expr.slice(colon + 1) };
}

/* 模板字面量里的 ${...} 逐个取出 */
function templateExprs(expr) {
  const out = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === '`') {
      const end = skipQuoted(expr, i);
      const body = expr.slice(i + 1, end - 1);
      let j = 0;
      while ((j = body.indexOf('${', j)) !== -1) {
        let depth = 1, k = j + 2;
        while (k < body.length && depth > 0) {
          if (body[k] === '{') depth++;
          else if (body[k] === '}') depth--;
          k++;
        }
        out.push(body.slice(j + 2, k - 1));
        j = k;
      }
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

function stringLiterals(expr) {
  const out = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      const end = skipQuoted(expr, i);
      out.push(expr.slice(i + 1, end - 1));
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/* 去掉注释（保留字符串字面量内容），用于分析表达式本身 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipQuoted(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function hasMarkup(expr) {
  return stringLiterals(expr).some(s => /<\/?[A-Za-z][\w:-]*(\s|>|\/)/.test(s));
}

/* ---------- 逐个插入值判定 ---------- */

function rootField(expr) {
  const m = expr.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*$/);
  if (m) return { obj: m[1], field: m[2] };
  const bare = expr.match(/^([A-Za-z_$][\w$]*)$/);
  if (bare) return { obj: '', field: bare[1] };
  return null;
}

function classifyOne(rawExpr, htmlVars) {
  const expr = stripOuterParens(rawExpr);
  if (!expr) return { status: 'safe', values: [] };

  /* 纯字符串字面量 / 纯数字 / 布尔 / null */
  if (/^(['"])(?:\\.|(?!\1).)*\1$/.test(expr)) return { status: 'safe', values: [] };
  if (/^-?\d+(\.\d+)?$/.test(expr)) return { status: 'safe', values: [] };
  if (/^(true|false|null|undefined)$/.test(expr)) return { status: 'safe', values: [] };

  /* 模板字面量：逐个 ${} 判定 */
  if (expr[0] === '`') {
    const inner = templateExprs(expr);
    if (!inner.length) return { status: 'safe', values: [] };
    return mergeResults(inner.map(x => classifyOne(x, htmlVars)));
  }

  /* 已转义或安全格式化 */
  if (SAFE_CALL.test(expr)) {
    /* esc(x) 之外，像 money(a + b) 里的加法由函数内部消化，这里整体视为安全 */
    return { status: 'safe', values: [] };
  }

  /* 三目：两个分支都判定 */
  const tri = splitTernary(expr);
  if (tri) return mergeResults([classifyOne(tri.yes, htmlVars), classifyOne(tri.no, htmlVars)]);

  /* || / ?? ：任一分支可能是实际插入值 */
  const orParts = splitTopLevel(expr, ['||', '??']);
  if (orParts.length > 1) return mergeResults(orParts.map(x => classifyOne(x, htmlVars)));

  /* 去括号后仍可能是一个拼接（如 `('<a>' + v.word + '</a>')`）：继续逐个判定 */
  const plusParts = splitTopLevel(expr, ['+']);
  if (plusParts.length > 1) return mergeResults(plusParts.map(x => classifyOne(x, htmlVars)));

  /* 已知 HTML 变量（前面已分析过的拼接变量）：其赋值处已被单独记录，这里不重复报 */
  const bare = expr.match(/^([A-Za-z_$][\w$]*)$/);
  if (bare && htmlVars[bare[1]]) return { status: 'safe', values: [] };

  /* 数值型标识符 / xxx.length 之类 */
  const rf = rootField(expr);
  if (rf) {
    if (rf.obj && NUMERIC_FIELDS.has(rf.field) && rf.field !== 'no') return { status: 'safe', values: [] };
    if (!rf.obj && NUMERIC_IDENT.test(rf.field)) return { status: 'safe', values: [] };
    /* 明确是数字的字段：no 在凭证里被用作字号（schema 上是字符串），仍按复核处理 */
    if (rf.obj && NUMERIC_FIELDS.has(rf.field)) return { status: 'review', values: [expr] };
    if (rf.field === 'length' || rf.field === 'count') return { status: 'safe', values: [] };
    /* 裸标识符：无法确定来源（可能是上游拼好的 HTML），按复核处理；
       但若标识符名本身命中用户可编辑字段（name/title/summary/…），
       它就是"用户文本被直接插进 innerHTML"，必须算高危 —— 否则
       `var li='<td>'+user.name+'</td>'; el.innerHTML=li;` 这类拼接洗白可整体逃逸门禁。 */
    if (!rf.obj) return { status: USER_TEXT_FIELDS.has(rf.field) ? 'unsafe' : 'review', values: [expr] };
    return { status: 'unsafe', values: [expr] };
  }

  /* 其他表达式（函数调用/数组 join 等）：无法静态判定 */
  return { status: 'review', values: [expr] };
}

function mergeResults(list) {
  let status = 'safe';
  const values = [];
  list.forEach(r => {
    if (r.status === 'unsafe') status = 'unsafe';
    else if (r.status === 'review' && status === 'safe') status = 'review';
    values.push.apply(values, r.values);
  });
  return { status: status, values: values };
}

/* ---------- 扫描文件 ---------- */

function walk(dir, out) {
  fs.readdirSync(dir).forEach(n => {
    const p = path.join(dir, n);
    if (SKIP.test(p)) return;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.js')) out.push(p);
  });
  return out;
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function tallyFields(rel, line, stmt, ok) {
  const re = /[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(stmt)) !== null) {
    const f = m[1];
    if (seen.has(f)) continue;
    seen.add(f);
    const e = fieldCons[f] || (fieldCons[f] = { ok: 0, bad: 0, where: [] });
    if (ok) e.ok++;
    else {
      e.bad++;
      if (e.where.length < 3) e.where.push(rel + ':' + line);
    }
  }
}

const findings = [];
const waived = [];
// 字段一致性：同一个字段在不同页面有的转义、有的不转义，说明口径不统一
const fieldCons = Object.create(null);
let statementCount = 0;
let innerHtmlCount = 0;

walk(JS_DIR, []).forEach(file => {
  const src = fs.readFileSync(file, 'utf8');
  const mask = maskStructural(src);
  const rel = path.relative(ROOT, file);
  const htmlVars = Object.create(null);
  const srcLines = src.split('\n');

  function analyze(name, exprStart, kind) {
    const { text } = readExpression(src, exprStart);
    if (!text || !text.trim()) return;
    statementCount++;
    const stmt = stripComments(text).replace(/\s+/g, ' ').trim();
    const markup = hasMarkup(text);
    const isInner = kind === 'innerHTML';
    if (isInner) innerHtmlCount++;
    /* html`` 自动转义标签模板（js/common/html.js）：插值默认转义，静态无需再判。
       只认"标识符紧跟反引号"的标签调用 —— 变量名叫 html 的字符串累加（html += '<td>'）不受影响。
       与 check_html_escape.js 的判据保持一致：两边口径不同就会出现"一个说安全、一个说未转义"。 */
    if (/\bhtml\s*`/.test(stmt)) {
      if (name) htmlVars[name] = { status: 'safe', values: [] };
      tallyFields(rel, lineAt(src, exprStart), stmt, true);
      return;
    }
    // 对象/数组字面量声明（如 `var S = {...}` 跨越几百行）本身不是 HTML；
    // 若不在这里截断，readExpression 会一直读到下一个分号，把后续代码里的 `.字段`
    // 全部算进这一条，既污染字段统计也制造假问题。
    if (!isInner && /^[\[{]/.test(stmt)) {
      if (name) htmlVars[name] = { status: 'safe', values: [] };
      return;
    }
    // innerHTML 允许先赋纯文本（如空串、提示文案），只有含标签或变量时才分析
    if (!isInner && !markup) {
      // `var html = ''` 这类空累加器先登记为安全，后续 += 才不会因为"来源未知"被跳过
      if (name && /^(['"])\1$/.test(stmt)) htmlVars[name] = { status: 'safe', values: [] };
      return;
    }
    if (isInner && !markup && !/[A-Za-z_$]/.test(stmt.replace(/['"][^'"]*['"]/g, ''))) return;

    const operands = splitTopLevel(stmt, ['+']);
    const results = operands.map(x => classifyOne(x, htmlVars));
    const merged = mergeResults(results);
    const hasEsc = /esc(Html|Attr)?\(|escapeHtml\(/.test(stmt);
    const unsafeValues = merged.values.filter(Boolean);

    if (merged.status === 'safe') {
      if (name) htmlVars[name] = { status: 'safe', values: [] };
      tallyFields(rel, lineAt(src, exprStart), stmt, true);
      return;
    }
    if (name) htmlVars[name] = { status: merged.status, values: unsafeValues };
    tallyFields(rel, lineAt(src, exprStart), stmt, false);

    const line = lineAt(src, exprStart);
    /* 行内豁免：与 check_html_escape.js 同一约定 `/* escape-ok: 原因 *\/`（前后各一行内） */
    const near = [srcLines[line - 2] || '', srcLines[line - 1] || '', srcLines[line] || ''].join('\n');
    const waive = near.match(/escape-ok\s*[:：]\s*([^*\n]*)/);
    if (waive) {
      waived.push({ rel: rel, line: line, why: waive[1].trim().slice(0, 50) });
      return;
    }
    const high = merged.status === 'unsafe' && unsafeValues.some(v => {
      const rf = rootField(stripOuterParens(v));
      return rf && rf.obj && USER_TEXT_FIELDS.has(rf.field);
    });
    findings.push({
      rel: rel,
      line: line,
      severity: high ? 'HIGH' : (merged.status === 'unsafe' ? 'UNSAFE' : 'REVIEW'),
      partial: hasEsc,
      values: Array.from(new Set(unsafeValues)).slice(0, 6).map(v => v.length > 160 ? v.slice(0, 160) + '…' : v),
      snippet: stmt.replace(/\s+/g, ' ').slice(0, 96),
      kind: kind
    });
  }

  // 三类赋值统一按源码顺序处理 —— 否则"先扫全部 innerHTML、再扫全部 var"会让使用点
  // 早于定义点被分析，预构建的 HTML 变量就被误判成未知值（实测：ops）。
  const events = [];
  let m;
  const reInner = /\.innerHTML\s*(\+?=)/g;
  while ((m = reInner.exec(mask)) !== null) {
    events.push({ kind: 'innerHTML', start: m.index + m[0].length, name: null });
  }
  const reVar = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = reVar.exec(mask)) !== null) {
    events.push({ kind: 'htmlVar', start: m.index + m[0].length, name: m[1] });
  }
  const rePlus = /\b([A-Za-z_$][\w$]*)\s*\+=/g;
  while ((m = rePlus.exec(mask)) !== null) {
    events.push({ kind: 'htmlVar', start: m.index + m[0].length, name: m[1] });
  }
  events.sort((a, b) => a.start - b.start).forEach(ev => {
    analyze(ev.name, ev.start, ev.kind);
  });
});

/* ---------- 输出 ---------- */

// 同一行可能有两条 `+=` 语句（各自独立），这里按 位置+代码 去重，避免同一问题报两遍
const seen = new Set();
const deduped = [];
findings.forEach(f => {
  const key = f.rel + ':' + f.line + ':' + f.values.join('|');
  if (seen.has(key)) return;
  seen.add(key);
  deduped.push(f);
});
findings.length = 0;
findings.push(...deduped);

const bySev = { HIGH: [], UNSAFE: [], REVIEW: [] };
findings.forEach(f => (bySev[f.severity] || bySev.REVIEW).push(f));

const fieldStat = Object.create(null);
findings.forEach(f => {
  f.values.forEach(v => {
    const rf = rootField(stripOuterParens(v));
    if (!rf) return;
    const key = rf.field;
    fieldStat[key] = fieldStat[key] || { unsafe: 0, where: [] };
    fieldStat[key].unsafe++;
    if (fieldStat[key].where.length < 5) fieldStat[key].where.push(f.rel + ':' + f.line);
  });
});

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: { innerHtml: innerHtmlCount, statements: statementCount }, findings: findings }, null, 2));
  process.exit(0);
}

function printList(title, list, limit) {
  console.log('\n' + title + '（' + list.length + ' 处）');
  console.log('─'.repeat(74));
  list.slice(0, limit || 9999).forEach(f => {
    const tag = f.partial ? ' [部分转义]' : '';
    console.log('  ' + (f.rel + ':' + f.line).padEnd(42) + '[' + f.severity + tag + ']');
    console.log('     值：' + (f.values.join('  ') || '（表达式）'));
    console.log('     码：' + f.snippet);
  });
}

console.log('HTML 逐值转义审计（语句级；扫描 innerHTML ' + innerHtmlCount
  + ' 处 / 拼接语句 ' + statementCount + ' 条）');
console.log('═'.repeat(74));
printList('★ 高危：插入了用户可编辑 / 可导入的文本字段（未转义）', bySev.HIGH);
printList('● 未转义：表达式值未经 esc，需人工确认', bySev.UNSAFE);
printList('○ 待确认：函数调用 / 数组 join 等静态无法判定', bySev.REVIEW);

console.log('\n按字段汇总（同一字段在不同页面的口径）');
Object.keys(fieldStat).sort((a, b) => fieldStat[b].unsafe - fieldStat[a].unsafe).forEach(k => {
  const s = fieldStat[k];
  console.log('  ' + k.padEnd(16) + '未转义 ' + String(s.unsafe).padStart(2) + ' 处   ' + s.where.join('、'));
});

// 一致性问题：同一字段有的地方转义、有的地方不转义 —— 说明"该怎么转"没有单点约定
const mixed = Object.keys(fieldCons)
  .filter(k => fieldCons[k].ok > 0 && fieldCons[k].bad > 0 && USER_TEXT_FIELDS.has(k))
  .sort((a, b) => fieldCons[b].bad - fieldCons[a].bad);
if (mixed.length) {
  console.log('\n字段口径不一致（同名字段：已转义 / 未转义）');
  console.log('─'.repeat(74));
  mixed.slice(0, 25).forEach(k => {
    const e = fieldCons[k];
    console.log('  ' + k.padEnd(16) + '转义 ' + String(e.ok).padStart(3) + ' 次 / 未转义 ' + String(e.bad).padStart(2) + ' 次   ' + e.where.join('、'));
  });
}

if (waived.length) {
  console.log('\n已豁免（escape-ok 行内注释）(' + waived.length + ' 处）');
  console.log('─'.repeat(74));
  waived.forEach(w => console.log('  ' + (w.rel + ':' + w.line).padEnd(42) + w.why));
}

console.log('\n合计：高危 ' + bySev.HIGH.length + ' / 未转义 ' + bySev.UNSAFE.length
  + ' / 待确认 ' + bySev.REVIEW.length + ' / 豁免 ' + waived.length);
console.log('说明：本脚本只产出清单，不判定通过；修复后再把判据并入 check_html_escape.js 并清空基线。');

/* --gate：作为门禁运行时**只**在「高危 > 0」时失败。
   未转义 / 待确认两级是人工复核清单（函数调用、数组 join、预构建片段等，静态分析无法定性），
   若一并当失败，门禁会长期变红而失去意义 —— 与 check_html_escape.js 棘轮同一条教训：
   门禁只卡「可判定的那一档」，把不确定项显式留在清单里给人看，不假装它们不存在。 */
if (process.argv.includes('--gate')) {
  if (bySev.HIGH.length) {
    console.log('\n✗ 门禁失败：' + bySev.HIGH.length + ' 处高危未转义（用户可编辑 / 可导入字段直接插进 innerHTML）');
    process.exit(1);
  }
  console.log('\n✓ 通过：0 处高危未转义（未转义 ' + bySev.UNSAFE.length + ' / 待确认 '
    + bySev.REVIEW.length + ' 处留作人工复核清单）');
}
