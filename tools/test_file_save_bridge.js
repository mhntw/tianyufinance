/* file-save-bridge.js 单元测试
 * 运行：node tools/test_file_save_bridge.js
 *
 * 验证：
 *  1. Tauri 环境：saveExcel 调 invoke('save_export_file', {name, base64}) 且 base64 可还原原字节
 *  2. Tauri 环境：saveText 调 invoke('save_export_file', {name, base64}) 且编码为 UTF-8 字节
 *  3. 非 Tauri 环境：saveExcel 回退到 XLSX.writeFile（不抛错）
 *  4. 非 Tauri 环境：saveText 回退到 Blob + a.click（不抛错）
 *  5. 回归：超 32KB（触发内部分块）的 base64 中间不得出现 padding '='
 *
 * 注：step 必须 await。此前 step 同步调用 async fn，断言失败会变成未被捕获的
 *     Promise rejection 而被吞掉，导致测试恒为"通过"——曾掩盖了 bytes→base64 的签名变更。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
// 必须 await：同步调用 async fn 会让断言失败变成未捕获的 rejection 而被吞掉
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message); }
}

// 引入被测模块
const bridgePath = path.join(__dirname, '..', 'js', 'file-save-bridge.js');
const code = fs.readFileSync(bridgePath, 'utf8');

// 构造一个最小全局环境，支持 require 与 window 模拟
function makeWindow(overrides) {
  const listeners = {};
  const el = { href: '', download: '', click() { this._clicked = true; }, setAttribute() {}, appendChild() {}, removeChild() {} };
  const w = {
    __TAURI__: null,
    document: {
      createElement() { return Object.assign({}, el, { click() { this._clicked = true; } }); },
      body: { appendChild() {}, removeChild() {} }
    },
    URL: { createObjectURL() { return 'blob:mock'; }, revokeObjectURL() {} },
    setTimeout: (fn) => fn(),
    TextEncoder: global.TextEncoder,
    Uint8Array: global.Uint8Array,
    Array: global.Array,
    Blob: function (parts) { this.parts = parts; },
    XLSX: {
      write(wb, opts) { return new Uint8Array([1, 2, 3, 4]); }, // mock：返回 4 字节
      writeFile() { this._writeFileCalled = true; },
      utils: { book_new() { return {}; }, book_append_sheet() {}, json_to_sheet() {}, aoa_to_sheet() {} }
    },
    showToast: () => {},
    console
  };
  Object.assign(w, overrides || {});
  return w;
}

// bridge 内部使用的是裸全局标识符（document / URL / Blob / setTimeout / XLSX），
// 在浏览器里它们天然存在于 window 上。Node 测试环境必须把这些一并作为形参注入，
// 使其在函数作用域内遮蔽同名的 Node 全局，否则会误用真实全局而抛错。
function loadBridge(win) {
  const fn = new Function(
    'window', 'global', 'XLSX', 'document', 'URL', 'Blob', 'setTimeout',
    code + '\n;return window.__fileSaveBridge;'
  );
  return fn(win, win, win.XLSX, win.document, win.URL, win.Blob, win.setTimeout);
}

(async function () {
  console.log('file-save-bridge 测试：');

  // 场景1：Tauri 环境 saveExcel（base64 参数，可还原原字节）
  await step('Tauri 下 saveExcel 调用 invoke(save_export_file) 且 base64 可还原', async () => {
    let captured = null;
    const win = makeWindow();
    win.__TAURI__ = { core: { invoke: (cmd, args) => { captured = { cmd, args }; return Promise.resolve('/fake/exports/x.xlsx'); } } };
    const bridge = loadBridge(win);
    const res = await bridge.saveExcel({}, '测试表');
    assert.strictEqual(captured.cmd, 'save_export_file');
    assert.strictEqual(captured.args.name, '测试表.xlsx');
    assert.strictEqual(typeof captured.args.base64, 'string', 'base64 应为字符串');
    // mock 的 XLSX.write 返回 [1,2,3,4]
    assert.strictEqual(captured.args.base64, Buffer.from([1, 2, 3, 4]).toString('base64'));
    assert.strictEqual(res, '/fake/exports/x.xlsx');
  });

  // 场景2：Tauri 环境 saveText（UTF-8 编码后 base64）
  await step('Tauri 下 saveText 编码为 UTF-8 字节的 base64', async () => {
    let captured = null;
    const win = makeWindow();
    win.__TAURI__ = { core: { invoke: (cmd, args) => { captured = { cmd, args }; return Promise.resolve('/p'); } } };
    const bridge = loadBridge(win);
    await bridge.saveText('你好,world', 'a.csv');
    assert.strictEqual(captured.args.name, 'a.csv');
    const decoded = Buffer.from(captured.args.base64, 'base64');
    assert.strictEqual(decoded.toString('utf8'), '你好,world', 'base64 应还原为原文');
  });

  // 场景3：非 Tauri 环境 saveExcel 回退 XLSX.writeFile
  await step('非 Tauri 下 saveExcel 回退 XLSX.writeFile 不抛错', async () => {
    const win = makeWindow();
    win.__TAURI__ = null;
    const bridge = loadBridge(win);
    let threw = false;
    try { await bridge.saveExcel({}, '回退表'); } catch (e) { threw = true; }
    assert.strictEqual(threw, false);
    assert.strictEqual(win.XLSX._writeFileCalled, true, '应回退调用 XLSX.writeFile');
  });

  // 场景4：非 Tauri 环境 saveText 回退 Blob + a.click
  await step('非 Tauri 下 saveText 回退 Blob 下载不抛错', async () => {
    const win = makeWindow();
    win.__TAURI__ = null;
    let clicked = false;
    const origCreate = win.document.createElement;
    win.document.createElement = function (tag) {
      const e = origCreate.call(win.document, tag);
      if (tag === 'a') { const oc = e.click; e.click = function () { clicked = true; oc.call(e); }; }
      return e;
    };
    const bridge = loadBridge(win);
    let threw = false;
    try { await bridge.saveText('csvdata', 'b.csv'); } catch (e) { threw = true; }
    assert.strictEqual(threw, false);
    assert.strictEqual(clicked, true, '应触发 a.click 下载');
  });

  // 场景5：核心回归 —— 超 32KB 时内部会分块处理，绝不能让 padding '=' 落在中间。
  // 历史 bug：分块各自 btoa 再拼接，块尾 padding 进入串中间，Rust 严格解码报
  // "Invalid symbol 61"。此用例锁死该行为。
  await step('超 32KB 内容 base64 中间无 padding 且可无损还原', async () => {
    const win = makeWindow();
    let captured = null;
    win.__TAURI__ = { core: { invoke: (cmd, args) => { captured = { cmd, args }; return Promise.resolve('/p'); } } };
    const bridge = loadBridge(win);

    // 覆盖 chunk 边界：内部 chunk = 0x8000 = 32768
    for (const n of [10, 32767, 32768, 32769, 65536, 151931]) {
      const big = '数据'.repeat(Math.ceil(n / 2)).slice(0, n);
      await bridge.saveText(big, 'big.csv');
      const s = captured.args.base64;
      const core = s.replace(/=+$/, '');
      assert.strictEqual(core.indexOf('='), -1, `n=${n} 中间不应出现 padding '='`);
      assert.ok(s.length - core.length <= 2, `n=${n} 尾部 padding 不得超过 2`);
      assert.strictEqual(
        Buffer.from(s, 'base64').toString('utf8'),
        big,
        `n=${n} 应能无损还原原文`
      );
    }
  });

  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
