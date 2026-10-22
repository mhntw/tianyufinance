#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_settings_render.js —— 设置页两张卡片的渲染等价 + 转义守卫
 *
 * 【为什么要有】Settings.js 已迁移到 html``（跨年校验表 / 风险检测卡片），这两张表的
 *   行是**整行一次成型**，结构（rowspan、grp-row、标签）与转义同时被改写 —— 光靠数据层
 *   的 verify_health_check 看不出「标签被当成文本转义了」这类错误。这里直接调渲染函数，
 *   对真实输出字符串断言。
 * 断言三类：
 *   ① 结构：rowspan / grp-row / 链接 data-code 属性正确；
 *   ② 标签：等级标签必须是真 <span>，不能变成 &lt;span（html`` 误转义 RawHtml 的典型症状）；
 *   ③ 转义：恶意 payload 不得原样出现，且必须出现 &lt;img 这种转义形态（防"没渲染"假绿）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail !== undefined ? '  → ' + String(detail).slice(0, 160) : ''));
}

/* ---------- 极简 DOM ---------- */
const els = {};
function el(id) {
  if (!els[id]) {
    const o = {
      id, _html: '', textContent: '', value: '', checked: false, style: {}, className: '', files: null,
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v == null ? '' : v); },
      querySelector() { return el('__q__'); }, querySelectorAll() { return []; },
      addEventListener() { }, appendChild() { },
      parentNode: { classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } }, style: {}, className: '' },
      classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
      setAttribute() { }, getAttribute() { return null; }
    };
    els[id] = o;
  }
  return els[id];
}
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = {
  getElementById: el, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el('__new__'), addEventListener() { }
};
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;
S.persist = function () { };
S.addLog = function () { };

require('./harness_boot.js').installBootImports(global, ROOT);

function stripEsm(src) {
  return src
    .replace(/\bimport\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*['"];?/g, function (_m, names) {
      return names.split(',').map(n => n.trim()).filter(Boolean)
        .map(n => 'var ' + n + ' = (globalThis.__XP_IMPORTS__ || {})[' + JSON.stringify(n) + '];').join('\n');
    })
    .replace(/\bimport\s+[^;]*?from\s*['"][^'"]*['"];?/g, '/* import removed */')
    .replace(/\bexport\s*\{[\s\S]*?\};?/g, '/* export removed */')
    .replace(/^\s*export\s+(function|const|let|var)\b/gm, '$1');
}

const src = stripEsm(fs.readFileSync(path.join(ROOT, 'js/pages/settings/Settings.js'), 'utf8')) +
  '\n;globalThis.__PAGE_HOOK__ = { y: _renderYearBoundaryToCard, h: _renderHealthCheckToCard };';
try { (0, eval)(src); } catch (e) { check(false, 'Settings.js 可加载', (e && e.stack) || e); }
const SE = globalThis.__PAGE_HOOK__;
if (!SE) { console.log('✗ Settings.js 未暴露渲染钩子'); process.exit(1); }

const P_TAG = '<script>window.__XSS__=1</script>';
const P_IMG = '<img src=x onerror="window.__XSS__=1">';
function assertEscaped(html, label) {
  check(html.indexOf(P_TAG) < 0 && html.indexOf(P_IMG) < 0, label + '：payload 未原样出现');
  check(/&lt;(script|img)/i.test(html), label + '：payload 以转义形态出现（防未渲染假绿）', html.slice(0, 120));
}

/* ---------- ① 跨年校验表 ---------- */
const yEl = el('yearBoundaryTableInPage');
SE.y([
  { fromYear: 2024, toYear: 2025, total: 12 },                                   // 无差异行
  {
    fromYear: 2025, toYear: 2026, checked: 2, total: 12,
    allDiffs: [
      // diff 是定点整数（×10000）：2e9 = ¥200000，超过 ¥100000 阈值才会生成穿透链接
      { code: '1001', name: P_IMG, prevEnd: 1000000, curOpen: 800000, diff: 2000000000 },
      { code: '1002', name: '银行存款', prevEnd: 500, curOpen: 500, diff: 0 }
    ]
  }
], yEl);
const yh = yEl.innerHTML;
check(/<tr class="ok-row"><td>2024→2025<\/td>/.test(yh), '无差异行结构', yh.slice(0, 80));
check(yh.indexOf('校验通过：12 个科目期初与上年期末一致（0 差异）✓') >= 0, '无差异行文案与科目数');
check(/<tr class="grp-row"><td rowspan="2" class="grp-label">2025→2026/.test(yh), '有差异行：grp-row + rowspan=2', yh.slice(0, 200));
check((yh.match(/<td class="mono">/g) || []).length >= 2, '每个差异科目各占一行');
check(/data-code="1001"/.test(yh), '超阈值科目编码生成穿透链接');
check(/title="差异超 ¥100000，点此查该科目账"/.test(yh), '穿透链接阈值文案', yh.slice(0, 300));
check(yh.indexOf('class="mono ta-r ty-red"') >= 0, '超 1 万差异标红列');
assertEscaped(yh, '跨年校验表');

/* ---------- ② 风险检测卡片 ---------- */
const smEl = el('healthSummary'), tEl = el('healthCheckTable');
SE.h({
  // period 正常是系统期间串；这里塞 payload 只为验证摘要区插值确实走转义（否则全是数字，测不出东西）
  period: P_TAG,
  summary: { total: 2, high: 1, medium: 1, info: 1 },
  checks: [
    {
      type: 'direction_anomaly', severity: 'high', title: P_TAG,
      items: [{ code: '1122', name: P_IMG, balance: -12340000, dir: '贷', issue: P_TAG }]
    },
    {
      type: 'large_voucher', severity: 'medium', title: '金额最大',
      items: [{ id: 'v"1', date: '2026-01-31', word: '记', no: 8, amount: 5000000, summary: P_IMG, issue: '' }]
    }
  ]
}, smEl, tEl);
const sh = smEl.innerHTML, th = tEl.innerHTML;
check(/<span class="hs-period">检测期间：/.test(sh), '摘要区：期间标签');
check(sh.indexOf('风险点：<b>2</b>') >= 0 && sh.indexOf('高危：<b>1</b>') >= 0, '摘要区：计数');
check(/<span>参考：<b>1<\/b><\/span>/.test(sh), '摘要区：参考项存在时显示');
assertEscaped(sh, '风险检测摘要');

check(/<span class="tag tag-stop">高危<\/span>/.test(th), '等级标签是真 <span>（未被二次转义）', th.slice(0, 200));
check(th.indexOf('&lt;span class=&quot;tag') < 0, '等级标签没有变成实体文本');
check(/<tr class="grp-row"><td rowspan="1" class="grp-label">/.test(th), '分组行结构');
check(/data-code="1122"/.test(th), '方向异常项：科目穿透链接');
check(/data-vid="v&quot;1"/.test(th), '大额凭证项：凭证号属性中的引号被转义', th.slice(0, 300));
check(th.indexOf('余额 ¥-1,234.00') >= 0 || th.indexOf('余额 ¥-1234.00') >= 0, '金额用 yuanFmt 显示');
assertEscaped(th, '风险检测卡片');

/* ---------- 汇总 ---------- */
console.log('设置页渲染守卫：' + pass + ' / ' + (pass + fail) + ' 通过');
if (fail) {
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ 跨年校验表 / 风险检测卡片：结构、标签与转义均符合预期');
