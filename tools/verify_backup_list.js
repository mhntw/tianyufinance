#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_backup_list.js —— 「查看备份」列表分类显示的验证
 *
 * 【背景】backups/ 里混着两种意义完全不同的产物：
 *     · 自动存档    <bookId>_<ts>.json            （最近 10 份环）
 *     · 覆盖前存档  <bookId>_pre_restore_<ts>.json （导入/恢复之前自动留，最近 3 份环）
 *   而恢复前的确认框、恢复后的提示都明确写着「如需撤销，可恢复『覆盖前存档』」——
 *   可列表此前一律显示「备份 · 时间」，用户**认不出是哪一条**：
 *   系统让用户去做一件事，界面却不让他做到（"说了却做不到"）。
 *   2026-09-28 补上分类显示（判据抽成纯函数 js/common/backup-classify.js）。
 *
 * 【本脚本守的三条】
 *   A. 分类规则必须与 Rust 的 backup_kind_of 同一条（尤其"先判 pre 再判 auto"的顺序）；
 *   B. 措辞闭环：提示里说「覆盖前存档」，列表里就必须能看出哪条是「覆盖前存档」；
 *   C. 折叠显示规则：**覆盖前存档始终可见**（否则它被藏起来，提示照样落空）。
 *
 * 用法：node tools/verify_backup_list.js
 * ============================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 一、判据表（加载真实纯函数） ---------- */
(function classify() {
  let src = fs.readFileSync(path.join(ROOT, 'js', 'common', 'backup-classify.js'), 'utf8');
  src = src.replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1')
           + '\n;globalThis.__BK__ = { backupKindOf: backupKindOf, backupLabelOf: backupLabelOf, pickVisibleBackups: pickVisibleBackups };';
  (0, eval)(src);
  const { backupKindOf: kindOf, backupLabelOf: labelOf, pickVisibleBackups: pick } = globalThis.__BK__;
  check(typeof kindOf === 'function' && typeof labelOf === 'function' && typeof pick === 'function',
    '应能加载 js/common/backup-classify.js 的三个纯函数');

  // A. 分类规则（顺序与 Rust 的 backup_kind_of 一致；判定**不依赖 bookId** —— 列表已按本账套过滤）
  check(kindOf('default_1724.json') === 'auto', 'A1 普通备份名 → 自动存档');
  check(kindOf('default_pre_restore_1724.json') === 'pre',
    'A2 <bookId>_pre_restore_<ts>.json → 覆盖前存档（必须先判 pre，因为 pre 名也以 <bookId>_ 开头）');
  check(kindOf('绅蓝之星_合并_20260922_1790070928732_pre_restore_1790080000000.json') === 'pre',
    'A3 带中文/下划线的账套名 + pre_restore → 仍判为覆盖前存档');
  check(kindOf('default_1724.txt') === null, 'A4 非 .json → null');
  check(kindOf(null) === null && kindOf(undefined) === null, 'A5 空文件名 → null，不抛异常');
  check(kindOf('default_1724.json') === 'auto',
    'A6 判据不依赖 bookId（浏览器/开发态 bookId 为空时也必须能分类；实测踩过这条）');
  // 反过来：不该把普通备份误判成覆盖前存档
  check(kindOf('pre_restore_账套_1724.json') === 'auto',
    'A7 名字里含 pre_restore 但不符合 <...>_pre_restore_<ts>.json 结尾 → 仍算自动存档');

  // B. 措辞闭环
  const preLabel = labelOf('pre', '09-28 14:00');
  const autoLabel = labelOf('auto', '09-28 14:00');
  check(preLabel.indexOf('覆盖前存档') >= 0, 'B1 覆盖前存档的文案必须含「覆盖前存档」四字', preLabel);
  check(autoLabel.indexOf('自动存档') >= 0, 'B2 自动存档的文案必须含「自动存档」', autoLabel);
  check(preLabel !== autoLabel, 'B3 两类文案必须可区分（此前一律「备份 · 时间」）');
  check(labelOf('pre') === '覆盖前存档 · ', 'B4 缺时间文案时不应出现 undefined', String(labelOf('pre')));

  // C. 折叠显示规则
  const list = [
    { kind: 'auto', label: 'A-new' },
    { kind: 'pre', label: 'P1' },
    { kind: 'auto', label: 'A-old' },
    { kind: 'auto', label: 'A-oldest' }
  ];
  const folded = pick(list, false).map(x => x.label);
  check(folded.length === 2 && folded[0] === 'A-new' && folded[1] === 'P1',
    'C1 折叠时 = 最新一份 + 全部「覆盖前存档」', JSON.stringify(folded));
  check(pick(list, true).length === 4, 'C2 展开时显示全部');
  check(pick([], false).length === 0, 'C3 空列表不抛异常');
  check(pick(null, false).length === 0, 'C4 null 输入不抛异常');
  // 真正的不变量是"覆盖前存档永不被折叠掉"，而不是"一定显示几条"——
  // 当最新那份本身就是覆盖前存档时，显示它一条即可（那也是此刻最该看的一条）。
  const preIsNewest = pick([{ kind: 'pre', label: 'P' }, { kind: 'auto', label: 'A' }], false).map(x => x.label);
  check(preIsNewest.indexOf('P') >= 0,
    'C5 覆盖前存档永不被折叠掉（含"它自己就是最新那份"的情形）', JSON.stringify(preIsNewest));
  const manyPre = pick([
    { kind: 'auto', label: 'A1' }, { kind: 'auto', label: 'A2' },
    { kind: 'pre', label: 'P1' }, { kind: 'pre', label: 'P2' }, { kind: 'auto', label: 'A3' }
  ], false).map(x => x.label);
  check(manyPre.indexOf('P1') >= 0 && manyPre.indexOf('P2') >= 0 && manyPre.indexOf('A1') >= 0,
    'C6 多份覆盖前存档也全部可见，同时保留最新一份', JSON.stringify(manyPre));
})();

/* ---------- 二、接线与闭环卡口（Tools.js 真的接上了） ---------- */
(function wiring() {
  const tools = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Tools.js'), 'utf8');
  check(/from '\.\.\/\.\.\/common\/backup-classify\.js/.test(tools),
    'Tools.js 应 import 分类判据模块（不得内联一套规则）');
  check(/backupKindOf\(/.test(tools) && /backupLabelOf\(/.test(tools),
    'Tools.js 应在构造列表项时使用 backupKindOf / backupLabelOf');
  check(/pickVisibleBackups\(/.test(tools), 'Tools.js 应在渲染时使用 pickVisibleBackups');
  check(tools.indexOf("label: '备份 · '") < 0,
    'B（闭环）：不得再出现不分类的旧文案 label: 备份 · 时间');

  // 提示里说了「覆盖前存档」→ 列表文案里就必须能看出哪条是它（同一个词）
  const mentionTip = /可恢复「覆盖前存档」|恢复覆盖前存档/.test(tools);
  check(mentionTip, 'B（闭环）：恢复相关提示应提到「覆盖前存档」（这是它存在的理由）');
  check(tools.indexOf('覆盖前存档') >= 0, 'B（闭环）：列表区文案里应出现「覆盖前存档」');
  check(/b\.kind === 'pre'/.test(tools), 'B（闭环）：渲染时应按 kind 突出「覆盖前存档」那一行');

  // 折叠计数不得写死（覆盖前存档始终显示，隐藏数 = 总数 - 实际显示数）
  check(!/disk\.length - 1/.test(tools),
    'C：折叠提示的「还有 N 份」不得写死 disk.length - 1（覆盖前存档始终显示，会算错）');
  check(/disk\.length - show\.length/.test(tools), 'C：折叠提示应按实际被折叠的条数计算');
})();

/* ---------- 三、文案与实际行为一致（同一类"说了做不到"） ---------- */
(function wordingAccuracy() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Tools.js'), 'utf8');

  // 「导出账套」是唯一能离开本机的副本，但点它只写到本机导出目录 —— 必须说清"再拷到 U 盘"
  const btn = (html.match(/<button[^>]*id="btnBkAll"[^>]*>/) || [''])[0];
  check(/title="/.test(btn), 'D 导出账套按钮应有 title 说明用途', btn.slice(0, 60));
  check(/U 盘|网盘/.test(btn) && /离开本机/.test(btn),
    'D 该 title 应说明「唯一能离开本机」并提示拷到 U 盘 / 网盘', btn.slice(0, 80));
  // ⚠ 只扫**用户可见的那几行**（health-warn 文案）—— 整文件搜会把"记录旧文案"的注释也算命中
  const warnLines = tools.match(/health-warn[^\n]*/g) || [];
  check(warnLines.length > 0, 'D 应能定位到备份健康度提示文案（判据自检）', '找到 ' + warnLines.length + ' 行');
  check(!warnLines.some(function (l) { return l.indexOf('点「导出账套」存一份到') >= 0; }),
    'D 健康提示不得写「点「导出账套」存一份到 U 盘」—— 它只写到本机导出目录，不会进 U 盘',
    warnLines.join(' | ').slice(0, 100));
  check(warnLines.some(function (l) { return /再把它拷到 U 盘或网盘|再拷到 U 盘/.test(l); }),
    'D 健康提示应把「生成副本 → 再拷到 U 盘 / 网盘」两步都写出来',
    warnLines.join(' | ').slice(0, 100));
  // 用户可见文案里不得混入 markdown 星号（会被原样显示）
  check(!warnLines.some(function (l) { return l.indexOf('**') >= 0; }),
    'D 用户可见文案里不得出现 markdown 星号（会原样显示成 **…**）',
    warnLines.join(' | ').slice(0, 100));
})();

if (fail) {
  console.log('❌ 备份列表：' + fail + ' 项不符（通过 ' + pass + '）');
  fails.forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(1);
}
console.log('✅ 备份列表：' + pass + ' 项通过（分类判据同 Rust + 措辞闭环 + 覆盖前存档始终可见）');
