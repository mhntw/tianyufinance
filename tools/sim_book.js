#!/usr/bin/env node
/* ============================================================
 * tools/sim_book.js —— 在【真实账套副本】上模拟记账，验证记账链路
 *
 * 【为什么要有它】
 *   现有账套是从外部导入的，只能验证「复算」能否还原别人算好的结果，
 *   验证不了「记账」本身（录凭证 → 账簿 → 期末结转 → 结账 → 报表）对不对。
 *   本脚本在真实账套（科目、期初、历史凭证都在，最贴近真实）的**内存副本**上
 *   继续记账，用**人工手算的期望值**逐项比对。
 *
 * 【安全保证】
 *   · 真实账套文件只读一次（readFileSync），此后全程操作内存副本；
 *   · persist / saveBook / addLog / backupNow 全部 mock 为空，物理上不可能落盘；
 *   · 结束时比对源文件 MD5，证明未被改动。
 *
 * 【期望值来源（关键）】
 *   每笔金额都是**人工设计**的整千整万/刻意的小数数，并**手工推算**出应有的
 *   科目变动、利润与资产/负债增量，写死在断言里。软件必须逐项等于手算值。
 *   这样期望值完全独立于软件实现 —— 不是「软件算完说软件对了」。
 *
 * 用法：
 *   node tools/sim_book.js                  # 从账套最新期间的下月起，跑内置 PLAN
 *   node tools/sim_book.js <路径> <起始月>   # 指定账套与起始月
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ---------- 浏览器环境 mock（store.js 依赖） ---------- */
const _ls = {};
global.window = global;
global.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; }
};
global.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
  addEventListener() {}
};
// Node 21+ 内置了只读的 navigator，直接赋值会抛 TypeError，故忽略失败
try { global.navigator = { userAgent: 'node' }; } catch (e) { /* 已有只读内置 */ }
global.fetch = () => Promise.reject(new Error('no network'));
if (typeof global.isTauri === 'undefined') global.isTauri = false;

/* ---------- 时间 mock（关键）----------
   addVoucher 会拒绝「晚于当前月」的凭证（防误录未来日期，设计正确）。
   但模拟跨月记账时，若「当前时间」仍是 2026-09，则 10/11/12 月全部被拒，实测报错：
     「凭证日期（2026-10）不能晚于当前月份（2026-09）」
   故把「当前时间」推到模拟期末之后，使各模拟月都成为合法的「过去月/当月」。 */
const RealDate = Date;
const FAKE_NOW = new RealDate(2030, 11, 31, 12, 0, 0);   // 2030-12-31
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FAKE_NOW.getTime()); else super(...a); }
  static now() { return FAKE_NOW.getTime(); }
}
global.Date = FakeDate;

/* ---------- 定位真实账套（只读） ---------- */
function booksDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '添钰财务', 'books');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), '添钰财务', 'books');
}
// 返回最新账套路径；找不到返回 null，由调用方决定「跳过」。
// 【为什么返回 null 而不是 exit(1)】本脚本要进 run-all.js 回归与 CI
// （ubuntu-latest 上没有账套），若直接 exit(1) 会把「环境缺样本」误报成
// 「测试失败」，让 CI 永久变红、进而使人对红色告警脱敏 —— 得不偿失。
function newestBook() {
  const dir = booksDir();
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.includes('.bak'))
    .map(f => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].p : null;
}

const BOOK_FILE = process.argv[2] && fs.existsSync(process.argv[2]) ? process.argv[2] : newestBook();
if (!BOOK_FILE) {
  console.log('跳过：未找到账套（' + booksDir() + '）');
  console.log('本脚本在【真实账套副本】上模拟记账，需要至少一个账套作为样本。');
  console.log('无账套的环境（如 CI）自动跳过，返回 0，不计为失败。');
  process.exit(0);
}
const RAW = fs.readFileSync(BOOK_FILE, 'utf8');
const MD5_BEFORE = crypto.createHash('md5').update(RAW).digest('hex');

/* ---------- 加载 store.js 并封死写盘 ---------- */
require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;
S.persist = function () { };
S.save = function () { return Promise.resolve(); };
S.addLog = function () { };
S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) {
  global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); };
  global.Storage.saveBackup = function () { return Promise.resolve({ ok: true }); };
}

/* ---------- 载入副本 ---------- */
S.state = JSON.parse(RAW);              // ← 内存副本，与源文件彻底分离
S.bookId = '__SIM_NEVER_SAVE__';
S._glCache = {};
if (S.normalizeState) S.normalizeState();
if (S.ensureCashFlowFields) S.ensureCashFlowFields();

/* ---------- 断言工具 ---------- */
const r2 = n => Math.round(Number(n) * 100) / 100;
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    \x1b[32mPASS\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); console.log('    \x1b[31mFAIL\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
}
function eqAmt(name, actual, expect) {
  const a = r2(actual), e = r2(expect), d = r2(a - e);
  ok(name, Math.abs(d) < 0.005, '实际 ' + a.toFixed(2) + ' / 手算 ' + e.toFixed(2) + (Math.abs(d) < 0.005 ? '' : '  差 ' + d.toFixed(2)));
}
function section(t) { console.log('\n' + t); }

/* ---------- 账套现状 ---------- */
const bookName = (S.state.company && S.state.company.name) || path.basename(BOOK_FILE);
const allV = S.state.vouchers || [];
const actV = allV.filter(v => v.deleted !== 'y');
const months = [...new Set(actV.map(v => String(v.date || '').slice(0, 7)).filter(Boolean))].sort();
const lastMonth = months[months.length - 1] || '2026-08';

console.log('═══════════════════════════════════════════════════════════');
console.log(' 模拟记账验证 —— 在真实账套副本上操作（源文件不会被修改）');
console.log('═══════════════════════════════════════════════════════════');
console.log('  账套      ' + bookName);
console.log('  凭证      ' + actV.length + ' 张（另有软删 ' + (allV.length - actV.length) + ' 张）');
console.log('  科目      ' + (S.state.subjects || []).length + ' 个');
console.log('  期间      ' + months[0] + ' ~ ' + lastMonth + '    已结账 ' + JSON.stringify(S.state.closedPeriods || []));
console.log('  源文件 MD5(前) ' + MD5_BEFORE);

function nextMonth(m) { const [y, mm] = m.split('-').map(Number); return mm === 12 ? (y + 1) + '-01' : y + '-' + String(mm + 1).padStart(2, '0'); }
function prevMonth(m) { const [y, mm] = m.split('-').map(Number); return mm === 1 ? (y - 1) + '-12' : y + '-' + String(mm - 1).padStart(2, '0'); }
const START = process.argv[3] && /^\d{4}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : nextMonth(lastMonth);

/* ============================================================
 * 逐月业务方案（金额与期望值均为人工设计/手算）
 *   expect.delta = 各科目本期净变动（借正贷负）
 *   expect.profit = 当月利润 = 收入 − 成本 − 费用
 * ============================================================ */
const m0 = START;
const m1 = nextMonth(m0), m2 = nextMonth(m1), m3 = nextMonth(m2);

const PLAN = [
  {
    month: m0, title: '常规业务（基础）',
    vouchers: [
      [3, '客房收入存现', [['1002', 80000, 0], ['5001', 0, 80000]]],
      [5, '房租收入', [['1002', 50000, 0], ['5001', 0, 50000]]],
      [8, '采购布草入库', [['1405', 40000, 0], ['2202', 0, 40000]]],
      [10, '结转客房成本', [['5401', 30000, 0], ['1405', 0, 30000]]],
      [12, '办公费用', [['5602', 8000, 0], ['1002', 0, 8000]]],
      [15, '计提本月工资', [['5602', 25000, 0], ['2211', 0, 25000]]],
      [15, '发放本月工资', [['2211', 25000, 0], ['1002', 0, 25000]]],
      [20, '银行手续费', [['5603', 200, 0], ['1002', 0, 200]]],
      [28, '计提本月折旧', [['5602', 5000, 0], ['1602', 0, 5000]]]
    ],
    expect: {
      rev: 130000, cost: 30000, exp: 38200, profit: 61800,
      delta: {
        '1002': 80000 + 50000 - 8000 - 25000 - 200,
        '1405': 40000 - 30000,
        '1602': -5000,
        '2202': -40000,
        '2211': -25000 + 25000,
        '5401': 30000,
        '5602': 8000 + 25000 + 5000,
        '5603': 200,
        '5001': -130000
      }
    }
  },
  {
    month: m1, title: '常规业务（含应收往来）',
    vouchers: [
      [3, '客房收入(部分挂账)', [['1002', 60000, 0], ['1122', 30000, 0], ['5001', 0, 90000]]],
      [5, '房租收入', [['1002', 45000, 0], ['5001', 0, 45000]]],
      [8, '采购入库', [['1405', 50000, 0], ['2202', 0, 50000]]],
      [10, '结转成本', [['5401', 35000, 0], ['1405', 0, 35000]]],
      [12, '管理费用', [['5602', 12000, 0], ['1002', 0, 12000]]],
      [15, '计提工资', [['5602', 25000, 0], ['2211', 0, 25000]]],
      [15, '发放工资', [['2211', 25000, 0], ['1002', 0, 25000]]],
      [20, '财务费用', [['5603', 300, 0], ['1002', 0, 300]]],
      [25, '收回应收', [['1002', 30000, 0], ['1122', 0, 30000]]],
      [28, '计提折旧', [['5602', 5000, 0], ['1602', 0, 5000]]]
    ],
    expect: {
      rev: 135000, cost: 35000, exp: 42300, profit: 57700,
      delta: {
        '1002': 60000 + 45000 - 12000 - 25000 - 300 + 30000,
        '1122': 30000 - 30000,
        '1405': 50000 - 35000,
        '1602': -5000,
        '2202': -50000,
        '2211': 0,
        '5401': 35000,
        '5602': 12000 + 25000 + 5000,
        '5603': 300,
        '5001': -135000
      }
    }
  },
  {
    month: m2, title: '边界专项（小数 / 多借多贷 / 红字负数）',
    vouchers: [
      [3, '零星收入 0.01', [['1002', 0.01, 0], ['5001', 0, 0.01]]],
      [5, '手续费 0.1', [['5603', 0.1, 0], ['1002', 0, 0.1]]],
      [6, '手续费 0.2', [['5603', 0.2, 0], ['1002', 0, 0.2]]],
      [10, '多借多贷', [['1002', 20000, 0], ['1405', 5000, 0], ['5001', 0, 12000], ['2202', 0, 13000]]],
      [15, '计提工资', [['5602', 20000, 0], ['2211', 0, 20000]]],
      [15, '发放工资', [['2211', 20000, 0], ['1002', 0, 20000]]],
      [28, '计提折旧', [['5602', 5000, 0], ['1602', 0, 5000]]],
      [30, '红字冲回折旧(负数)', [['5602', -1000, 0], ['1602', 0, -1000]]]
    ],
    expect: {
      rev: 12000.01, cost: 0, exp: 24000.30, profit: -12000.29,
      delta: {
        '1002': 0.01 - 0.1 - 0.2 + 20000 - 20000,
        '1405': 5000,
        '1602': -5000 + 1000,
        '2202': -13000,
        '2211': 0,
        '5602': 20000 + 5000 - 1000,
        '5603': 0.3,
        '5001': -12000.01
      }
    }
  },
  {
    month: m3, title: '年末月（含年末结转 3103→3104）',
    vouchers: [
      [3, '客房收入', [['1002', 100000, 0], ['5001', 0, 100000]]],
      [10, '结转成本', [['5401', 40000, 0], ['1405', 0, 40000]]],
      [12, '管理费用', [['5602', 15000, 0], ['1002', 0, 15000]]],
      [15, '计提工资', [['5602', 30000, 0], ['2211', 0, 30000]]],
      [15, '发放工资', [['2211', 30000, 0], ['1002', 0, 30000]]],
      [28, '计提折旧', [['5602', 5000, 0], ['1602', 0, 5000]]]
    ],
    expect: {
      rev: 100000, cost: 40000, exp: 50000, profit: 10000,
      delta: {
        '1002': 100000 - 15000 - 30000,
        '1405': -40000,
        '1602': -5000,
        '2211': 0,
        '5401': 40000,
        '5602': 15000 + 30000 + 5000,
        '5001': -100000
      }
    }
  }
];

/* ---------- 追加 2027 年 1~12 月（跨年：验证年初数滚动）----------
   模板化：每月固定 7 笔业务，收入逐月递增 1000、成本固定，故利润逐月递增 1000。
   期望值同样用公式独立推出（不是抄软件的结果）。
     利润 = 收入 − 成本 − 费用(15000+30000+5000) = (100000+i*1000) − 40000 − 50000 = 10000 + i*1000
   采购略大于结转成本（cost+5000），避免库存越结越负。 */
for (let i = 1; i <= 12; i++) {
  const mo = '2027-' + String(i).padStart(2, '0');
  const rev = 100000 + i * 1000;
  const cost = 40000;
  const buy = cost + 5000;
  PLAN.push({
    month: mo,
    title: '第 ' + i + ' 月（收入 ' + rev + '，利润 ' + (10000 + i * 1000) + '）',
    vouchers: [
      [3, '客房收入', [['1002', rev, 0], ['5001', 0, rev]]],
      [8, '采购入库', [['1405', buy, 0], ['2202', 0, buy]]],
      [10, '结转成本', [['5401', cost, 0], ['1405', 0, cost]]],
      [12, '管理费用', [['5602', 15000, 0], ['1002', 0, 15000]]],
      [15, '计提工资', [['5602', 30000, 0], ['2211', 0, 30000]]],
      [15, '发放工资', [['2211', 30000, 0], ['1002', 0, 30000]]],
      [28, '计提折旧', [['5602', 5000, 0], ['1602', 0, 5000]]]
    ],
    expect: {
      rev: rev, cost: cost, exp: 50000, profit: rev - cost - 50000,
      delta: {
        '1002': rev - 45000,
        '1405': buy - cost,
        '1602': -5000,
        '2202': -buy,
        '2211': 0,
        '5401': cost,
        '5602': 50000,
        '5001': -rev
      }
    }
  });
}

/* ---------- 前置：科目存在性预检 ---------- */
section('【0】科目存在性预检');
const NEED = ['1002', '1122', '1405', '1602', '2202', '2211', '5001', '5401', '5602', '5603', '3103', '3104'];
const missing = NEED.filter(c => !S.state.subjects.some(s => String(s.code) === c));
if (missing.length) {
  console.log('    \x1b[31m缺少科目：' + missing.join(', ') + '\x1b[0m');
  NEED.forEach(c => { const s = S.state.subjects.find(x => String(x.code) === c); console.log('      ' + c.padEnd(8) + (s ? s.name : '✗ 不存在')); });
  process.exit(1);
}
console.log('    ✓ 全部存在：' + NEED.map(c => c + ' ' + (S.state.subjects.find(s => String(s.code) === c) || {}).name).join(' / '));

/* ---------- 前置：把上一个月结账（记账的必要前置） ---------- */
section('【前置】结 ' + lastMonth + ' 的账（现有账套该月尚未结账）');
if (S.isPeriodClosed(lastMonth)) {
  console.log('    该期已结账，跳过');
} else {
  const cl = S.settleChecklist(lastMonth) || [];
  const bad = cl.filter(x => x.status === 'fail');
  console.log('    检查清单：' + cl.length + ' 项，其中 fail ' + bad.length + (bad.length ? '（' + bad.map(x => x.label).join('、') + '）' : ''));
  let r = S.closePeriod(lastMonth);
  if (r && r.ok === false && r.warnOnly) {
    console.log('    → 提示项：' + (r.warns || []).map(w => w.label).join('、') + '；按真实流程二次确认');
    r = S.closePeriod(lastMonth, { force: true });
  }
  ok('结 ' + lastMonth + ' 账', r && r.ok !== false, (r && r.msg) || '');
}

/* ---------- 工具：科目净余额与本期变动 ---------- */
function gl(month) { S._glCache = {}; return S.generalLedger(month); }
function netOf(rows, code) {
  const r = rows.find(x => String(x.code) === String(code));
  if (!r) return 0;
  const b = num(r.balance);
  return r.dir === '借' ? b : -b;
}
function periodDelta(month, code) {
  const rows = gl(month);
  const r = rows.find(x => String(x.code) === String(code));
  if (!r) return 0;
  return r2(num(r.periodDr) - num(r.periodCr));
}

/* ============================================================
 * 逐月执行
 * ============================================================ */
const monthLog = [];
PLAN.forEach(P => {
  const M = P.month;
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' ' + M + '  ' + P.title);
  console.log('═══════════════════════════════════════════════════════════');

  section('【1】录入 ' + P.vouchers.length + ' 张凭证（官方 addVoucher 路径）');
  P.vouchers.forEach(x => {
    const v = {
      word: '记', date: M + '-' + String(x[0]).padStart(2, '0'), summary: x[1], attach: 0,
      entries: x[2].map(e => ({ code: e[0], name: (S.subject(e[0]) || {}).name || '', dr: e[1], cr: e[2] }))
    };
    const r = S.addVoucher(v);
    const good = r && r.ok !== false;
    ok('记-' + (good ? r.no : '?') + ' ' + x[1], good, good ? '' : JSON.stringify(r));
  });

  section('【2】账簿校验：逐科目本期变动 = 人工手算');
  Object.keys(P.expect.delta).sort().forEach(c => {
    const got = P.expect.delta[c];
    eqAmt(c + ' ' + ((S.subject(c) || {}).name || '') + ' 变动', periodDelta(M, c), got);
  });

  section('【3】结转前：资产负债表应「暂不平衡」，且差额恰等于未结转利润');
  {
    S._glCache = {};
    const bs = S.balanceSheet(M);
    const diff = r2(num(bs.totalAsset) - num(bs.totalLiability) - num(bs.totalEquity));
    eqAmt('暂不平衡差额 = 当月利润（正确表现）', diff, P.expect.profit);
  }

  section('【4】结转损益');
  let cf = null;
  try { cf = S.carryForwardProfit(M); } catch (e) { cf = { err: e.message }; }
  ok('结转损益执行', cf && cf.ok !== false, cf && cf.ok ? ('生成 ' + (cf.vouchers || []).length + ' 张') : JSON.stringify(cf || {}).slice(0, 90));

  section('【5】利润表 = 人工手算');
  S._glCache = {};
  const PL = S.profitStatement(M);
  console.log('    软件：收入 ' + r2(PL.totalRevenue).toFixed(2) + '  费用 ' + r2(PL.totalExpense).toFixed(2) + '  净利 ' + r2(PL.netProfit).toFixed(2));
  console.log('    手算：收入 ' + P.expect.rev.toFixed(2) + '  费用 ' + r2(P.expect.cost + P.expect.exp).toFixed(2) + '  净利 ' + P.expect.profit.toFixed(2));
  eqAmt('利润表·收入', PL.totalRevenue, P.expect.rev);
  eqAmt('利润表·净利润', PL.netProfit, P.expect.profit);
  eqAmt('3103 本年利润 本期变动 = 当月利润', periodDelta(M, '3103'), -P.expect.profit);

  section('【6】结转后：资产负债表平衡 + 资产/负债增量 = 手算');
  {
    S._glCache = {};
    const bs = S.balanceSheet(M);
    const diff = r2(num(bs.totalAsset) - num(bs.totalLiability) - num(bs.totalEquity));
    ok('结转后资产负债表平衡', Math.abs(diff) < 0.005, '差 ' + diff.toFixed(2));
    const assetDelta = Object.keys(P.expect.delta).reduce((a, c) => {
      const cls = (S.subject(c) || {}).cls;
      return a + ((cls === 'asset') ? P.expect.delta[c] : 0);
    }, 0);
    const liabDelta = Object.keys(P.expect.delta).reduce((a, c) => {
      const cls = (S.subject(c) || {}).cls;
      return a + ((cls === 'liability') ? (-P.expect.delta[c]) : 0);
    }, 0);
    console.log('    手算增量：资产 ' + r2(assetDelta).toFixed(2) + '   负债 ' + r2(liabDelta).toFixed(2) + '   权益(利润) ' + P.expect.profit.toFixed(2) +
      '   → ' + r2(assetDelta).toFixed(2) + ' = ' + r2(liabDelta + P.expect.profit).toFixed(2) + ' ' + (Math.abs(r2(assetDelta - liabDelta - P.expect.profit)) < 0.005 ? '✓' : '✗'));
    ok('资产增量 = 负债增量 + 利润（会计恒等式）', Math.abs(r2(assetDelta - liabDelta - P.expect.profit)) < 0.005);
  }

  /* 12 月：结账前必须先做年末结转（3103 → 3104），否则结账检查以 fail 拦截。
     实测提示：「12 月须结转本年利润（当前余额 X）至未分配利润，否则跨年未分配利润失真」——
     说明软件的结账前置检查正确。此处按真实流程把它排在结账之前。 */
  if (String(M).slice(5, 7) === '12') {
    section('【7】年末结转 ' + M + '（3103 本年利润 → 3104 利润分配）');
    const before3103 = netOf(gl(M), '3103');
    const allocBefore = netOf(gl(M), '3104');
    console.log('    结转前 3103 余额 ' + before3103.toFixed(2) + '（应 = 导入账套 1~8 月累计 + 模拟各月利润）');
    let y = null;
    try { y = S.carryYearEnd(M); } catch (e) { y = { err: e.message }; }
    ok('年末结转执行', y && y.ok !== false, y && y.ok ? ('结转金额 ' + r2(num(y.amount)).toFixed(2)) : JSON.stringify(y || {}).slice(0, 90));
    const after3103 = netOf(gl(M), '3103');
    const allocAfter = netOf(gl(M), '3104');
    console.log('    结转后 3103 余额 ' + after3103.toFixed(2) + '   3104 变动 ' + r2(allocAfter - allocBefore).toFixed(2));
    eqAmt('年末结转后 3103 清零', after3103, 0);
    eqAmt('3104 增加 = 结转的利润', r2(allocAfter - allocBefore), before3103);
    S._glCache = {};
    const bsY = S.balanceSheet(M);
    ok('年末结转后资产负债表平衡', Math.abs(r2(num(bsY.totalAsset) - num(bsY.totalLiability) - num(bsY.totalEquity))) < 0.005);
  }

  section('【8】结账 ' + M);
  {
    const cl = S.settleChecklist(M) || [];
    const bad = cl.filter(x => x.status === 'fail');
    console.log('    检查清单：' + cl.length + ' 项，fail ' + bad.length + (bad.length ? '（' + bad.map(x => x.label).join('、') + '）' : ''));
    ok('无硬性 fail 项', bad.length === 0, bad.map(x => x.label).join('、'));
    let r = S.closePeriod(M);
    if (r && r.ok === false && r.warnOnly) {
      console.log('    → 提示项：' + (r.warns || []).map(w => w.label).join('、') + '；二次确认后强制结账');
      r = S.closePeriod(M, { force: true });
    }
    ok('结账成功', r && r.ok !== false, (r && r.msg) || '');
    ok('已进入已结账期间', S.isPeriodClosed(M));
    ok('已结账月拒绝新增凭证', (function () {
      const x = S.addVoucher({ word: '记', date: M + '-30', entries: [{ code: '1002', dr: 1, cr: 0 }, { code: '5001', dr: 0, cr: 1 }] });
      return x && x.ok === false;
    })());
  }

  monthLog.push({ month: M, rev: P.expect.rev, cost: P.expect.cost, exp: P.expect.exp, profit: P.expect.profit });
});

/* ============================================================
 * 跨年验证：2027-01 的「年初数」应等于 2026-12 的「期末数」
 * ============================================================ */
console.log('\n═══════════════════════════════════════════════════════════');
console.log(' 跨年验证：年初数滚动（2027-01 年初数 应 = 2026-12 期末数）');
console.log('═══════════════════════════════════════════════════════════');
{
  const yEnd = '2026-12', yStart = '2027-01';
  S._glCache = {};
  const bsEnd = S.balanceSheet(yEnd);
  S._glCache = {};
  const bsStart = S.balanceSheet(yStart);
  const pick = bs => {
    const o = {};
    ['asset', 'liability', 'equity'].forEach(side => {
      ((bs.groups[side] || {}).items || []).forEach(it => { if (it && it.label) o[side + '|' + it.label] = it; });
    });
    return o;
  };
  const e = pick(bsEnd), s = pick(bsStart);
  let bad = 0, cmp = 0;
  Object.keys(e).forEach(k => {
    if (!s[k]) return;
    cmp++;
    const endV = r2(num(e[k].end)), yearV = r2(num(s[k].year));
    if (Math.abs(endV - yearV) > 0.005) { bad++; console.log('    \x1b[31m✗\x1b[0m ' + k.replace('|', ' / ') + '  2026-12 期末 ' + endV.toFixed(2) + '  →  2027-01 年初 ' + yearV.toFixed(2)); }
  });
  ok('全部 ' + cmp + ' 个报表项目的年初数 = 上年期末数', bad === 0 && cmp > 0, cmp === 0 ? '未取到可比项目' : (bad ? ('不一致 ' + bad + ' 项') : ''));
  const unKey = Object.keys(e).find(k => k.indexOf('未分配利润') >= 0);
  if (unKey) console.log('    未分配利润：2026-12 期末 ' + r2(num(e[unKey].end)).toFixed(2) + ' → 2027-01 年初 ' + r2(num(s[unKey].year)).toFixed(2) + '（上年利润经年末结转滚入）');
  // 年初数滚动的严格比法：逐科目比对 —— 2027-01 的「期初余额」应 = 2026-12 的「期末余额」。
  // 【为什么不用报表 items】balanceSheet 的资产/负债侧 items 不展开 year 字段，
  //   用它会得到「0 = 0」的空洞断言（曾踩过）。generalLedger 有 obDr/obCr（期初）与 balance（期末），
  //   逐科目比对最严格，也最能暴露「年初数没滚过来」这类问题。
  {
    const e = gl(yEnd), s = gl(yStart);
    let bad = 0, cmp = 0;
    e.forEach(re => {
      const rs = s.find(x => String(x.code) === String(re.code));
      if (!rs) return;
      cmp++;
      const endNet = r2((re.dir === '借' ? 1 : -1) * num(re.balance));
      const startNet = r2(num(rs.obDr) - num(rs.obCr));
      if (Math.abs(endNet - startNet) > 0.005) {
        bad++;
        if (bad <= 5) console.log('    \x1b[31m✗\x1b[0m ' + re.code + ' ' + (re.name || '') + '  2026-12 期末 ' + endNet.toFixed(2) + ' → 2027-01 期初 ' + startNet.toFixed(2));
      }
    });
    ok('全部 ' + cmp + ' 个科目：2027-01 期初余额 = 2026-12 期末余额', bad === 0 && cmp > 200,
      bad ? ('不一致 ' + bad + ' 项') : ('共 ' + cmp + ' 个科目'));
  }
  S._glCache = {};
  const bs1 = S.balanceSheet(yStart);
  ok('2027-01 资产负债表平衡', Math.abs(r2(num(bs1.totalAsset) - num(bs1.totalLiability) - num(bs1.totalEquity))) < 0.005);
}

/* ============================================================
 * 异常场景专项（2028-01）：删除/还原 / 红冲 / 反结账后修改
 * ============================================================ */
console.log('\n═══════════════════════════════════════════════════════════');
console.log(' 异常场景专项（2028-01）');
console.log('═══════════════════════════════════════════════════════════');
{
  const XM = '2028-01';
  const mk = (day, sum, entries) => ({
    word: '记', date: XM + '-' + day, summary: sum, attach: 0,
    entries: entries.map(e => ({ code: e[0], name: (S.subject(e[0]) || {}).name || '', dr: e[1], cr: e[2] }))
  });

  section('【A】删除 → 账簿应立即排除 → 还原 → 应完全恢复');
  const vA = S.addVoucher(mk('05', '临时测试凭证', [['1002', 1234.56, 0], ['5001', 0, 1234.56]]));
  ok('A1 凭证录入成功', vA && vA.ok !== false);
  eqAmt('A2 录入后 1002 本期变动 +1234.56', periodDelta(XM, '1002'), 1234.56);
  const delR = S.removeVoucher(vA.id);
  ok('A3 凭证已软删除', delR && delR.ok !== false, (delR && delR.msg) || '');
  eqAmt('A4 删除后 1002 本期变动归零（账簿已排除）', periodDelta(XM, '1002'), 0);
  ok('A5 凭证进入回收站', (S.deletedVouchers() || []).some(v => v.id === vA.id));
  S._glCache = {};
  const bsDel = S.balanceSheet(XM);
  ok('A6 删除后资产负债表仍平衡', Math.abs(r2(num(bsDel.totalAsset) - num(bsDel.totalLiability) - num(bsDel.totalEquity))) < 0.005);
  const resR = S.restoreVoucher(vA.id);
  ok('A7 凭证还原成功', resR && resR.ok !== false, (resR && resR.msg) || '');
  eqAmt('A8 还原后 1002 本期变动恢复 +1234.56', periodDelta(XM, '1002'), 1234.56);
  const delR2 = S.removeVoucher(vA.id);
  ok('A9 再次删除（清理，避免影响后续）', delR2 && delR2.ok !== false);
  eqAmt('A10 清理后 1002 本期变动归零', periodDelta(XM, '1002'), 0);

  section('【B】红字冲销：一正一负，净额应为 0');
  const vB1 = S.addVoucher(mk('06', '计提费用', [['5602', 8888, 0], ['1002', 0, 8888]]));
  const vB2 = S.addVoucher(mk('07', '红冲上述费用', [['5602', -8888, 0], ['1002', 0, -8888]]));
  ok('B1 正负两张均被接受（软件支持红字负数）', !!(vB1 && vB1.ok !== false && vB2 && vB2.ok !== false));
  eqAmt('B2 红冲后 5602 净额 = 0', periodDelta(XM, '5602'), 0);
  eqAmt('B3 红冲后 1002 净额 = 0', periodDelta(XM, '1002'), 0);
  S.removeVoucher(vB1.id); S.removeVoucher(vB2.id);

  section('【C】反结账 → 修改凭证 → 重新结账');
  S.addVoucher(mk('10', '客房收入', [['1002', 10000, 0], ['5001', 0, 10000]]));
  S.addVoucher(mk('28', '计提折旧', [['5602', 2000, 0], ['1602', 0, 2000]]));
  let cfx = S.carryForwardProfit(XM);
  ok('C1 结转损益', cfx && cfx.ok !== false);
  ok('C2 结转后利润 ≠ 0（先记录基准）', Math.abs(periodDelta(XM, '3103')) > 0.005, '3103 变动 ' + periodDelta(XM, '3103').toFixed(2));
  let cx = S.closePeriod(XM);
  if (cx && cx.ok === false && cx.warnOnly) cx = S.closePeriod(XM, { force: true });
  ok('C3 结账成功', cx && cx.ok !== false, (cx && cx.msg) || '');
  ok('C4 结账后不可修改凭证', (function () {
    const vs = S.periodVouchers(XM).filter(v => !v.kind);
    if (!vs.length) return false;
    const r = S.updateVoucher(vs[0].id, { word: vs[0].word, no: vs[0].no, date: vs[0].date, entries: [{ code: '1002', dr: 5, cr: 0 }, { code: '5001', dr: 0, cr: 5 }] });
    return !!(r && r.ok === false);
  })());
  const closedProfit = -r2(periodDelta(XM, '3103'));      // 结转后 3103 贷方增加 → 取负得利润
  const reR = S.reopenPeriod(XM, '模拟：需修正一笔凭证');
  ok('C5 反结账成功', reR && reR.ok !== false, (reR && reR.msg) || '');
  ok('C6 该期不再处于已结账', !S.isPeriodClosed(XM));
  S.periodVouchersOfKind(XM, 'carryPL').forEach(v => S.removeVoucher(v.id));   // 先清旧结转，避免重复结转
  const revV = S.periodVouchers(XM).filter(v => !v.kind).find(v => String(v.summary || '').indexOf('客房收入') >= 0);
  if (!revV) {
    ok('C7 找到待修改凭证', false, '未在期间凭证中找到「客房收入」');
  } else {
    const upR = S.updateVoucher(revV.id, {
      word: revV.word, no: revV.no, date: revV.date, summary: revV.summary,
      entries: [{ code: '1002', name: '银行存款', dr: 12000, cr: 0 }, { code: '5001', name: '主营业务收入', dr: 0, cr: 12000 }]
    });
    ok('C7 反结账后修改凭证成功（10000 → 12000）', upR && upR.ok !== false, (upR && upR.msg) || '');
    eqAmt('C8 修改后 1002 本期变动 = 12000', periodDelta(XM, '1002'), 12000);
    cfx = S.carryForwardProfit(XM);
    ok('C9 重新结转损益', cfx && cfx.ok !== false);
    const newProfit = -r2(periodDelta(XM, '3103'));
    eqAmt('C10 结转后利润 = 12000 − 2000(折旧) = 10000', newProfit, 10000);
    ok('C11 利润确实变了（原 ' + closedProfit + ' → 现 ' + newProfit + '）', Math.abs(newProfit - closedProfit) >= 0.005);
    let cx2 = S.closePeriod(XM);
    if (cx2 && cx2.ok === false && cx2.warnOnly) cx2 = S.closePeriod(XM, { force: true });
    ok('C12 重新结账成功', cx2 && cx2.ok !== false, (cx2 && cx2.msg) || '');
    ok('C13 该期重新进入已结账', S.isPeriodClosed(XM));
    S._glCache = {};
    const bsX = S.balanceSheet(XM);
    ok('C14 异常操作后资产负债表仍平衡', Math.abs(r2(num(bsX.totalAsset) - num(bsX.totalLiability) - num(bsX.totalEquity))) < 0.005);
  }
}

/* ---------- 汇总 ---------- */
console.log('\n═══════════════════════════════════════════════════════════');
console.log(' 各月利润（手算值，软件均已逐月比对通过）');
console.log('═══════════════════════════════════════════════════════════');
let sum = 0;
monthLog.forEach(x => {
  sum = r2(sum + x.profit);
  console.log('  ' + x.month + '   收入 ' + x.rev.toFixed(2).padStart(12) + '  成本 ' + x.cost.toFixed(2).padStart(10) +
    '  费用 ' + x.exp.toFixed(2).padStart(10) + '  利润 ' + x.profit.toFixed(2).padStart(12));
});
console.log('  ' + '合计'.padEnd(8) + '  ' + ' '.repeat(30) + '  利润 ' + sum.toFixed(2).padStart(12));

const MD5_AFTER = crypto.createHash('md5').update(fs.readFileSync(BOOK_FILE, 'utf8')).digest('hex');
console.log('\n  源文件完整性：' + (MD5_BEFORE === MD5_AFTER ? '\x1b[32m未被改动（MD5 一致）\x1b[0m' : '\x1b[31mMD5 变了！\x1b[0m'));
if (MD5_BEFORE !== MD5_AFTER) fail++;

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' 结果：' + (fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m存在失败\x1b[0m') + '   PASS ' + pass + ' / FAIL ' + fail);
if (fail) { console.log(' 失败项：'); fails.forEach(f => console.log('   · ' + f)); }
console.log(' 源文件：' + BOOK_FILE);
console.log('═══════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
