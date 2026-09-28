#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_import_failure.js —— 导入**失败**必须说出来，而且说法对用户有意义
 *
 * 【为什么有这个脚本】2026-09-28 真机发现：选一个不是金蝶账套的 .ais 时，用户看到的是
 *     `系统异常：Error: Wrong page type. Expected 0 but received 110. @ assertPageType (http…`
 *   而代码里写好的「导入失败：…」**从未执行过**。根因在 js/kis-import.js 的 parse：
 *       ensureMdbReader().then(function () { resolve(convert(buf, name)); }, reject);
 *   `convert(...)` 在 then 回调里抛错时，抛错变成**内层 promise 的拒绝**，而那条内层链
 *   没有人接 —— 于是外层 promise **永不 settle**：调用方的 .catch 是死代码，
 *   拒绝冒到全局兜底，用户就吃到了原始英文栈。
 *
 * 【它守的两条不变量】
 *   A. `KisImport.parse` 在任何失败下都必须**结算**（reject），绝不允许"卡住不 settle"。
 *      这是"失败能被上层处理"的前提 —— 用超时把"卡住"判成失败，否则本脚本会跟着一起绿。
 *   B. 失败**不得**留下未处理的 promise 拒绝（否则全局兜底会拿原始栈顶掉友好提示）。
 *   另附静态卡口：Settings.js 两处导入 catch 必须走 importErrText，不得退回裸 e.message。
 *
 * 【历史教训】这条缺陷在"只测成功路径"的网下**永远不可见**（导入器平时跑得好好的）
 *   —— 故本脚本的桩**故意让解析失败**，并已做变异复验：
 *   把 parse 退回 resolve(convert(...)) → 立刻转红（1.2 秒超时判为"卡住"）。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, actual) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (actual === undefined ? '' : '   → ' + actual)); }
}

/* 0) 全局兜底监听：捕获"未处理的拒绝"（真实应用里它就是那条「系统异常」横幅的来源） */
const unhandled = [];
process.on('unhandledRejection', function (r) {
  unhandled.push(String((r && r.message) || r));
});

/* 1) 浏览器环境 mock + 装载被测源码
      MDBReader **存在但构造函数抛错** —— 精确模拟"文件不是金蝶账套"时的真实行为
      （mdb-reader 在页类型断言处失败）。存在是必要的：mdbReady() 为 true 才不会去
      动态加载脚本（Node 里加载不来，会挂住）。 */
const REAL_MSG = 'Wrong page type. Expected 0 but received 110.';
global.window = global;
global.STANDARDS = {};
global.document = { createElement: function () { return { style: {}, appendChild: function () {} }; }, head: {} };
global.MDBReader = function MDBReader() { throw new Error(REAL_MSG); };
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'kis-import.js'), 'utf8'));
const KI = global.KisImport;

/* 2) 判定"结算与否"：把"卡住不 settle"也判成失败（否则修复前后都是绿的） */
function settle(p, ms) {
  return new Promise(function (resolve) {
    let done = false;
    const t = setTimeout(function () { if (!done) { done = true; resolve({ state: 'pending' }); } }, ms);
    p.then(function () {
      if (!done) { done = true; clearTimeout(t); resolve({ state: 'resolved' }); }
    }, function (e) {
      if (!done) { done = true; clearTimeout(t); resolve({ state: 'rejected', msg: String((e && e.message) || e) }); }
    });
  });
}
function fileLike(name) {
  return { name: name, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(32)); } };
}

(async function main() {
  check(KI && typeof KI.parse === 'function', '应能加载 js/kis-import.js 并取到 KisImport.parse');

  console.log('\n【A】解析失败时必须**结算为 reject**（不允许卡住不 settle）');
  const inputs = [
    ['File / Blob（arrayBuffer 分支）', fileLike('probe_2026年.ais')],
    ['ArrayBuffer（直传分支）', new ArrayBuffer(32)],
    ['Uint8Array（跨 realm 兜底分支）', new Uint8Array(32)]
  ];
  for (const [label, input] of inputs) {
    const r = await settle(KI.parse(input), 1200);
    check(r.state === 'rejected', label + '：parse 应以 reject 结算',
      '实际=' + r.state + (r.state === 'pending' ? '（卡住不 settle —— 调用方的 .catch 会变成死代码）' : ''));
    check(r.state !== 'rejected' || r.msg.indexOf('Wrong page type') >= 0,
      label + '：拒绝原因应保留解析库原文（便于排查）', '实际=' + r.msg);
  }

  console.log('\n【A2】多年合并（parseMulti）同样必须把失败传出来');
  const mr = await settle(KI.parseMulti([fileLike('x_2024年.ais'), fileLike('x_2025年.ais')]), 1500);
  check(mr.state === 'rejected', 'parseMulti：任一文件失败即 reject（不得静默卡住）', '实际=' + mr.state);

  console.log('\n【B】失败不得留下未处理的 promise 拒绝（否则用户看到的是英文栈）');
  await new Promise(function (r) { setTimeout(r, 250); });   // 给 unhandledRejection 触发机会
  check(unhandled.length === 0,
    '上述失败均未产生未处理拒绝（全局兜底不该看到原始栈）',
    '实测 ' + unhandled.length + ' 条：' + unhandled.join(' | '));

  console.log('\n【C】错误文案：翻成人话，且不猜测');
  const icSrc = fs.readFileSync(path.join(ROOT, 'js', 'common', 'import-classify.js'), 'utf8')
    .replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1');
  (0, eval)(icSrc);
  check(typeof importErrText === 'function', '应能加载 js/common/import-classify.js 的 importErrText');
  const friendly = importErrText(new Error(REAL_MSG));
  check(friendly.indexOf('不是有效的金蝶账套文件') >= 0,
    '真实 mdb-reader 报错应翻成「这不是有效的金蝶账套文件…」', '实际=' + friendly.slice(0, 40) + '…');
  check(friendly.indexOf(REAL_MSG) >= 0, '同时保留技术详情（用户可复制上报、我们仍能定位）');
  check(importErrText(new Error('不支持的输入类型')) === '不支持的输入类型',
    '判不出的错误**原样透出**，不猜测、不一律说成"导入失败"');
  check(importErrText(null) === '未知错误', '空错误也要给出可读文案（不得渲染成 "undefined"）');
  check(importErrText(new Error('解析库未加载 (MDBReader)')).indexOf('刷新页面') >= 0,
    '解析库未就绪时给出可执行的下一步（刷新），而不是把库名甩给用户');

  console.log('\n【D】静态卡口（防复发）');
  /* ⚠ 查静态模式前**必须先剥掉注释**：本项目的注释里会（也应该）写出反模式的样子，
     否则卡口会被自己的说明文字命中 —— 这个坑在 check_single_source 上已经踩过一次。 */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/\/\/.*$/gm, ' ');
  }
  const kis = stripComments(fs.readFileSync(path.join(ROOT, 'js', 'kis-import.js'), 'utf8'));
  check(kis.indexOf('resolve(convert(') < 0,
    'kis-import.js 的**代码**里不得出现 resolve(convert(...)) —— 回调里抛错会变成内层拒绝、外层永不结算');
  const st = stripComments(fs.readFileSync(path.join(ROOT, 'js', 'pages', 'settings', 'Settings.js'), 'utf8'));
  const uses = (st.match(/importErrText\(e\)/g) || []).length;
  check(uses >= 2,
    'Settings.js 两处导入 catch（单本 .ais / 多年合并）都应走 importErrText',
    '实测 ' + uses + ' 处');
  check(st.indexOf("showToast('导入失败：' + (e && e.message") < 0
    && st.indexOf("showToast('合并导入失败：' + (e && e.message") < 0,
    '不得退回裸 (e && e.message || e)（那正是把英文栈甩给用户的写法）');

  console.log('');
  console.log(fail === 0 ? ('✓ 导入失败路径全部通过（' + pass + ' 项）')
    : ('✗ 通过 ' + pass + ' / 不符 ' + fail));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('脚本自身异常：' + (e && e.stack || e));
  process.exit(1);
});
