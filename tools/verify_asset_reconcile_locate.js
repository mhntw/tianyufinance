#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_asset_reconcile_locate.js —— 固定资产「差额定位」验证
 *
 * 【为什么需要】原有的卡片↔总账核对只能报「某科目差 X 元」，用户还得自己翻凭证找是哪几笔
 *   才造成这个差额。2026-09-22 给它加了「差额定位」：把账上该科目的凭证分录与卡片做金额配对，
 *   列出「账上有、卡片中找不到对应」的分录 与 「卡片有、账上找不到对应」的卡片。
 *   绅蓝之星 2026-08 的活样本：账上 1601001 比卡片多 153,040.00 —— 定位到 4 笔
 *   「已记入 1601、却从未建卡」的购进（记-45 床垫 53,000 ／ 记-27 客房用品 51,144
 *   ／ 记-101 棉织品 96,000 ／ 记-127 退款 −2,000）共 198,144.00，以及卡片 0019
 *   「客房餐厅用品」45,104.00 在账上找不到等额分录（198,144 − 45,104 = 153,040）。
 *
 * 【本脚本测的是真代码，不是复刻】旧有 verify_asset_cross_report.js 的 D 组是**复刻**
 *   `_assetLedgerReconcile` 的口径 —— 复刻件与真实实现对不上时，测试照样是绿的。
 *   这里改为把 js/pages/asset/Asset.js 的**真实源码**加载进 Node（只改 import/export 语法），
 *   直接调用真实的 `_assetLedgerReconcile` / `renderAssetReconcile`。
 *
 * 【断言刻意做成"数据无关"】金额会随账务处理变化（用户修账、重新导入都会变），
 *   把 153,040 写死会让测试在正确修账之后反而失败。故主断言用两条**不变量**：
 *     ① 完备性：对每个有差异的科目，(无卡片分录合计 − 无账上卡片合计) + 差额 ≈ 0。
 *     ② 口径：无差异的科目不得产出定位列表；列出的分录必须确属该科目、且日期不晚于期间。
 *   ⚠ **完备性不变量单独拦不住「组合配对退化成 1:1」** —— 这一点是实测出来的，别删合成样本：
 *     把 `_FA_MAX_SUB` 那层循环降级成 n<=1 后，真实数据上两侧会**同时**多出等额残项
 *     （绅蓝之星：账上多出 596,074.00（13 笔）／卡片多出 443,034.00（4 张）），
 *     差值恰好与差额抵消 ⇒ 完备性照样通过，只有列表被严重污染、用户被误导。
 *     真正拦住它的是下面那个**合成样本**（391,050 = 336,150 + 54,900 的两笔构成一张卡），
 *     降级后立刻报「无卡片分录应恰为 1 笔，实际 3 笔」。故合成样本是必需的，不可删。
 *
 * 用法：node tools/verify_asset_reconcile_locate.js
 * ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

/* ---------- 装载真实模块（宽松 DOM mock；只改写 import/export 语法） ---------- */
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const CACHE = {};
function el(id) {
  return { _id: id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false,
    style: {}, className: '', title: '',
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, removeChild() {}, insertBefore() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, querySelector: () => el('q'), querySelectorAll: () => [],
    closest() { return null; }, focus() {}, click() {}, scrollIntoView() {} };
}
function getEl(id) { if (!CACHE[id]) CACHE[id] = el(id); return CACHE[id]; }
global.document = { getElementById: getEl, querySelector: () => el('q'), querySelectorAll: () => [],
  createElement: () => el('new'), addEventListener() {}, body: el('body'), documentElement: el('html') };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;
const U = global.U || {};
U.monthsBetween = U.monthsBetween || function (a, b) {
  const pa = String(a).split('-'), pb = String(b).split('-');
  return (pb[0] - pa[0]) * 12 + (pb[1] - pa[1]);
};
U.num = U.num || function (v) { const x = parseFloat(v); return isFinite(x) ? x : 0; };
global.U = U;
const MONEY = n => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
global.__TY_EXPORT__ = { store: S, util: U, ACCOUNT_CLASSES: global.ACCOUNT_CLASSES };
// 期间桩必须可变：renderAssetReconcile 走 _assetPeriod() → periodRangeValue()，返回空会提前 return（页面清空）
let CUR_M = '';
global.__TY_HELPERS__ = {
  $: getEl, money: MONEY, esc: s => String(s == null ? '' : s), showToast() {},
  currentPeriod: () => CUR_M, periodRangeValue: () => CUR_M, syncAll() {},
  S: S, U: U, num: NUM
};
global.__XP_IMPORTS__ = { bindSubjectPicker: () => ({ refresh() {} }) };
function stripEsm(src) {
  return src
    .replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"];?[ \t]*$/gm, function (_m, names) {
      return names.split(',').map(n => n.trim()).filter(Boolean)
        .map(n => 'var ' + n + ' = (globalThis.__XP_IMPORTS__ || {})[' + JSON.stringify(n) + '];').join('\n');
    })
    .replace(/^\s*export\s*\{[\s\S]*?\};?[ \t]*$/gm, '/* export removed */');
}
let src = stripEsm(fs.readFileSync(path.join(ROOT, 'js', 'pages', 'asset', 'Asset.js'), 'utf8'));
src += '\n;globalThis.__AR__ = { reconcile: _assetLedgerReconcile, render: renderAssetReconcile };';
(0, eval)(src);
const AR = globalThis.__AR__;
const r2 = v => Math.round(v * 100) / 100;

/* ============================================================
 * 一、合成样本：组合配对（一张卡吃多笔分录）与等额反向对冲
 * ============================================================ */
(function synthetic() {
  const SUBJ = [
    { code: '1002', name: '银行存款', normal: 'dr', cls: 'asset', level: 1 },
    { code: '1601', name: '固定资产', normal: 'dr', cls: 'asset', level: 1 },
    { code: '1601001', name: '家具设备', normal: 'dr', cls: 'asset', level: 2 },
    { code: '1602', name: '累计折旧', normal: 'cr', cls: 'asset', level: 1 }
  ];
  function vch(date, no, faAmt, sum) {   // 借 1601001 / 贷 1002，借贷平衡
    return { date: date, word: '记', no: no, deleted: '', summary: sum,
      entries: [{ code: '1601001', dr: faAmt, cr: 0, summary: sum },
                { code: '1002', dr: 0, cr: faAmt, summary: sum }] };
  }
  S.state = {
    schemaVersion: S.state && S.state.schemaVersion,
    company: { name: '合成样本', startMonth: '2024-01' },
    subjects: SUBJ, openingBalances: {}, param: {},
    // 336,150 ＋ 54,900 构成一张 391,050 的卡；另有 100,000 账上有、卡片没有
    vouchers: [
      vch('2024-02-10', 1, 336150, '购固定家具'),
      vch('2024-02-20', 2, 54900, '固定家具尾款'),
      vch('2024-03-05', 3, 100000, '已入账但未建卡的资产'),
      // 等额反向：同一金额记两次、其中一次被冲销（净影响 0）
      vch('2024-04-01', 4, 7777, '重复记账'),
      vch('2024-04-02', 5, -7777, '冲销重复记账')
    ],
    fixedAssets: [
      { code: '0001', name: '固定家具', original: 391050, accumDeprBegin: 0, accumDepr: 0,
        periodUsed: 0, life: 60, acqDate: '2024-02-10', status: '正常', faAcctId: '1601001' }
    ]
  };
  if (S.normalizeState) S.normalizeState();
  S._glCache = {}; S.bookId = '__SYN__';
  const rc = AR.reconcile('2024-06');
  const d = rc && rc.orig && rc.orig.detail[0];
  check(!!d, '合成：应有差异科目');
  if (!d) return;
  check(d.code === '1601001', '合成：差异应定位到 1601001', d && d.code);
  // 账上 1601001 = 336,150 ＋ 54,900 ＋ 100,000 ＋ 7,777 − 7,777 = 491,050；卡片 391,050
  check(Math.abs(d.diff - (391050 - 491050)) < 0.01, '合成：差额应为 391,050 − 491,050 = −100,000', d && String(d.diff));
  const un = d.unbacked || [];
  check(un.length === 1, '合成：无卡片分录应恰为 1 笔（组合配对不得把 336,150 / 54,900 误列）',
    '实际 ' + un.length + ' 笔：' + un.map(e => e.amt).join(', '));
  check(un.length === 1 && Math.abs(un[0].amt - 100000) < 0.01, '合成：该笔应为 100,000.00',
    un[0] ? String(un[0].amt) : '');
  check((d.cardOrphan || []).length === 0, '合成：不应有「卡片有、账上无」的卡片');
  check(d.cancelledPairs === 1, '合成：应识别出 1 组等额反向（重复记账后冲销）分录', String(d.cancelledPairs));
  check(Math.abs(r2(un.reduce((s, e) => s + e.amt, 0) - 0) + d.diff) < 0.01,
    '合成：完备性 —— (无卡片分录 − 无账上卡片) + 差额 ≈ 0');
})();

/* ============================================================
 * 二、真实账套：数据无关的不变量
 * ============================================================ */
function booksDir() {
  const h = os.homedir();
  return process.platform === 'darwin' ? path.join(h, 'Library', 'Application Support', '添钰财务', 'books')
    : process.platform === 'win32' ? path.join(h, 'AppData', 'Roaming', '添钰财务', 'books')
      : path.join(h, '.local', 'share', '添钰财务', 'books');
}
const dir = booksDir();
let books = [];
try {
  books = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.indexOf('.bak') < 0)
    .map(f => { const p = path.join(dir, f); let o = null; try { o = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { } return o ? { file: f, o: o } : null; })
    .filter(x => x && (x.o.fixedAssets || []).length > 0 && (x.o.vouchers || []).length > 0);
} catch (e) { }

if (!books.length) {
  console.log('跳过：本机没有「含卡片且有凭证」的账套（' + dir + '）');
  console.log(fail === 0 ? '✓ 合成样本 ' + pass + ' 项断言全部通过' : '★ 合成样本有 ' + fail + ' 项不符');
  process.exit(fail === 0 ? 0 : 1);
}

const notes = [];
books.forEach(function (bk) {
  S.state = JSON.parse(JSON.stringify(bk.o));
  if (S.normalizeState) S.normalizeState();
  S._glCache = {}; S.bookId = '__LOC__';
  const months = (S.allMonths ? S.allMonths() : []) || [];
  const use = months.length ? [months[months.length - 1]] : [];   // 末期（差额最完整）
  use.forEach(function (m) {
    const rc = AR.reconcile(m);
    if (!rc || !rc.orig) { check(false, bk.file + ' ' + m + ' 对账结果为空'); return; }
    const det = rc.orig.detail || [];
    det.forEach(function (d) {
      const un = d.unbacked || [], co = d.cardOrphan || [];
      const tag = bk.o.company.name + ' ' + m + ' ' + d.code;
      if (Math.abs(d.diff) <= 0.01) {
        // ② 无差异的科目不得产出定位列表（避免"定位"把无关项列出来吓人）
        check(un.length === 0 && co.length === 0, tag + ' 无差异时不应产出定位列表',
          '无卡片 ' + un.length + ' / 无账上 ' + co.length);
        return;
      }
      // ① 完备性：两侧相抵必须恰好解释差额
      const unSum = r2(un.reduce((s, e) => s + e.amt, 0));
      const coSum = r2(co.reduce((s, c) => s + c.amt, 0));
      check(Math.abs(unSum - coSum + d.diff) < 0.01, tag + ' 完备性：(无卡片 − 无账上) + 差额 ≈ 0',
        '无卡片 ' + unSum + ' / 无账上 ' + coSum + ' / 差额 ' + d.diff);
      // ② 口径：列出的分录必须确属该科目、日期不晚于期间；卡片原值必须为正
      un.forEach(function (e) {
        check(/^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) || String(e.date) === '',
          tag + ' 无卡片分录应有日期', String(e.date));
        check(String(e.date).slice(0, 7) <= m, tag + ' 无卡片分录日期不应晚于期间', String(e.date));
        check(!!e.vch, tag + ' 无卡片分录应带凭证字号');
      });
      co.forEach(function (c) {
        check(NUM(c.amt) > 0, tag + ' 无账上卡片的原值应为正', String(c.amt));
      });
      if (un.length || co.length) {
        notes.push(tag + '：账上多出 ' + MONEY(unSum) + '（' + un.length + ' 笔）／卡片多出 ' +
          MONEY(coSum) + '（' + co.length + ' 张）／差额 ' + MONEY(d.diff) +
          (d.cancelledPairs ? '／已对冲 ' + d.cancelledPairs + ' 组' : ''));
      }
    });
  });
  // 渲染路径也要能跑通（提示文本里必须写明是"按金额推断"）
  CUR_M = use[0] || '';
  AR.render();
  const html = getEl('assetReconcileCheck').innerHTML || '';
  const rc0 = AR.reconcile(use[0]);
  if (rc0 && rc0.orig && !rc0.orig.ok) {
    // 【2026-09-22】提示必须"摘要常驻 + 明细折叠"：该提示挂在卡片页表格**上方**，
    //   逐笔明细一铺开就有十几行，会把下面的卡片清单整个挤下去（实测反馈"太占空间"）。
    //   这四条一起守：有折叠入口、明细默认收起、逐笔凭证不得留在常驻摘要里、明细里保留口径声明。
    const folded = html.replace(/<div class="rc-detail" hidden>[\s\S]*<\/div>/, '');
    const who = bk.o.company.name;
    check(html.indexOf('rc-toggle') >= 0, who + ' 提示应有「查看差额明细」折叠入口');
    check(html.indexOf('rc-detail" hidden') >= 0, who + ' 明细应默认收起（rc-detail 带 hidden）');
    check(folded.indexOf('记-') < 0, who + ' 常驻摘要不得含逐笔凭证（凭证明细须全部在折叠区内）',
      '常驻摘要里出现了凭证字号');
    check(html.indexOf('按金额推断') >= 0, who + ' 明细里应写明「按金额推断」的局限（账卡无关联字段）');
    // 【2026-09-22 二次反馈"摘要两行还是太占空间"】常驻内容只许**恰好一行** ——
    //   提示挂在卡片清单上方，常驻每多一行就实打实少看一行卡片。
    //   判据：把折叠区整段移除后，剩下的 HTML 里只能有 1 个 .rc-line。
    const headLines = (folded.match(/class="rc-line"/g) || []).length;
    check(headLines === 1, who + ' 常驻摘要只应占一行（其余内容须全部收进折叠区）', '实测常驻 ' + headLines + ' 行');
    // 而且那一行必须写明「差多少」—— 只写"有差异"等于把结论也藏进折叠区了
    check(folded.indexOf(MONEY(Math.abs(rc0.orig.diff))) >= 0,
      who + ' 常驻那一行应写出原值差额 ' + MONEY(rc0.orig.diff), '常驻行里找不到该金额');
    // 【2026-09-22 实测缺陷，别删】折叠入口与明细必须**同属一个父元素**（点击时按父元素找 .rc-detail）。
    //   原实现把 parts 逐项各自包一层 .rc-line，入口与明细落进两个 .rc-line，点击找不到明细 → 没反应。
    //   旧断言只查了"存在 rc-toggle / rc-detail"，查不出层级关系，所以放过了这个 bug ——
    //   判据：从入口到明细之间不得出现 </div>（出现即说明中间闭合了一层父元素）。
    const iTog = html.indexOf('rc-toggle'), iDet = html.indexOf('rc-detail');
    check(iTog >= 0 && iDet > iTog, who + ' 折叠入口应排在明细之前');
    if (iTog >= 0 && iDet > iTog) {
      check(html.slice(iTog, iDet).indexOf('</div>') < 0,
        who + ' 折叠入口与明细必须同一父元素下的兄弟节点（否则点击找不到明细、点了没反应）');
    }
  }
});

/* ---------- 汇总 ---------- */
if (notes.length) {
  console.log('差额定位结果（信息性，不参与断言）：');
  notes.slice(0, 12).forEach(t => console.log('  · ' + t));
  console.log('');
}
if (fail === 0) {
  console.log('✓ ' + pass + ' 项断言全部通过 —— 差额定位完备、且组合配对生效');
  process.exit(0);
}
console.log('★ ' + fail + ' 项不符（通过 ' + pass + '）：');
fails.slice(0, 20).forEach(function (f) { console.log('  · ' + f); });
if (fails.length > 20) console.log('  ...（其余 ' + (fails.length - 20) + ' 项略）');
process.exit(1);
