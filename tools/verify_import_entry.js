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
 *      一类不一致，因为他不会去细读确认框）。于是 .json 从"覆盖当前账套"改为"作为新账套导入"。
 *      随后（同日、用户要求）连"从外部 .json 覆盖"这条补救入口也删掉了 ——
 *      **「查看备份 → 恢复」成为全应用唯一能覆盖当前账本的入口**。
 *
 * 【本脚本守的四条不变量（这是它存在的理由）】
 *   A. 判据永不产出"覆盖"动作 —— 否则 .json 又会悄悄换掉用户的账。
 *   B. 「覆盖当前账本」全应用只有一个入口文件（Tools.js）且只有一条路（列表里的「恢复」）；
 *      外部文件那条补救入口**不得复活**（它一旦回来，"导入"与"覆盖"又会纠缠）。
 *   C. 该唯一入口必须"先确认 → 再快照 → 最后覆盖" —— 顺序错了等于没拦（首版静态断言就栽在这上面）。
 *   D. 金蝶 .ais 导入**已冻结**：只修缺陷、不加功能（行数与第三方库哈希被锁，见【四】段）。
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
               + '\n;globalThis.__PLAN__ = importPlanOf; globalThis.__SAFEID__ = safeIdOf;';
  (0, eval)(src);
  const planOf = globalThis.__PLAN__;
  const safeIdOf = globalThis.__SAFEID__;
  check(typeof planOf === 'function', '应能加载 js/common/import-classify.js 的 importPlanOf');
  check(typeof safeIdOf === 'function', '应能加载 js/common/import-classify.js 的 safeIdOf');

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

  // 名称净化判据本身是纯函数，逐条断言（含路径分隔符与限长）
  check(/export\s+function\s+safeIdOf/.test(src0), 'js/common/import-classify.js 应导出 safeIdOf');
  check(safeIdOf('A/B公司') === 'A_B公司', 'safeIdOf 应把 / 换成 _（否则 id 会被当路径分隔符）',
    safeIdOf('A/B公司'));
  // 输入含两个非法字符（\ 与 :）→ 各换成一个 _，故结果为 C__账套_2026
  check(safeIdOf('C:\\账套:2026') === 'C__账套_2026', 'safeIdOf 应处理 \\ 与 :', safeIdOf('C:\\账套:2026'));
  check(!/[\\/:*?"<>|]/.test(safeIdOf('../x')),
    'safeIdOf 不得留下任何路径分隔符（../x 不能把落盘路径带出 books/ 之外）', safeIdOf('../x'));
  check(!/[\\/:*?"<>|]/.test(safeIdOf('绅蓝之星/客房部')), '（回归）当前账套名净化后仍是单个路径分量',
    safeIdOf('绅蓝之星/客房部'));
  check(safeIdOf('  账套  ') === '账套', 'safeIdOf 应去首尾空格（文件名带空格易出问题）');
  check(safeIdOf('长'.repeat(200)).length === 60, 'safeIdOf 应限长（过长会撑破文件名长度上限）');
  check(safeIdOf(null) === '' && safeIdOf(undefined) === '', 'safeIdOf 对空值返回空串（由调用方兜底默认名）');
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
  check(/S\.importExternalBook\(/.test(njBody),
    'importJsonAsNewBook 应走 S.importExternalBook（与 .ais 导入同一条建账套路径）');
  check(/safeIdOf\(/.test(njBody),
    'importJsonAsNewBook 的账套 id 必须经 safeIdOf 净化（id 会被 Rust 当文件名用，名字里的 / 会让落盘失败）');
  // 成败门控：写盘失败时不得报"导入成功"（否则与保存失败告警横幅自相矛盾）
  check(/\.then\(function \(saved\)/.test(njBody) && /if \(saved\)[^\n]*showToast\(/.test(njBody),
    'importJsonAsNewBook 的"导入成功"提示必须以落盘成功为条件（写盘失败不得谎报成功）');
  //  .ais 两条路径同样必须门控：它们也曾无条件 showToast("金蝶账套导入成功"/"多年合并导入成功")
  ['handleImportAis', 'handleMultiYearImport'].forEach(function (fn) {
    const iFn = settings.indexOf('function ' + fn + '(');
    const body = iFn < 0 ? '' : settings.slice(iFn, settings.indexOf('\n  }', iFn));
    check(iFn >= 0, 'Settings.js 应有 ' + fn + '（.ais 导入路径）');
    check(body.indexOf('safeIdOf(') >= 0, fn + ' 的账套 id 必须经 safeIdOf 净化（id 会被 Rust 当文件名用）');
    check(/S\.importExternalBook\(/.test(body), fn + ' 应走 S.importExternalBook（唯一建账套实现）');
    const iSaved = body.indexOf('if (saved)');
    check(iSaved >= 0 && /showToast\(tip/.test(body.slice(iSaved)),
      fn + ' 的"导入成功"提示（showToast(tip…) 必须在 if (saved) 之后（写盘失败不得谎报成功）');
  });

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

  /* 不变量 B（后半）：外部文件覆盖那条补救入口**不得复活**。
     它只存在过很短时间就被用户要求删除 —— 一旦回来，"导入"与"覆盖"又会在语义上纠缠。 */
  check(html.indexOf('id="restoreFromFileInput"') < 0,
    '不变量 B：index.html 不应再有"从文件恢复"的选择器（该入口已删除，不得复活）');
  check(!/\$\('restoreFromFileInput'\)/.test(tools) && !/id="btnRestoreFromFile"/.test(tools),
    '不变量 B：Tools.js 不应再引用或渲染"从文件恢复"入口');
  check(!/function\s+restoreFromFile\s*\(/.test(tools),
    '不变量 B：Tools.js 不应再有 restoreFromFile 函数（外部文件覆盖当前账套）');

  // 不变量 C：**唯一**覆盖入口的保护与顺序（「查看备份」列表里的「恢复」）
  const iFn = tools.indexOf('function restoreFromBackup(');
  const fnBody = iFn < 0 ? '' : tools.slice(iFn, iFn + 2200);
  check(iFn >= 0, 'Tools.js 应有 restoreFromBackup 函数（查看备份列表里的「恢复」）');
  check(/storageLoadBackup\(/.test(fnBody), '（判据自检）截取的函数体应完整到结尾', '长度 ' + fnBody.length);
  check(/confirmAsync/.test(fnBody) && /恢复当前账本/.test(fnBody),
    '不变量 C：该入口必须先明确告知"恢复当前账本"并取得确认');
  check(/guardBeforeRestore/.test(fnBody), '不变量 C：该入口应保留覆盖前留存档守卫');
  const iC = fnBody.indexOf('confirmAsync'), iG = fnBody.indexOf('guardBeforeRestore'), iR = fnBody.indexOf('restoreBookState(');
  check(iC >= 0 && iG > iC && iR > iG,
    '不变量 C：顺序必须是「先确认 → 再留快照 → 最后覆盖」（顺序错＝没拦；取消时也不该白留快照）',
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
  // 导入账套（.json / .ais 共用）的数据整理必须在 store 一处实现：
  // 原先它是 Settings.js 里的 loadServerBookIntoLocal，Node 测不到 —— 于是测试只能"手抄一份逻辑"假装覆盖。
  const ieb = storeSrc.slice(storeSrc.indexOf('importExternalBook: function'), storeSrc.indexOf('importExternalBook: function') + 2000);
  check(/importExternalBook: function/.test(storeSrc), 'store.js 应有 importExternalBook（导入账套的唯一建账套实现）');
  check(/normalizeState\(\)/.test(ieb), 'importExternalBook 应补 normalizeState（旧备份缺字段会让页面渲染崩）');
  check(/ensureVoucherIds\(\)/.test(ieb),
    'importExternalBook 应补 ensureVoucherIds（旧 .json 备份的凭证 id 可能缺失/不稳，会导致点凭证定位失效）');
  check(/ensureCashFlowFields\(\)/.test(ieb), 'importExternalBook 应补 ensureCashFlowFields（旧备份可能没有）');
  check(/_saveBookChecked\(/.test(ieb) && !/saveBook\([^)]*\)\.catch\(/.test(ieb),
    'importExternalBook 必须判落盘成败（_saveBookChecked），不得只挂 .catch 当成功');
  check(/ensureCashFlowFields\(\)/.test(rbs),
    'restoreBookState 应含 ensureCashFlowFields（原 restoreFromData 有、它缺 —— 合并时补上）');
  // 落盘必须走**唯一判定点** _saveBookChecked：直接调 Storage.saveBook(...).catch(...) 是死代码
  // （saveBook 内部已 catch、恒 resolved），写盘失败无人上报。
  // 用「到下一个方法为止」的窗口而非定长 slice：bodyOf 只取 900 字符，注释一多就会截断，
  // 而这里的落盘行在注释之后（曾被截断过一次，故改用自限窗口）。
  // ⚠ 查反模式前**必须先剥注释**：代码里（也应该）把反模式写进注释作说明，
//   否则卡口会被自己的说明文字命中 —— 这个坑 verify_import_failure.js 已经踩过一次。
  const stripC = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  const iRbs = storeSrc.indexOf('restoreBookState: function');
  const rbsWin = stripC(iRbs < 0 ? '' : storeSrc.slice(iRbs, storeSrc.indexOf('switchBook: function', iRbs)));
  check(/this\._saveBookChecked\(/.test(rbsWin), 'restoreBookState 应立即落盘且判成败（走 _saveBookChecked，不得只靠 persist）');
  check(!/Storage\.saveBook\([^)]*\)\s*\.catch\(/.test(rbsWin),
    'restoreBookState 不得再用 Storage.saveBook(...).catch(...) 这种死代码写法');
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

/* ---------- 四、冻结段：金蝶 .ais 导入**只修缺陷，不加功能** ----------
   为什么冻结：它是一次性迁移通道（一本账套导入一次），真正的成本是**逆向知识**
   （js/kis-import.js 约 22% 的说明是"从真实账套试出来的"），重建远贵于保留 ——
   故不删、不抽成独立程序，但也不再长大。
   ⚠ 把"冻结"写成注释是不够的（三个月后没人记得），故此处把它变成**会咬人的卡口**。
   合法地增行 / 升级第三方库：改下面的基线并**在本段写明理由**（别只改数字）。 */
(function () {
  const crypto = require('crypto');
  const KIS_LINES = 1067;                       // 2026-09-28 冻结时行数（含冻结说明自身）
  const VENDOR = {                              // 第三方库：内容哈希锁定（原地改必红）
    'js/mdb-reader.js': 'd2004378ef866d0c',
    'js/buffer.js': 'e7c24f84529843da'
  };
  const kis = fs.readFileSync(path.join(ROOT, 'js', 'kis-import.js'), 'utf8');
  const lines = kis.split('\n').length;
  check(lines <= KIS_LINES,
    '冻结模块 js/kis-import.js 行数只许减不许增（只修缺陷，不加功能）',
    '实测 ' + lines + ' 行 > 基线 ' + KIS_LINES + ' 行');
  check(kis.indexOf('已冻结') >= 0,
    'js/kis-import.js 头部必须保留"已冻结"声明（否则后人不知道这里的规矩）');
  Object.keys(VENDOR).forEach(function (f) {
    const p = path.join(ROOT, f);
    const h = fs.existsSync(p)
      ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : '(文件缺失)';
    check(h === VENDOR[f], '第三方库 ' + f + ' 不得原地修改（升级请同步基线并写明理由）',
      '实测 ' + h + ' ≠ 基线 ' + VENDOR[f]);
  });
  // 界面上"能选 .ais 的入口"也算功能面：入口膨胀正是本次三合一要治的病
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const aisInputs = (html.match(/<input[^>]*>/g) || []).filter(function (t) { return /accept="[^"]*\.ais/.test(t); });
  check(aisInputs.length === 1,
    '界面上接受 .ais 的文件选择器只应有 1 个（维持"一个按钮"的三合一成果）',
    '实测 ' + aisInputs.length + ' 个');
})();

if (fail) {
  console.log('❌ 导入账套入口：' + fail + ' 项不符（通过 ' + pass + '）');
  fails.forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(1);
}
console.log('✅ 导入账套入口：' + pass + ' 项通过（导入只新增 + 覆盖只在一处 + 恢复只许一处实现 + .ais 导入已冻结）');
