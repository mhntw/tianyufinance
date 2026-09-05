// 对话框桥接单测：在 Node 下验证 dialog-bridge.js 的 confirmAsync / promptAsync 行为。
// 覆盖：confirm 的 Tauri 分支（plugin.dialog 优先）与浏览器降级；prompt 的 Tauri=HTML浮层(无document时降级null)、浏览器原生。
// 运行：node tools/test_dialog_bridge.js

const assert = require('assert');
const path = require('path');

global.window = {};
const bridge = require(path.join(__dirname, '..', 'js', 'dialog-bridge.js'));
const { confirmAsync, promptAsync, getDialogApi, promptModal } = bridge;

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' -> ' + (e && e.message ? e.message : e)); }
}

async function run() {
  // 场景1：无任何环境（无 __TAURI__ 且无 confirm/prompt 函数）——安全降级
  global.window = {};
  await step('无环境 confirm 降级为 false', async () => {
    assert.strictEqual(await confirmAsync('hi'), false);
  });
  await step('无环境 prompt 降级为 null（无 document）', async () => {
    assert.strictEqual(await promptAsync('hi'), null);
  });

  // 场景2：浏览器降级（仅 window.confirm / window.prompt）
  global.window = {
    confirm: (m) => true,
    prompt: (m, d) => 'abc'
  };
  await step('浏览器降级 confirm 返回原生结果', async () => {
    assert.strictEqual(await confirmAsync('删吗', { title: '标题' }), true);
  });
  await step('浏览器降级 prompt 返回原生结果', async () => {
    assert.strictEqual(await promptAsync('名称', '默认', { title: '新建' }), 'abc');
  });

  // 场景3：Tauri 分支 confirm 仍走 plugin.dialog.confirm，title 透传
  const fakeDlg = {
    confirm: (msg, title) => Promise.resolve(true),
    prompt: () => Promise.resolve('不应被调用')
  };
  global.window = { __TAURI__: { plugin: { dialog: fakeDlg } } };
  await step('getDialogApi 返回 plugin.dialog', async () => {
    assert.strictEqual(getDialogApi(), fakeDlg);
  });
  await step('Tauri confirm 优先 dialog.confirm 且 title 透传', async () => {
    assert.strictEqual(await confirmAsync('确认删除', { title: '删除账套' }), true);
  });

  // 场景4：Tauri 兼容顶层 __TAURI__.dialog
  global.window = { __TAURI__: { dialog: fakeDlg } };
  await step('兼容顶层 __TAURI__.dialog', async () => {
    assert.strictEqual(getDialogApi(), fakeDlg);
    assert.strictEqual(await confirmAsync('x'), true);
  });

  // 场景5：Tauri 取消 confirm
  global.window = { __TAURI__: { plugin: { dialog: { confirm: () => Promise.resolve(false) } } } };
  await step('Tauri confirm 取消返回 false', async () => {
    assert.strictEqual(await confirmAsync('删吗'), false);
  });

  // 场景6：Tauri 环境下 prompt 不调用 dialog.prompt（官方插件无此 API），
  // 一律走 HTML 浮层分支（无 document 时 promptModal 兜底 resolve null）。
  // 验证：dialog.prompt 即便"恰好存在"也不会被调用——桥接明确不使用它。
  let tauriPromptCalled = false;
  global.window = { __TAURI__: { plugin: { dialog: { confirm: () => Promise.resolve(true), prompt: () => { tauriPromptCalled = true; return Promise.resolve('输入值'); } } } } };
  await step('Tauri 下 prompt 不走 dialog.prompt、走 HTML 浮层分支', async () => {
    const r = await promptAsync('名称', '默认', { title: '新建账套' });
    assert.strictEqual(tauriPromptCalled, false, '不应调用不存在的 dialog.prompt');
    assert.strictEqual(r, null, '无 document 时 promptModal 兜底返回 null');
  });

  // 场景7：浏览器原生 prompt 取消返回 null
  global.window = { prompt: () => null };
  await step('浏览器 prompt 取消返回 null', async () => {
    assert.strictEqual(await promptAsync('名'), null);
  });

  console.log('\n结果：通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
