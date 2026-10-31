#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/test_xss_payload.js —— 对抗性注入测试（用运行结果证明"渲染成文本"）
 *
 * 【为什么需要】
 *   本项目的 XSS 是靠静态扫描 + 人工复核解决的（check_html_escape / audit_escape_gaps）。
 *   静态扫描只能证明"代码看起来转了义"，证明不了"恶意数据进来后确实不执行"。
 *   2026-10-22 的复盘发现：漏掉的两处（期初余额 data-code、费用明细科目树模板串）
 *   都是静态工具判不了的写法 —— 只有把 payload 真的喂进渲染函数才能兜住。
 *
 * 【做法】自造一本"恶意账套"（不读任何真实账套），把 payload 放进
 *   科目名 / 凭证摘要 / 凭证字 / 固定资产名 / 公司名 等所有用户可编辑字段，
 *   然后**真实加载**页面模块（只改 import 语法），驱动真实的渲染函数，
 *   捕获所有 innerHTML 赋值，断言：
 *     ① 输出里不含可执行标签/事件属性（<script、<img、onerror=、onmouseover= 等）；
 *     ② 输出里**确实**出现了转义后的 payload（&lt;script&gt; 等）——
 *        证明 payload 真的走到了渲染里，而不是因为没渲染而"假绿"。
 *
 * 用法：node tools/test_xss_payload.js
 * 退出码：0 = 全部通过；1 = 存在可执行 payload 逃逸
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 极简 DOM mock：所有 innerHTML 赋值都进 CAPTURED ---------- */
const CAPTURED = [];
function el(id) {
  const o = {
    _id: id, _html: '', textContent: '', value: '', checked: false, hidden: false,
    style: {}, className: '', title: '', dataset: {},
    classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
    appendChild() { }, removeChild() { }, insertBefore() { }, setAttribute() { }, removeAttribute() { },
    getAttribute() { return null; }, addEventListener() { }, removeEventListener() { },
    // 页面代码常对 querySelector 结果继续操作（.closest/.classList），返回元素比返回 null 更接近真机
    querySelector() { return el('__q__'); }, querySelectorAll() { return []; },
    parentNode: { classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } }, style: {}, className: '' },
    closest() { return null; }, focus() { }, blur() { }, click() { }, scrollIntoView() { }
  };
  Object.defineProperty(o, 'innerHTML', {
    get() { return o._html; },
    set(v) { o._html = String(v == null ? '' : v); if (o._html) CAPTURED.push({ id: id, html: o._html }); },
    configurable: true
  });
  return o;
}
const CACHE = {};
function getEl(id) { if (!CACHE[id]) CACHE[id] = el(id); return CACHE[id]; }
global.document = {
  getElementById: getEl, createElement: () => el('__new__'),
  querySelector: (sel) => getEl('sel:' + sel), querySelectorAll: () => [],
  addEventListener() { }, removeEventListener() { },
  body: el('body'), head: el('head'), documentElement: el('html'),
  createTextNode: (t) => ({ textContent: t })
};
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;
const U = global.util || {};
S.persist = function () { };
S.addLog = function () { };
globalThis.__TY_EXPORT__ = { store: S, util: U, ACCOUNT_CLASSES: global.ACCOUNT_CLASSES };

/* ---------- helpers 引导（真实现，不写桩转义） ---------- */
const escReal = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.__TY_HELPERS__ = {
  $: getEl, money: U.money, esc: escReal, num: U.num, round2: U.round2, amt: U.amt, yuan: U.yuan,
  currentPeriod: () => '2024-06', lastClosedPeriod: () => '2024-06',
  periodRangeValue: () => '2024-06', periodRangeValues: () => ({ start: '2024-06', end: '2024-06' }),
  formatPeriod: m => String(m == null ? '' : m), todayStr: () => '2024-06-15', nowTimeStr: () => '00:00:00',
  syncAll() { }, openModal() { }, closeModal() { }, showToast() { }, refreshAll() { },
  bookScopeChanged: () => false, bookKey: () => 'XSS', S: S, U: U, monthList: U.monthList,
  exportTable() { }
};
// 页面有的地方直接裸调全局 openModal/closeModal（app.js 提供），测试壳需补齐，否则渲染在最后一步抛错
globalThis.openModal = function () { };
globalThis.closeModal = function () { };
globalThis.__XP_IMPORTS__ = Object.assign({}, globalThis.__TY_HELPERS__, {
  // 组件 / 兄弟模块只用签名，本测试不驱动它们
  bindSubjectPicker: () => ({ refresh() { } }),
  createSubjectTree: () => ({ refresh() { }, setCurrent() { } }),
  updatePeriodRangeTrigger() { },
  matchSubjectCode: (codes) => (codes && codes.length ? (c => codes.indexOf(String(c)) >= 0) : () => true),
  subjectFullName: c => String(c == null ? '' : c),
  subjectLevel: () => 1,
  subjectFilter: fn => (S.subjects() || []).filter(fn),
  prevYearMonth: m => m, monthList: () => [], monthLabel: m => String(m == null ? '' : m),
  absFmt: v => String(v == null ? '' : v),
  goPage() { },
  exportTable() { },
  importPlanOf: () => ({ kind: 'book' }),
  importErrText: e => String(e == null ? '' : e),
  safeIdOf: s => String(s == null ? '' : s),
  computeAmtCells: () => ({ cells: [] }),
  ACCOUNT_CLASSES: global.ACCOUNT_CLASSES
});
require('./harness_boot.js').installBootImports(globalThis, path.join(__dirname, '..'));

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
function loadPage(rel, hookSrc) {
  const src = stripEsm(fs.readFileSync(path.join(ROOT, rel), 'utf8')) + '\n;' + hookSrc;
  (0, eval)(src);
  return globalThis.__PAGE_HOOK__;
}

/* html`` 用**真实源码**（只改 import 语法）装进 __XP_IMPORTS__：
   测试里再抄一份转义实现就等于自己验自己，跑绿了也证明不了页面真的安全。 */
(function () {
  const src = stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'common', 'html.js'), 'utf8'));
  (0, eval)(src + '\n;globalThis.__XP_IMPORTS__.html = html; globalThis.__XP_IMPORTS__.raw = raw;');
})();

/* 分页器（common/pager.js）同样用真实源码 —— 页面模块 import 它，测试里不能缺，
   也不该在测试里另写一份页码逻辑（那是自己验自己）。 */
(function () {
  const src = stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'common', 'pager.js'), 'utf8'));
  (0, eval)(src + '\n;globalThis.__XP_IMPORTS__.renderPager = renderPager;');
})();

/* ---------- 恶意 payload：每种都试两种形态 ---------- */
const P_TAG = '<script>window.__XSS__=1</script>';
const P_IMG = '<img src=x onerror="window.__XSS__=1">';
const P_ATTR = 'x" onmouseover="window.__XSS__=1';

function installEvilBook() {
  S.state = {
    schemaVersion: S.SCHEMA_VERSION,
    company: { name: P_IMG + '恶意公司', startMonth: '2024-01', code: 'XSS' },
    subjects: [
      { code: '1001', name: P_IMG, normal: 'dr', cls: 'asset', level: 1 },
      { code: '6602', name: P_TAG, normal: 'dr', cls: 'expense', level: 1 }
    ],
    openingBalances: {}, param: { voucherWord: P_ATTR }, closedPeriods: [], fixedAssets: [],
    voucherWords: [{ name: P_IMG, title: P_TAG, enabled: true }],
    vouchers: [{
      id: 'v1', word: P_ATTR, no: 1, date: '2024-02-10', attach: 0, summary: P_TAG,
      entries: [{ code: '1001', summary: P_IMG, dr: U.amt(100), cr: 0, cashActivity: '' },
                { code: '6602', summary: P_TAG, dr: 0, cr: U.amt(100), cashActivity: '' }],
      attachments: []
    }]
  };
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  S.bookId = '__XSS__';
}

/* ---------- 断言 ---------- */
/* 判据用**原始 payload 字符串**是否原样出现在输出里 ——
   不能只搜 `onerror=`：转义后的文本里这个字样仍然在（`&quot; onerror=&quot;`），会误报。
   原样出现 = 一个字符都没被转义 = 浏览器会当成标签/属性执行。 */
const FORBIDDEN = [
  { raw: P_TAG, label: 'script 标签原样输出' },
  { raw: P_IMG, label: 'img onerror 原样输出' },
  { raw: P_ATTR, label: '属性闭合 payload 原样输出' }
];
function assertNoPayload(scope) {
  const bad = [];
  CAPTURED.forEach(c => {
    FORBIDDEN.forEach(f => {
      if (c.html.indexOf(f.raw) >= 0) bad.push(scope + ' 在 ' + c.id + '：' + f.label);
    });
  });
  check(bad.length === 0, scope + '：渲染输出不含原样 payload', bad.slice(0, 3).join('；'));
}
function sawEscapedPayload(scope) {
  const hit = CAPTURED.some(c => /&lt;(script|img)/i.test(c.html));
  check(hit, scope + '：payload 确实进入渲染且被转义（&lt;script / &lt;img）',
    '未发现任何转义后的 payload —— 可能是没渲染，属于假绿');
}

/* ============================================================
 * A. 凭证查询列表（摘要 / 凭证字号 / 制单人 / 科目名）
 * ============================================================ */
const V = loadPage('js/pages/voucher/Voucher.js',
  'globalThis.__PAGE_HOOK__ = { renderQuery: renderQuery, refreshVoucher: refreshVoucher, amtInnerHtml: amtInnerHtml };');

installEvilBook();
CAPTURED.length = 0;
try { V.renderQuery('2024-01', '2024-12'); } catch (e) { check(false, 'Voucher.renderQuery 可执行', String(e && e.message || e)); }
assertNoPayload('凭证查询');
sawEscapedPayload('凭证查询');

/* 录入页分录行（摘要 / 科目编码属性位） */
CAPTURED.length = 0;
try { V.refreshVoucher(); } catch (e) { check(false, 'Voucher.refreshVoucher 可执行', String((e && e.stack) || e)); }
assertNoPayload('凭证录入');
sawEscapedPayload('凭证录入');

/* 金额位格「装不进 11 格」的溢出分支：computeAmtCells 在 parseFloat 失败时会把**原始串**带进 text，
   页面若直接拼进 innerHTML 就是一条注入路径（导入账套/手输金额都能到达）。 */
const amtHtml = (function () { try { return V.amtInnerHtml(P_IMG, true, -1, true, true); } catch (e) { return ''; } })();
check(amtHtml && amtHtml.indexOf(P_IMG) < 0, '金额位格溢出：payload 未原样输出', String(amtHtml).slice(0, 120));
check(/&lt;img/i.test(amtHtml), '金额位格溢出：payload 被转义成文本', String(amtHtml).slice(0, 120));

/* 位格分支（未溢出的短串）：computeAmtCells 会按字符塞进位格，这里同样不能原样输出。
   '</div><b>' 共 9 字符 < 11，走位格而不是溢出分支 —— 是 raw(amtCellHtml) 的安全前提。 */
const cellHtml = (function () { try { return V.amtInnerHtml('</div><b>', false, -1, true, true); } catch (e) { return ''; } })();
check(cellHtml && cellHtml.indexOf('</div><b>') < 0, '金额位格：短串里的标签未原样输出', String(cellHtml).slice(0, 160));
check(/&lt;/.test(cellHtml) && /&gt;/.test(cellHtml), '金额位格：位格内字符被转义', String(cellHtml).slice(0, 160));

/* ============================================================
 * B. 设置页凭证字 / 科目表
 * ============================================================ */
const Settings = loadPage('js/pages/settings/Settings.js',
  'globalThis.__PAGE_HOOK__ = { refreshVoucherWord: refreshVoucherWord, refreshCashflowInit: refreshCashflowInit };');

installEvilBook();
CAPTURED.length = 0;
try { Settings.refreshVoucherWord(); } catch (e) { check(false, 'Settings.refreshVoucherWord 可执行', String(e && e.message || e)); }
assertNoPayload('设置-凭证字');
sawEscapedPayload('设置-凭证字');

/* ============================================================
 * C. 固定资产列表（卡片名 / 编码 / 历史记录）
 * ============================================================ */
const Asset = loadPage('js/pages/asset/Asset.js',
  'globalThis.__PAGE_HOOK__ = { refreshAssets: refreshAssets, refreshDad: refreshDad, allHistory: showAllFaHistory };');

installEvilBook();
S.state.fixedAssets = [{
  id: 'FA1', code: P_ATTR, name: P_IMG, cls: '01', dept: P_TAG, status: '在用',
  orig: U.amt(1000), salvageRate: 5, life: 60, startMonth: '2024-01', method: '平均年限法',
  acqDate: '2024-01-15', original: U.amt(1000), accumDepr: 0, accumDeprBegin: 0, salvage: 0, impairment: 0,
  // 类别现在是卡片自有文本字段（2026-10-27 起无档案），同样必须转义
  category: P_TAG,
  history: [{ time: '2024-02-01 10:00:00', op: P_TAG, who: P_IMG, fields: { name: [P_IMG, P_TAG], memo: P_TAG } }]
}];
CAPTURED.length = 0;
try { Asset.refreshAssets(); } catch (e) { check(false, 'Asset.refreshAssets 可执行', String((e && e.stack) || e)); }
assertNoPayload('固定资产清单');
sawEscapedPayload('固定资产清单');

/* 折旧明细表（逐资产行 + 组末小计） */
CAPTURED.length = 0;
try { Asset.refreshDad('2024-06'); } catch (e) { check(false, 'Asset.refreshDad 可执行', String((e && e.stack) || e)); }
assertNoPayload('折旧明细表');
sawEscapedPayload('折旧明细表');

/* （「资产类别档案表」用例已移除：类别档案 2026-10-27 下线，类别现在是卡片自有字段，
   其转义由上方「固定资产清单」用例的 category 覆盖） */

/* 变动历史（时间线 + 字段前后值表） */
CAPTURED.length = 0;
try { Asset.allHistory(); } catch (e) { check(false, 'Asset.showAllFaHistory 可执行', String((e && e.stack) || e)); }
assertNoPayload('固定资产变动历史');
sawEscapedPayload('固定资产变动历史');

/* ============================================================
 * D. 费用明细科目树（模板串 + 属性插值，2026-10-22 实测漏检点）
 * ============================================================ */
const ED = loadPage('js/pages/report/ExpenseDetail.js',
  'globalThis.__PAGE_HOOK__ = { renderExpenseDetail: renderExpenseDetail, edPopRenderTree: edPopRenderTree };');
installEvilBook();
/* 费用明细按期间控件取值（空值会直接早退，什么也不渲染 → 变成"假绿"） */
getEl('edPeriodStart').value = '2024-01';
getEl('edPeriodEnd').value = '2024-06';
/* 「显示零余额」默认未勾选时会走 edFilterZeroRoots 把无发生额的科目整棵剪掉，
   恶意科目（无凭证金额）就会一个都不渲染 —— 同样是假绿。勾上才能让科目树真实输出。 */
getEl('edOptZero').checked = true;
CAPTURED.length = 0;
try { ED.renderExpenseDetail(); } catch (e) { check(false, 'ExpenseDetail.renderExpenseDetail 可执行', String((e && e.stack) || e)); }
assertNoPayload('费用明细');
sawEscapedPayload('费用明细');

/* 展开子级：walk 的递归结果必须是 RawHtml，否则子节点会被当成文本再转义一次
   （表现为子级 checkbox 消失、变成一行字面 <div...>，冒烟测试不易发现）。 */
const popMock = getEl('edPopMock');
CAPTURED.length = 0;
// 测试壳里的 subjectFullName 桩只回编码，payload 进不了标签；这里换成真实语义（编码 + 名称）
const prevSfn = globalThis.subjectFullName;
globalThis.subjectFullName = (code, name) => String(code) + ' ' + String(name == null ? '' : name);
try {
  ED.edPopRenderTree(popMock, [{ code: '6602', name: P_TAG, children: [{ code: '660201', name: P_IMG, children: [] }] }], new Set(['6602']));
} catch (e) { check(false, 'edPopRenderTree 可执行', String((e && e.stack) || e)); }
globalThis.subjectFullName = prevSfn;
const treeHtml = popMock.innerHTML;
check((treeHtml.match(/class="ed-subj-node"/g) || []).length === 2,
  '费用明细树：父/子两级都渲染为真实节点', '子级被二次转义成文本：' + treeHtml.slice(0, 200));
check(treeHtml.indexOf('&lt;div class=&quot;ed-subj-node') < 0,
  '费用明细树：子级未以字面标签输出', treeHtml.slice(0, 200));
assertNoPayload('费用明细树');
sawEscapedPayload('费用明细树');

/* ============================================================
 * E. 科目余额表（科目名 / 穿透链接属性 / 折叠箭头）
 * ============================================================ */
const TB = loadPage('js/pages/ledger/TrialBalance.js',
  'globalThis.__PAGE_HOOK__ = { renderTrialBalance: renderTrialBalance };');
installEvilBook();
getEl('tbExpandAll').checked = true;      // 展开全部级次，确保子科目也进入渲染
CAPTURED.length = 0;
try { TB.renderTrialBalance(); } catch (e) { check(false, 'TrialBalance.renderTrialBalance 可执行', String((e && e.stack) || e)); }
assertNoPayload('科目余额表');
sawEscapedPayload('科目余额表');

/* ============================================================
 * F. 科目档案（科目编码/名称/折叠箭头）
 * ============================================================ */
const SUBJ = loadPage('js/pages/subject/Subject.js',
  'globalThis.__PAGE_HOOK__ = { refreshSubjects: refreshSubjects };');
installEvilBook();
getEl('subjSearch').value = '';          // 空搜索：全量渲染（有搜索词会按关键字剪枝，可能变成假绿）
CAPTURED.length = 0;
try { SUBJ.refreshSubjects(); } catch (e) { check(false, 'Subject.refreshSubjects 可执行', String((e && e.stack) || e)); }
assertNoPayload('科目档案');
sawEscapedPayload('科目档案');

/* ============================================================
 * G. 部门档案（部门编码 / 部门名称）
 *    工资模块 2026-10-27 整体下线，工资表/工资凭证模板两段随之删除；
 *    部门档案已迁到 js/pages/settings/Dept.js。
 * ============================================================ */
const DEPT = loadPage('js/pages/settings/Dept.js',
  'globalThis.__PAGE_HOOK__ = { refreshDeptCard: refreshDeptCard };');
installEvilBook();
S.state.depts = [{ code: P_ATTR, name: P_IMG, type: P_TAG, parent: '', enabled: true }];
CAPTURED.length = 0;
try { DEPT.refreshDeptCard(); } catch (e) { check(false, 'Dept.refreshDeptCard 可执行', String((e && e.stack) || e)); }
assertNoPayload('部门档案');
sawEscapedPayload('部门档案');

/* ============================================================
 * H. 期初余额（科目编码/名称 + 平衡提示）
 * ============================================================ */
const OP = loadPage('js/pages/settings/Opening.js',
  'globalThis.__PAGE_HOOK__ = { refreshOpening: refreshOpening };');
installEvilBook();
CAPTURED.length = 0;
try { OP.refreshOpening(); } catch (e) { check(false, 'Opening.refreshOpening 可执行', String((e && e.stack) || e)); }
assertNoPayload('科目期初余额');
sawEscapedPayload('科目期初余额');

/* ============================================================
 * I. 总账（科目名 / 摘要 / 期初余额行）
 * ============================================================ */
const GL = loadPage('js/pages/ledger/Ledger.js',
  'globalThis.__PAGE_HOOK__ = { renderGl: renderGl };');
installEvilBook();
CAPTURED.length = 0;
try { GL.renderGl('2024-06'); } catch (e) { check(false, 'Ledger.renderGl 可执行', String((e && e.stack) || e)); }
assertNoPayload('总账');
sawEscapedPayload('总账');

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('XSS 对抗性注入测试（捕获 ' + CAPTURED.length + ' 段渲染输出）');
console.log('─'.repeat(60));
if (fail) {
  fails.forEach(f => console.log('  ✗ ' + f));
  console.log('\n✗ 失败 ' + fail + ' / 通过 ' + pass);
  process.exit(1);
}
console.log('✓ 通过：' + pass + ' 项断言全部通过（0 处 payload 逃逸）');
process.exit(0);
