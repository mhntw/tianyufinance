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

const problems = [];
const waived = [];
let checked = 0;

walk(JS_DIR, []).forEach(file => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(ROOT, file);

  lines.forEach((line, i) => {
    const m = line.match(/innerHTML\s*=\s*(.+)$/);
    if (!m) return;
    // 只取到行内第一个分号：`el.innerHTML = ''; all.length = 0;` 这类多语句同行
    // 若整行分析，会把后面语句的标识符也算进来（实测造成大量误报）。
    const rhs = m[1].split(';')[0];
    checked++;

    // 空赋值 / 纯字面量：无数据插入
    const stripped = rhs.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/`[^`]*`/g, '');
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

    // 已转义：整行出现 esc 系列调用即视为安全（esc 通常包住每个插入值）
    if (/esc(Html|Attr)?\(|escapeHtml\(/.test(near)) return;

    /* 先挖掉「安全函数调用」再分析 —— 否则 money(c.dr) 里的 c.dr 会被当成裸属性访问
       而误报（实测这类误报占了剩余项的一半）。这些函数产出固定格式的数字/方向文本，
       不含 HTML 标签，无需转义。循环多轮以处理嵌套（money(num(x))）。 */
    const SAFE_CALL = /\b(money|moneyRed|num|round2|amtCell|signed|fmt|esc|escHtml|escAttr|dirText|balText|walk)\s*\([^()]*\)/g;
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

console.log('innerHTML 转义检查（扫描 ' + checked + ' 处赋值）');
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
  const BASE = path.join(__dirname, '_html_escape_baseline.json');
  /* 【2026-09-26 修正基线键】第一版用「文件:行号」为键 —— 结果**任何行号位移都会误报**：
     同一次收口里动了 Asset.js 的行数，17 处已知项整体错位 → 全部被当成"新增 6 处"而转红。
     行号是最不稳定的东西，故改为「**文件 + 该行代码内容**」为键：改文件别处、增删行都不影响，
     真正新增一处未转义注入面才会命中。行号仍打印给人看，只是不当键。 */
  const keyOf = p => p.rel + '|' + (p.code || '');
  let base = [];
  try { base = JSON.parse(fs.readFileSync(BASE, 'utf8')); } catch (e) { base = []; }
  const cur = problems.map(keyOf);
  if (process.argv.includes('--write-baseline')) {
    fs.writeFileSync(BASE, JSON.stringify(cur, null, 1) + '\n');
    console.log('已按当前结果重写基线（' + cur.length + ' 处）');
    process.exit(0);
  }
  if (!base.length) {
    fs.writeFileSync(BASE, JSON.stringify(cur, null, 1) + '\n');
    console.log('首次运行：已建立基线（' + cur.length + ' 处），本次不阻断。');
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
