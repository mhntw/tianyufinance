// 弹窗桥接单测：在 Node 下验证 dialog-bridge.js 的 showDialog / confirmAsync / promptAsync。
// 覆盖：确认与输入共用同一实现、复用 .modal 体系、正文分段与缩进、\n 换行、HTML 转义、
//      Enter/Esc/遮罩、嵌套只关最上层、防重复关闭、无 document 时安全降级。
// 运行：node tools/test_dialog_bridge.js

const assert = require('assert');
const path = require('path');

global.window = {};
const bridge = require(path.join(__dirname, '..', 'js', 'dialog-bridge.js'));
const { showDialog, confirmAsync, promptAsync, renderDialogBody } = bridge;

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' -> ' + (e && e.message ? e.message : e)); }
}

/* 最小 DOM mock：够 showDialog 用（createElement / body.appendChild / querySelector / 事件）。 */
function installDom() {
  const made = { overlays: [], keyHandlers: [] };
  function mkEl(tag) {
    const el = {
      tagName: tag, className: '', innerHTML: '', value: '', style: { cssText: '' },
      parentNode: null, onclick: null, _q: {},
      classList: {
        add(c) { if (el.className.split(/\s+/).indexOf(c) < 0) el.className = (el.className ? el.className + ' ' : '') + c; },
        remove(c) { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        contains(c) { return el.className.split(/\s+/).indexOf(c) >= 0; }
      },
      appendChild(c) { c.parentNode = el; },
      removeChild(c) { c.parentNode = null; },
      addEventListener() {},
      // 惰性造子节点：input 选择器给 input（带 value），其余给 button
      querySelector(sel) {
        if (!el._q[sel]) {
          const isInput = sel.indexOf('input') >= 0;
          const node = mkEl(isInput ? 'input' : 'button');
          node.className = sel.replace(/^\./, '');
          el._q[sel] = node;
        }
        return el._q[sel];
      },
      focus() {}
    };
    return el;
  }
  const body = mkEl('body');
  global.document = {
    createElement(tag) { const el = mkEl(tag); if (tag === 'div') made.overlays.push(el); return el; },
    body: body,
    addEventListener(type, fn) { if (type === 'keydown') made.keyHandlers.push(fn); },
    removeEventListener(type, fn) {
      if (type !== 'keydown') return;
      const i = made.keyHandlers.indexOf(fn);
      if (i >= 0) made.keyHandlers.splice(i, 1);
    }
  };
  return made;
}
// 向所有已注册的 keydown 监听派发按键；key 传字符串或完整事件对象（用于 keyCode 场景）
function pressKey(made, key) {
  const ev = (typeof key === 'string') ? { key: key, preventDefault() {} } : key;
  made.keyHandlers.slice().forEach((fn) => fn(ev));
}
const last = (made) => made.overlays[made.overlays.length - 1];

async function run() {
  // 场景1：无 document —— 安全降级（不抛错、不挂起）
  delete global.document;
  global.window = {};
  await step('无 document 时 confirm 降级为 false', async () => {
    assert.strictEqual(await confirmAsync('hi'), false);
  });
  await step('无 document 时 prompt 降级为 null', async () => {
    assert.strictEqual(await promptAsync('hi'), null);
  });

  const made = installDom();
  global.window = {};

  // 场景2：确认框 —— 复用 .modal 体系 + 正文格式
  await step('确认框复用 .modal 体系（不再走系统原生框）', async () => {
    const p = confirmAsync('确认删除该凭证？');
    const ov = last(made);
    assert.ok(ov.className.indexOf('modal') >= 0, '应复用 .modal 类（与业务模态同一套外观）');
    assert.ok(ov.className.indexOf('show') >= 0, '.modal 需带 .show 才可见');
    assert.ok(ov.innerHTML.indexOf('modal-box') >= 0 && ov.innerHTML.indexOf('modal-actions') >= 0,
      '应使用既有模态结构 modal-box / modal-actions');
    assert.strictEqual(ov.style.zIndex, '2147483647', '层级应覆盖为最高（可盖住业务模态）');
    assert.ok(/class="modal-body" style="[^"]*padding-left:1em/.test(ov.innerHTML),
      '正文容器应统一左缩进（不逐段判断，避免漏缩进）');
    ov._q['.ty-dlg-ok'].onclick();
    assert.strictEqual(await p, true);
  });
  await step('正文 \n 转换行、超长可滚动', async () => {
    const p = confirmAsync('第一段\n第二段', { title: '格式' });
    const body = last(made).innerHTML;
    assert.ok(body.indexOf('第一段<br>第二段') >= 0, '同段内单换行应为 <br>');
    assert.ok(/max-height:60vh/.test(body), '正文应可滚动，避免长文案撑破窗口');
    last(made)._q['.ty-dlg-ok'].onclick();
    await p;
  });
  await step('空行分段、末段无多余下边距', async () => {
    const p = confirmAsync('第一段说明。\n\n第二段说明。\n\n第三段说明。', { title: '分段' });
    const body = last(made).innerHTML;
    assert.strictEqual((body.match(/<p style=/g) || []).length, 3, '空行应切成 3 个段落');
    assert.ok(/margin:0;/.test(body), '最后一段不应多出下边距');
    last(made)._q['.ty-dlg-ok'].onclick();
    await p;
  });
  await step('列表项悬挂缩进、多项成列', async () => {
    const p = confirmAsync('本期存在以下提示项：\n\n· 税金测算：需确认\n· 折旧：本期未计提\n\n仍要结账吗？', { title: '结账提示' });
    const body = last(made).innerHTML;
    assert.strictEqual((body.match(/text-indent:-1em/g) || []).length, 2, '两个列表项应各自悬挂缩进');
    assert.ok(/margin:0 0 4px/.test(body), '列表项之间用较小间距');
    last(made)._q['.ty-dlg-ok'].onclick();
    await p;
  });
  await step('括号旁注独立成块、第二行并入同一块', async () => {
    const p = confirmAsync('确认用该备份恢复当前账本？\n（备份仅用于软件故障/文件损坏等意外找回；\n账务差错请用「红字冲销/反结账」更正）', { title: '恢复备份' });
    const body = last(made).innerHTML;
    assert.strictEqual((body.match(/<p style=/g) || []).length, 2, '应为「问句段 + 括号旁注段」两块');
    assert.ok(/账务差错请用「红字冲销\/反结账」更正/.test(body), '旁注第二行应并入同一块');
    last(made)._q['.ty-dlg-ok'].onclick();
    await p;
  });
  await step('正文做 HTML 转义（防卡片名等注入）', async () => {
    const p = confirmAsync('<img src=x onerror=alert(1)>');
    assert.ok(last(made).innerHTML.indexOf('&lt;img') >= 0, '尖括号应被转义');
    last(made)._q['.ty-dlg-cancel'].onclick();
    await p;
  });

  // 场景3：输入框模式（与确认共用同一实现）
  await step('输入框模式：渲染输入框并回填默认值', async () => {
    const p = promptAsync('请输入名称', '默认值', { title: '重命名' });
    const ov = last(made);
    assert.ok(ov.innerHTML.indexOf('ty-dlg-input') >= 0, '应渲染输入框');
    assert.ok(ov.innerHTML.indexOf('value="默认值"') >= 0, '默认值应回填');
    assert.ok(ov.innerHTML.indexOf('重命名') >= 0, '标题应渲染');
    ov._q['.ty-dlg-input'].value = '  新名字  ';
    ov._q['.ty-dlg-ok'].onclick();
    assert.strictEqual(await p, '新名字', '确定应返回 trim 后的输入值');
  });
  await step('输入框模式：取消返回 null', async () => {
    const p = promptAsync('请输入名称');
    last(made)._q['.ty-dlg-cancel'].onclick();
    assert.strictEqual(await p, null);
  });
  await step('确认与输入共用同一实现（除输入框外模板完全相同，杜绝两套漂移）', async () => {
    // 用同一标题与正文，只有 input 有无之差，才能验证"同一份模板"
    const p1 = confirmAsync('同一段正文。', { title: '共用实现' });
    const cHtml = last(made).innerHTML;
    last(made)._q['.ty-dlg-cancel'].onclick();
    await p1;
    const p2 = promptAsync('同一段正文。', '默认', { title: '共用实现' });
    const iHtml = last(made).innerHTML;
    last(made)._q['.ty-dlg-cancel'].onclick();
    await p2;
    assert.ok(iHtml.indexOf('ty-dlg-input') >= 0, '输入模式应多出输入框');
    assert.strictEqual(cHtml, iHtml.replace(/<input[^>]*>/, ''), '确认与输入的模板应同一份');
  });
  await step('showDialog 可直连（input 省略即确认框）', async () => {
    const p = showDialog({ title: '直连', message: '内容' });
    assert.ok(last(made).innerHTML.indexOf('直连') >= 0);
    last(made)._q['.ty-dlg-ok'].onclick();
    assert.strictEqual(await p, true);
  });

  // 场景4：键盘与嵌套
  await step('Esc 取消、Enter 确认（document 级按键）', async () => {
    const pEsc = confirmAsync('esc 测试');
    pressKey(made, 'Escape');
    assert.strictEqual(await pEsc, false, 'Esc 应取消');
    const pEnter = confirmAsync('enter 测试');
    pressKey(made, 'Enter');
    assert.strictEqual(await pEnter, true, 'Enter 应确认');
    const pInput = promptAsync('输入回车');
    last(made)._q['.ty-dlg-input'].value = 'abc';
    pressKey(made, 'Enter');
    assert.strictEqual(await pInput, 'abc', '输入框回车应提交（挂 document，不依赖焦点）');
  });
  await step('回车/ESC 在 keyCode 模式下同样生效（中文输入法 / 个别 webview 的 e.key 不可靠）', async () => {
    // 实测回归：只认 e.key 时输入法组合状态下回车、Esc 会"没反应"，故必须双判定
    const p1 = confirmAsync('keyCode 回车');
    pressKey(made, { key: '', keyCode: 13, preventDefault() {} });
    assert.strictEqual(await p1, true, 'keyCode 13 应确认');
    const p2 = confirmAsync('keyCode ESC');
    pressKey(made, { key: 'Process', keyCode: 27, preventDefault() {} });
    assert.strictEqual(await p2, false, 'keyCode 27 应取消');
  });
  await step('嵌套弹窗：一次按键只关最上层', async () => {
    const p1 = confirmAsync('第一层');
    const p2 = confirmAsync('第二层');
    assert.strictEqual(made.keyHandlers.length, 2, '两层各注册一个 keydown');
    pressKey(made, 'Enter');
    assert.strictEqual(await p2, true, '第二层应被关闭');
    assert.strictEqual(made.keyHandlers.length, 1, '第一层仍在，监听数应回到 1');
    pressKey(made, 'Escape');
    assert.strictEqual(await p1, false, '第一层随后由 Esc 关闭');
    assert.strictEqual(made.keyHandlers.length, 0, '全部关闭后无残留监听');
  });
  await step('重复关闭安全（连点确定+取消只生效一次）', async () => {
    const p = confirmAsync('防重复');
    const ov = last(made);
    ov._q['.ty-dlg-ok'].onclick();
    ov._q['.ty-dlg-cancel'].onclick();
    assert.strictEqual(await p, true, '结果以第一次为准');
  });
  await step('关闭后浮层从 body 移除', async () => {
    const p = confirmAsync('x');
    const ov = last(made);
    assert.ok(ov.parentNode, '创建后应挂到 body');
    ov._q['.ty-dlg-ok'].onclick();
    await p;
    assert.strictEqual(ov.parentNode, null, '关闭后应移除');
  });

  // 场景5：正文渲染函数可直接单测
  await step('renderDialogBody 单独可用（无 DOM 依赖）', async () => {
    const html = renderDialogBody('A\n\n· B\n\n（C）');
    assert.strictEqual((html.match(/<p style=/g) || []).length, 3, '应为 段落 + 列表 + 旁注 三块');
    assert.ok(/text-indent:-1em/.test(html), '列表项应悬挂缩进');
    assert.strictEqual(renderDialogBody(''), '', '空文案应返回空串');
  });

  console.log('\n结果：通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
