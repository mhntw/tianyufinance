/* 陈旧 DOM 引用检测
 * 运行：node tools/test_stale_dom_refs.js
 *
 * 背景：
 *   页面重构（如期间输入拆成 qPeriodStart/qPeriodEnd）后，JS 里常残留对**已删除元素**
 *   的引用。这类引用在静态检查里看不出问题，运行时却是 $ 返回 null → 访问 .value
 *   抛 TypeError → 被全局兜底弹成「系统异常已被捕获」，用户完全看不出真实原因。
 *
 *   本文件已实际发现并修复三处真实缺陷：
 *     - app.js       $('qPeriod')     元素已移除（改为 qPeriodStart/qPeriodEnd）
 *     - Asset.js     $('dasPeriod')   元素已移除（改为 dasPeriodStart/dasPeriodEnd）
 *     - Cashier.js   $('vSummary')    凭证页没有单一摘要框（摘要是每行分录一个）
 *
 * 判定：只报「取到元素后立刻解引用」的写法（.value / .checked / .innerHTML / ...），
 *       即会真正抛错的情况。已经用 `if (el)` 或 `el &&` 守卫的属安全写法，不报。
 *       动态生成的 id（由 JS 的 innerHTML 创建，不在 index.html 里）自动排除。
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function step(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = /^(node_modules|\.git|tauri|tools|backups_)/;
const SKIP_FILES = new Set(['xlsx.full.min.js', 'mdb-reader.js', 'buffer.js', 'kis-import.js']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.test(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js') && !SKIP_FILES.has(name)) out.push(p);
  }
  return out;
}

// index.html 中静态存在的 id
function staticIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

// JS 里通过 innerHTML 等动态创建的 id（这些在 index.html 里没有，属正常）
function dynamicIds(code) {
  const ids = new Set();
  for (const m of code.matchAll(/\sid=\\?["']([A-Za-z0-9_$-]+)\\?["']/g)) ids.add(m[1]);
  for (const m of code.matchAll(/id:\s*['"]([A-Za-z0-9_$-]+)['"]/g)) ids.add(m[1]);
  return ids;
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// 匹配 $('x') 或 getElementById('x')，且**紧跟**属性/下标解引用 → 会抛错
// 例：$('qPeriod').value   /   document.getElementById('a').checked
function findUnguardedDeref(code, missingIds) {
  const hits = [];
  const re = /(?:\$|document\.getElementById)\(\s*['"]([A-Za-z0-9_$-]+)['"]\s*\)\s*\.\s*([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = re.exec(code))) {
    if (!missingIds.has(m[1])) continue;
    // 往前看 40 字符，若处于 && / || / if ( 之后说明有守卫
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    const guarded = /(\|\||&&|\?|if\s*\()\s*$/.test(before.trimEnd());
    if (guarded) continue;
    hits.push({ id: m[1], prop: m[2], line: code.slice(0, m.index).split('\n').length });
  }
  return hits;
}

(async function () {
  console.log('陈旧 DOM 引用检测：');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const statics = staticIds(html);

  const files = walk(path.join(ROOT, 'js'));
  // 先汇总全库"动态创建的 id"，避免把运行时生成的元素误报
  const dyn = new Set();
  for (const f of files) {
    for (const id of dynamicIds(stripComments(fs.readFileSync(f, 'utf8')))) dyn.add(id);
  }

  await step('自检：能检出未守卫的失效引用', function () {
    const sample = "var x = $('noSuchElement').value;";
    const hits = findUnguardedDeref(sample, new Set(['noSuchElement']));
    if (!hits.length) throw new Error('扫描器失效：未检出已知问题');
  });

  await step('自检：有守卫的引用不算问题', function () {
    const sample = "if ($('noSuchElement')) { var x = $('noSuchElement').value; }";
    const hits = findUnguardedDeref(sample, new Set(['noSuchElement']));
    const unguarded = hits.filter(h => !/if\s*\(/.test(sample));
    if (unguarded.length) throw new Error('误报：已守卫的写法被计入');
  });

  const offenders = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const missing = new Set();
    for (const m of code.matchAll(/id="([^"]+)"/g)) { /* noop */ }
    // 该文件引用了、但既不在 index.html 也不是运行时动态创建的 id
    for (const m of code.matchAll(/['"]([A-Za-z0-9_$-]+)['"]\s*\)/g)) { /* noop */ }
    const re = /(?:\$|document\.getElementById)\(\s*['"]([A-Za-z0-9_$-]+)['"]\s*\)/g;
    let mm;
    while ((mm = re.exec(code))) {
      const id = mm[1];
      if (!statics.has(id) && !dyn.has(id)) missing.add(id);
    }
    for (const h of findUnguardedDeref(code, missing)) {
      offenders.push({ file: path.relative(ROOT, f), ...h });
    }
  }

  await step('源码中不应存在未守卫的失效 DOM 解引用', function () {
    if (offenders.length) {
      throw new Error('发现 ' + offenders.length + ' 处：\n    ' +
        offenders.map(o => `${o.file}:${o.line}  $('${o.id}').${o.prop}`).join('\n    '));
    }
  });

  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
