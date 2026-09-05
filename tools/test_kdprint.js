/* kdPrint 打印 HTML 生成逻辑测试（纯函数部分）
 * 运行：node tools/test_kdprint.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'js', 'app.js');
const code = fs.readFileSync(appPath, 'utf8');

// 提取 buildPrintHtml 与 escapeHtml 两个纯函数（它们在 app.js 顶层作用域）
function extract(name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = code.match(re);
  if (!m) throw new Error('未找到 ' + name);
  // 简易括号匹配截取函数体
  let i = code.indexOf('{', m.index);
  let depth = 0, end = -1;
  for (let j = i; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return code.slice(m.index, end + 1);
}

let passed = 0, failed = 0;
// 必须 await：同步调用 async fn 会让断言失败变成未捕获的 rejection 而被吞掉，
// 导致测试恒为"通过"（曾掩盖 bytes→base64 的签名变更，让问题流到打包版才暴露）。
async function step(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message); } }

(async function () {
  console.log('kdPrint 生成逻辑测试：');
  const buildPrintHtml = eval('(' + extract('buildPrintHtml').replace('function buildPrintHtml', 'function') + ')');
  const escapeHtml = eval('(' + extract('escapeHtml').replace('function escapeHtml', 'function') + ')');

  await step('escapeHtml 转义关键字符', function () {
    assert.strictEqual(escapeHtml('<a>&"'), '&lt;a&gt;&amp;&quot;');
  });

  await step('buildPrintHtml 包含标题与 @media print', function () {
    const h = buildPrintHtml('测试报表', '<table><tr><td>1</td></tr></table>');
    assert.ok(h.includes('<title>测试报表</title>'), '应含标题');
    assert.ok(h.includes('@media print'), '应含打印样式');
    assert.ok(h.includes('<table>'), '应含主体');
  });

  await step('buildPrintHtml 对标题做 HTML 转义防注入', function () {
    const h = buildPrintHtml('<script>x</script>', '');
    assert.ok(!h.includes('<script>x</script>'), '标题中的标签应被转义');
    assert.ok(h.includes('&lt;script&gt;'), '应转义为实体');
  });

  await step('kdPrint 在 Tauri 下走 save_export_file + open_in_explorer', async function () {
    // 模拟 window.__TAURI__ 与 invoke，验证调用链
    const calls = [];
    const invoke = (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(cmd === 'save_export_file' ? '/fake/exports/x.html' : undefined); };
    global.window = {
      __TAURI__: { core: { invoke } },
      document: { querySelector: () => null, addEventListener() {} },
      TextEncoder: global.TextEncoder,
      Uint8Array: global.Uint8Array,
      Array: global.Array
    };
    global.document = global.window.document;
    global.TextEncoder = global.TextEncoder;
    // kdPrint 直接使用裸全局标识符 location / PAGE_NAMES（浏览器里天然存在），
    // Node 环境需补齐，否则抛 ReferenceError
    global.location = { hash: '' };
    global.PAGE_NAMES = global.PAGE_NAMES || {};
    // 重新加载 kdPrint 相关函数到含 window 的环境。
    // kdPrint 依赖同作用域的 toBase64（app.js 内），需一并提取后同作用域 eval，
    // 否则 kdPrint 内调用 toBase64 会解析到全局而报 is not defined。
    const kdPrintSrc = extract('kdPrint');
    const toBase64Src = extract('toBase64');
    const fn = eval(
      toBase64Src + '\n(' + kdPrintSrc.replace('function kdPrint', 'function') + ')'
    );
    fn({ closest: () => null });
    await new Promise(r => setTimeout(r, 50));
    assert.ok(calls.some(c => c.cmd === 'save_export_file'), '应调用 save_export_file');
    assert.ok(calls.some(c => c.cmd === 'open_in_explorer'), '应调用 open_in_explorer 打开文件');
    const sf = calls.find(c => c.cmd === 'save_export_file');
    assert.strictEqual(typeof sf.args.base64, 'string', 'base64 应为字符串');
    assert.ok(sf.args.base64.length > 0, 'base64 不应为空');
    // 核心回归：打印内容常超 32KB，内部会分块处理。绝不能出现中间的 padding '='，
    // 否则 Rust 严格解码报 "Invalid symbol 61"（总账打印失败的根因）。
    const core = sf.args.base64.replace(/=+$/, '');
    assert.strictEqual(core.indexOf('='), -1, "中间不应出现 padding '='");
    assert.ok(sf.args.base64.length - core.length <= 2, '尾部 padding 不得超过 2');
  });

  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
