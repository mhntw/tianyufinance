#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_import_entry.js —— 「导入账套」唯一入口 + 「覆盖只在一处」验证
 *
 * 【背景】2026-09-28 两次收敛：
 *   ① 三合一：原「导入账套 / 多年合并导入 / 导入备份」三个并列入口合并为 #btnBookImport，
 *      按文件**种类 + 数量**分流（判据是纯函数 js/common/import-classify.js）。
 *   ② 语义统一：该入口**只做新增，绝不覆盖当前账套** —— 用户看到"导入"二字想的是
 *      "加一本 / 打开别人给的账"，不会预期自己正在用的账被换掉（名字与行为不符是最坏的
 *      一类不一致，因为他不会去细读确认框）。于是 .json 从"覆盖当前账套"改为"作为新账套导入"，
 *      而"覆盖当前账本"能力搬到「查看备份 → 从文件恢复…」，与列表里的「恢复」同处一个面板。
 *
 * 【本脚本守的两条不变量（这是它存在的理由）】
 *   A. 判据永不产出"覆盖"动作 —— 否则 .json 又会悄悄换掉用户的账。
 *   B. 「覆盖当前账本」全应用只有一个入口文件（Tools.js，且都在「查看备份」面板里），
 *      且必须"先确认、后快照、再覆盖" —— 顺序错了等于没拦（首版静态断言就栽在这上面）。
 *
 * 用法：node tools/verify_import_entry.js
 * ============================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 一、判据表：直接加载**真实**纯函数（只去掉 export 语法） ---------- */
(function plan() {
  const src0 = fs.readFileSync(path.join(ROOT, 'js', 'common', 'import-classify.js'), 'utf8');
  let src = src0.replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1')
               + '\n;globalThis.__PLAN__ = importPlanOf;';
  (0, eval)(src);
  const planOf = globalThis.__PLAN__;
  check(typeof planOf === 'function', '应能加载 js/common/import-classify.js 的 importPlanOf');

  const F = names => names.map(n => ({ name: n }));
  const act = names => planOf(F(names)).action;

  // 三条分流（全部是"新增"）
  check(act(['2026年.ais']) === 'new-ais', '1 个 .ais → 新建账套');
  check(act(['2024年.ais', '2025年.ais']) === 'merge-ais', '2 个 .ais → 合并新建（原「多年合并导入」）');
  check(act(['2024年.ais', '2025年.ais', '2026年.ais']) === 'merge-ais', '3 个 .ais → 合并新建');
  check(act(['2024年.ais', '2025年.ais', '2026年.ais', '2027年.ais']) === 'merge-ais', '4 个 .ais → 合并新建');
  check(act(['backup.json']) === 'new-json',
    '1 个 .json → **作为新账套导入**（不是覆盖当前账套 —— 见文件头不变量）');

  // 不变量 A：判据永不产出"覆盖"
  const allActions = [];
  [['2026年.ais'], ['a.ais', 'b.ais'], ['x.json'], ['x.json', 'y.ais'], ['x.json', 'y.json'],
   ['a.txt'], [], ['notes.pdf']].forEach(function (n) { allActions.push(planOf(F(n)).action); });
  check(allActions.indexOf('overwrite') < 0, '不变量 A：判据的任何输入都不得产出 overwrite（覆盖）动作',
    allActions.join(','));
  check(/^\s*export\s+.*importPlanOf/ms.test(src0) && src0.indexOf("'overwrite'") < 0,
    '不变量 A：判据源码里不应再出现 overwrite 这一动作名（防止旧语义被改回来）');

  // 边界：不猜、明确报错
  check(act(['a.json', 'b.ais']) === 'error', '备份与金蝶账套混选 → 报错（不猜）');
  check(act(['a.json', 'b.json']) === 'error', '多个 .json → 报错（备份无法合并）');
  check(act(['note.txt']) === 'error', '选入非 .ais/.json → 报错');
  check(act(['2026年.ais', 'note.txt']) === 'error', '合法文件里混入其它类型 → 报错');
  check(act([]) === 'error', '未选文件 → 报错（不误当 merge）');
  check(planOf(null).action === 'error', 'null 输入不应抛异常（返回 error）');

  // 大小写与中文名
  check(act(['备份.JSON']) === 'new-json', '扩展名大小写不敏感（.JSON）');
  check(act(['2026年.AIS']) === 'new-ais', '扩展名大小写不敏感（.AIS）');
  check(act(['绅蓝之星_2026年.ais']) === 'new-ais', '中文名 + 下划线文件名照常识别');
  // 报错时必须带可读原因（否则用户只看到"失败"）
  const e1 = planOf(F(['a.json', 'b.ais']));
  check(!!e1.msg && e1.msg.length > 6, '报错应带可读原因（msg）', e1.msg || '（无）');
  // 每个动作的文件列表只能含该动作对应的文件
  check(planOf(F(['x.json'])).files.length === 1, 'new-json 应只返回该 .json 文件');
  check(planOf(F(['a.ais', 'b.ais'])).files.length === 2, 'merge-ais 应返回全部 .ais 文件');
})();

/* ---------- 二、接线卡口：旧入口真的消失、新入口真的接上、覆盖真的只有一处 ---------- */
(function wiring() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Settings.js'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Tools.js'), 'utf8');

  // 旧元素：按 element id 查（注释里提到旧名字是允许的，故只查 id="..." 形态）
  ['btnBmImport', 'btnMultiYearImport', 'btnImportBackup', 'aisFile', 'bkFile', 'multiAisFile']
    .forEach(function (id) {
      check(html.indexOf('id="' + id + '"') < 0,
        'index.html 不应再有旧元素 id="' + id + '"（已合并/删除）');
    });
  check(html.indexOf('id="btnBookImport"') >= 0, 'index.html 应有唯一入口按钮 id="btnBookImport"');
  check(html.indexOf('id="bookImportFile"') >= 0, 'index.html 应有统一文件选择器 id="bookImportFile"');
  check(html.indexOf('id="restoreFromFileInput"') >= 0,
    'index.html 应有「从文件恢复…」的选择器 id="restoreFromFileInput"');
  check((html.match(/id="btnBookImport"/g) || []).length === 1, '导入入口只应有一个按钮');

  // 旧绑定：不能留"删了 UI 留了死绑"（$('x').addEventListener 对 null 会抛 TypeError）
  ['bkFile', 'multiAisFile', 'aisFile', 'btnBmImport', 'btnMultiYearImport', 'btnImportBackup']
    .forEach(function (id) {
      const bad = new RegExp("(\\$|getElementById)\\(\\s*['\"]" + id + "['\"]\\s*\\)\\s*\\.").test(settings + tools);
      check(!bad, '不得再对已删除的 ' + id + ' 取元素后解引用（会抛 TypeError）');
    });

  // 新绑定与新分派
  check(/\$\('bookImportFile'\)/.test(settings), 'Settings.js 应绑定统一选择器 #bookImportFile');
  check(/\$\('btnBookImport'\)/.test(settings), 'Settings.js 应绑定唯一入口按钮 #btnBookImport');
  check(/importPlanOf/.test(settings), 'Settings.js 应取用纯判据 importPlanOf（不得内联一套判据）');
  ['new-ais', 'merge-ais', 'new-json'].forEach(function (a) {
    check(new RegExp("action\\s*===\\s*'" + a + "'").test(settings),
      'Settings.js 应显式分派 action === ' + a);
  });
  check(/handleImportAis\(/.test(settings), 'new-ais 分支应走原有 handleImportAis');
  check(/importJsonAsNewBook\(/.test(settings), 'new-json 分支应走 importJsonAsNewBook');
  check(/handleMultiYearImport\(/.test(settings), 'merge-ais 分支应走原有 handleMultiYearImport');

  // 不变量 A（接线层）：导入入口必须"只新增"，不得触碰覆盖/快照那套
  check(settings.indexOf('restoreBookState') < 0,
    '不变量 A：Settings.js（导入入口）不得调用 restoreBookState —— 导入只做新增，覆盖走「查看备份」');
  check(settings.indexOf('guardBeforeRestore') < 0,
    '不变量 A：Settings.js 不得再引用覆盖前快照守卫（那是"覆盖"专用的保护）');
  //  .json 作为新账套导入：必须与 .ais 共用同一条建账套路径，并补 .json 特有的数据整理
  const iNewJson = settings.indexOf('function importJsonAsNewBook(');
  const njBody = iNewJson < 0 ? '' : settings.slice(iNewJson, iNewJson + 2200);
  check(iNewJson >= 0, 'Settings.js 应有 importJsonAsNewBook（.json 作为新账套导入）');
  check(/reader\.readAsText/.test(njBody), '（判据自检）截取的函数体应完整到结尾', '长度 ' + njBody.length);
  check(/loadServerBookIntoLocal\(/.test(njBody),
    'importJsonAsNewBook 应走 loadServerBookIntoLocal（与 .ais 导入同一条建账套路径）');
  check(/ensureVoucherIds/.test(njBody),
    'importJsonAsNewBook 应补 ensureVoucherIds（旧 .json 备份的凭证 id 可能缺失/不稳，会导致点凭证定位失效）');

  // 不变量 B：「覆盖当前账本」全应用只有 Tools.js 一个文件
  function callersOf(needle, dir, out) {
    out = out || [];
    fs.readdirSync(dir).forEach(function (n) {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) return callersOf(needle, p, out);
      if (!/\.js$/.test(n)) return;
      if (fs.readFileSync(p, 'utf8').indexOf(needle) >= 0) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    });
    return out;
  }
  const rbCallers = callersOf('restoreBookState(', path.join(ROOT, 'js', 'pages'));
  check(rbCallers.length === 1 && rbCallers[0] === 'js/pages/settings/Tools.js',
    '不变量 B：页面层调用 restoreBookState 的文件只应有 js/pages/settings/Tools.js',
    '实测：' + (rbCallers.join(', ') || '（无）'));
  check(fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8').indexOf('restoreBookState(') >= 0,
    '（store 内部实现的 restoreFromData 委托不算违规，保持现状）');

  // Tools.js：从文件恢复的入口与保护
  check(/\$\('restoreFromFileInput'\)/.test(tools), 'Tools.js 应绑定 #restoreFromFileInput');
  check(/id="btnRestoreFromFile"/.test(tools), 'Tools.js 应在备份面板渲染「从文件恢复…」链接');
  const iFn = tools.indexOf('function restoreFromFile(');
  const fnBody = iFn < 0 ? '' : tools.slice(iFn, iFn + 2000);
  check(iFn >= 0, 'Tools.js 应有 restoreFromFile 函数（外部 .json 覆盖恢复）');
  check(/reader\.readAsText/.test(fnBody), '（判据自检）截取的函数体应完整到结尾', '长度 ' + fnBody.length);
  check(/confirmAsync/.test(fnBody) && /覆盖当前账套/.test(fnBody),
    '从文件恢复必须先明确告知"覆盖当前账套"并确认（破坏性语义不得藏起来）');
  check(/guardBeforeRestore/.test(fnBody), '从文件恢复应保留覆盖前留存档守卫');
  const iC = fnBody.indexOf('confirmAsync'), iG = fnBody.indexOf('guardBeforeRestore'), iR = fnBody.indexOf('restoreBookState(');
  check(iC >= 0 && iG > iC && iR > iG,
    '顺序必须是「先确认 → 再留快照 → 最后覆盖」（顺序错了等于没拦；用户取消时也不该白留快照）',
    'confirmAt=' + iC + ' guardAt=' + iG + ' restoreAt=' + iR);
})();

/* ---------- 三、「恢复只许一处实现」+ 旧备份缺字段不崩 ---------- */
(function restore() {
  const mem = {};
  global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  global.window = global; global.__TAURI__ = {}; global.isTauri = false;
  require(path.join(ROOT, 'js', 'storage.js'));
  require(path.join(ROOT, 'js', 'store.js'));
  const S = global.S;

  const storeSrc = fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8');
  const bodyOf = function (name) {
    const i = storeSrc.indexOf(name + ': function');
    return i < 0 ? '' : storeSrc.slice(i, i + 900);
  };
  const rbs = bodyOf('restoreBookState'), rfd = bodyOf('restoreFromData');
  check(/ensureCashFlowFields\(\)/.test(rbs),
    'restoreBookState 应含 ensureCashFlowFields（原 restoreFromData 有、它缺 —— 合并时补上）');
  check(/Storage\.saveBook/.test(rbs), 'restoreBookState 应立即落盘（不能只靠防抖 persist）');
  check(/this\.restoreBookState\(/.test(rfd),
    'restoreFromData 应委托 restoreBookState（恢复只许一处实现，否则改一处必漏另一处）');
  check(!/Object\.assign\(\{\},\s*emptyState\(\),\s*data\)/.test(rfd),
    'restoreFromData 不应再有第二套恢复实现（空状态合并应只在 restoreBookState 里）');

  // 行为：委托关系可观测
  S.bookId = 'T_BOOK';
  const real = S.restoreBookState;
  let called = 0;
  S.restoreBookState = function (st, opts) { called++; return real.call(S, st, opts); };
  const r = S.restoreFromData({ subjects: [], vouchers: [] });
  S.restoreBookState = real;
  check(r.ok === true && called === 1, 'restoreFromData 行为上确实经过 restoreBookState',
    'called=' + called + ' ok=' + (r && r.ok));

  // 行为：旧备份缺字段 → 合并空状态补齐（不直接替换，否则页面渲染会崩）
  const minimal = { company: { name: '旧备份', startMonth: '2026-01' }, subjects: [], vouchers: [] };
  const beforeKeys = Object.keys(minimal).length;
  const ok = S.restoreBookState(minimal);
  check(ok === true, 'restoreBookState 对合法备份应返回 true');
  check(S.state && S.state.company && S.state.company.name === '旧备份', '恢复后数据已生效');
  check(Object.keys(S.state).length > beforeKeys,
    '缺字段的旧备份应被空状态**补齐**（合并而非直接替换）',
    beforeKeys + ' → ' + Object.keys(S.state).length);
  check(typeof S.state.schemaVersion === 'number', '恢复后 schemaVersion 应被归一为当前版本号');
  check(S.bookId === 'T_BOOK', '恢复到**当前**账套（bookId 不变）');
  S._glCache = { 'T_BOOK|2026-03': { stale: true } };
  S.restoreBookState(minimal);
  check(Object.keys(S._glCache).length === 0, '恢复后必须作废总账缓存（否则账簿/报表继续显示恢复前的数）');
  check(S.restoreBookState(null) === false && S.restoreFromData(null).ok === false,
    '非法备份应返回失败而不是抛异常');
})();

if (fail) {
  console.log('❌ 导入账套入口：' + fail + ' 项不符（通过 ' + pass + '）');
  fails.forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(1);
}
console.log('✅ 导入账套入口：' + pass + ' 项通过（导入只新增 + 覆盖只在一处 + 恢复只许一处实现）');
