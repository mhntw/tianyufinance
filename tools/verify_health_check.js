#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_health_check.js —— 「风险检测」与其跨年分区的验证
 *
 * 【背景】2026-09-28 两件事：
 *   ① 把「查看校验报告」按钮删除，跨年**完整表**并入「风险检测」卡片（healthYearSec）；
 *      它只对多年合并账套有内容、且其价值已在合并导入成功那一刻自动交付 → 两个入口合一。
 *   ② 修掉一处**同一事实、两处阈值**的缺陷：资产负债表平衡判据
 *        runSelfTest（顶部横幅 / 结账清单）  原为硬编码 `>= 0.01`
 *        financialHealthCheck（风险检测）    原为硬编码 `>= 0.005`
 *      改成两处都用全局 EPS（半分）。这不是"看着不一致" —— 是**可复现的行为差异**：
 *      JS 里 `0.03 - 0.02 === 0.009999999999999998`，于是 `>= 0.01` 会把真实的 1 分不平判成"平"
 *      （本脚本 B 组用例就是这条修复的回归）。
 *
 * 【为什么这条要测】`financialHealthCheck` 此前**零测试覆盖**，而它产出的是
 *   "期末损益未结转""资产负债表不平衡"这类会直接影响用户判断的结论。
 *
 * 用法：node tools/verify_health_check.js
 * ============================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 装载真实 store ---------- */
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;

const SUBJ = [
  { code: '1001', name: '库存现金', normal: 'dr', cls: 'asset', level: 1 },
  { code: '2202', name: '应付账款', normal: 'cr', cls: 'liability', level: 1 },
  { code: '3001', name: '实收资本', normal: 'cr', cls: 'equity', level: 1 }
];
function mkState(vouchers, extra) {
  S.state = Object.assign({
    schemaVersion: S.state && S.state.schemaVersion,
    company: { name: '体检样本', startMonth: '2026-01' },
    subjects: SUBJ, openingBalances: {}, param: {}, closedPeriods: [], fixedAssets: [],
    vouchers: vouchers || []
  }, extra || {});
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  S.bookId = 'HEALTH_SAMPLE';
}
// 借 1001 / 贷 3001；dr 与 cr 不等即"不平"（刻意用于造 1 分不平）
function vch(no, dr, cr) {
  return { id: 'V' + no, word: '记', no: no, date: '2026-02-10', deleted: '', summary: '样本',
    entries: [{ code: '1001', dr: dr, cr: 0, summary: '样本' }, { code: '3001', dr: 0, cr: cr, summary: '样本' }] };
}
/* 检测参数与「风险检测」按钮**保持一致**（Settings.js 只传 keySubject）——
   若这里自己造一套参数，测试就测不到用户真实看到的那份结果。
   （首版这里传了 largeVoucher: 50000，结果掩盖了一个真问题：UI 也一直传着它，
     导致 store 侧"按本账套分布自适应取 TOP30"的设计逻辑在生产里从不执行。） */
const OH = { keySubject: 100000 };
const typesOf = r => (r && r.checks ? r.checks : []).map(c => c.type);
const bsItemsOf = r => (r && r.items ? r.items : []).filter(x => /资产负债表/.test(x.label || ''));

/* ---------- A. 平衡账套：不得误报 ---------- */
(function balanced() {
  mkState([vch(1, 100, 100)]);
  const h = S.financialHealthCheck(OH);
  const t = typesOf(h);
  check(t.indexOf('bs_unbalanced') < 0, 'A1 平衡账套：风险检测不应报「资产负债表不平衡」', t.join(',') || '(无)');
  check(t.indexOf('direction_anomaly') < 0, 'A2 平衡账套：不应报「科目方向异常」', t.join(',') || '(无)');
  check(t.indexOf('unclosed_pl') < 0, 'A3 平衡账套：不应报「期末损益未结转」', t.join(',') || '(无)');
  const st = S.runSelfTest('2026-02');
  check(bsItemsOf(st).length === 0, 'A4 平衡账套：运行期自检（顶部横幅/结账清单）不应报资产负债表问题',
    JSON.stringify(bsItemsOf(st)));
})();

/* ---------- B. 差 1 分：两处必须给**同一结论**（本次容差统一的回归） ---------- */
(function oneCent() {
  /* 刻意取这组值：JS 里 0.03 - 0.02 === 0.009999999999999998（小于 0.01）。
     所以旧的 `>= 0.01` 会漏判这条真实不平 —— 而它正是本脚本要锁住的差异。 */
  mkState([vch(2, 0.03, 0.02)]);
  const bs = S.balanceSheet('2026-02');
  const raw = bs.totalAsset - bs.totalAll;
  check(Math.abs(raw) > 0 && Math.abs(raw) < 0.01,
    'B0（样本自检）合计差额应为「1 分」且浮点值略小于 0.01 —— 否则本用例失去意义',
    raw.toPrecision(20));

  const h = S.financialHealthCheck(OH);
  check(typesOf(h).indexOf('bs_unbalanced') >= 0,
    'B1 差 1 分：风险检测应报「资产负债表不平衡」', typesOf(h).join(',') || '(无)');

  const st = S.runSelfTest('2026-02');
  check(bsItemsOf(st).length > 0,
    'B2 差 1 分：运行期自检（顶部横幅 / 结账清单）**也必须**报 —— 与 B1 同一事实同一结论',
    JSON.stringify(st.items || []));
})();

/* ---------- C. 跨年分区（原「查看校验报告」的内容） ---------- */
(function yearJump() {
  const yb = [{ fromYear: 2024, toYear: 2025, checked: 2, total: 2, allDiffs: [
    { code: '1001', name: '库存现金', prevEnd: 100000, curOpen: 250000, diff: 150000 },
    { code: '3001', name: '实收资本', prevEnd: 1000, curOpen: 1500, diff: 500 }
  ] }];
  mkState([vch(3, 100, 100)], { meta: { yearBoundaries: yb } });
  const h = S.financialHealthCheck(OH);
  const yj = (h.checks || []).filter(c => c.type === 'year_jump')[0];
  check(!!yj, 'C1 账套带跨年差异时应产出 year_jump 检查项', typesOf(h).join(',') || '(无)');
  if (yj) {
    const codes = (yj.items || []).map(i => i.code);
    check(codes.length === 1 && codes[0] === '1001',
      'C2 只有 ≥ 阈值（¥100,000）的那条跨年差异应命中', JSON.stringify(codes));
  }
  // 阈值口径必须真的生效（否则"过滤"形同虚设）
  const h2 = S.financialHealthCheck({ largeVoucher: 50000, keySubject: 200000 });
  check(!typesOf(h2).indexOf || typesOf(h2).indexOf('year_jump') < 0,
    'C3 阈值提到 ¥200,000 后，¥150,000 的差异不应再命中', typesOf(h2).join(',') || '(无)');
  // 无跨年数据的普通账套：不得产出该项
  mkState([vch(4, 100, 100)]);
  check(typesOf(S.financialHealthCheck(OH)).indexOf('year_jump') < 0,
    'C4 普通（非多年合并）账套不得产出 year_jump 检查项');
})();

/* ---------- E. 「必然命中」的条目不得计入风险点 ---------- */
(function noAlarmFatigue() {
  mkState([vch(5, 100, 100), vch(6, 200, 200)]);
  const h = S.financialHealthCheck(OH);
  const lv = (h.checks || []).filter(c => c.type === 'large_voucher')[0];
  check(!!lv, 'E1 有凭证时就应产出「金额最大的 N 笔凭证」（它是参考清单）', typesOf(h).join(',') || '(无)');
  check(lv && lv.severity === 'info',
    'E2 该条等级应为 info —— 它必然命中，且 desc 自陈"大额不等于异常"', lv ? lv.severity : '-');
  check(h.summary.total === h.summary.high + h.summary.medium,
    'E3 summary.total 必须只统计 high + medium（不得把参考项算成风险点）', JSON.stringify(h.summary));
  check(h.summary.total === 0,
    'E4 正常账套应显示「风险点 0」—— 此前会因参考清单而永远至少显示 1 个风险点',
    JSON.stringify(h.summary));
  check(h.summary.info >= 1, 'E5 参考项数量应单独统计（不与风险点混在一起）', JSON.stringify(h.summary));
})();

/* ---------- D. 结构卡口 ---------- */
(function structure() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'js/pages/settings/Settings.js'), 'utf8');
  const store = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');

  check(html.indexOf('btnViewYearBoundary') < 0,
    'D1 index.html 不应再有「查看校验报告」按钮（已并入风险检测）');
  check(!/getElementById\(\s*['"]btnViewYearBoundary['"]\s*\)/.test(settings),
    'D2 Settings.js 不应再绑定「查看校验报告」按钮');
  check(html.indexOf('id="healthYearSec"') >= 0 && html.indexOf('id="healthYearTable"') >= 0,
    'D3 风险检测卡片里应有跨年分区容器（healthYearSec / healthYearTable）');
  const calls = (settings.match(/_renderYearBoundaryToCard\(/g) || []).length;
  check(calls >= 3,
    'D4 跨年表渲染应是**唯一实现**并被两处复用（定义 1 次 + 调用 2 次：独立卡片与体检分区）',
    '实测出现 ' + calls + ' 次');
  check(/healthYearTable/.test(settings), 'D5 Settings.js 应把跨年表渲染进体检卡片的 healthYearTable');
  // 跨年分区必须**无条件**设置显隐（否则切换账套会残留上一本的跨年表）
  check(/ysec\.style\.display\s*=\s*'none'/.test(settings) && /ysec\.style\.display\s*=\s*''/.test(settings),
    'D6 跨年分区在无数据时必须**显式隐藏**、有数据时才显示（防止切账套后残留上一本的跨年表）');

  // 容差单点：两处 BS 判据都不得硬编码小数字
  const hard = store.match(/totalAll\)\s*>=\s*0\.0\d+/g) || [];
  check(hard.length === 0,
    'D7 资产负债表平衡判据不得硬编码 0.01/0.005（必须用全局 EPS，否则两处会再次分叉）', hard.join(' | '));
  // 逐函数取体（按下一个方法定义切段），确认两处都走 EPS
  function methodBody(name) {
    const i = store.indexOf('    ' + name + ': function');
    if (i < 0) return '';
    const j = store.search(new RegExp('\\n    [a-zA-Z_$][\\w$]*: function'));
    return store.slice(i, j > i ? j : store.length);
  }
  const rsBody = methodBody('runSelfTest'), fhBody = methodBody('financialHealthCheck');
  check(/totalAsset - bs\.totalAll\)\s*>=\s*EPS/.test(rsBody),
    'D8a runSelfTest 的 BS 判据应使用 EPS（顶部横幅 / 结账清单那一份）',
    (rsBody.match(/totalAll\)\s*>=[^)]*/) || ['未找到'])[0]);
  // UI 必须走 store 的设计口径（自适应 TOP-N），不得再传固定 largeVoucher 把它顶掉
  const fhCall = (settings.match(/financialHealthCheck\(\{[^}]*\}\)/) || [''])[0];
  check(fhCall.indexOf('largeVoucher') < 0,
    'D10 「风险检测」按钮不得传 largeVoucher（否则 store 侧"按账套分布自适应取 TOP30"的设计逻辑永不执行）', fhCall);
  check(/keySubject/.test(fhCall), 'D11 该按钮应传 keySubject（跨年/关键科目阈值口径）', fhCall);
  check(store.indexOf('total: checks.length') < 0,
    'D9 summary.total 不得再直接取 checks.length（那是"分类数"，会把参考项也算成风险点）');
  check(/Math\.abs\(diff\)\s*>=\s*EPS/.test(fhBody),
    'D8b financialHealthCheck 的 BS 判据应使用 EPS（风险检测那一份）',
    (fhBody.match(/>= ?[0-9.]+|>= EPS/g) || ['未找到']).join(' '));
})();

if (fail) {
  console.log('❌ 风险检测：' + fail + ' 项不符（通过 ' + pass + '）');
  fails.forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(1);
}
console.log('✅ 风险检测：' + pass + ' 项通过（跨年分区并入体检 + BS 容差单点 + 不误报）');
