// audit_refs.js — 扫描全部 JS → DOM 引用、store 方法、render 注册三类断裂
// 用法: node tools/audit_refs.js
// 输出: 三类断裂清单（无问题则 PASS）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');
const STORE_JS = path.join(ROOT, 'js', 'store.js');

// 收集所有要扫的 JS 文件（跳过 minified/xlsx）
function walk(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js') && !p.includes('xlsx') && !p.includes('.min.')) out.push(p);
  }
  return out;
}
const ALL_JS = walk(path.join(ROOT, 'js'));

// ========== 1. DOM id 存在性 ==========
console.log('\n=== 1. DOM 引用断裂 ($("id") 找不到元素) ===');
const html = fs.readFileSync(INDEX_HTML, 'utf8');
const htmlIds = new Set();
const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
let m;
while ((m = idRe.exec(html))) htmlIds.add(m[1]);

// 收集 JS 里所有 $('xxx') / $("xxx") 调用 + 行号
const domRefs = [];
const dollarRe = /\$\s*\(\s*["']([^"']+)["']\s*\)/g;
for (const f of ALL_JS) {
  const txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n');
  dollarRe.lastIndex = 0;
  while ((m = dollarRe.exec(txt))) {
    const id = m[1];
    const before = txt.slice(0, m.index);
    const lineNo = before.split('\n').length;
    // 跳过注释行：整行以 // 开头，或 /* ... */ 块中
    const thisLine = lines[lineNo - 1];
    const trimmed = thisLine.replace(/^\s+/, '');
    if (trimmed.startsWith('//')) continue;
    // 检测是否在 /* ... */ 块中（简化：从文件头到当前位置 /* 数量是否 > */ 数量）
    const blockBefore = txt.slice(0, m.index);
    const openBlock = (blockBefore.match(/\/\*/g) || []).length;
    const closeBlock = (blockBefore.match(/\*\//g) || []).length;
    if (openBlock > closeBlock) continue;
    if (!htmlIds.has(id)) {
      const lineStart = txt.lastIndexOf('\n', m.index - 1) + 1;
      const nextNl = txt.indexOf('\n', m.index);
      const nextNl2 = txt.indexOf('\n', nextNl + 1);
      const nextNl3 = txt.indexOf('\n', nextNl2 + 1);
      // 模式 A：同一行有 if/guard
      // 【修正 2026-09-20】原正则不含「?」，于是漏掉「guard 与 $() 在同一行」的写法：
      //   function dasMonth() { var e = $('dasPeriodEnd'); return e ? e.value : currentPeriod(); }
      // 这类在全项目很常见（单行取值函数），实测又造成 11 处假警报。
      const guardSame = /\bif\b|\?\.|\?|!==\s*null|!=\s*null|&&\s*\w/.test(thisLine);
      // 模式 B：赋值给变量，下面行 if (var)
      let guardVar = false;
      const assignMatch = thisLine.match(/(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*\$\(\s*["']/);
      if (assignMatch) {
        const vname = assignMatch[1];
        const after = txt.slice(nextNl > 0 ? nextNl + 1 : m.index + 1, nextNl3 > 0 ? nextNl3 : m.index + 400);
        // 【修正 2026-09-20】原正则写的是「变量 ? .」——要求问号后紧跟点号，
        //   于是漏掉了最常见的写法「变量 ? 变量.属性 : 默认值」，例如：
        //     const month = eInp ? eInp.value : currentPeriod();
        //   问号后是变量名而非点号 → 永远匹配不上 → 全项目报了 33 处假警报，
        //   把审计结果变成噪声（实测这 33 处每一处的下一行都有正确的判空）。
        //   现放宽为「变量 ?」即可 —— 无论问号后跟的是点号、变量名还是字面量。
        // 【再修正 2026-09-20】上一版仍漏掉两类常见写法：
        //   ① if (a && vname) —— 变量名不在括号首位（如 `if (sInp && eInp)`）；
        //   ② if (vname && ...) —— 变量名后是 &&，而原字符类 [)!=?] 不含 &。
        //   现改为：变量名出现在 if(...) 内，或后接 ? / && / || / != null，即视为已有判空。
        if (new RegExp(
          `(if\\s*\\([^)]*\\b${vname}\\b[^)]*\\))` +
          `|(\\b${vname}\\b\\s*(?:\\?|&&|\\|\\|))` +
          `|(\\b${vname}\\b\\s*[!=]==\\s*null)`, 'm'
        ).test(after)) {
          guardVar = true;
        }
      }
      const hasGuard = guardSame || guardVar;
      domRefs.push({ file: path.relative(ROOT, f), line: lineNo, id, hasGuard });
    }
  }
}

if (!domRefs.length) {
  console.log('  [PASS] 所有 $("id") 引用的元素在 index.html 中都存在');
} else {
  const unsafe = domRefs.filter(r => !r.hasGuard);
  const safe = domRefs.filter(r => r.hasGuard);
  if (unsafe.length) {
    console.log('  [FAIL] 以下 DOM id 被引用但 HTML 不存在，且**无 null guard（会炸 TypeError）**:');
    const byFile = {};
    for (const r of unsafe) (byFile[r.file] = byFile[r.file] || []).push(r);
    for (const [f, rs] of Object.entries(byFile)) {
      console.log(`\n    ${f}:`);
      for (const r of rs) console.log(`      L${r.line}: $("${r.id}")`);
    }
  }
  if (safe.length) {
    console.log(`  [INFO] 以下 ${safe.length} 个 DOM id 不存在但有 null guard（安全）: ${[...new Set(safe.map(r=>r.id))].join(', ')}`);
  }
}

// ========== 2. store 方法存在性 ==========
console.log('\n=== 2. Store 方法断裂 (S.xxx() 找不到实现) ===');
const storeTxt = fs.readFileSync(STORE_JS, 'utf8');

// store.js 里定义的方法: name: function / name:function / name : function
const storeMethods = new Set();
const methRe = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:\s*function\b/g;
while ((m = methRe.exec(storeTxt))) storeMethods.add(m[1]);
// 还有 state 的字段不算方法，跳过

// JS 里的 S.xxx( 调用（跳过 S.state.xxx / S.VOUCHER_KINDS.xxx 等）
const sCalls = [];
const sCallRe = /\bS\.([A-Za-z_$][\w$]*)\s*\(/g;
for (const f of ALL_JS) {
  const txt = fs.readFileSync(f, 'utf8');
  sCallRe.lastIndex = 0;
  while ((m = sCallRe.exec(txt))) {
    const name = m[1];
    // 跳过属性读取（无括号已过滤），跳过 known non-methods
    if (['state', 'VOUCHER_KINDS'].includes(name)) continue;
    if (!storeMethods.has(name)) {
      const before = txt.slice(0, m.index);
      const line = before.split('\n').length;
      sCalls.push({ file: path.relative(ROOT, f), line, method: name });
    }
  }
}

if (!sCalls.length) {
  console.log('  [PASS] 所有 S.xxx() 调用的方法在 store.js 中都存在');
} else {
  console.log('  [FAIL] 以下 S.xxx() 调用了 store.js 中不存在的方法:');
  const byFile = {};
  for (const r of sCalls) (byFile[r.file] = byFile[r.file] || []).push(r);
  for (const [f, rs] of Object.entries(byFile)) {
    console.log(`\n    ${f}:`);
    for (const r of rs) console.log(`      L${r.line}: S.${r.method}()`);
  }
}

// ========== 3. render 注册一致性 ==========
console.log('\n=== 3. render 注册 (globalThis.__renderX vs app.js renderVia/X) ===');
const mainPath = path.join(ROOT, 'js', 'main.js');
const appPath = path.join(ROOT, 'js', 'app.js');
const mainTxt = fs.readFileSync(mainPath, 'utf8');
const appTxt = fs.readFileSync(appPath, 'utf8');

// main.js: globalThis.__renderX = func
const registered = new Set();
const regRe = /globalThis\.__render([A-Za-z0-9]+)\s*=/g;
while ((m = regRe.exec(mainTxt))) registered.add(m[1]);

// app.js: renderVia('X') 里的 X
const needed = new Set();
const needRe = /renderVia\(\s*['"]([A-Za-z0-9]+)['"]\s*\)/g;
while ((m = needRe.exec(appTxt))) needed.add(m[1]);

// 只注册但路由不用（无害）
const extraRegistered = [...registered].filter(x => ![...needed].some(n => x === n || x.toLowerCase() === n.toLowerCase()));
// 路由需要但没注册（断链！）
const missingRegistered = [...needed].filter(x => ![...registered].some(r => r.toLowerCase() === x.toLowerCase()));

if (missingRegistered.length === 0) {
  console.log('  [PASS] 所有 renderVia 路由都有对应的 globalThis.__renderX 注册');
} else {
  console.log('  [FAIL] 以下 renderVia 路由没有对应的 globalThis.__render 注册:');
  for (const x of missingRegistered) console.log(`    renderVia('${x}') — 缺 __render${x}`);
}
if (extraRegistered.length > 0) {
  console.log('  [INFO] 以下 __renderX 注册在 app.js 路由表里没找到引用（可能间接调用，暂不报错）:');
  for (const x of extraRegistered) console.log(`    __render${x}`);
}

// ========== 4. 汇总 ==========
const totalFails = domRefs.length + sCalls.length + missingRegistered.length;
console.log('\n=== 汇总 ===');
console.log(`  DOM 引用断裂:   ${domRefs.length}`);
console.log(`  Store 方法断裂: ${sCalls.length}`);
console.log(`  Render 注册断链: ${missingRegistered.length}`);
console.log(`  -----------------------------------`);
console.log(`  总计: ${totalFails} ${totalFails === 0 ? '✅ 全部通过' : '❌ 需要修复'}`);
process.exit(totalFails === 0 ? 0 : 1);
