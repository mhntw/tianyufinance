'use strict';
/* ============================================================
 * check_html_escape.js —— innerHTML 拼接的转义检查
 *
 * 【为什么需要】本项目用 innerHTML 拼 HTML（200+ 处），靠人工记得调 esc()。
 * 实测有十余处漏了转义，拼进去的是**用户可编辑或可导入**的字符串：
 *   搜索关键词、员工姓名、账套名（来自导入的文件名）、科目名、报表行名。
 * 单机场景危害有限，但账套文件常是"别人发来的"，在 Tauri 环境下
 * 一个 <img onerror> 的危害被放大 —— 且这类问题**不会报错**，只会静默执行。
 *
 * 【检测思路】只看 innerHTML 赋值号**右侧**的表达式，从中提取「会被插进 HTML 的值」：
 *     · 属性访问   a.name / r.label / p.summary   → 数据，**需转义**
 *     · 裸标识符   kw / name / label              → 数据，**需转义**
 *   以下不算：
 *     · 函数调用   money(x) / num(x) / toFixed()  → 产出固定格式，安全
 *     · 数字与常量 count / length / colspan / idx → 不可能是 HTML
 *     · 字符串字面量、空赋值 ''
 *
 * 【豁免】确认安全时写行内注释（便于和代码一起维护）：
 *     el.innerHTML = html;   /* escape-ok: html 由本函数内逐段 esc 拼接 *​/
 *
 * 退出码：0 = 通过；1 = 存在未豁免的拼接（供 CI 使用）
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const SKIP = /node_modules|mdb-reader\.js|buffer\.js/;

/* 安全标识符：数值/长度/序号/格式化的 DOM 枚举 —— 不可能携带标签 */
const SAFE = new Set([
  'toFixed', 'Math', 'count', 'length', 'size', 'idx', 'index', 'i', 'j', 'k', 'n', 'm',
  'colspan', 'rowspan', 'colCount', 'rowCount', 'span', 'width', 'height',
  'noA', 'noB', 'noC', 'min', 'max', 'total', 'sum', 'pct', 'rate',
]);

/* 方法名：出现在 `.` 之后的属于调用，不是被插入的数据。
   若不排除，`parts.join('<br>')`、`COLS.map(...)` 会被误判成"插入了变量"。 */
const METHOD = new Set([
  'join', 'map', 'filter', 'forEach', 'reduce', 'slice', 'concat', 'split', 'trim',
  'replace', 'indexOf', 'toString', 'push', 'pop', 'sort', 'reverse', 'some', 'every',
  'find', 'includes', 'keys', 'values', 'entries', 'padStart', 'padEnd', 'flat',
  'toUpperCase', 'toLowerCase', 'charAt', 'substring', 'substr', 'repeat',
]);

function walk(dir, out) {
  fs.readdirSync(dir).forEach(n => {
    const p = path.join(dir, n);
    if (SKIP.test(p)) return;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.js')) out.push(p);
  });
  return out;
}

/* 把 html`...` 模板整体替换成 ''（只留下模板**外**的拼接）。
   原先是"整行含 html` 就跳过"，于是 `html`...` + x.name` 这种混合拼贴完全看不见；
   改成掩掉模板后，剩余部分照常走逐值检查，纯 html`` 赋值则自然落空、不会误报。 */
function maskHtmlTemplates(src) {
  const re = /\bhtml\s*`/g;
  let out = '', i = 0, m;
  while ((m = re.exec(src))) {
    out += src.slice(i, m.index) + "''";
    let j = m.index + m[0].length, depth = 0, quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (c === '\\') { j += 2; continue; }
        if (c === quote) quote = '';
        j++; continue;
      }
      if (c === "'" || c === '"') { quote = c; j++; continue; }
      if (c === '`' && depth === 0) { j++; break; }
      if (c === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
      if (depth > 0) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      j++;
    }
    i = j; re.lastIndex = j;
  }
  return out + src.slice(i);
}

const problems = [];
const waived = [];
let checked = 0;

walk(JS_DIR, []).forEach(file => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(ROOT, file);

  lines.forEach((line, i) => {
    // outerHTML 与 innerHTML 是同一类注入面（整段替换宿主节点的 HTML），一并纳入扫描
    const m = line.match(/(?:innerHTML|outerHTML)\s*=\s*(.+)$/);
    if (!m) return;
    // 只取到行内第一个分号：`el.innerHTML = ''; all.length = 0;` 这类多语句同行
    // 若整行分析，会把后面语句的标识符也算进来（实测造成大量误报）。
    const rhs = m[1].split(';')[0];
    checked++;

    /* html`` 标签模板（js/common/html.js）：插值默认转义、可信片段须显式 raw()。
       只掩掉模板本身，**模板外**的 `+` 拼接仍按下面的规则逐值检查 ——
       否则 `html`...` + x.name` 这类混合写法会被整行豁免。 */
    const scanRhs = /\bhtml\s*`/.test(rhs) ? maskHtmlTemplates(rhs) : rhs;

    // 空赋值 / 纯字面量：无数据插入
    const stripped = scanRhs.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/`[^`]*`/g, '');
    if (!/[A-Za-z_$]/.test(stripped)) return;

    /* 只检查「字面量与变量混拼」的情况 —— 那才是**在本行手工拼 HTML 模板**，
       是真正该逐值 esc 的地方。
       纯变量赋值（el.innerHTML = html）**刻意不查**：html 通常是上游函数拼好的结果，
       静态无从判断其内容；而它的来源（那个手工拼模板的函数）会被本脚本单独报出来。
       若把这类也报，实测会从 20 处膨胀到 80 处噪音，脚本随即失去意义。 */
    const hasLiteral = /'[^']*'|"[^"]*"|`[^`]*`/.test(rhs);
    if (!hasLiteral) return;

    // 本行或相邻行有豁免
    const near = [lines[i - 1] || '', line, lines[i + 1] || ''].join('\n');
    const waive = near.match(/escape-ok\s*[:：]\s*([^*\n]*)/);

    /* 已转义：整行出现 esc 系列调用即视为安全（esc 通常包住每个插入值）。
       ⚠ 判据必须只看**代码**：原先拿原文判，注释里写一句「逐项 escAttr(t.id)」就能让
         相邻的未转义行静默通过（Settle.js:1250 实测被这样蒙过去）。故先剥注释再判。
       （`//` 仅在不紧邻冒号时剥，避免把 'http://' 里的斜杠当注释起点） */
    const nearCode = near
      // 块注释必须跨行匹配：`/* 说明\n 逐项 esc(x.name) */` 里的 esc 文本若留在窗口里，
      // 会让相邻的未转义行被误判为"已转义"（单行正则 .*? 不跨行，等于没剥）。
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/esc(Html|Attr)?\(|escapeHtml\(/.test(nearCode)) return;

    /* 先挖掉「安全函数调用」再分析 —— 否则 money(c.dr) 里的 c.dr 会被当成裸属性访问
       而误报（实测这类误报占了剩余项的一半）。这些函数产出固定格式的数字/方向文本，
       不含 HTML 标签，无需转义。循环多轮以处理嵌套（money(num(x))）。 */
    // tmplMoney(v) = money(U.amt(v))：与 money 同类（结账模板侧的金额格式化出口，
    //   产出固定格式数字串，不含 HTML），故一并列入白名单，避免其入参 dr/cr/diff 被误报。
    /* 允许一层嵌套括号：money(Math.abs(c.dr - c.cr)) 这类写法原先匹配不到，
       导致内层的 c.dr / c.cr 被当成裸属性访问而误报（Opening.js:97 实测）。
       这些函数无论入参是什么，产出的都是固定格式的数字/方向文本，不含 HTML。 */
    const SAFE_CALL = /\b(tmplMoney|money|num|round2|amtCell|signed|fmt|esc|escHtml|escAttr|dirText|balText|walk)\s*\((?:[^()]|\([^()]*\))*\)/g;
    let work = stripped;
    for (let pass = 0; pass < 6; pass++) {
      const next = work.replace(SAFE_CALL, '');
      if (next === work) break;
      work = next;
    }

    // 提取「属性访问」与「裸标识符」（基于挖掉安全调用后的 work）
    const found = new Set();
    // 形如 a.b —— 说明某对象的属性被插进来；排除 a.join / a.map 这类方法调用
    (work.match(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g) || []).forEach(x => {
      const parts = x.split('.');
      if (METHOD.has(parts[1])) return;
      if (!SAFE.has(parts[0])) found.add(x);
    });
    // 裸标识符：只保留「作为整体被插入」的变量。
    // 排除三类，否则会大量误报：
    //   · 后跟 (    —— 函数调用（money(x)、walk(roots)），产出的是固定格式
    //   · 后跟 .    —— 属性访问的根（parts.join、COLS.map）：
    //                  根对象本身没被插入，真正插入的是 a.name 那种，已由上面的规则覆盖
    //   · 前有 .    —— 属性名
    (work.match(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g) || []).forEach(raw => {
      const id = raw.replace(/^[^A-Za-z_$]+/, '');
      if (!id || SAFE.has(id) || METHOD.has(id)) return;
      if (/^(var|let|const|return|function|if|else|new|typeof|true|false|null|undefined|String|Number|Array|Object|JSON|Boolean)$/.test(id)) return;
      const esc$ = id.replace(/\$/g, '\\$');
      if (new RegExp('\\b' + esc$ + '\\s*\\(').test(work)) return;   // 函数调用
      if (new RegExp('\\b' + esc$ + '\\s*\\.').test(work)) return;   // 属性访问的根
      found.add(id);
    });

    if (!found.size) return;

    const info = { rel, line: i + 1, vals: [...found].slice(0, 3), code: line.trim().slice(0, 76) };
    if (waive) { info.why = waive[1].trim().slice(0, 44); waived.push(info); }
    else problems.push(info);
  });
});

/* 【2026-10-22 新增：模板串插值检查】
   上面那段只看「innerHTML = 行内拼接」，模板串（`...${x}...`）是它的盲区：
   ExpenseDetail.js 的科目树整块用模板串渲染，`data-code="${n.code}"`、
   `value="${n.code}"`、`<span>${name}</span>` 三处未转义全都被漏检（均为真实注入面），
   最后由人工 sweep 才发现。故补这一段。
   判据刻意收窄到「插入的是用户可编辑文本字段」：表达式末项命中 name/code/label/summary/…
   （且未被 esc 系列包裹）才报 —— 实测在当前代码上零误报，
   不会把 `${toggleCls}`、`${amountCells}` 这类内部拼好的片段算进来。 */
const USER_FIELD = /(name|code|label|summary|word|sourceNo|remark|detail|memo|title|period|person|maker|dept|category|digest|reason|note)$/i;
// 逐文件缓存行数组：模板串补检每行要取前后行做豁免判定，避免重复读盘
const _lineCache = new Map();
function linesOf(file) {
  if (!_lineCache.has(file)) _lineCache.set(file, fs.readFileSync(file, 'utf8').split('\n'));
  return _lineCache.get(file);
}
let tplChecked = 0;
/* 【html`` 自动转义模板】js/common/html.js 的 html`` 标签模板：插值默认转义、可信片段须显式 raw()，
   因此这类模板里的 ${...} 不需要再判 esc —— 判了反而会逼人写成 esc() 造成双重转义。
   这里用一个小状态机把「位于 html`` 模板内」的行标出来（支持嵌套模板与 ${} 里的代码块）。 */
function autoEscapedLines(src) {
  const set = new Set();
  const mask = src.split('');       // 注释与普通字符串抹成空格（保留换行，行号不变）
  const blank = (a, b) => { for (let k = a; k < b && k < mask.length; k++) if (mask[k] !== '\n') mask[k] = ' '; };
  const stack = [];      // 打开中的模板：{ tagged, startLine, enclosing, enclosingDepth }
  let mode = 'text';     // 'text' = 模板正文；'code' = ${...} 内部
  let codeDepth = 0;
  let line = 0;
  const skipString = function (from) {
    const q = src[from];
    let k = from + 1;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === q) { k++; break; }
      if (src[k] === '\n' && q !== '`') { break; }   // 未闭合的普通字符串：不跨行
      k++;
    }
    blank(from, k);
    for (let j = from; j < k; j++) if (src[j] === '\n') line++;
    return k - 1;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') { line++; continue; }
    /* 代码态（模板正文之外）才认注释 / 普通字符串：模板正文里的 // 是文本，不是注释 */
    if (mode === 'code' || !stack.length) {
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? src.length : end + 2;
        blank(i, stop);
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop - 1;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i + 2);
        const stop = end < 0 ? src.length : end;
        blank(i, stop);
        i = stop - 1;
        continue;
      }
      if (ch === '"' || ch === "'") { i = skipString(i); continue; }
    }
    if (ch === '`') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && src[k] === '\\'; k--) bs++;
      if (bs % 2 === 1) continue;           // 转义的反引号，不是模板边界
      if (mode === 'text' && stack.length) {
        const t = stack.pop();              // 关闭最近打开的模板
        if (t.tagged) for (let l = t.startLine; l <= line; l++) set.add(l);
        mode = t.enclosing;                 // 嵌套模板关闭后要回到外层 ${...} 内部
        if (mode === 'code') codeDepth = t.enclosingDepth;
      } else {
        const before = src.slice(Math.max(0, i - 24), i);
        const m = before.match(/([A-Za-z_$][\w$]*)\s*$/);
        stack.push({
          tagged: !!(m && m[1] === 'html'),
          startLine: line,
          enclosing: mode,
          enclosingDepth: codeDepth
        });
        mode = 'text';
      }
      continue;
    }
    if (mode === 'text') {
      if (ch === '$' && src[i + 1] === '{') { mode = 'code'; codeDepth = 0; i++; }
      continue;
    }
    if (ch === '{') codeDepth++;
    else if (ch === '}') { if (codeDepth === 0) mode = 'text'; else codeDepth--; }
  }
  return { auto: set, code: mask.join('') };
}
walk(JS_DIR, []).forEach(file => {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const scan = autoEscapedLines(src);
  const autoLines = scan.auto;
  scan.code.split('\n').forEach((line, i) => {
    let m;
    const re = /\$\{([^{}]*)\}/g;
    while ((m = re.exec(line))) {
      const expr = m[1].trim();
      if (!expr) continue;
      tplChecked++;
      if (autoLines.has(i)) continue;       // html`` 模板内：插值已由标签函数自动转义
      if (/^(esc|escAttr|escHtml|escapeHtml)\s*\(/.test(expr)) continue;
      // 三元表达式逐分支看末项；只认「a.name / name」这种取值，函数调用与字面量不算
      const hit = expr.split(/[?:]/).some(branch => {
        const last = branch.replace(/[()+\-*/&|<>=!]/g, ' ').trim().split(/\s+/).pop() || '';
        return USER_FIELD.test(last) && /^[A-Za-z_$][\w$.]*$/.test(last);
      });
      if (!hit) continue;
      const near = [linesOf(file)[i - 1] || '', line, linesOf(file)[i + 1] || ''].join('\n');
      const info = { rel, line: i + 1, vals: [expr.slice(0, 40)], code: line.trim().slice(0, 76) };
      const waive = near.match(/escape-ok\s*[:：]\s*([^*\n]*)/);
      if (waive) { info.why = waive[1].trim().slice(0, 44); waived.push(info); }
      else problems.push(info);
    }
  });
});
/* 【命中数卡口】本脚本是"扫描 → 发现未转义才报"的结构：若扫描彻底落空（正则失效、
   页面改用别的渲染方式），problems 恒为空 → 打印"✓ 所有插入的值均已转义"并退出码 0。
   那是最坏的绿：门禁还在，待检查对象为 0。故显式要求"必须真的扫到 innerHTML 赋值"。 */
if (checked === 0) {
  console.log('✗ 未扫描到任何 innerHTML 赋值 —— 判据已失效，本次"通过"无效（一个待检项都没有）。');
  process.exit(1);
}
if (tplChecked === 0) {
  console.log('✗ 未扫描到任何模板串插值 —— 判据已失效，本次"通过"无效。');
  process.exit(1);
}

console.log('innerHTML 转义检查（扫描 ' + checked + ' 处赋值 / ' + tplChecked + ' 处模板串插值）');
console.log('─'.repeat(60));

if (problems.length) {
  console.log('★ 插入了未转义的值（' + problems.length + ' 处）：');
  problems.forEach(p => {
    console.log('  ' + (p.rel + ':' + p.line).padEnd(44) + '[' + p.vals.join(', ') + ']');
    console.log('      ' + p.code);
  });
  console.log('');
} else {
  console.log('✓ 所有插入的值均已转义或已豁免');
}

if (waived.length) {
  console.log('· 已豁免（' + waived.length + ' 处）：');
  waived.forEach(w => console.log('  ' + (w.rel + ':' + w.line).padEnd(44) + w.why));
  console.log('');
}

if (problems.length) {
  console.log('· ' + problems.length + ' 处待处理（其中部分是数字/数组等静态分析难以判定的误报）');
  console.log('  修法：把插入的**值**包上 esc()，标签本身不要包。');
  console.log('      改：\'<td>\' + p.name + \'</td>\'');
  console.log('      为：\'<td>\' + esc(p.name) + \'</td>\'');
  console.log('  确认安全可豁免：在相邻行写 /* escape-ok: 原因 */');
  console.log('');
  /* 【2026-09-26 由"软通过"改为"棘轮"】原状：发现问题仍 exit(0)，注释自陈"待逐项确认后改回 exit(1)"，
     于是一个**发现了 17 处问题却永远不失败**的检查诞生了 —— 这是"假绿"的另一种形态。
     "直接改回 exit(1)"的顾虑仍成立：17 处里混着静态分析难以判定的误报（金额格式化 / 数组 join / 数字计数），
     直接阻断会让 CI 长期变红而失去意义。但"永远绿"同样不可接受。故取中间态 —— **棘轮**：
       · 出现**基线之外的新增**未转义注入面 → exit(1)（这才是真正要防的回归）；
       · 与基线一致 → exit(0)，且输出写明"已知 N 处待处理"，不伪装成"已通过"。
     收敛路径不变：逐项确认 → 该修的修、该豁免的加 escape-ok 行内注释 → 跑 --write-baseline 把基线调小。
     ⚠ 本块注释内不得出现注释定界符（第一次改就被它提前闭合，导致整个脚本 SyntaxError）。 */
  /* 【2026-09-26 修正基线键】第一版用「文件:行号」为键 —— 结果**任何行号位移都会误报**：
     同一次收口里动了 Asset.js 的行数，17 处已知项整体错位 → 全部被当成"新增 6 处"而转红。
     行号是最不稳定的东西，故改为「**文件 + 该行代码内容**」为键：改文件别处、增删行都不影响，
     真正新增一处未转义注入面才会命中。行号仍打印给人看，只是不当键。 */
  const keyOf = p => p.rel + '|' + (p.code || '');
  /* 【2026-10-22 修正"空基线自动豁免"】原实现只要 JSON.parse 出来是空数组，就走
     "首次运行：已建立基线，本次不阻断"并 exit 0 —— 于是把基线手动清成 [] 之后，
     那一轮发现的问题全部被重新写进基线、悄悄变绿（实测清空后立刻又变成 11 处"已知"）。
     现在按**文件是否存在**区分两种意图：
       · 文件不存在 → 真正的首次运行，允许建立基线（exit 0）；
       · 文件存在（哪怕内容为 []）→ 严格模式，必须 0 处问题，否则 exit 1。
     想放宽时仍可显式跑 --write-baseline。 */
  const BASE = path.join(__dirname, '_html_escape_baseline.json');
  const baseExists = fs.existsSync(BASE);
  let base = [];
  try { base = JSON.parse(fs.readFileSync(BASE, 'utf8')); } catch (e) { base = []; }
  const cur = problems.map(keyOf);
  if (process.argv.includes('--write-baseline')) {
    fs.writeFileSync(BASE, JSON.stringify(cur, null, 1) + '\n');
    console.log('已按当前结果重写基线（' + cur.length + ' 处）');
    process.exit(0);
  }
  if (!baseExists) {
    fs.writeFileSync(BASE, JSON.stringify(cur, null, 1) + '\n');
    console.log('首次运行：已建立基线（' + cur.length + ' 处），本次不阻断。');
    process.exit(0);
  }
  if (!base.length) {
    if (problems.length) {
      console.log('✗ 基线为空（严格模式）但仍有 ' + problems.length + ' 处未转义注入面：');
      problems.forEach(p => console.log('   ' + p.rel + ':' + p.line + '  [' + p.vals.join(', ') + ']'));
      console.log('  → 请 esc() 转义，或确认安全后写 /* escape-ok: 原因 */ 豁免。');
      process.exit(1);
    }
    console.log('✓ 通过：基线为空且未发现未转义注入面');
    process.exit(0);
  }
  const baseSet = new Set(base);
  const fresh = problems.filter(p => !baseSet.has(keyOf(p)));
  if (fresh.length) {
    console.log('✗ 新增 ' + fresh.length + ' 处未转义注入面（基线 ' + base.length + ' 处之外）：');
    fresh.forEach(p => console.log('   ' + p.rel + ':' + p.line + '  [' + p.vals.join(', ') + ']'));
    console.log('  → 请 esc() 转义，或确认安全后写 /* escape-ok: 原因 */ 豁免；');
    console.log('    确认无误再跑 `node tools/check_html_escape.js --write-baseline` 收敛基线。');
    process.exit(1);
  }
  console.log('✓ 通过：未新增未转义注入面（已知 ' + problems.length + ' 处待处理，见基线）');
  process.exit(0);
}
console.log('✓ 通过');
process.exit(0);
