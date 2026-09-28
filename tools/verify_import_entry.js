#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_import_entry.js —— 「导入账套」三合一入口验证
 *
 * 【背景】原先设置页「账套管理」有**三个并列入口**（导入账套 / 多年合并导入 / 导入备份），
 *   用户反馈"重复、太复杂"。逐条比对后，三者**唯一的行为差异只有三条**：
 *     ① 1 个 .json → 覆盖恢复当前账套 ； ② 1 个 .ais → 新建账套 ； ③ ≥2 个 .ais → 合并新建
 *   故 2026-09-28 合并为唯一入口 #btnBookImport，判据抽成纯函数
 *   （js/common/import-classify.js），底部实现复用原有三个函数，一行未改。
 *
 * 【为什么这条要测】三合一的风险不在"合并"，而在**把破坏性语义藏进通用按钮**：
 *   .json 分支会**覆盖当前账套**。若判据写错（例如把 .json 判成"新建"、或把混选当单选处理），
 *   用户会以为什么都没发生，实际却换掉了账本。故本脚本分三层验证：
 *     一、判据表（纯函数，逐条枚举 + 边界）
 *     二、接线卡口（旧按钮/旧 input 必须真的消失，否则是"删了 UI 留了死绑"）
 *     三、"恢复只许一处实现"（restoreFromData 必须委托 restoreBookState —— 此前两条实现有实差）
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
  let src = fs.readFileSync(path.join(ROOT, 'js', 'common', 'import-classify.js'), 'utf8');
  src = src.replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1')
           + '\n;globalThis.__PLAN__ = importPlanOf;';
  (0, eval)(src);
  const planOf = globalThis.__PLAN__;
  check(typeof planOf === 'function', '应能加载 js/common/import-classify.js 的 importPlanOf');

  const F = names => names.map(n => ({ name: n }));
  const act = names => planOf(F(names)).action;

  // 三条真实语义
  check(act(['backup.json']) === 'overwrite', '1 个 .json → 覆盖当前账套（原「导入备份」）');
  check(act(['2026年.ais']) === 'new', '1 个 .ais → 新建账套（原「导入账套」）');
  check(act(['2024年.ais', '2025年.ais']) === 'merge', '2 个 .ais → 合并新建（原「多年合并导入」）');
  check(act(['2024年.ais', '2025年.ais', '2026年.ais']) === 'merge', '3 个 .ais → 合并新建');
  check(act(['2024年.ais', '2025年.ais', '2026年.ais', '2027年.ais']) === 'merge',
    '4 个 .ais → 合并新建（多年份不设上限）');

  // 边界：不猜、明确报错
  check(act(['a.json', 'b.ais']) === 'error', '备份与金蝶账套混选 → 报错（不猜）');
  check(act(['a.json', 'b.json']) === 'error', '多个 .json → 报错（备份无法合并）');
  check(act(['note.txt']) === 'error', '选入非 .ais/.json → 报错');
  check(act(['2026年.ais', 'note.txt']) === 'error', '合法文件里混入其它类型 → 报错');
  check(act([]) === 'error', '未选文件 → 报错（不误当 merge）');
  check(planOf(null).action === 'error', 'null 输入不应抛异常（返回 error）');

  // 大小写与中文名
  check(act(['备份.JSON']) === 'overwrite', '扩展名大小写不敏感（.JSON）');
  check(act(['2026年.AIS']) === 'new', '扩展名大小写不敏感（.AIS）');
  check(act(['绅蓝之星_2026年.ais']) === 'new', '中文名 + 下划线文件名照常识别');
  // 报错时必须带可读原因（否则用户只看到"失败"）
  const e1 = planOf(F(['a.json', 'b.ais']));
  check(!!e1.msg && e1.msg.length > 6, '报错应带可读原因（msg）', e1.msg || '（无）');
  // overwrite 是破坏性动作：返回的 files 必须只含那一个 .json，调用方据此提示覆盖哪一本
  const ow = planOf(F(['my.json']));
  check(ow.files.length === 1 && /\.json$/i.test(ow.files[0].name), 'overwrite 应只返回该 .json 文件');
})();

/* ---------- 二、接线卡口：旧入口真的消失、新入口真的接上 ---------- */
(function wiring() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Settings.js'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Tools.js'), 'utf8');

  // 旧元素：按 element id 查（注释里提到旧名字是允许的，故只查 id="..." 形态）
  ['btnBmImport', 'btnMultiYearImport', 'btnImportBackup', 'aisFile', 'bkFile', 'multiAisFile']
    .forEach(function (id) {
      check(html.indexOf('id="' + id + '"') < 0,
        'index.html 不应再有旧元素 id="' + id + '"（三合一后应已删除）');
    });
  check(html.indexOf('id="btnBookImport"') >= 0, 'index.html 应有唯一入口按钮 id="btnBookImport"');
  check(html.indexOf('id="bookImportFile"') >= 0, 'index.html 应有统一文件选择器 id="bookImportFile"');
  const btnCount = (html.match(/id="btnBookImport"/g) || []).length;
  check(btnCount === 1, '导入入口只应有一个按钮（实测 ' + btnCount + '）');

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
  ['overwrite', 'new', 'merge'].forEach(function (a) {
    check(new RegExp("action\\s*===\\s*'" + a + "'").test(settings),
      'Settings.js 应显式分派 action === ' + a);
  });
  // 三条分流必须调用原有实现（合并不等于重写）
  check(/importJsonBackup\(/.test(settings), 'overwrite 分支应走 importJsonBackup');
  check(/handleImportAis\(/.test(settings), 'new 分支应走原有 handleImportAis');
  check(/handleMultiYearImport\(/.test(settings), 'merge 分支应走原有 handleMultiYearImport');
  /* 覆盖是**破坏性**动作：必须"先说后果、再动手"。
     ⚠ 判据必须**限定在 importJsonBackup 函数体内**并检查先后顺序 —— 首版只查"整个文件里有没有
       confirmAsync / 覆盖当前账套 字样"，而 Settings.js 别处还有其它确认框，于是变异测试里
       "把覆盖确认整段删掉"照样全绿（本脚本的断言自己形同虚设）。已按此收紧。 */
  const iFn = settings.indexOf('function importJsonBackup(');
  const fnBody = iFn < 0 ? '' : settings.slice(iFn, iFn + 2200);
  check(iFn >= 0, 'Settings.js 应有 importJsonBackup（overwrite 分支的实现）');
  check(/reader\.readAsText/.test(fnBody), '（判据自检）截取的函数体应完整到结尾', '长度 ' + fnBody.length);
  check(/confirmAsync/.test(fnBody) && /覆盖当前账套/.test(fnBody),
    'importJsonBackup 内必须明确告知"将覆盖当前账套"并取得确认（破坏性语义不得藏在通用按钮里）');
  const iConfirm = fnBody.indexOf('confirmAsync'), iRestore = fnBody.indexOf('restoreBookState(');
  check(iConfirm >= 0 && iRestore > iConfirm, '必须先确认、后覆盖（顺序反了等于没拦）',
    'confirmAt=' + iConfirm + ' restoreAt=' + iRestore);
  check(/__guardBeforeRestore/.test(fnBody),
    'importJsonBackup 内应保留「覆盖前留存档」守卫（快照失败要二次确认）');
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
    if (i < 0) return '';
    // 截到下一个同缩进的 `//` 段或方法定义（够用即可，仅做静态判据）
    return storeSrc.slice(i, i + 900);
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
  // 缓存必须作废（否则恢复后查同月命中旧缓存 → 显示旧数）
  S._glCache = { 'T_BOOK|2026-03': { stale: true } };
  S.restoreBookState(minimal);
  check(Object.keys(S._glCache).length === 0, '恢复后必须作废总账缓存（否则账簿/报表继续显示恢复前的数）');
  // 非法数据不得抛异常
  check(S.restoreBookState(null) === false && S.restoreFromData(null).ok === false,
    '非法备份应返回失败而不是抛异常');
})();

if (fail) {
  console.log('❌ 导入账套三合一：' + fail + ' 项不符（通过 ' + pass + '）');
  fails.forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(1);
}
console.log('✅ 导入账套三合一：' + pass + ' 项通过（判据三条分流 + 旧入口已清除 + 恢复只许一处实现）');
